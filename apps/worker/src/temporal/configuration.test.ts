import assert from "node:assert/strict";
import { test } from "node:test";

import {
  getTemporalCloudConfiguration,
  getWorkflowStartDelay,
  taskQueueRouteForCommand,
  tenantActivityConcurrency,
  tenantShardForUserId,
  tenantTaskQueueName,
} from "./configuration";
import { parseNonNegativeInteger, parsePositiveInteger } from "./environment";

test("Temporal Cloud configuration requires an environment-specific task queue", () => {
  assert.deepEqual(
    getTemporalCloudConfiguration({
      TEMPORAL_ADDRESS: "example.tmprl.cloud:7233",
      TEMPORAL_NAMESPACE: "invook.example",
      TEMPORAL_API_KEY: "test-key",
      TEMPORAL_TASK_QUEUE_PREFIX: "invook-test",
    }),
    {
      address: "example.tmprl.cloud:7233",
      namespace: "invook.example",
      apiKey: "test-key",
      taskQueuePrefix: "invook-test",
      tenantShardCount: 1,
      tenantShardIndex: 0,
    },
  );
  assert.throws(
    () =>
      getTemporalCloudConfiguration({
        TEMPORAL_ADDRESS: "example.tmprl.cloud:7233",
        TEMPORAL_NAMESPACE: "invook.example",
        TEMPORAL_API_KEY: "test-key",
        TEMPORAL_TASK_QUEUE_PREFIX: "Invalid Prefix",
      }),
    /lowercase letters/i,
  );
});

test("Temporal tenant shard configuration is bounded", () => {
  assert.equal(parseNonNegativeInteger(undefined, 0, "TEST_SHARD"), 0);
  assert.throws(
    () => parseNonNegativeInteger("-1", 0, "TEST_SHARD"),
    /non-negative integer/i,
  );
  assert.throws(
    () =>
      getTemporalCloudConfiguration({
        TEMPORAL_ADDRESS: "example.tmprl.cloud:7233",
        TEMPORAL_NAMESPACE: "invook.example",
        TEMPORAL_API_KEY: "test-key",
        TEMPORAL_TASK_QUEUE_PREFIX: "invook-test",
        TEMPORAL_TENANT_SHARD_COUNT: "2",
        TEMPORAL_TENANT_SHARD_INDEX: "2",
      }),
    /must be lower/i,
  );
});

test("Temporal tenant queues use only stable user ownership and logical lanes", () => {
  const userId = "11111111-1111-4111-8111-111111111111";
  assert.equal(
    tenantTaskQueueName({ taskQueuePrefix: "invook-test" }, userId, "control"),
    `invook-test-tenant-${userId}-control`,
  );
  assert.equal(tenantShardForUserId(userId, 8), tenantShardForUserId(userId, 8));
  assert.ok(tenantShardForUserId(userId, 8) < 8);
  assert.throws(
    () =>
      tenantTaskQueueName(
        { taskQueuePrefix: "invook-test" },
        "person@example.com",
        "control",
      ),
    /valid user ID/i,
  );
});

test("Temporal commands route only through isolated tenant lanes", () => {
  const configuration = getTemporalCloudConfiguration({
    TEMPORAL_ADDRESS: "example.tmprl.cloud:7233",
    TEMPORAL_NAMESPACE: "invook.example",
    TEMPORAL_API_KEY: "test-key",
    TEMPORAL_TASK_QUEUE_PREFIX: "invook-test",
  });
  const base = {
    id: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    accountId: "33333333-3333-4333-8333-333333333333",
    runId: null,
    stepType: "label.thread.assign",
    payload: {},
    attempts: 0,
    maxAttempts: 5,
  };
  assert.deepEqual(
    taskQueueRouteForCommand(configuration, {
      ...base,
      activityTaskLane: "live",
    }),
    {
      workflowTaskQueue:
        "invook-test-tenant-22222222-2222-4222-8222-222222222222-control",
      activityTaskQueue:
        "invook-test-tenant-22222222-2222-4222-8222-222222222222-live",
    },
  );
});

test("Temporal Activity concurrency is a positive integer", () => {
  assert.equal(parsePositiveInteger(undefined, 5, "TEST_CONCURRENCY"), 5);
  assert.equal(parsePositiveInteger("7", 5, "TEST_CONCURRENCY"), 7);
  assert.throws(
    () => parsePositiveInteger("0", 5, "TEST_CONCURRENCY"),
    /must be a positive integer/i,
  );
});

test("every tenant lane executes Activities in parallel", () => {
  assert.ok(tenantActivityConcurrency("control") >= 2);
  assert.ok(tenantActivityConcurrency("live") >= 5);
  assert.ok(tenantActivityConcurrency("bulk") >= 2);
});

test("Temporal workflow start delay preserves a future runAt checkpoint", () => {
  const now = Date.parse("2026-08-17T10:00:00.000Z");
  assert.equal(
    getWorkflowStartDelay({ runAt: "2026-08-17T10:05:00.000Z" }, now),
    5 * 60 * 1_000,
  );
  assert.equal(
    getWorkflowStartDelay({ runAt: "2026-08-17T09:55:00.000Z" }, now),
    undefined,
  );
  assert.equal(getWorkflowStartDelay({ runAt: "not-a-date" }, now), undefined);
});
