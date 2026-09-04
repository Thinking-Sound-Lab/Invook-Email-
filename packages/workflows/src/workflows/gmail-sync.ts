import { continueAsNew, proxyActivities } from "@temporalio/workflow";

import {
  gmailSyncPagesPerExecution,
  gmailSyncThreadBatchSize,
  type GmailSyncActivities,
  type GmailSyncWorkflowInput,
  type GmailSyncWorkflowResult,
} from "../contracts/gmail-sync";

const discoveryActivityOptions = {
  startToCloseTimeout: "5 minutes",
  scheduleToCloseTimeout: "1 hour",
  retry: {
    initialInterval: "2 seconds",
    backoffCoefficient: 2,
    maximumInterval: "1 minute",
  },
} as const;

/**
 * Ingestion fetches every message of every thread in the batch, so it is given
 * a longer attempt budget than discovery and a wider retry ceiling to ride out
 * Gmail rate limiting.
 */
const ingestionActivityOptions = {
  startToCloseTimeout: "15 minutes",
  scheduleToCloseTimeout: "6 hours",
  retry: {
    initialInterval: "5 seconds",
    backoffCoefficient: 2,
    maximumInterval: "5 minutes",
  },
} as const;

const finalizeActivityOptions = {
  startToCloseTimeout: "30 minutes",
  scheduleToCloseTimeout: "6 hours",
  retry: {
    initialInterval: "5 seconds",
    backoffCoefficient: 2,
    maximumInterval: "5 minutes",
  },
} as const;

function toThreadBatches(providerThreadIds: string[]): string[][] {
  const batches: string[][] = [];
  for (
    let offset = 0;
    offset < providerThreadIds.length;
    offset += gmailSyncThreadBatchSize
  ) {
    batches.push(
      providerThreadIds.slice(offset, offset + gmailSyncThreadBatchSize),
    );
  }
  return batches;
}

/**
 * Builds an account's mailbox replica: walks `threads.list` to the end of the
 * mailbox and ingests every thread it discovers, then replays the history
 * accumulated during the walk.
 *
 * Gmail returns pages newest first. A page is persisted and fully ingested
 * before the next is requested, so the run owns its own completion gate — the
 * finalization Activity runs only once every discovered thread has been stored,
 * and a crash resumes from the recorded cursor rather than restarting the
 * mailbox.
 */
export async function gmailSyncWorkflow(
  input: GmailSyncWorkflowInput,
): Promise<GmailSyncWorkflowResult> {
  const taskQueue = input.activityTaskQueue;
  const { syncGmailThreadPageActivity } = proxyActivities<GmailSyncActivities>({
    ...discoveryActivityOptions,
    taskQueue,
  });
  const { ingestGmailThreadBatchActivity } =
    proxyActivities<GmailSyncActivities>({
      ...ingestionActivityOptions,
      taskQueue,
    });
  const { finalizeGmailSyncActivity } = proxyActivities<GmailSyncActivities>({
    ...finalizeActivityOptions,
    taskQueue,
  });

  let pageNumber = input.pageNumber;
  let pageToken = input.pageToken;
  let pagesCompleted = input.pagesCompleted;
  let threadsDiscovered = input.threadsDiscovered;
  let threadsIngested = input.threadsIngested;
  let pagesThisExecution = 0;

  const superseded = (): GmailSyncWorkflowResult => ({
    status: "superseded",
    runId: input.runId,
    pagesCompleted,
    threadsDiscovered,
    threadsIngested,
  });

  for (;;) {
    const page = await syncGmailThreadPageActivity({
      userId: input.userId,
      accountId: input.accountId,
      runId: input.runId,
      pageNumber,
      pageToken,
    });
    if (page.status === "superseded") return superseded();

    pagesCompleted += 1;
    pagesThisExecution += 1;
    threadsDiscovered += page.pendingThreadIds.length;

    // Parallelism is bounded by the page size, so a page never schedules more
    // than 50 Activities at once.
    const batches = await Promise.all(
      toThreadBatches(page.pendingThreadIds).map((providerThreadIds) =>
        ingestGmailThreadBatchActivity({
          userId: input.userId,
          accountId: input.accountId,
          runId: input.runId,
          providerThreadIds,
        }),
      ),
    );
    for (const batch of batches) {
      if (batch.status === "superseded") return superseded();
      threadsIngested += batch.ingestedThreadCount;
    }

    if (page.nextPageToken === null) break;
    pageNumber += 1;
    pageToken = page.nextPageToken;

    // Continue-As-New only with work left, so the final page never starts an
    // Execution that would immediately finalize.
    if (pagesThisExecution >= gmailSyncPagesPerExecution) {
      await continueAsNew<typeof gmailSyncWorkflow>({
        userId: input.userId,
        accountId: input.accountId,
        runId: input.runId,
        activityTaskQueue: input.activityTaskQueue,
        pageNumber,
        pageToken,
        pagesCompleted,
        threadsDiscovered,
        threadsIngested,
      });
    }
  }

  const finalized = await finalizeGmailSyncActivity({
    userId: input.userId,
    accountId: input.accountId,
    runId: input.runId,
  });
  return {
    status: finalized.status === "ready" ? "ready" : "superseded",
    runId: input.runId,
    pagesCompleted,
    threadsDiscovered,
    threadsIngested,
  };
}
