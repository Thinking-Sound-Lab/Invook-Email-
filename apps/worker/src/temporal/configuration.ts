import { validate as validateUuid } from "uuid";

import type { TemporalCommandJob } from "@invook/database";
import type {
  TaskQueueLane,
  WorkflowStepExecution,
} from "@invook/workflows";

import {
  parsePositiveInteger,
  requiredEnvironmentValue,
} from "./environment";

const gmailControlConcurrency = 5;
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
  };
}

/**
 * The queue a lane's work is served from.
 *
 * One queue per lane, not one per tenant. Tenant isolation is no longer a
 * routing concern: a Workflow schedules its own Activities one step at a time,
 * so a mailbox with a hundred thousand threads contributes a page of work to
 * the queue rather than a hundred thousand tasks. Poller count now scales with
 * the number of worker processes instead of the number of signups.
 */
export function laneTaskQueueName(
  configuration: Pick<TemporalCloudConfiguration, "taskQueuePrefix">,
  lane: TaskQueueLane,
): string {
  return `${configuration.taskQueuePrefix}-${lane}`;
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

export function laneActivityConcurrency(lane: TaskQueueLane): number {
  switch (lane) {
    case "control":
      return gmailControlConcurrency;
    case "live":
      return Math.max(mailLabelConcurrency, 5);
    case "bulk":
      // Bounds the process, not a tenant: each Workflow already paces its own
      // Activities, and provider content work is bounded separately by
      // GMAIL_CONTENT_CONCURRENCY.
      return mailBulkConcurrency;
  }
}

export function workflowStepExecution(
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
    // Workflow Tasks are cheap and ordering-sensitive, so they all run on the
    // control lane; only Activities follow the step's lane.
    workflowTaskQueue: laneTaskQueueName(configuration, "control"),
    activityTaskQueue: laneTaskQueueName(configuration, command.activityTaskLane),
  };
}

/**
 * What a dispatched admission step asks Temporal to do.
 *
 * Each variant names the Workflow that owns the work and the identity it is
 * addressed by. Parsing here keeps the untrusted parts of a step payload — the
 * scan ID a webhook wrote, the run a transaction recorded — out of the dispatch
 * path's control flow.
 */
export type AdmittedWorkflowCommand =
  | { kind: "gmail-sync"; accountId: string; runId: string }
  | { kind: "gmail-incremental-sync"; accountId: string }
  | { kind: "thread-label-scan"; accountId: string }
  | { kind: "historical-label-scan"; accountId: string; historicalScanId: string }
  | {
      kind: "historical-label-batch-completed";
      accountId: string;
      historicalScanId: string;
      providerBatchId: string;
    };

function requiredUuid(value: unknown, name: string): string {
  if (typeof value !== "string" || !validateUuid(value)) {
    throw new Error(`${name} must be a UUID.`);
  }
  return value;
}

export function admittedWorkflowCommand(
  command: TemporalCommandJob,
): AdmittedWorkflowCommand {
  const accountId = command.accountId;
  if (!accountId) {
    throw new Error("The Temporal admission step is missing its account.");
  }
  switch (command.stepType) {
    case "gmail.sync.run": {
      if (!command.runId) {
        throw new Error(
          "The Gmail synchronization admission step is missing its run.",
        );
      }
      return { kind: "gmail-sync", accountId, runId: command.runId };
    }
    case "gmail.history.catchup":
      return { kind: "gmail-incremental-sync", accountId };
    case "label.recent.scan":
      return { kind: "thread-label-scan", accountId };
    case "label.batch.submit":
      return {
        kind: "historical-label-scan",
        accountId,
        historicalScanId: requiredUuid(
          command.payload.historicalScanId,
          "The historical label scan ID",
        ),
      };
    case "label.batch.event": {
      const providerBatchId = command.payload.providerBatchId;
      if (typeof providerBatchId !== "string" || !providerBatchId.trim()) {
        throw new Error("The provider Batch ID is missing.");
      }
      return {
        kind: "historical-label-batch-completed",
        accountId,
        historicalScanId: requiredUuid(
          command.payload.historicalScanId,
          "The historical label scan ID",
        ),
        providerBatchId,
      };
    }
    default:
      throw new Error(
        `Unsupported Temporal admission step: ${command.stepType}`,
      );
  }
}
