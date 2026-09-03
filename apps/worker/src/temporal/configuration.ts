import { parse as parseUuid, validate as validateUuid } from "uuid";

import type { TemporalCommandJob } from "@invook/database";
import type {
  TenantTaskQueueLane,
  WorkflowStepExecution,
} from "@invook/workflows";

import {
  parseNonNegativeInteger,
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
  tenantShardCount: number;
  tenantShardIndex: number;
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
