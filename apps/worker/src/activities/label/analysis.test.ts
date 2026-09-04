import assert from "node:assert/strict";
import test from "node:test";

import type { WorkflowStepJob } from "@invook/database";

import {
  parseThreadLabelAnalysisJob,
  scanThreadLabelPageActivity,
} from "./analysis";

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

test("a scan page rejects a reference time the Workflow could not have frozen", async () => {
  await assert.rejects(
    () =>
      scanThreadLabelPageActivity({
        userId: "11111111-1111-4111-8111-111111111111",
        accountId: "22222222-2222-4222-8222-222222222222",
        referenceAt: "not-a-timestamp",
        cursorThreadId: null,
      }),
    /reference time is invalid/,
  );
});
