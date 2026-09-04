import assert from "node:assert/strict";
import { test } from "node:test";

import type { TemporalCommandJob } from "@invook/database";

import { taskQueueLanes } from "@invook/workflows";

import {
  admittedWorkflowCommand,
  getTemporalCloudConfiguration,
  getWorkflowStartDelay,
  laneActivityConcurrency,
  laneTaskQueueName,
  taskQueueRouteForCommand,
} from "./configuration";
import { parsePositiveInteger } from "./environment";

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

test("lane queues are named once per lane, not once per tenant", () => {
  const configuration = { taskQueuePrefix: "invook-test" };
  assert.equal(
    laneTaskQueueName(configuration, "control"),
    "invook-test-control",
  );
  assert.equal(laneTaskQueueName(configuration, "live"), "invook-test-live");
  assert.equal(laneTaskQueueName(configuration, "bulk"), "invook-test-bulk");
  // Poller count follows the number of lanes, so it cannot grow with signups.
  assert.equal(
    new Set(
      taskQueueLanes.map((lane) =>
        laneTaskQueueName(configuration, lane),
      ),
    ).size,
    taskQueueLanes.length,
  );
});

test("commands route Workflow Tasks to control and Activities to their lane", () => {
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
      workflowTaskQueue: "invook-test-control",
      activityTaskQueue: "invook-test-live",
    },
  );
  assert.equal(
    taskQueueRouteForCommand(configuration, {
      ...base,
      activityTaskLane: "bulk",
    }).activityTaskQueue,
    "invook-test-bulk",
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

test("every lane executes Activities in parallel", () => {
  assert.ok(laneActivityConcurrency("control") >= 2);
  assert.ok(laneActivityConcurrency("live") >= 5);
  assert.ok(laneActivityConcurrency("bulk") >= 2);
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

function admissionCommand(
  stepType: string,
  payload: Record<string, unknown> = {},
  overrides: Partial<TemporalCommandJob> = {},
): TemporalCommandJob {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    userId: "11111111-1111-4111-8111-111111111111",
    accountId: "22222222-2222-4222-8222-222222222222",
    runId: null,
    stepType,
    payload,
    attempts: 0,
    maxAttempts: 5,
    activityTaskLane: "bulk",
    ...overrides,
  };
}

test("admission steps name the Workflow that owns their work", () => {
  assert.deepEqual(
    admittedWorkflowCommand(
      admissionCommand("gmail.sync.run", {}, {
        runId: "33333333-3333-4333-8333-333333333333",
      }),
    ),
    {
      kind: "gmail-sync",
      accountId: "22222222-2222-4222-8222-222222222222",
      runId: "33333333-3333-4333-8333-333333333333",
    },
  );
  assert.deepEqual(admittedWorkflowCommand(admissionCommand("gmail.history.catchup")), {
    kind: "gmail-incremental-sync",
    accountId: "22222222-2222-4222-8222-222222222222",
  });
  assert.deepEqual(admittedWorkflowCommand(admissionCommand("label.recent.scan")), {
    kind: "thread-label-scan",
    accountId: "22222222-2222-4222-8222-222222222222",
  });
  assert.deepEqual(
    admittedWorkflowCommand(
      admissionCommand("label.batch.event", {
        historicalScanId: "44444444-4444-4444-8444-444444444444",
        providerBatchId: "batch_abc",
      }),
    ),
    {
      kind: "historical-label-batch-completed",
      accountId: "22222222-2222-4222-8222-222222222222",
      historicalScanId: "44444444-4444-4444-8444-444444444444",
      providerBatchId: "batch_abc",
    },
  );
});

test("admission refuses a step it cannot address a Workflow with", () => {
  assert.throws(
    () => admittedWorkflowCommand(admissionCommand("gmail.sync.run")),
    /missing its run/,
  );
  assert.throws(
    () =>
      admittedWorkflowCommand(
        admissionCommand("gmail.history.catchup", {}, { accountId: null }),
      ),
    /missing its account/,
  );
  // A scan identifier reaches dispatch from a provider webhook, so it is
  // validated rather than trusted.
  assert.throws(
    () =>
      admittedWorkflowCommand(
        admissionCommand("label.batch.submit", { historicalScanId: "nope" }),
      ),
    /must be a UUID/,
  );
  assert.throws(
    () =>
      admittedWorkflowCommand(
        admissionCommand("label.batch.event", {
          historicalScanId: "44444444-4444-4444-8444-444444444444",
        }),
      ),
    /provider Batch ID is missing/,
  );
  assert.throws(
    () => admittedWorkflowCommand(admissionCommand("memory.extract")),
    /Unsupported Temporal admission step/,
  );
});
