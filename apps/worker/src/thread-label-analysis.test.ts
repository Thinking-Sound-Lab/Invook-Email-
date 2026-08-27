import assert from "node:assert/strict";
import test from "node:test";

import { createStoredThreadLabelInputHash } from "@invook/ai";
import type { WorkflowStepJob } from "@invook/database";

import {
  classifyHistoricalThreadLabel,
  parseHistoricalThreadLabelScanCoordinatorJob,
  parseHistoricalThreadLabelScanJob,
  parseThreadLabelAnalysisJob,
} from "./thread-label-analysis";

const HISTORICAL_SCAN_ID = "11111111-1111-4111-8111-111111111111";
const PREVIEW_RECEIPT_ID = "22222222-2222-4222-8222-222222222222";

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

test("historical scans accept assigned and unassigned thread checkpoints", () => {
  const parsed = parseHistoricalThreadLabelScanJob(
    workflowJob("label.thread.scan", {
      historicalScanId: HISTORICAL_SCAN_ID,
      previewReceiptId: PREVIEW_RECEIPT_ID,
      threadId: "thread-1",
      labelId: "billing-label",
      definitionVersion: 2,
      enablementVersion: 3,
      assignmentVersion: 7,
    }),
  );

  assert.deepEqual(parsed.checkpoint, {
    historicalScanId: HISTORICAL_SCAN_ID,
    previewReceiptId: PREVIEW_RECEIPT_ID,
    threadId: "thread-1",
    labelId: "billing-label",
    definitionVersion: 2,
    enablementVersion: 3,
    assignmentVersion: 7,
  });

  const unassigned = parseHistoricalThreadLabelScanJob(
    workflowJob("label.thread.scan", {
      historicalScanId: HISTORICAL_SCAN_ID,
      previewReceiptId: null,
      threadId: "thread-2",
      labelId: "billing-label",
      definitionVersion: 2,
      enablementVersion: 4,
      assignmentVersion: null,
    }),
  );

  assert.deepEqual(unassigned.checkpoint, {
    historicalScanId: HISTORICAL_SCAN_ID,
    previewReceiptId: null,
    threadId: "thread-2",
    labelId: "billing-label",
    definitionVersion: 2,
    enablementVersion: 4,
    assignmentVersion: null,
  });
});

test("historical scan coordinators restore their durable Date and cursor", () => {
  assert.deepEqual(
    parseHistoricalThreadLabelScanCoordinatorJob(
      workflowJob("label.historical.scan", {
        historicalScanId: HISTORICAL_SCAN_ID,
        previewReceiptId: PREVIEW_RECEIPT_ID,
        labelId: "billing-label",
        definitionVersion: 2,
        enablementVersion: 3,
        after: "2026-08-01T00:00:00.000Z",
        cursorThreadId: "thread-100",
      }),
    ),
    {
      userId: "user-1",
      accountId: "account-1",
      checkpoint: {
        historicalScanId: HISTORICAL_SCAN_ID,
        previewReceiptId: PREVIEW_RECEIPT_ID,
        labelId: "billing-label",
        definitionVersion: 2,
        enablementVersion: 3,
        after: new Date("2026-08-01T00:00:00.000Z"),
        cursorThreadId: "thread-100",
      },
    },
  );

  assert.throws(
    () =>
      parseHistoricalThreadLabelScanCoordinatorJob(
        workflowJob("label.historical.scan", {
          historicalScanId: HISTORICAL_SCAN_ID,
          previewReceiptId: null,
          labelId: "billing-label",
          definitionVersion: 2,
          enablementVersion: 3,
          after: "not-a-timestamp",
          cursorThreadId: null,
        }),
      ),
    /ISO timestamp/,
  );
});

test("historical scans reuse an exact preview result without a model call", async () => {
  const thread = {
    subject: "Quarterly invoice",
    messages: [{
      subject: "Quarterly invoice",
      sender: "billing@example.com",
      recipients: ["owner@example.com"],
      bodyText: "The invoice is attached.",
      sentAt: "2026-08-20T00:00:00.000Z",
    }],
  };
  let modelCalls = 0;
  const result = await classifyHistoricalThreadLabel(
    {
      thread,
      definition: {
        id: "billing-label",
        name: "Billing",
        description: "Invoices and receipts",
        definitionVersion: 1,
      },
      previewResult: {
        classifierInputHash: createStoredThreadLabelInputHash(thread),
        matched: true,
        confidence: 97,
        modelId: "preview-model",
      },
    },
    async () => {
      modelCalls += 1;
      return { modelId: "worker-model", labelId: "billing-label", confidence: 88 };
    },
  );

  assert.equal(modelCalls, 0);
  assert.deepEqual(result, {
    matched: true,
    confidence: 97,
    modelId: "preview-model",
    source: "preview",
  });
});

test("historical scans call the model when stored thread input changed", async () => {
  const thread = {
    subject: "Updated invoice",
    messages: [{
      subject: "Updated invoice",
      sender: "billing@example.com",
      recipients: ["owner@example.com"],
      bodyText: "This message changed after preview.",
      sentAt: "2026-08-20T00:00:00.000Z",
    }],
  };
  let modelCalls = 0;
  const result = await classifyHistoricalThreadLabel(
    {
      thread,
      definition: {
        id: "billing-label",
        name: "Billing",
        description: "Invoices and receipts",
        definitionVersion: 1,
      },
      previewResult: {
        classifierInputHash: "a".repeat(64),
        matched: true,
        confidence: 97,
        modelId: "preview-model",
      },
    },
    async () => {
      modelCalls += 1;
      return { modelId: "worker-model", labelId: "no-match:billing-label", confidence: 81 };
    },
  );

  assert.equal(modelCalls, 1);
  assert.deepEqual(result, {
    matched: false,
    confidence: 81,
    modelId: "worker-model",
    source: "model",
  });
});

test("all one hundred exact preview outcomes avoid duplicate historical model calls", async () => {
  let modelCalls = 0;
  const results = await Promise.all(
    Array.from({ length: 100 }, async (_, index) => {
      const thread = {
        subject: `Preview thread ${index}`,
        messages: [{
          subject: `Preview thread ${index}`,
          sender: `sender-${index}@example.com`,
          recipients: ["owner@example.com"],
          bodyText: `Stored body ${index}`,
          sentAt: "2026-08-20T00:00:00.000Z",
        }],
      };
      return classifyHistoricalThreadLabel(
        {
          thread,
          definition: {
            id: "custom-label",
            name: "Custom",
            description: "A custom label",
            definitionVersion: 1,
          },
          previewResult: {
            classifierInputHash: createStoredThreadLabelInputHash(thread),
            matched: index % 2 === 0,
            confidence: 90,
            modelId: "preview-model",
          },
        },
        async () => {
          modelCalls += 1;
          return {
            modelId: "worker-model",
            labelId: "custom-label",
            confidence: 90,
          };
        },
      );
    }),
  );

  assert.equal(results.length, 100);
  assert.equal(modelCalls, 0);
  assert.ok(results.every((result) => result.source === "preview"));
});
