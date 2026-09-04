import { fileURLToPath } from "node:url";

import {
  Client,
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
} from "@temporalio/client";
import { WorkflowIdReusePolicy } from "@temporalio/common";
import {
  bundleWorkflowCode,
  NativeConnection,
  Worker,
  type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";

import {
  isTemporalAdmissionStepType,
  type TemporalCommandJob,
} from "@invook/database";
import {
  gmailCatchUpSignal,
  gmailIncrementalSyncWorkflow,
  gmailSyncWorkflow,
  historicalLabelBatchCompletedSignal,
  historicalLabelScanWorkflow,
  tenantTaskQueueLanes,
  threadLabelRescanSignal,
  threadLabelScanWorkflow,
  workflowStepWorkflow,
  type GmailIncrementalSyncActivities,
  type GmailSyncActivities,
  type HistoricalLabelScanActivities,
  type ThreadLabelScanActivities,
  type WorkflowStepActivities,
} from "@invook/workflows";

import {
  admittedWorkflowCommand,
  getTemporalCloudConfiguration,
  getWorkflowStartDelay,
  taskQueueRouteForCommand,
  tenantActivityConcurrency,
  tenantShardForUserId,
  tenantTaskQueueName,
  workflowStepExecution,
  type TemporalCloudConfiguration,
} from "./configuration";

const tenantWorkflowConcurrency = 4;

type TemporalActivities = WorkflowStepActivities &
  GmailSyncActivities &
  GmailIncrementalSyncActivities &
  ThreadLabelScanActivities &
  HistoricalLabelScanActivities;

interface CreateTemporalRuntimeInput {
  activities: TemporalActivities;
}

export class TemporalRuntime {
  private readonly activities: TemporalActivities;
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
    activities: TemporalActivities;
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
        new URL("./workflow-bundle.ts", import.meta.url),
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

  /**
   * Hands an admission step to the Workflow that owns its work.
   *
   * Workflow IDs are derived from the account, run, or scan rather than the
   * command, so a re-offered command can never put two Executions on one piece
   * of work: a start is rejected while its Execution lives, and a signal is
   * absorbed by the entity that receives it.
   */
  private async startAdmittedWorkflow(
    command: TemporalCommandJob,
    taskQueueRoute: { workflowTaskQueue: string; activityTaskQueue: string },
  ): Promise<void> {
    const admitted = admittedWorkflowCommand(command);
    const { workflowTaskQueue: taskQueue, activityTaskQueue } = taskQueueRoute;
    switch (admitted.kind) {
      case "gmail-sync":
        await this.client.workflow.start(gmailSyncWorkflow, {
          args: [
            {
              userId: command.userId,
              accountId: admitted.accountId,
              runId: admitted.runId,
              activityTaskQueue,
              pageNumber: 1,
              pageToken: null,
              pagesCompleted: 0,
              threadsDiscovered: 0,
              threadsIngested: 0,
            },
          ],
          taskQueue,
          workflowId: `gmail-sync:${admitted.accountId}:${admitted.runId}`,
          // A re-offered run restarts only when its previous Execution died.
          workflowIdReusePolicy:
            WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY,
        });
        return;
      case "gmail-incremental-sync":
        // The entity coalesces triggers, so every catch-up request is the same
        // signal and an idle Execution is recreated rather than kept open.
        await this.client.workflow.signalWithStart(
          gmailIncrementalSyncWorkflow,
          {
            args: [
              {
                userId: command.userId,
                accountId: admitted.accountId,
                activityTaskQueue,
                pendingRequestCount: 0,
                catchUpsCompleted: 0,
              },
            ],
            signal: gmailCatchUpSignal,
            signalArgs: [],
            taskQueue,
            workflowId: `gmail-incremental-sync:${admitted.accountId}`,
          },
        );
        return;
      case "thread-label-scan":
        // A scan already walking the account absorbs the signal as one extra
        // pass, so a boot sweep never queues a second walk of the same threads.
        await this.client.workflow.signalWithStart(threadLabelScanWorkflow, {
          args: [
            {
              userId: command.userId,
              accountId: admitted.accountId,
              activityTaskQueue,
              referenceAt: null,
              cursorThreadId: null,
              pagesCompleted: 0,
              reservedThreadCount: 0,
              isRescanRequested: false,
            },
          ],
          signal: threadLabelRescanSignal,
          signalArgs: [],
          taskQueue,
          workflowId: `thread-label-scan:${admitted.accountId}`,
        });
        return;
      case "historical-label-scan":
        await this.client.workflow.start(historicalLabelScanWorkflow, {
          args: [
            {
              userId: command.userId,
              accountId: admitted.accountId,
              historicalScanId: admitted.historicalScanId,
              activityTaskQueue,
              scope: {
                retryAttempt: 0,
                threadIds: null,
                continuations: [],
                retryDelayMs: 0,
              },
              batchesCompleted: 0,
              appliedThreadCount: 0,
            },
          ],
          taskQueue,
          workflowId: `historical-label-scan:${admitted.historicalScanId}`,
          workflowIdReusePolicy:
            WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY,
        });
        return;
      case "historical-label-batch-completed": {
        // The webhook only releases a wait. A scan that already finalized this
        // Batch, or finished entirely, has no Execution to signal.
        const handle = this.client.workflow.getHandle(
          `historical-label-scan:${admitted.historicalScanId}`,
        );
        try {
          await handle.signal(
            historicalLabelBatchCompletedSignal,
            admitted.providerBatchId,
          );
        } catch (error) {
          if (error instanceof WorkflowNotFoundError) return;
          throw error;
        }
        return;
      }
      default: {
        const unsupported: never = admitted;
        throw new Error(
          `Unsupported Temporal admission step: ${JSON.stringify(unsupported)}`,
        );
      }
    }
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
        try {
          if (isTemporalAdmissionStepType(command.stepType)) {
            await this.startAdmittedWorkflow(command, taskQueueRoute);
            return;
          }
          const startDelay = getWorkflowStartDelay(command.payload);
          await this.client.workflow.start(workflowStepWorkflow, {
            args: [
              workflowStepExecution(command, taskQueueRoute.activityTaskQueue),
            ],
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
