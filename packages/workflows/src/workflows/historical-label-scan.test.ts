import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import type { WorkflowHandle } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";

import type {
  FailHistoricalLabelScanInput,
  FinalizeHistoricalLabelBatchOutcome,
  HistoricalLabelScanActivities,
  HistoricalLabelScanWorkflowInput,
  HistoricalLabelScanWorkflowResult,
  SubmitHistoricalLabelBatchOutcome,
} from "../contracts/historical-label-scan";
import {
  historicalLabelBatchCompletedSignal,
  historicalLabelScanWorkflow,
} from "./historical-label-scan";

const taskQueue = "historical-label-scan-test";
const historicalScanId = "44444444-4444-4444-8444-444444444444";

function workflowInput(
  overrides: Partial<HistoricalLabelScanWorkflowInput> = {},
): HistoricalLabelScanWorkflowInput {
  return {
    userId: "11111111-1111-4111-8111-111111111111",
    accountId: "22222222-2222-4222-8222-222222222222",
    historicalScanId,
    activityTaskQueue: taskQueue,
    scope: {
      retryAttempt: 0,
      threadIds: null,
      continuations: [],
      retryDelayMs: 0,
    },
    batchesCompleted: 0,
    appliedThreadCount: 0,
    ...overrides,
  };
}

describe("historicalLabelScanWorkflow", () => {
  let environment: TestWorkflowEnvironment;

  before(async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping();
  });

  after(async () => {
    await environment?.teardown();
  });

  const withWorker = async <Result>(
    activities: Partial<HistoricalLabelScanActivities>,
    body: (
      handle: WorkflowHandle<typeof historicalLabelScanWorkflow>,
    ) => Promise<Result>,
    input: HistoricalLabelScanWorkflowInput = workflowInput(),
  ): Promise<Result> => {
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath: fileURLToPath(
        new URL("./historical-label-scan.ts", import.meta.url),
      ),
      activities: {
        async failHistoricalLabelScanActivity() {},
        ...activities,
      },
    });
    return worker.runUntil(async () => {
      const handle = await environment.client.workflow.start(
        historicalLabelScanWorkflow,
        {
          args: [input],
          taskQueue,
          workflowId: `historical-label-scan-test:${Math.random()}`,
        },
      );
      try {
        return await body(handle);
      } finally {
        await handle.terminate().catch(() => undefined);
      }
    });
  };

  test("waits for each Batch's completion before submitting the next", async () => {
    const submittedBatchIds: string[] = [];
    const finalizedBatchIds: string[] = [];

    const result: HistoricalLabelScanWorkflowResult = await withWorker(
      {
        async submitHistoricalLabelBatchActivity(): Promise<SubmitHistoricalLabelBatchOutcome> {
          if (submittedBatchIds.length >= 3) return { status: "exhausted" };
          // Every previously submitted Batch must already be finalized.
          assert.equal(finalizedBatchIds.length, submittedBatchIds.length);
          const providerBatchId = `batch-${submittedBatchIds.length + 1}`;
          submittedBatchIds.push(providerBatchId);
          return {
            status: "submitted",
            submissionId: `submission-${providerBatchId}`,
            providerBatchId,
            requestCount: 10,
          };
        },
        async finalizeHistoricalLabelBatchActivity(
          input,
        ): Promise<FinalizeHistoricalLabelBatchOutcome> {
          finalizedBatchIds.push(input.providerBatchId);
          return {
            status: "finalized",
            appliedThreadCount: 4,
            nextScope: {
              retryAttempt: 0,
              threadIds: null,
              continuations: [],
              retryDelayMs: 0,
            },
          };
        },
      },
      async (handle) => {
        // Nothing has been signalled, so the waits are released only by the
        // completion timeout the environment skips through.
        return handle.result();
      },
    );

    assert.deepEqual(submittedBatchIds, ["batch-1", "batch-2", "batch-3"]);
    assert.deepEqual(finalizedBatchIds, submittedBatchIds);
    assert.equal(result.status, "exhausted");
    assert.equal(result.batchesCompleted, 3);
    assert.equal(result.appliedThreadCount, 12);
  });

  test("a completion webhook releases the wait without the timeout", async () => {
    let finalizeCallCount = 0;
    let batchSubmitted: (() => void) | null = null;
    const submitted = new Promise<void>((resolve) => {
      batchSubmitted = resolve;
    });

    const result = await withWorker(
      {
        async submitHistoricalLabelBatchActivity(): Promise<SubmitHistoricalLabelBatchOutcome> {
          if (finalizeCallCount > 0) return { status: "exhausted" };
          batchSubmitted?.();
          return {
            status: "submitted",
            submissionId: "submission-1",
            providerBatchId: "batch-1",
            requestCount: 10,
          };
        },
        async finalizeHistoricalLabelBatchActivity(
          input,
        ): Promise<FinalizeHistoricalLabelBatchOutcome> {
          finalizeCallCount += 1;
          assert.equal(input.providerBatchId, "batch-1");
          return {
            status: "finalized",
            appliedThreadCount: 7,
            nextScope: {
              retryAttempt: 0,
              threadIds: null,
              continuations: [],
              retryDelayMs: 0,
            },
          };
        },
      },
      async (handle) => {
        await submitted;
        await handle.signal(historicalLabelBatchCompletedSignal, "batch-1");
        return handle.result();
      },
    );

    assert.equal(finalizeCallCount, 1);
    assert.equal(result.appliedThreadCount, 7);
  });

  test("a Batch still running when the wait expires is waited on again", async () => {
    let finalizeCallCount = 0;

    const result = await withWorker(
      {
        async submitHistoricalLabelBatchActivity(): Promise<SubmitHistoricalLabelBatchOutcome> {
          if (finalizeCallCount >= 3) return { status: "exhausted" };
          return {
            status: "submitted",
            submissionId: "submission-1",
            providerBatchId: "batch-1",
            requestCount: 10,
          };
        },
        async finalizeHistoricalLabelBatchActivity(): Promise<FinalizeHistoricalLabelBatchOutcome> {
          finalizeCallCount += 1;
          // The provider is still running for the first two checks, so the
          // Batch must not be abandoned.
          if (finalizeCallCount < 3) return { status: "pending" };
          return {
            status: "finalized",
            appliedThreadCount: 1,
            nextScope: null,
          };
        },
      },
      async (handle) => handle.result(),
    );

    assert.equal(finalizeCallCount, 3);
    assert.equal(result.status, "complete");
    assert.equal(result.batchesCompleted, 1);
  });

  test("an empty scope advances the scan without any completion wait", async () => {
    const submittedScopes: Array<number> = [];

    const result = await withWorker(
      {
        async submitHistoricalLabelBatchActivity(
          input,
        ): Promise<SubmitHistoricalLabelBatchOutcome> {
          submittedScopes.push(input.retryAttempt);
          if (input.retryAttempt >= 2) return { status: "exhausted" };
          return {
            status: "skipped",
            nextScope: {
              retryAttempt: input.retryAttempt + 1,
              threadIds: ["thread-1"],
              continuations: [],
              retryDelayMs: 0,
            },
          };
        },
        async finalizeHistoricalLabelBatchActivity(): Promise<FinalizeHistoricalLabelBatchOutcome> {
          throw new Error("a skipped scope must not be finalized");
        },
      },
      async (handle) => handle.result(),
    );

    assert.deepEqual(submittedScopes, [0, 1, 2]);
    assert.equal(result.status, "exhausted");
    assert.equal(result.batchesCompleted, 0);
  });

  test("a scan the Workflow cannot advance is closed as failed", async () => {
    const failures: FailHistoricalLabelScanInput[] = [];

    const result = await withWorker(
      {
        async submitHistoricalLabelBatchActivity(): Promise<SubmitHistoricalLabelBatchOutcome> {
          throw new Error("label_analysis_model_unavailable");
        },
        async failHistoricalLabelScanActivity(input) {
          failures.push(input);
        },
      },
      async (handle) => handle.result(),
    );

    assert.equal(result.status, "failed");
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.historicalScanId, historicalScanId);
  });

  test("a superseded scan stops without submitting anything further", async () => {
    const result = await withWorker(
      {
        async submitHistoricalLabelBatchActivity(): Promise<SubmitHistoricalLabelBatchOutcome> {
          return { status: "superseded" };
        },
      },
      async (handle) => handle.result(),
    );

    assert.equal(result.status, "superseded");
    assert.equal(result.batchesCompleted, 0);
  });
});
