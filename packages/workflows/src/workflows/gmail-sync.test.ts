import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";

import type {
  GmailSyncActivities,
  GmailSyncPageInput,
  GmailSyncPageOutcome,
  GmailSyncThreadBatchInput,
  GmailSyncThreadBatchOutcome,
  GmailSyncWorkflowInput,
  GmailSyncWorkflowResult,
} from "../contracts/gmail-sync";
import { gmailSyncThreadBatchSize } from "../contracts/gmail-sync";
import { gmailSyncWorkflow } from "./gmail-sync";

const taskQueue = "gmail-sync-test";

function threadPage(pageNumber: number, threadCount: number): string[] {
  return Array.from(
    { length: threadCount },
    (_, index) => `page-${pageNumber}-thread-${index + 1}`,
  );
}

function workflowInput(
  overrides: Partial<GmailSyncWorkflowInput> = {},
): GmailSyncWorkflowInput {
  return {
    userId: "11111111-1111-4111-8111-111111111111",
    accountId: "22222222-2222-4222-8222-222222222222",
    runId: "33333333-3333-4333-8333-333333333333",
    activityTaskQueue: taskQueue,
    pageNumber: 1,
    pageToken: null,
    pagesCompleted: 0,
    threadsDiscovered: 0,
    threadsIngested: 0,
    ...overrides,
  };
}

describe("gmailSyncWorkflow", () => {
  let environment: TestWorkflowEnvironment;

  before(async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping();
  });

  after(async () => {
    await environment?.teardown();
  });

  const runWorkflow = async (
    activities: GmailSyncActivities,
    input: GmailSyncWorkflowInput = workflowInput(),
  ): Promise<GmailSyncWorkflowResult> => {
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath: fileURLToPath(new URL("./gmail-sync.ts", import.meta.url)),
      activities,
    });
    return worker.runUntil(
      environment.client.workflow.execute(gmailSyncWorkflow, {
        args: [input],
        taskQueue,
        workflowId: `gmail-sync-test:${input.runId}:${input.pageNumber}`,
      }),
    );
  };

  test("walks every page and ingests each one before finalizing", async () => {
    const pages = [threadPage(1, 25), threadPage(2, 10), threadPage(3, 3)];
    const requestedPageTokens: Array<string | null> = [];
    const ingestedBatches: string[][] = [];
    let finalizedAfterIngestedThreads: number | null = null;

    const result = await runWorkflow({
      async syncGmailThreadPageActivity(
        input: GmailSyncPageInput,
      ): Promise<GmailSyncPageOutcome> {
        requestedPageTokens.push(input.pageToken);
        return {
          status: "recorded",
          nextPageToken:
            input.pageNumber < pages.length ? `token-${input.pageNumber + 1}` : null,
          pendingThreadIds: pages[input.pageNumber - 1] ?? [],
        };
      },
      async ingestGmailThreadBatchActivity(
        input: GmailSyncThreadBatchInput,
      ): Promise<GmailSyncThreadBatchOutcome> {
        ingestedBatches.push(input.providerThreadIds);
        return {
          status: "ingested",
          ingestedThreadCount: input.providerThreadIds.length,
        };
      },
      async finalizeGmailSyncActivity() {
        finalizedAfterIngestedThreads = ingestedBatches.flat().length;
        return { status: "ready", historyCursor: "9001" };
      },
    });

    assert.deepEqual(requestedPageTokens, [null, "token-2", "token-3"]);
    // 25 + 10 + 3 threads split into batches of ten.
    assert.deepEqual(
      ingestedBatches.map((batch) => batch.length).sort((a, b) => b - a),
      [10, 10, 10, 5, 3],
    );
    assert.ok(
      ingestedBatches.every(
        (batch) => batch.length <= gmailSyncThreadBatchSize,
      ),
    );
    // Finalization must observe every discovered thread already ingested.
    assert.equal(finalizedAfterIngestedThreads, 38);
    assert.deepEqual(result, {
      status: "ready",
      runId: "33333333-3333-4333-8333-333333333333",
      pagesCompleted: 3,
      threadsDiscovered: 38,
      threadsIngested: 38,
    });
  });

  test("stops without finalizing when another run takes the account", async () => {
    let finalizeCallCount = 0;

    const result = await runWorkflow({
      async syncGmailThreadPageActivity(
        input: GmailSyncPageInput,
      ): Promise<GmailSyncPageOutcome> {
        if (input.pageNumber === 2) return { status: "superseded" };
        return {
          status: "recorded",
          nextPageToken: "token-2",
          pendingThreadIds: threadPage(1, 4),
        };
      },
      async ingestGmailThreadBatchActivity(
        input: GmailSyncThreadBatchInput,
      ): Promise<GmailSyncThreadBatchOutcome> {
        return {
          status: "ingested",
          ingestedThreadCount: input.providerThreadIds.length,
        };
      },
      async finalizeGmailSyncActivity() {
        finalizeCallCount += 1;
        return { status: "ready", historyCursor: "9001" };
      },
    });

    assert.equal(finalizeCallCount, 0);
    assert.equal(result.status, "superseded");
    assert.equal(result.pagesCompleted, 1);
    assert.equal(result.threadsIngested, 4);
  });

  test("a superseded batch abandons the run before the next page", async () => {
    const requestedPageNumbers: number[] = [];

    const result = await runWorkflow({
      async syncGmailThreadPageActivity(
        input: GmailSyncPageInput,
      ): Promise<GmailSyncPageOutcome> {
        requestedPageNumbers.push(input.pageNumber);
        return {
          status: "recorded",
          nextPageToken: "token-2",
          pendingThreadIds: threadPage(1, 4),
        };
      },
      async ingestGmailThreadBatchActivity(): Promise<GmailSyncThreadBatchOutcome> {
        return { status: "superseded" };
      },
      async finalizeGmailSyncActivity() {
        throw new Error("finalization must not run for a superseded run");
      },
    });

    assert.deepEqual(requestedPageNumbers, [1]);
    assert.equal(result.status, "superseded");
    assert.equal(result.threadsIngested, 0);
  });

  test("continues as new past the page budget without losing the cursor", async () => {
    const executionPageCounts: number[] = [];
    let currentExecutionPageCount = 0;
    // Sixteen pages exceeds the twelve-page budget, so the run must span two
    // Executions and resume from the recorded cursor.
    const totalPageCount = 16;

    const result = await runWorkflow({
      async syncGmailThreadPageActivity(
        input: GmailSyncPageInput,
      ): Promise<GmailSyncPageOutcome> {
        if (input.pageNumber === 1 || input.pageToken === "token-13") {
          executionPageCounts.push(currentExecutionPageCount);
          currentExecutionPageCount = 0;
        }
        currentExecutionPageCount += 1;
        return {
          status: "recorded",
          nextPageToken:
            input.pageNumber < totalPageCount
              ? `token-${input.pageNumber + 1}`
              : null,
          pendingThreadIds: threadPage(input.pageNumber, 2),
        };
      },
      async ingestGmailThreadBatchActivity(
        input: GmailSyncThreadBatchInput,
      ): Promise<GmailSyncThreadBatchOutcome> {
        return {
          status: "ingested",
          ingestedThreadCount: input.providerThreadIds.length,
        };
      },
      async finalizeGmailSyncActivity() {
        return { status: "ready", historyCursor: "9001" };
      },
    });

    // The first Execution stops at the budget; the second finishes the mailbox.
    assert.deepEqual(executionPageCounts, [0, 12]);
    assert.deepEqual(result, {
      status: "ready",
      runId: "33333333-3333-4333-8333-333333333333",
      pagesCompleted: totalPageCount,
      threadsDiscovered: totalPageCount * 2,
      threadsIngested: totalPageCount * 2,
    });
  });
});
