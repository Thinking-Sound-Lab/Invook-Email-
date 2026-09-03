/**
 * Durable Gmail synchronization steps: page discovery, thread batches, replay
 * finalization, watch renewal, and account teardown.
 */
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
  hasCompletedMailSyncPage,
  markGmailReplicaReady,
  markMailSyncThreadRunning,
  setGmailReplicaState,
  recordMailboxMessageBatchRefresh,
  recordMailboxMessageRefresh,
  recordMailSyncPage,
  startMailSyncRun,
  upsertMailboxThreadMessages,
  type GoogleCredential,
  type IndexedMessage,
  type WorkflowStepJob,
} from "@invook/database";
import {
  getGmailMessage,
  getGmailThread,
  GmailApiError,
  listGmailThreads,
} from "@invook/gmail";

import { gmailContentConcurrency } from "./concurrency";
import { classifyGmailWorkflowFailure } from "./workflow-failure";
import { runGmailConnectionCleanup } from "./watch-lifecycle";
import {
  parseGmailThreadBatchPayload,
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
import {
  requiredInteger,
  requiredString,
} from "../memory/candidates";

export async function runGmailPage(job: WorkflowStepJob) {
  if (!job.accountId || !job.userId || !job.runId) {
    throw new Error("The Gmail page job is missing its synchronization run.");
  }
  const runId = requiredString(job.payload.runId, "Gmail synchronization run ID");
  const pageNumber = requiredInteger(job.payload.pageNumber, "Gmail page number");
  const rawPageToken = job.payload.pageToken;
  if (
    rawPageToken !== null &&
    rawPageToken !== undefined &&
    typeof rawPageToken !== "string"
  ) {
    throw new Error("The Gmail page token is invalid.");
  }
  if (await hasCompletedMailSyncPage(runId, pageNumber)) {
    return { status: "current", runId, pageNumber };
  }

  const active = await startMailSyncRun(runId, job.accountId);
  if (!active) return { status: "inactive", runId, pageNumber };
  const { account, credential } = await getMailSyncContext(job.accountId);
  if (pageNumber === 1) {
    const run = await getMailSyncRunContext({ runId, accountId: account.id });
    if (!run) return { status: "inactive", runId, pageNumber };
    await ensureGmailWatch(account.id, credential.accessToken);
    await setGmailReplicaState({
      accountId: account.id,
      state: run.runType === "repair" ? "repairing" : "snapshotting",
    });
  }
  const page = await listGmailThreads(credential.accessToken, {
    pageToken: rawPageToken ?? undefined,
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
  const providerThreadIds = Array.from(
    new Set((page.threads ?? []).map((thread) => thread.id)),
  );
  const recorded = await recordMailSyncPage({
    runId,
    userId: account.userId,
    accountId: account.id,
    pageNumber,
    pageToken: rawPageToken ?? null,
    nextPageToken: page.nextPageToken ?? null,
    providerThreadIds,
  });
  if (!recorded) return { status: "inactive", runId, pageNumber };
  return {
    status: "complete",
    runId,
    pageNumber,
    discoveredThreadCount: providerThreadIds.length,
    hasNextPage: Boolean(page.nextPageToken),
  };
}

async function processInitialGmailThread(input: {
  job: WorkflowStepJob;
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
    input.job.attempts,
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

export async function runGmailThreadBatch(job: WorkflowStepJob) {
  if (!job.accountId || !job.runId) {
    throw new Error("The Gmail thread batch is missing its synchronization run.");
  }
  const { runId, providerThreadIds } = parseGmailThreadBatchPayload(job.payload);
  if (runId !== job.runId) {
    throw new Error("The Gmail thread batch run ID does not match its workflow.");
  }
  const { account, credential } = await getMailSyncContext(job.accountId);
  const changedThreadIds: string[] = [];
  const outcome = await processGmailThreadBatch({
    providerThreadIds,
    concurrency: gmailContentConcurrency,
    processThread: async (providerThreadId) => {
      const result = await processInitialGmailThread({
        job,
        runId,
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
    const classifiedFailures = outcome.failures.map((failure) => ({
      ...failure,
      classification: classifyGmailWorkflowFailure(failure.error, {
        attempt: job.attempts,
        maxAttempts: job.maxAttempts,
      }),
    }));
    const terminalFailure = classifiedFailures.find(
      (failure) =>
        failure.classification.isReconnectRequired ||
        failure.classification.isTerminal,
    );
    if (terminalFailure) throw terminalFailure.error;
    for (const failure of classifiedFailures) {
      await failMailSyncThread({
        runId,
        providerThreadId: failure.providerThreadId,
        attempt: job.attempts,
        message: failure.classification.persistedMessage,
        terminal: false,
        reconnectRequired: false,
      });
    }
    throw classifiedFailures[0]?.error ?? new Error("Gmail thread batch failed.");
  }
  return {
    status: "complete",
    runId,
    threadCount: providerThreadIds.length,
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

export async function runGmailFinalize(job: WorkflowStepJob) {
  if (!job.accountId || !job.runId) {
    throw new Error("The Gmail finalization job is missing its synchronization run.");
  }
  const runId = requiredString(job.payload.runId, "Gmail synchronization run ID");
  if (!(await isActiveMailSyncRun({ runId, accountId: job.accountId }))) {
    return { status: "inactive", runId };
  }
  const replica = await getGmailReplicaContext(job.accountId);
  if (!replica) throw new Error("The Gmail replica state was not found.");
  const run = await getMailSyncRunContext({ runId, accountId: job.accountId });
  if (!run) return { status: "inactive", runId };
  const { account, credential } = await getMailSyncContext(job.accountId);
  await ensureGmailWatch(account.id, credential.accessToken);
  const replayState = run.runType === "repair" ? "repairing" : "replaying";
  await setGmailReplicaState({ accountId: account.id, state: replayState });

  if (run.runType === "repair") {
    const [providerMessageIds, storedMessageIds] = await Promise.all([
      getMailSyncRunProviderMessageIds({ runId, accountId: account.id }),
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
    runId,
    finalHistoryCursor: historyCursor,
  });
  if (!completed) return { status: "inactive", runId };
  return {
    status: "complete",
    runId,
    historyCursor,
    runType: run.runType,
  };
}

export async function runGmailHistoryCatchup(job: WorkflowStepJob) {
  if (!job.accountId) throw new Error("The Gmail history job has no account.");
  const result = await catchUpGmailHistory({
    accountId: job.accountId,
    sourceStepId: job.id,
    resumeNonReady: job.attempts > 1,
  });
  if (result.status === "complete" && typeof result.historyCursor === "string") {
    await completeGmailSynchronizationRecovery({
      accountId: job.accountId,
      historyCursor: result.historyCursor,
    });
    await enqueuePendingAnalysisWorkflowSteps();
  }
  return result;
}

export async function runGmailWatchRenewal(job: WorkflowStepJob) {
  if (!job.accountId) throw new Error("The Gmail watch renewal has no account.");
  const { account, credential } = await getMailSyncContext(job.accountId);
  const renewal = await runDailyGmailWatchRenewal({
    renew: () => renewGmailWatch(account.id, credential.accessToken),
    catchUp: () => catchUpGmailHistory({
      accountId: account.id,
      sourceStepId: job.id,
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
  if (
    catchup.status === "complete" &&
    typeof catchup.historyCursor === "string"
  ) {
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
