import assert from "node:assert/strict";
import test from "node:test";

import type { WorkflowStepJob } from "@invook/database";

import {
  parseRecentThreadLabelScanJob,
  parseThreadLabelAnalysisJob,
} from "./thread-label-analysis";

function workflowJob(
  stepType: string,
  payload: Record<string, unknown>,
): WorkflowStepJob {
  return {
    id: "step-1",
    userId: "user-1",
    accountId: "account-1",
    runId: null,
    stepType,
    payload,
    attempts: 1,
    maxAttempts: 5,
  };
}

test("live thread assignment jobs preserve their durable checkpoint", () => {
  assert.deepEqual(
    parseThreadLabelAnalysisJob(
      workflowJob("label.thread.assign", {
        threadId: "thread-1",
        analysisVersion: 2,
        definitionHash: "a".repeat(64),
        lane: "live",
      }),
    ),
    {
      userId: "user-1",
      accountId: "account-1",
      checkpoint: {
        threadId: "thread-1",
        analysisVersion: 2,
        definitionHash: "a".repeat(64),
      },
    },
  );
});

test("live thread assignment jobs reject invalid checkpoints", () => {
  assert.throws(
    () =>
      parseThreadLabelAnalysisJob(
        workflowJob("label.thread.assign", {
          threadId: "thread-1",
          analysisVersion: 0,
          definitionHash: "not-a-sha256",
        }),
      ),
    /positive integer/,
  );
});

test("recent recovery restores its fixed reference time and rejects invalid cursors", () => {
  const referenceAt = "2026-08-31T08:00:00.000Z";
  const job = workflowJob("label.recent.scan", {
    referenceAt,
    cursorThreadId: null,
  });
  assert.deepEqual(parseRecentThreadLabelScanJob(job), {
    userId: "user-1",
    accountId: "account-1",
    referenceAt: new Date(referenceAt),
    cursorThreadId: null,
  });
  assert.throws(
    () =>
      parseRecentThreadLabelScanJob({
        ...job,
        payload: { referenceAt, cursorThreadId: "invalid" },
      }),
    /UUID/,
  );
  assert.throws(
    () =>
      parseRecentThreadLabelScanJob({
        ...job,
        payload: { referenceAt: "invalid", cursorThreadId: null },
      }),
    /timestamp/,
  );
});
