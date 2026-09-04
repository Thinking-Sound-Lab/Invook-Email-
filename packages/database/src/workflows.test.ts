import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createDailyGmailWatchRenewalStep,
  createGmailWatchRecoveryStep,
  createImmediateGmailRepairRecoveryStep,
} from "./gmail-watch";
import {
  createGmailSyncRunStep,
  createPostSyncDerivationSteps,
  TEMPORAL_COMMAND_DISPATCH_BATCH_SIZE,
  temporalCommandJobFromRow,
  temporalCommandPriority,
  taskQueueLaneForStep,
  taskQueueLaneForStepType,
} from "./workflows";

test("live Gmail work dispatches ahead of bulk synchronization work", () => {
  assert.equal(TEMPORAL_COMMAND_DISPATCH_BATCH_SIZE, 10);
  assert.ok(
    temporalCommandPriority("gmail.history.catchup") <
      temporalCommandPriority("gmail.sync.run"),
  );
  assert.ok(
    temporalCommandPriority("label.thread.assign") <
    temporalCommandPriority("gmail.sync.run"),
  );
  assert.ok(
    temporalCommandPriority("label.batch.event") <
      temporalCommandPriority("label.batch.submit"),
  );
  assert.equal(
    taskQueueLaneForStepType("gmail.sync.run"),
    "bulk",
  );
  assert.equal(
    taskQueueLaneForStep({
      stepType: "label.thread.assign",
    }),
    "live",
  );
  assert.equal(
    taskQueueLaneForStep({
      stepType: "label.recent.scan",
    }),
    "bulk",
  );
  assert.equal(
    taskQueueLaneForStep({
      stepType: "label.batch.submit",
    }),
    "bulk",
  );
  assert.equal(
    taskQueueLaneForStepType("label.batch.submit"),
    "bulk",
  );
  assert.equal(
    taskQueueLaneForStepType("label.batch.event"),
    "bulk",
  );
});

test("new mail control work is isolated from live enrichment and bulk history", () => {
  assert.equal(taskQueueLaneForStepType("gmail.history.catchup"), "control");
  assert.equal(taskQueueLaneForStepType("gmail.message.refresh"), "control");
  assert.equal(taskQueueLaneForStepType("gmail.watch.renew"), "control");
  assert.equal(taskQueueLaneForStepType("memory.incremental"), "live");
  assert.equal(taskQueueLaneForStepType("gmail.sync.run"), "bulk");
  assert.equal(taskQueueLaneForStepType("memory.extract"), "bulk");
});

test("Temporal command routing requires stable tenant ownership", () => {
  const base = {
    id: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    accountId: "33333333-3333-4333-8333-333333333333",
    runId: null,
    stepType: "gmail.history.catchup",
    payload: {},
    attempts: 0,
    maxAttempts: 5,
  };
  assert.equal(
    temporalCommandJobFromRow({
      ...base,
      activityTaskLane: "control",
    }).activityTaskLane,
    "control",
  );
  assert.throws(
    () =>
      temporalCommandJobFromRow({
        ...base,
        userId: null,
        activityTaskLane: "control",
      }),
    /invalid durable routing contract/i,
  );
});

test("a synchronization run is admitted once per run identifier", () => {
  const step = createGmailSyncRunStep({
    runId: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    accountId: "33333333-3333-4333-8333-333333333333",
  });

  assert.equal(step.stepType, "gmail.sync.run");
  assert.equal(
    step.idempotencyKey,
    "gmail-sync-run:11111111-1111-4111-8111-111111111111",
  );
  assert.deepEqual(step.payload, {
    runId: "11111111-1111-4111-8111-111111111111",
  });
  assert.equal(taskQueueLaneForStep(step), "bulk");
});

test("daily Gmail watch renewal is deterministic and scheduled one day later", () => {
  const input = {
    userId: "11111111-1111-4111-8111-111111111111",
    accountId: "22222222-2222-4222-8222-222222222222",
    renewedAt: new Date("2026-08-13T10:15:30.000Z"),
    expectedExpirationAt: new Date("2026-08-20T10:15:30.000Z"),
  };

  const first = createDailyGmailWatchRenewalStep(input);
  const duplicate = createDailyGmailWatchRenewalStep(input);

  assert.deepEqual(duplicate, first);
  assert.ok(first.payload);
  assert.equal(first.payload.cadence, "daily");
  assert.equal(first.payload.runAt, "2026-08-14T10:15:30.000Z");
  assert.equal(first.payload.expectedExpirationAt, "2026-08-20T10:15:30.000Z");
  assert.equal(
    first.idempotencyKey,
    "gmail-watch-renew:22222222-2222-4222-8222-222222222222:daily:2026-08-14",
  );
  assert.equal(taskQueueLaneForStepType(first.stepType), "control");
});

test("terminal watch recovery schedules a unique bounded daily successor", () => {
  const step = createGmailWatchRecoveryStep({
    userId: "11111111-1111-4111-8111-111111111111",
    accountId: "22222222-2222-4222-8222-222222222222",
    expectedExpirationAt: new Date("2026-08-20T10:00:00.000Z"),
    recoveryKey: "failed:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    now: new Date("2026-08-13T10:00:00.000Z"),
  });

  assert.equal(step.payload?.reason, "terminal_failure_recovery");
  assert.equal(step.payload?.runAt, "2026-08-14T10:00:00.000Z");
  assert.equal(
    step.idempotencyKey,
    "gmail-watch-renew:22222222-2222-4222-8222-222222222222:recovery:failed:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  );
});

test("terminal watch recovery runs immediately when expiration is within a day", () => {
  const step = createGmailWatchRecoveryStep({
    userId: "11111111-1111-4111-8111-111111111111",
    accountId: "22222222-2222-4222-8222-222222222222",
    expectedExpirationAt: new Date("2026-08-13T20:00:00.000Z"),
    recoveryKey: "near-expiration",
    now: new Date("2026-08-13T10:00:00.000Z"),
  });

  assert.equal(step.payload?.runAt, "2026-08-13T10:00:00.000Z");
});

test("terminal initial synchronization failure creates an immediate repair trigger", () => {
  const step = createImmediateGmailRepairRecoveryStep({
    userId: "11111111-1111-4111-8111-111111111111",
    accountId: "22222222-2222-4222-8222-222222222222",
    failedRunId: "33333333-3333-4333-8333-333333333333",
    now: new Date("2026-08-13T10:00:00.000Z"),
  });

  assert.deepEqual(step.payload, {
    cadence: "recovery",
    reason: "terminal_sync_failure_recovery",
    failedRunId: "33333333-3333-4333-8333-333333333333",
    runAt: "2026-08-13T10:00:00.000Z",
  });
  assert.equal(
    step.idempotencyKey,
    "gmail-repair-recovery:22222222-2222-4222-8222-222222222222:33333333-3333-4333-8333-333333333333",
  );
  assert.equal(taskQueueLaneForStepType(step.stepType), "control");
});

test("ready replicas enqueue only the post-sync Memory derivation", () => {
  const steps = createPostSyncDerivationSteps({
    userId: "11111111-1111-4111-8111-111111111111",
    accountId: "22222222-2222-4222-8222-222222222222",
    historyCursor: "987654321",
  });

  assert.deepEqual(
    steps.map((step) => step.stepType),
    ["memory.extract"],
  );
  assert.deepEqual(
    new Set(steps.map((step) => taskQueueLaneForStepType(step.stepType))),
    new Set(["bulk"]),
  );
  assert.equal(
    taskQueueLaneForStepType("memory.incremental"),
    "live",
  );
  assert.equal(
    taskQueueLaneForStepType("label.thread.assign"),
    "live",
  );
  assert.equal(
    taskQueueLaneForStepType("label.recent.scan"),
    "bulk",
  );
});
