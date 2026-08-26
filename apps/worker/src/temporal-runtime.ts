import { fileURLToPath } from "node:url";

import {
  Client,
  WorkflowExecutionAlreadyStartedError,
} from "@temporalio/client";
import { WorkflowIdReusePolicy } from "@temporalio/common";
import {
  bundleWorkflowCode,
  NativeConnection,
  Worker,
  type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";
import { parse as parseUuid, validate as validateUuid } from "uuid";

import type { TemporalCommandJob } from "@invook/database";
import {
  tenantTaskQueueLanes,
  workflowStepWorkflow,
  type TenantTaskQueueLane,
  type WorkflowStepActivities,
  type WorkflowStepExecution,
} from "@invook/workflows";

const gmailControlConcurrency = 5;
const tenantWorkflowConcurrency = 4;
export const gmailContentConcurrency = parsePositiveInteger(
  process.env.GMAIL_CONTENT_CONCURRENCY,
  5,
  "GMAIL_CONTENT_CONCURRENCY",
);
const mailLabelConcurrency = parsePositiveInteger(
  process.env.MAIL_LABEL_CONCURRENCY,
  5,
  "MAIL_LABEL_CONCURRENCY",
);
const mailBulkConcurrency = parsePositiveInteger(
  process.env.MAIL_BULK_CONCURRENCY,
  3,
  "MAIL_BULK_CONCURRENCY",
);

export interface TemporalCloudConfiguration {
  address: string;
  namespace: string;
  apiKey: string;
  taskQueuePrefix: string;
  tenantShardCount: number;
  tenantShardIndex: number;
}

interface CreateTemporalRuntimeInput {
  activities: WorkflowStepActivities;
}

export function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

export function parseNonNegativeInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return parsed;
}

function requiredEnvironmentValue(
  value: string | undefined,
  name: string,
): string {
  const normalized = value?.trim() ?? "";
  if (!normalized) throw new Error(`${name} is required for Temporal Cloud.`);
  return normalized;
}

export function getTemporalCloudConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): TemporalCloudConfiguration {
  const taskQueuePrefix = requiredEnvironmentValue(
    environment.TEMPORAL_TASK_QUEUE_PREFIX,
    "TEMPORAL_TASK_QUEUE_PREFIX",
  );
  if (!/^[a-z0-9][a-z0-9-]*$/.test(taskQueuePrefix)) {
    throw new Error(
      "TEMPORAL_TASK_QUEUE_PREFIX must contain lowercase letters, digits, and hyphens.",
    );
  }
  const tenantShardCount = parsePositiveInteger(
    environment.TEMPORAL_TENANT_SHARD_COUNT,
    1,
    "TEMPORAL_TENANT_SHARD_COUNT",
  );
  const tenantShardIndex = parseNonNegativeInteger(
    environment.TEMPORAL_TENANT_SHARD_INDEX,
    0,
    "TEMPORAL_TENANT_SHARD_INDEX",
  );
  if (tenantShardIndex >= tenantShardCount) {
    throw new Error(
      "TEMPORAL_TENANT_SHARD_INDEX must be lower than TEMPORAL_TENANT_SHARD_COUNT.",
    );
  }
  return {
    address: requiredEnvironmentValue(
      environment.TEMPORAL_ADDRESS,
      "TEMPORAL_ADDRESS",
    ),
    namespace: requiredEnvironmentValue(
      environment.TEMPORAL_NAMESPACE,
      "TEMPORAL_NAMESPACE",
    ),
    apiKey: requiredEnvironmentValue(
      environment.TEMPORAL_API_KEY,
      "TEMPORAL_API_KEY",
    ),
    taskQueuePrefix,
    tenantShardCount,
    tenantShardIndex,
  };
}

export function tenantTaskQueueName(
  configuration: Pick<TemporalCloudConfiguration, "taskQueuePrefix">,
  userId: string,
  lane: TenantTaskQueueLane,
): string {
  if (!validateUuid(userId)) {
    throw new Error("Temporal tenant routing requires a valid user ID.");
  }
  const taskQueue = `${configuration.taskQueuePrefix}-tenant-${userId.toLowerCase()}-${lane}`;
  if (taskQueue.length > 255) {
    throw new Error(
      "The derived Temporal tenant task queue exceeds 255 characters.",
    );
  }
  return taskQueue;
}

export function tenantShardForUserId(
  userId: string,
  shardCount: number,
): number {
  if (!validateUuid(userId)) {
    throw new Error("Temporal tenant sharding requires a valid user ID.");
  }
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new Error("Temporal tenant shard count must be a positive integer.");
  }
  let hash = 2_166_136_261;
  for (const byte of parseUuid(userId)) {
    hash = Math.imul(hash ^ byte, 16_777_619) >>> 0;
  }
  return hash % shardCount;
}

export function getWorkflowStartDelay(
  payload: Record<string, unknown>,
  now: number = Date.now(),
): number | undefined {
  if (typeof payload.runAt !== "string") return undefined;
  const runAt = Date.parse(payload.runAt);
  if (!Number.isFinite(runAt) || runAt <= now) return undefined;
  return runAt - now;
}

export function tenantActivityConcurrency(lane: TenantTaskQueueLane): number {
  switch (lane) {
    case "control":
      return gmailControlConcurrency;
    case "live":
      return Math.max(mailLabelConcurrency, 5);
    case "bulk":
      // Above one so a user's Gmail accounts synchronize in parallel; each
      // account's provider content work is bounded by GMAIL_CONTENT_CONCURRENCY.
      return mailBulkConcurrency;
  }
}

function workflowStepExecution(
  command: TemporalCommandJob,
  activityTaskQueue: string,
): WorkflowStepExecution {
  return {
    id: command.id,
    userId: command.userId,
    accountId: command.accountId,
    runId: command.runId,
    stepType: command.stepType,
    payload: command.payload,
    attempts: command.attempts,
    maxAttempts: command.maxAttempts,
    activityTaskQueue,
  };
}

export function taskQueueRouteForCommand(
  configuration: TemporalCloudConfiguration,
  command: TemporalCommandJob,
): { workflowTaskQueue: string; activityTaskQueue: string } {
  return {
    workflowTaskQueue: tenantTaskQueueName(
      configuration,
      command.userId,
      "control",
    ),
    activityTaskQueue: tenantTaskQueueName(
      configuration,
      command.userId,
      command.activityTaskLane,
    ),
  };
}

export class TemporalRuntime {
  private readonly activities: WorkflowStepActivities;
  private readonly client: Client;
  private readonly configuration: TemporalCloudConfiguration;
  private readonly connection: NativeConnection;
  private readonly tenantWorkersByUserId = new Map<string, Promise<Worker[]>>();
  private readonly workerRuns = new Map<Worker, Promise<void>>();
  private readonly workflowBundle: WorkflowBundleWithSourceMap;
  private isClosing = false;
  private isRunning = false;
  private lifecyclePromise: Promise<void> | null = null;
  private resolveLifecycle: (() => void) | null = null;
  private rejectLifecycle: ((error: Error) => void) | null = null;

  private constructor(input: {
    activities: WorkflowStepActivities;
    client: Client;
    configuration: TemporalCloudConfiguration;
    connection: NativeConnection;
    workflowBundle: WorkflowBundleWithSourceMap;
  }) {
    this.activities = input.activities;
    this.client = input.client;
    this.configuration = input.configuration;
    this.connection = input.connection;
    this.workflowBundle = input.workflowBundle;
  }

  static async create(
    input: CreateTemporalRuntimeInput,
  ): Promise<TemporalRuntime> {
    const configuration = getTemporalCloudConfiguration();
    const connection = await NativeConnection.connect({
      address: configuration.address,
      apiKey: configuration.apiKey,
      tls: true,
    });
    const client = new Client({
      connection,
      namespace: configuration.namespace,
    });
    const workflowBundle = await bundleWorkflowCode({
      workflowsPath: fileURLToPath(
        new URL("./temporal-workflows.ts", import.meta.url),
      ),
    });
    return new TemporalRuntime({
      activities: input.activities,
      client,
      configuration,
      connection,
      workflowBundle,
    });
  }

  private ownsTenant(userId: string): boolean {
    return (
      tenantShardForUserId(userId, this.configuration.tenantShardCount) ===
      this.configuration.tenantShardIndex
    );
  }

  private async createTenantWorkers(userId: string): Promise<Worker[]> {
    return Promise.all(
      tenantTaskQueueLanes.map((lane) => {
        const concurrency = tenantActivityConcurrency(lane);
        return Worker.create({
          activities: this.activities,
          connection: this.connection,
          namespace: this.configuration.namespace,
          taskQueue: tenantTaskQueueName(this.configuration, userId, lane),
          maxConcurrentActivityTaskExecutions: concurrency,
          maxConcurrentActivityTaskPolls: Math.min(concurrency, 2),
          ...(lane === "control"
            ? {
                workflowBundle: this.workflowBundle,
                maxConcurrentWorkflowTaskExecutions: tenantWorkflowConcurrency,
                maxConcurrentWorkflowTaskPolls: 2,
              }
            : {}),
        });
      }),
    );
  }

  private startWorker(worker: Worker): void {
    if (this.workerRuns.has(worker)) return;
    const workerRun = worker.run().then(
      () => {
        if (!this.isClosing) {
          this.rejectLifecycle?.(
            new Error("A Temporal Worker stopped before shutdown was requested."),
          );
        }
      },
      (error: unknown) => {
        if (!this.isClosing) {
          this.rejectLifecycle?.(
            error instanceof Error
              ? error
              : new Error("An unknown Temporal Worker error occurred."),
          );
        }
      },
    );
    this.workerRuns.set(worker, workerRun);
  }

  private async ensureTenantWorker(userId: string): Promise<void> {
    if (!this.ownsTenant(userId)) return;
    let workersPromise = this.tenantWorkersByUserId.get(userId);
    if (!workersPromise) {
      workersPromise = this.createTenantWorkers(userId);
      this.tenantWorkersByUserId.set(userId, workersPromise);
    }
    try {
      const workers = await workersPromise;
      if (this.isRunning) workers.forEach((worker) => this.startWorker(worker));
    } catch (error) {
      this.tenantWorkersByUserId.delete(userId);
      throw error;
    }
  }

  async ensureTenantWorkers(userIds: Iterable<string>): Promise<void> {
    if (this.isClosing) {
      throw new Error("Temporal tenant Workers cannot start during shutdown.");
    }
    await Promise.all(
      [...new Set(userIds)].map((userId) => this.ensureTenantWorker(userId)),
    );
  }

  // Dispatch runs inside the outbox database transaction, so it must only
  // start Workflows. Tenant Workers are ensured by the command loop before
  // each drain; Temporal retains Workflow Tasks durably until a Worker polls,
  // so a tenant whose Worker is not yet running loses no work.
  async dispatch(commands: TemporalCommandJob[]): Promise<void> {
    await Promise.all(
      commands.map(async (command) => {
        const taskQueueRoute = taskQueueRouteForCommand(
          this.configuration,
          command,
        );
        const input = workflowStepExecution(
          command,
          taskQueueRoute.activityTaskQueue,
        );
        try {
          const startDelay = getWorkflowStartDelay(command.payload);
          await this.client.workflow.start(workflowStepWorkflow, {
            args: [input],
            taskQueue: taskQueueRoute.workflowTaskQueue,
            workflowId: `workflow-step:${command.id}`,
            workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
            ...(startDelay === undefined ? {} : { startDelay }),
          });
        } catch (error) {
          if (error instanceof WorkflowExecutionAlreadyStartedError) return;
          throw error;
        }
      }),
    );
  }

  run(): Promise<void> {
    if (this.lifecyclePromise) return this.lifecyclePromise;
    this.lifecyclePromise = new Promise<void>((resolve, reject) => {
      this.resolveLifecycle = resolve;
      this.rejectLifecycle = reject;
    });
    this.isRunning = true;
    for (const workersPromise of this.tenantWorkersByUserId.values()) {
      void workersPromise
        .then((workers) => {
          if (!this.isClosing) {
            workers.forEach((worker) => this.startWorker(worker));
          }
        })
        .catch((error: unknown) => {
          this.rejectLifecycle?.(
            error instanceof Error
              ? error
              : new Error("An unknown Temporal tenant Worker error occurred."),
          );
        });
    }
    return this.lifecyclePromise;
  }

  async close(): Promise<void> {
    if (this.isClosing) return;
    this.isClosing = true;
    const tenantWorkerResults = await Promise.allSettled(
      this.tenantWorkersByUserId.values(),
    );
    const tenantWorkers = tenantWorkerResults.flatMap((result) =>
      result.status === "fulfilled" ? result.value : [],
    );
    await Promise.all(tenantWorkers.map((worker) => worker.shutdown()));
    await Promise.all(this.workerRuns.values());
    await this.connection.close();
    this.resolveLifecycle?.();
  }
}
