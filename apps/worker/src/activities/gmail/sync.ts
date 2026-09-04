/**
 * Durable Gmail synchronization work: page discovery, thread ingestion, replay
 * finalization, message refresh, watch renewal, and account teardown.
 */
import { activityInfo } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";

import {
  completeMailSyncThread,
  completeMailSyncRun,
  completeGmailSynchronizationRecovery,
  deleteIndexedMessage,
  enqueueDailyGmailWatchRenewal,
  enqueuePendingAnalysisWorkflowSteps,
  failMailSyncThread,
  getIndexedMessageIds,
  getGmailReplicaContext,
  isMailSyncThreadComplete,
  getMailSyncRunContext,
  getMailSyncRunProviderMessageIds,
  InactiveMailSyncRunError,
  isActiveMailSyncRun,
  markGmailReplicaReady,
  markMailSyncThreadRunning,
  setGmailReplicaState,
  recordMailboxMessageBatchRefresh,
  recordMailboxMessageRefresh,
  recordMailSyncPage,
  startMailSyncRun,
  upsertMailboxThreadMessages,
  withGmailAccountControlLock,
  type GoogleCredential,
  type IndexedMessage,
  type WorkflowStepJob,
} from "@invook/database";
import {
  getGmailMessage,
  getGmailThread,
  GmailApiError,
  GOOGLE_REAUTHENTICATION_REQUIRED_ERROR_CODE,
  isGoogleReauthenticationRequired,
  listGmailThreads,
} from "@invook/gmail";
import type {
  GmailCatchUpInput,
  GmailCatchUpOutcome,
  GmailSyncFinalizeInput,
  GmailSyncFinalizeOutcome,
  GmailSyncPageInput,
  GmailSyncPageOutcome,
  GmailSyncThreadBatchInput,
  GmailSyncThreadBatchOutcome,
} from "@invook/workflows";

import { gmailContentConcurrency } from "./concurrency";
import { classifyGmailWorkflowFailure } from "./workflow-failure";
import {
  GmailConnectionInactiveError,
  runGmailConnectionCleanup,
} from "./watch-lifecycle";
import {
  assertGmailThreadBatch,
  processGmailThreadBatch,
} from "./thread-batch";
import { runDailyGmailWatchRenewal } from "./watch-renewal";

import {
  encryptionKey,
  objectStorage,
} from "../configuration";
import { getMailSyncContext } from "./connection";
import { syncGmailDraftResources } from "./drafts";
import {
  applyHistoryRange,
  catchUpGmailHistory,
} from "./history";
import {
  normalizeFullMessage,
  prepareMessage,
  storeMessage,
} from "./messages";
import {
  ensureGmailWatch,
  renewGmailWatch,
} from "./watch";
import { requiredString } from "../memory/candidates";

/**
 * Discovers one page of the mailbox and reports the threads still owed
 * ingestion.
 *
 * Temporal retries this Activity, so it re-reads the run and replica state on
 * every attempt and persists the page idempotently before returning the cursor
 * the Workflow needs to advance.
 */
export async function syncGmailThreadPageActivity(
  input: GmailSyncPageInput,
): Promise<GmailSyncPageOutcome> {
  const active = await startMailSyncRun(input.runId, input.accountId);
  if (!active) return { status: "superseded" };

  const { account, credential } = await getMailSyncContext(input.accountId);
  if (account.userId !== input.userId) return { status: "superseded" };
  if (input.pageNumber === 1) {
    const run = await getMailSyncRunContext({
      runId: input.runId,
      accountId: account.id,
    });
    if (!run) return { status: "superseded" };
    await ensureGmailWatch(account.id, credential.accessToken);
    await setGmailReplicaState({
      accountId: account.id,
      state: run.runType === "repair" ? "repairing" : "snapshotting",
    });
  }

  const page = await listGmailThreads(credential.accessToken, {
    pageToken: input.pageToken ?? undefined,
  });
  if (
    !Array.isArray(page.threads ?? []) ||
    (page.threads ?? []).some(
      (thread) => typeof thread.id !== "string" || !thread.id.trim(),
    ) ||
    (page.nextPageToken !== undefined &&
      (typeof page.nextPageToken !== "string" || !page.nextPageToken.trim()))
  ) {
    throw new Error("Gmail returned an invalid thread page.");
  }

  const recorded = await recordMailSyncPage({
    runId: input.runId,
    userId: account.userId,
    accountId: account.id,
    pageNumber: input.pageNumber,
    pageToken: input.pageToken,
    nextPageToken: page.nextPageToken ?? null,
    providerThreadIds: (page.threads ?? []).map((thread) => thread.id),
  });
  if (recorded.status === "superseded") return { status: "superseded" };
  return {
    status: "recorded",
    nextPageToken: page.nextPageToken ?? null,
    pendingThreadIds: recorded.pendingThreadIds,
  };
}

async function processInitialGmailThread(input: {
  attempt: number;
  runId: string;
  providerThreadId: string;
  account: { id: string; userId: string; email: string };
  credential: GoogleCredential;
}): Promise<{
  status: "complete" | "current" | "gone" | "inactive";
  threadId: string | null;
}> {
  const shouldProcess = await markMailSyncThreadRunning(
    input.runId,
    input.account.id,
    input.providerThreadId,
    input.attempt,
  );
  if (!shouldProcess) {
    return {
      status: (await isMailSyncThreadComplete({
        runId: input.runId,
        accountId: input.account.id,
        providerThreadId: input.providerThreadId,
      })) ? "current" : "inactive",
      threadId: null,
    };
  }
  let gmailThread;
  try {
    gmailThread = await getGmailThread(
      input.credential.accessToken,
      input.providerThreadId,
    );
  } catch (error) {
    if (!(error instanceof GmailApiError) || error.status !== 404) throw error;
    const completed = await completeMailSyncThread({
      runId: input.runId,
      providerThreadId: input.providerThreadId,
    });
    return {
      status: completed ? "gone" : "inactive",
      threadId: null,
    };
  }
  if (
    gmailThread.id !== input.providerThreadId ||
    !Array.isArray(gmailThread.messages) ||
    gmailThread.messages.length === 0
  ) {
    throw new Error("Gmail returned an invalid full thread response.");
  }
  const messages: IndexedMessage[] = [];
  try {
    for (const gmailMessage of gmailThread.messages) {
      if (gmailMessage.threadId !== input.providerThreadId) {
        throw new Error("Gmail returned a message for a different thread.");
      }
      messages.push(
        await prepareMessage({
          userId: input.account.userId,
          accountId: input.account.id,
          accountEmail: input.account.email,
          ingestionMode: "initial",
          message: await normalizeFullMessage(
            input.credential.accessToken,
            gmailMessage,
          ),
        }),
      );
    }
    const stored = await upsertMailboxThreadMessages({
      messages,
      activeRunId: input.runId,
    });
    return {
      status: "complete",
      threadId: stored.threadId,
    };
  } catch (error) {
    if (!(error instanceof InactiveMailSyncRunError)) throw error;
    return { status: "inactive", threadId: null };
  }
}

/**
 * Ingests one batch of discovered threads.
 *
 * Temporal owns retry exhaustion, so a failure here is classified only by kind:
 * a revoked credential is non-retryable and terminalizes the run, while any
 * other failure returns each thread to the queue and rethrows so the Activity's
 * retry policy governs the next attempt.
 */
export async function ingestGmailThreadBatchActivity(
  input: GmailSyncThreadBatchInput,
): Promise<GmailSyncThreadBatchOutcome> {
  assertGmailThreadBatch(input.providerThreadIds);
  if (!(await isActiveMailSyncRun({ runId: input.runId, accountId: input.accountId }))) {
    return { status: "superseded" };
  }

  const attempt = activityInfo().attempt;
  const { account, credential } = await getMailSyncContext(input.accountId);
  if (account.userId !== input.userId) return { status: "superseded" };

  const changedThreadIds: string[] = [];
  const outcome = await processGmailThreadBatch({
    providerThreadIds: input.providerThreadIds,
    concurrency: gmailContentConcurrency,
    processThread: async (providerThreadId) => {
      const result = await processInitialGmailThread({
        attempt,
        runId: input.runId,
        providerThreadId,
        account,
        credential,
      });
      if (result.threadId) changedThreadIds.push(result.threadId);
    },
  });
  await recordMailboxMessageBatchRefresh({
    userId: account.userId,
    accountId: account.id,
    threadIds: changedThreadIds,
  });

  if (outcome.failures.length > 0) {
    const reconnectFailure = outcome.failures.find((failure) =>
      isGoogleReauthenticationRequired(failure.error),
    );
    if (reconnectFailure) {
      await failMailSyncThread({
        runId: input.runId,
        providerThreadId: reconnectFailure.providerThreadId,
        attempt,
        message: GOOGLE_REAUTHENTICATION_REQUIRED_ERROR_CODE,
        terminal: true,
        reconnectRequired: true,
      });
      throw ApplicationFailure.nonRetryable(
        "gmail_reconnect_required",
        "GmailReconnectRequired",
      );
    }
    for (const failure of outcome.failures) {
      await failMailSyncThread({
        runId: input.runId,
        providerThreadId: failure.providerThreadId,
        attempt,
        message:
          failure.error instanceof Error
            ? failure.error.message
            : "Unknown worker failure",
        terminal: false,
        reconnectRequired: false,
      });
    }
    throw outcome.failures[0]?.error ?? new Error("Gmail thread batch failed.");
  }

  // A thread can report no progress because the run lost ownership mid-batch, so
  // confirm the run rather than inferring it from the per-thread outcomes.
  if (
    outcome.succeededThreadIds.length === 0 &&
    !(await isActiveMailSyncRun({ runId: input.runId, accountId: input.accountId }))
  ) {
    return { status: "superseded" };
  }
  return {
    status: "ingested",
    ingestedThreadCount: outcome.succeededThreadIds.length,
  };
}

export async function runGmailMessageRefresh(job: WorkflowStepJob) {
  if (!job.accountId) {
    throw new Error("The Gmail message refresh job has no account.");
  }
  if (job.payload.reason !== "implausible_date") {
    throw new Error("The Gmail message refresh reason is invalid.");
  }
  const providerMessageId = requiredString(
    job.payload.providerMessageId,
    "Gmail message ID",
  );
  const { account, credential } = await getMailSyncContext(job.accountId);
  let gmailMessage;
  try {
    gmailMessage = await getGmailMessage(
      credential.accessToken,
      providerMessageId,
    );
  } catch (error) {
    if (!(error instanceof GmailApiError) || error.status !== 404) throw error;
    const deleted = await deleteIndexedMessage({
      accountId: account.id,
      providerMessageId,
    });
    if (deleted.threadId) {
      await recordMailboxMessageRefresh({
        userId: account.userId,
        accountId: account.id,
        threadId: deleted.threadId,
      });
    }
    return { status: "gone", providerMessageId };
  }

  const stored = await storeMessage({
    userId: account.userId,
    accountId: account.id,
    accountEmail: account.email,
    ingestionMode: "initial",
    message: await normalizeFullMessage(credential.accessToken, gmailMessage),
  });
  await recordMailboxMessageRefresh({
    userId: account.userId,
    accountId: account.id,
    threadId: stored.threadId,
  });
  return { status: "complete", providerMessageId };
}

/**
 * Replays the history accumulated during discovery and publishes the replica.
 *
 * A repair run additionally reconciles deletions: a message absent from the
 * provider is only discoverable by differencing the run's discovered set
 * against the stored one, which incremental history can never report.
 */
export async function finalizeGmailSyncActivity(
  input: GmailSyncFinalizeInput,
): Promise<GmailSyncFinalizeOutcome> {
  return withGmailAccountControlLock(input.accountId, async () => {
    if (!(await isActiveMailSyncRun({ runId: input.runId, accountId: input.accountId }))) {
      return { status: "superseded" };
    }
    const replica = await getGmailReplicaContext(input.accountId);
    if (!replica) throw new Error("The Gmail replica state was not found.");
    const run = await getMailSyncRunContext({
      runId: input.runId,
      accountId: input.accountId,
    });
    if (!run) return { status: "superseded" };
    const { account, credential } = await getMailSyncContext(input.accountId);
    if (account.userId !== input.userId) return { status: "superseded" };
    await ensureGmailWatch(account.id, credential.accessToken);
    const replayState = run.runType === "repair" ? "repairing" : "replaying";
    await setGmailReplicaState({ accountId: account.id, state: replayState });

    if (run.runType === "repair") {
      const [providerMessageIds, storedMessageIds] = await Promise.all([
        getMailSyncRunProviderMessageIds({
          runId: input.runId,
          accountId: account.id,
        }),
        getIndexedMessageIds(account.id),
      ]);
      const providerMessageIdSet = new Set(providerMessageIds);
      for (const providerMessageId of storedMessageIds) {
        if (providerMessageIdSet.has(providerMessageId)) continue;
        await deleteIndexedMessage({
          accountId: account.id,
          providerMessageId,
        });
      }
    }

    let expectedCursor = replica.historyCursor ?? replica.initialHistoryId;
    let startHistoryId = run.startingHistoryCursor;
    let historyCursor = startHistoryId;
    for (;;) {
      const replay = await applyHistoryRange({
        accessToken: credential.accessToken,
        userId: account.userId,
        accountId: account.id,
        accountEmail: account.email,
        startHistoryId,
        expectedCursor,
        stateAfterApply: replayState,
        ingestionMode: "initial",
      });
      if (!replay.applied) {
        throw new Error("The Gmail history cursor changed during final replay.");
      }
      historyCursor = replay.historyId;
      if (!replay.pendingHistoryCursor) break;
      expectedCursor = historyCursor;
      startHistoryId = historyCursor;
    }

    await syncGmailDraftResources({
      accessToken: credential.accessToken,
      userId: account.userId,
      accountId: account.id,
      accountEmail: account.email,
      ingestionMode: "initial",
    });
    await markGmailReplicaReady({
      userId: account.userId,
      accountId: account.id,
      historyCursor,
    });

    const completed = await completeMailSyncRun({
      runId: input.runId,
      finalHistoryCursor: historyCursor,
    });
    if (!completed) return { status: "superseded" };
    return { status: "ready", historyCursor };
  });
}

/**
 * Applies everything Gmail recorded since the account's cursor.
 *
 * One pass drains every trigger that preceded it, so the Workflow signals only
 * that something changed and lets this Activity decide how much history that
 * turned out to be. A retry re-reads the cursor, so a partially applied range
 * is never applied twice.
 */
export async function catchUpGmailHistoryActivity(
  input: GmailCatchUpInput,
): Promise<GmailCatchUpOutcome> {
  return withGmailAccountControlLock(input.accountId, async () => {
    let result;
    try {
      result = await catchUpGmailHistory({
        accountId: input.accountId,
        // A retry means the previous attempt failed partway, so a replica left
        // mid-flight is resumed rather than deferred forever.
        resumeNonReady: activityInfo().attempt > 1,
      });
    } catch (error) {
      if (error instanceof GmailConnectionInactiveError) {
        return { status: "disconnected" };
      }
      if (isGoogleReauthenticationRequired(error)) {
        throw ApplicationFailure.nonRetryable(
          "gmail_reconnect_required",
          "GmailReconnectRequired",
        );
      }
      throw error;
    }

    switch (result.status) {
      case "deferred":
        return { status: "deferred" };
      case "superseded":
        return { status: "superseded" };
      case "repair_started":
        return { status: "repair_started", runId: result.runId };
      case "applied": {
        // A replica that just became ready has finished its recovery, so the
        // derived work waiting on it is released here rather than on a sweep.
        if (!result.hasPendingHistory) {
          await completeGmailSynchronizationRecovery({
            accountId: input.accountId,
            historyCursor: result.historyCursor,
          });
          await enqueuePendingAnalysisWorkflowSteps();
        }
        return {
          status: "applied",
          historyCursor: result.historyCursor,
          hasPendingHistory: result.hasPendingHistory,
          changedThreadCount: result.changedThreadCount,
        };
      }
      default: {
        const unsupported: never = result;
        throw new Error(
          `Unsupported Gmail catch-up outcome: ${JSON.stringify(unsupported)}`,
        );
      }
    }
  });
}

export async function runGmailWatchRenewal(job: WorkflowStepJob) {
  if (!job.accountId) throw new Error("The Gmail watch renewal has no account.");
  const { account, credential } = await getMailSyncContext(job.accountId);
  const renewal = await runDailyGmailWatchRenewal({
    renew: () => renewGmailWatch(account.id, credential.accessToken),
    catchUp: () => catchUpGmailHistory({
      accountId: account.id,
      resumeNonReady: job.attempts > 1,
      resumeFailedReplica: true,
    }),
    scheduleNext: (renewedWatch) => enqueueDailyGmailWatchRenewal({
      userId: account.userId,
      accountId: account.id,
      renewedAt: renewedWatch.renewedAt,
      expectedExpirationAt: renewedWatch.expirationAt,
    }),
  });
  const catchup = renewal.catchup;
  if (catchup.status === "applied") {
    await completeGmailSynchronizationRecovery({
      accountId: account.id,
      historyCursor: catchup.historyCursor,
    });
    await enqueuePendingAnalysisWorkflowSteps();
  }
  return {
    ...catchup,
    nextRenewalStepId: renewal.nextRenewalStepId,
    watchExpirationAt: renewal.watch.expirationAt.toISOString(),
  };
}

export async function runGmailAccountCleanup(job: WorkflowStepJob) {
  if (!job.accountId || !job.userId) throw new Error("The Gmail cleanup has no account owner.");
  const cleanupId = requiredString(job.payload.cleanupId, "Gmail cleanup ID");
  return runGmailConnectionCleanup({
    accountId: job.accountId, userId: job.userId, cleanupId, stepId: job.id,
  }, {
    encryptionKey,
    deleteObjects: (keys) => objectStorage.deleteObjects(keys),
    getStopAccessToken: async (accountId, database) =>
      (await getMailSyncContext(accountId, database)).credential.accessToken,
  });
}

export async function runGmailObjectDelete(job: WorkflowStepJob) {
  const manifest = job.payload.manifest;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("The Gmail object cleanup manifest is invalid.");
  }
  const objectKeys = "objectKeys" in manifest ? manifest.objectKeys : undefined;
  if (
    !Array.isArray(objectKeys) ||
    objectKeys.some((key) => typeof key !== "string" || !key.trim())
  ) {
    throw new Error("The Gmail object cleanup keys are invalid.");
  }
  await objectStorage.deleteObjects(objectKeys);
  return { objectCount: objectKeys.length };
}
