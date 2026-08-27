import { activityInfo } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";

import {
  AiConfigurationError,
  deleteMemoryBatchFiles,
  extractFeedbackMemories,
  getThreadLabelBatchState,
  isAnyMemoryBatchProviderConfigured,
  isAiConfigured,
  isMemoryBatchConfigured,
  isMemoryBatchProviderConfigured,
  isThreadLabelBatchConfigured,
  batchProviders,
  MemoryBatchConfigurationError,
  readMemoryBatch,
  submitMemoryBatch,
  type FeedbackMemoryCandidate,
  type MemoryAnalysisThread,
  type MemoryBatchManifestEntry,
  type BatchProvider,
  type MessageMemoryCandidate,
} from "@invook/ai";
import {
  clearPendingMemoryEvidence,
  applyGmailHistoryBatch,
  completeMailSyncThread,
  completeMailSyncRun,
  completeGmailSynchronizationRecovery,
  deleteIndexedMessage,
  completeWorkflowStep,
  decryptGoogleCredential,
  deleteExpiredLabelPreviewReceipts,
  DRAFT_FEEDBACK_VERSION,
  encryptGoogleCredential,
  enqueueDailyGmailWatchRenewal,
  ensureDailyGmailWatchRenewals,
  enqueuePendingAnalysisWorkflowSteps,
  enqueueBatchEvent,
  enqueueMemoryBatchRetry,
  enqueueMissingMailSyncRuns,
  enqueueImplausibleGmailMessageDateRepairs,
  enqueueFailedInitialGmailRepairRecoveries,
  enqueuePendingGmailHistoryCatchups,
  enqueuePostSyncWorkflowSteps,
  enqueueReadyMailSyncFinalizers,
  enqueueStartupThreadLabelBatchSubmissions,
  enqueueInitialSyncLiveThreadLabelAnalyses,
  enqueueInitialThreadLabelBatchIfReady,
  enqueueThreadLabelBatchSubmission,
  failMailSyncThread,
  failWorkflowStep,
  getIndexedMessageIds,
  getDraftFeedbackSamples,
  getMemoryAnalysisThreads,
  getUserAuthoredMemories,
  getWorkerAccount,
  getGmailReplicaContext,
  getGmailWatchContext,
  getActiveRepairMailSyncRunContext,
  isMailSyncThreadComplete,
  getMailSyncRunContext,
  getMailSyncRunProviderMessageIds,
  getStoredProviderMessageIds,
  InactiveMailSyncRunError,
  isActiveMailSyncRun,
  getBatchSubmission,
  hasCompletedMailSyncPage,
  listenForTemporalCommandNotifications,
  listActiveTemporalTenantIds,
  listGmailObjectKeysForAccount,
  markGmailAccountCleanupRunning,
  listSubmittedThreadLabelBatchIds,
  markGmailReplicaReady,
  markMailSyncThreadRunning,
  markWorkflowStepRunning,
  MEMORY_SCHEMA_VERSION,
  markDraftFeedbackAnalyzed,
  saveExtractedMemories,
  saveGmailWatchState,
  saveGmailDraftResource,
  deleteGmailDraftResourceByMessageId,
  setGmailReplicaState,
  setMemorySyncStage,
  toPostgresTextProjection,
  dispatchTemporalCommandBatch,
  createRepairMailSyncRun,
  replaceGmailDraftResources,
  recordMailboxMessageBatchRefresh,
  recordMailboxMessageRefresh,
  recordMailSyncPage,
  requeueRetryableThreadLabelBatchFailures,
  startMailSyncRun,
  updateStoredCredential,
  upsertMailboxMessage,
  upsertMailboxThreadMessages,
  withGmailAccountControlLock,
  type GoogleCredential,
  type IndexedMessage,
  type MemoryType,
  type WorkflowStepJob,
} from "@invook/database";
import {
  extractEmailAddress,
  gmailHistoryChanges,
  gmailSystemLabels,
  getGmailAttachment,
  getGmailDraft,
  getGmailMessage,
  getGmailMessageState,
  getGmailProfile,
  getGmailThread,
  GMAIL_MESSAGE_FUTURE_TOLERANCE_MS,
  GmailApiError,
  isMemoryEligible,
  listGmailDrafts,
  listGmailHistory,
  listGmailThreads,
  normalizeGmailFullMessage,
  parseGmailMessage,
  refreshGoogleAccessToken,
  startGmailWatch,
  stopGmailWatch,
  type ParsedGmailMessage,
} from "@invook/gmail";
import { createObjectStorage } from "@invook/object-storage";
import type {
  WorkflowStepExecution,
  WorkflowStepResult,
} from "@invook/workflows";

import {
  gmailContentConcurrency,
  parseNonNegativeInteger,
  TemporalRuntime,
} from "./temporal-runtime";
import { classifyGmailWorkflowFailure } from "./gmail-workflow-failure";
import {
  parseGmailThreadBatchPayload,
  processGmailThreadBatch,
} from "./gmail-thread-batch";
import {
  applyGmailHistoryWithExpiredCursorRepair,
  shouldRepairNonReadyGmailReplica,
} from "./gmail-history-recovery";
import {
  gmailHistoryCatchupDisposition,
  planGmailHistoryCatchup,
} from "./gmail-history-catchup";
import { runDailyGmailWatchRenewal } from "./gmail-watch-renewal";
import {
  failTerminalThreadLabelAnalysis,
  isThreadLabelWorkflowStep,
  runLabelSubmission,
  threadLabelAnalysisErrorCode,
} from "./thread-label-analysis";
import { terminateWorkerAfterFatalError } from "./process-lifecycle";
import {
  runThreadLabelBatchEvent,
  runThreadLabelBatchSubmission,
} from "./thread-label-batch";

const encryptionKey = process.env.TOKEN_ENCRYPTION_KEY ?? "";
const googleClientId = process.env.GMAIL_GOOGLE_CLIENT_ID ?? "";
const googleClientSecret = process.env.GMAIL_GOOGLE_CLIENT_SECRET ?? "";
const mailLabelHotWindowDays = parseNonNegativeInteger(
  process.env.MAIL_LABEL_HOT_WINDOW_DAYS,
  14,
  "MAIL_LABEL_HOT_WINDOW_DAYS",
);
const mailLabelHotWindowMaxThreads = parseNonNegativeInteger(
  process.env.MAIL_LABEL_HOT_WINDOW_MAX_THREADS,
  1_000,
  "MAIL_LABEL_HOT_WINDOW_MAX_THREADS",
);
const feedbackBatchSize = 24;
const credentialRenewalWindowMs = 5 * 60 * 1_000;
const objectStorage = createObjectStorage();
const terminalProviderBatchStates = new Set([
  "completed",
  "failed",
  "expired",
  "cancelled",
]);

function createJobSignal() {
  let pending = false;
  let release: (() => void) | null = null;

  return {
    notify() {
      pending = true;
      if (release) {
        const currentRelease = release;
        release = null;
        currentRelease();
      }
    },
    wait() {
      if (pending) {
        pending = false;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        release = () => {
          pending = false;
          resolve();
        };
      });
    },
  };
}

function normalizedEmails(values: string[], ownerEmail: string): string[] {
  return Array.from(
    new Set(
      values
        .map(extractEmailAddress)
        .filter((email) => email.includes("@") && email !== ownerEmail.toLowerCase()),
    ),
  );
}

async function refreshCredentialIfRequired(
  accountId: string,
  credential: GoogleCredential,
): Promise<GoogleCredential> {
  const expiresSoon =
    Date.parse(credential.expiresAt) <= Date.now() + credentialRenewalWindowMs;
  if (!expiresSoon) return credential;

  if (!googleClientId || !googleClientSecret) {
    throw new Error(
      "The worker needs GMAIL_GOOGLE_CLIENT_ID and GMAIL_GOOGLE_CLIENT_SECRET to refresh Gmail access.",
    );
  }

  const refreshed = await refreshGoogleAccessToken({
    refreshToken: credential.refreshToken,
    clientId: googleClientId,
    clientSecret: googleClientSecret,
  });
  const nextCredential: GoogleCredential = {
    ...credential,
    accessToken: refreshed.accessToken,
    expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000).toISOString(),
    scopes: refreshed.scope?.split(" ").filter(Boolean) ?? credential.scopes,
  };

  await updateStoredCredential(
    accountId,
    encryptGoogleCredential(nextCredential, encryptionKey),
  );

  return nextCredential;
}

async function prepareMessage(options: {
  userId: string;
  accountId: string;
  accountEmail: string;
  message: ParsedGmailMessage;
  ingestionMode: "initial" | "incremental";
  isLiveDelivery?: boolean;
}): Promise<IndexedMessage> {
  const { userId, accountId, accountEmail, message, ingestionMode } = options;
  const direction =
    message.labelIds.includes("SENT") ||
    extractEmailAddress(message.from) === accountEmail.toLowerCase()
      ? "outgoing"
      : "incoming";
  const sentAt = options.message.sentAt
    ? new Date(options.message.sentAt)
    : null;
  const internalDate = sentAt;
  if (
    !internalDate ||
    !sentAt ||
    !Number.isFinite(internalDate.getTime()) ||
    !Number.isFinite(sentAt.getTime())
  ) {
    throw new Error(
      `Gmail message ${message.providerMessageId} has no usable internal or sent date.`,
    );
  }

  const attachments = await Promise.all(
    message.attachments.map(async (attachment) => {
      const attachmentObject = await objectStorage.putObject({
        key: `${accountId}/messages/${message.providerMessageId}/attachments/${attachment.index}-${attachment.checksumSha256}`,
        body: attachment.content,
        contentType: attachment.mimeType,
      });
      return {
        providerAttachmentId: attachment.providerAttachmentId,
        mimePartPath: attachment.mimePartPath
          ? toPostgresTextProjection(attachment.mimePartPath)
          : null,
        filename: toPostgresTextProjection(attachment.filename ?? ""),
        mimeType: attachment.mimeType
          ? toPostgresTextProjection(attachment.mimeType)
          : null,
        contentId: attachment.contentId
          ? toPostgresTextProjection(attachment.contentId)
          : null,
        contentDisposition: attachment.contentDisposition
          ? toPostgresTextProjection(attachment.contentDisposition)
          : null,
        size: attachment.size,
        objectKey: attachmentObject.key,
        checksumSha256: attachmentObject.checksumSha256,
        contentLength: attachmentObject.contentLength,
        etag: attachmentObject.etag,
      };
    }),
  );
  return {
    userId,
    accountId,
    providerThreadId: message.providerThreadId,
    providerMessageId: message.providerMessageId,
    subject: toPostgresTextProjection(message.subject),
    snippet: toPostgresTextProjection(message.snippet),
    participants: [message.from, ...message.to, ...message.cc]
      .filter(Boolean)
      .map(toPostgresTextProjection),
    gmailLabels: gmailSystemLabels(message.labelIds),
    providerHistoryId: message.historyId,
    internalDate,
    sizeEstimate: message.sizeEstimate,
    headerLines: message.headers.map((header) => ({
      key: toPostgresTextProjection(header.name),
      line: toPostgresTextProjection(header.raw),
    })),
    sentAt,
    direction,
    sender: {
      raw: toPostgresTextProjection(message.from),
      email: toPostgresTextProjection(extractEmailAddress(message.from)),
    },
    recipients: [...message.to, ...message.cc].map(toPostgresTextProjection),
    bodyText: toPostgresTextProjection(message.bodyText ?? ""),
    bodyHtml: message.bodyHtml
      ? toPostgresTextProjection(message.bodyHtml)
      : null,
    isMemoryEligible: direction === "outgoing" && isMemoryEligible(message),
    ingestionMode,
    isLiveDelivery: options.isLiveDelivery,
    memoryContactEmails: normalizedEmails(
      [message.from, ...message.to, ...message.cc],
      accountEmail,
    ).map(toPostgresTextProjection),
    attachments,
  };
}

async function normalizeFullMessage(
  accessToken: string,
  message: Parameters<typeof normalizeGmailFullMessage>[0],
): Promise<ParsedGmailMessage> {
  return normalizeGmailFullMessage(message, ({ messageId, attachmentId }) =>
    getGmailAttachment(accessToken, messageId, attachmentId),
  );
}

async function storeMessage(
  options: Parameters<typeof prepareMessage>[0] & {
    activeRunId?: string;
  },
) {
  const { activeRunId, ...messageOptions } = options;
  const message = await prepareMessage(messageOptions);
  return upsertMailboxMessage(message, undefined, activeRunId);
}

async function syncGmailDraftResources(options: {
  accessToken: string;
  userId: string;
  accountId: string;
  accountEmail: string;
  ingestionMode: "initial" | "incremental";
  notify?: boolean;
}) {
  let pageToken: string | undefined;
  const drafts: Array<{
    providerDraftId: string;
    providerMessageId: string;
    providerThreadId: string;
    providerHistoryId: string | null;
    providerMetadata: Record<string, unknown>;
  }> = [];
  do {
    const page = await listGmailDrafts(options.accessToken, {
      maxResults: 100,
      pageToken,
    });
    for (const reference of page.drafts ?? []) {
      const draft = await getGmailDraft(options.accessToken, reference.id);
      const parsed = await parseGmailMessage(draft.message);
      await storeMessage({
        userId: options.userId,
        accountId: options.accountId,
        accountEmail: options.accountEmail,
        message: parsed,
        ingestionMode: options.ingestionMode,
      });
      drafts.push({
        providerDraftId: draft.id,
        providerMessageId: draft.message.id,
        providerThreadId: draft.message.threadId,
        providerHistoryId: draft.message.historyId ?? null,
        providerMetadata: {
          labelIds: parsed.labelIds,
          snippet: draft.message.snippet ?? null,
          internalDate: draft.message.internalDate ?? null,
          sizeEstimate: draft.message.sizeEstimate ?? null,
        },
      });
    }
    pageToken = page.nextPageToken;
  } while (pageToken);

  await replaceGmailDraftResources({
    userId: options.userId,
    accountId: options.accountId,
    drafts,
    notify: options.notify,
  });
  return drafts;
}

async function refreshAffectedGmailDraftResources(options: {
  accessToken: string;
  userId: string;
  accountId: string;
  accountEmail: string;
  providerMessageIds: string[];
  ingestionMode: "initial" | "incremental";
}) {
  const affectedProviderMessageIds = new Set(options.providerMessageIds);
  if (affectedProviderMessageIds.size === 0) return;

  let pageToken: string | undefined;
  const draftsByMessageId = new Map<
    string,
    { providerDraftId: string; providerMessageId: string }
  >();
  do {
    const page = await listGmailDrafts(options.accessToken, {
      maxResults: 100,
      pageToken,
    });
    for (const reference of page.drafts ?? []) {
      if (affectedProviderMessageIds.has(reference.message.id)) {
        draftsByMessageId.set(reference.message.id, {
          providerDraftId: reference.id,
          providerMessageId: reference.message.id,
        });
      }
    }
    pageToken = page.nextPageToken;
  } while (pageToken);

  for (const providerMessageId of affectedProviderMessageIds) {
    const reference = draftsByMessageId.get(providerMessageId);
    if (!reference) {
      await deleteGmailDraftResourceByMessageId({
        userId: options.userId,
        accountId: options.accountId,
        providerMessageId,
      });
      continue;
    }
    const draft = await getGmailDraft(options.accessToken, reference.providerDraftId);
    const parsed = await parseGmailMessage(draft.message);
    await storeMessage({
      userId: options.userId,
      accountId: options.accountId,
      accountEmail: options.accountEmail,
      message: parsed,
      ingestionMode: options.ingestionMode,
    });
    await saveGmailDraftResource({
      userId: options.userId,
      accountId: options.accountId,
      notify: true,
      draft: {
        providerDraftId: draft.id,
        providerMessageId: draft.message.id,
        providerThreadId: draft.message.threadId,
        providerHistoryId: draft.message.historyId ?? null,
        providerMetadata: {
          labelIds: parsed.labelIds,
          snippet: draft.message.snippet ?? null,
          internalDate: draft.message.internalDate ?? null,
          sizeEstimate: draft.message.sizeEstimate ?? null,
        },
      },
    });
  }
}

async function applyHistoryRange(options: {
  accessToken: string;
  userId: string;
  accountId: string;
  accountEmail: string;
  startHistoryId: string;
  expectedCursor: string;
  stateAfterApply?: "ready" | "snapshotting" | "replaying" | "repairing";
  continuationSourceStepId?: string;
  ingestionMode: "initial" | "incremental";
  isLiveDelivery?: boolean;
}) {
  let pageToken: string | undefined;
  let historyId = options.startHistoryId;
  const messageActions = new Map<
    string,
    {
      action: "upsert" | "labels" | "delete";
      providerHistoryId: string | null;
      gmailLabels: ReturnType<typeof gmailSystemLabels> | null;
      isDraftRelated: boolean;
    }
  >();
  const actionPrecedence = { labels: 1, upsert: 2, delete: 3 } as const;

  do {
    const page = await listGmailHistory(options.accessToken, {
      startHistoryId: options.startHistoryId,
      maxResults: 500,
      pageToken,
    });
    for (const history of page.history ?? []) {
      for (const change of gmailHistoryChanges(history)) {
        const current = messageActions.get(change.messageId);
        messageActions.set(change.messageId, {
          action:
            current && actionPrecedence[current.action] > actionPrecedence[change.action]
              ? current.action
              : change.action,
          providerHistoryId: history.id ?? null,
          gmailLabels: change.providerLabelIds
            ? gmailSystemLabels(change.providerLabelIds)
            : current?.gmailLabels ?? null,
          isDraftRelated: change.isDraftRelated || (current?.isDraftRelated ?? false),
        });
      }
    }
    if (page.historyId) historyId = page.historyId;
    pageToken = page.nextPageToken;
  } while (pageToken);

  const deletedMessageIds = Array.from(messageActions)
    .filter(([, change]) => change.action === "delete")
    .map(([providerMessageId, change]) => ({
      providerMessageId,
      providerHistoryId: change.providerHistoryId,
    }));
  const upsertIds = Array.from(messageActions)
    .filter(([, change]) => change.action === "upsert")
    .map(([messageId]) => messageId);
  const labelActionIds = Array.from(messageActions)
    .filter(([, change]) => change.action === "labels")
    .map(([messageId]) => messageId);
  const storedLabelActionIds = new Set(
    await getStoredProviderMessageIds({
      accountId: options.accountId,
      providerMessageIds: labelActionIds,
    }),
  );
  for (const providerMessageId of labelActionIds) {
    if (!storedLabelActionIds.has(providerMessageId)) upsertIds.push(providerMessageId);
  }

  const labelChanges: Array<{
    providerMessageId: string;
    providerHistoryId: string | null;
    gmailLabels: ReturnType<typeof gmailSystemLabels>;
  }> = [];
  for (const providerMessageId of labelActionIds) {
    if (!storedLabelActionIds.has(providerMessageId)) continue;
    const change = messageActions.get(providerMessageId);
    if (!change) continue;
    let gmailLabels = change.gmailLabels;
    if (!gmailLabels) {
      try {
        gmailLabels = gmailSystemLabels(
          (await getGmailMessageState(options.accessToken, providerMessageId))
            .labelIds,
        );
      } catch (error) {
        if (!(error instanceof GmailApiError) || error.status !== 404) throw error;
        deletedMessageIds.push({
          providerMessageId,
          providerHistoryId: change.providerHistoryId,
        });
        continue;
      }
    }
    labelChanges.push({
      providerMessageId,
      providerHistoryId: change.providerHistoryId,
      gmailLabels,
    });
  }

  const messages: IndexedMessage[] = [];
  for (let start = 0; start < upsertIds.length; start += gmailContentConcurrency) {
    const batch = upsertIds.slice(start, start + gmailContentConcurrency);
    const gmailMessages = await Promise.all(
      batch.map(async (messageId) => {
        try {
          return {
            messageId,
            message: await getGmailMessage(options.accessToken, messageId),
          };
        } catch (error) {
          if (error instanceof GmailApiError && error.status === 404) {
            return { messageId, message: null };
          }
          throw error;
        }
      }),
    );
    for (const gmailMessage of gmailMessages) {
      if (!gmailMessage.message) {
        deletedMessageIds.push({
          providerMessageId: gmailMessage.messageId,
          providerHistoryId:
            messageActions.get(gmailMessage.messageId)?.providerHistoryId ?? null,
        });
        continue;
      }
      messages.push(
        await prepareMessage({
          userId: options.userId,
          accountId: options.accountId,
          accountEmail: options.accountEmail,
          message: await normalizeFullMessage(
            options.accessToken,
            gmailMessage.message,
          ),
          ingestionMode: options.ingestionMode,
          isLiveDelivery: options.isLiveDelivery,
        }),
      );
    }
  }

  const applied = await applyGmailHistoryBatch({
    userId: options.userId,
    accountId: options.accountId,
    expectedCursor: options.expectedCursor,
    nextCursor: historyId,
    messages,
    labelChanges,
    deletedMessageIds,
    stateAfterApply: options.stateAfterApply,
    continuationSourceStepId: options.continuationSourceStepId,
  });
  if (applied.applied) {
    await refreshAffectedGmailDraftResources({
      accessToken: options.accessToken,
      userId: options.userId,
      accountId: options.accountId,
      accountEmail: options.accountEmail,
      providerMessageIds: Array.from(messageActions)
        .filter(([, change]) => change.isDraftRelated)
        .map(([providerMessageId]) => providerMessageId),
      ingestionMode: options.ingestionMode,
    });
  }
  return { ...applied, historyId };
}

async function getMailSyncContext(accountId: string) {
  const account = await getWorkerAccount(accountId);
  if (!account) {
    throw new Error("The connected Gmail account or credential was not found.");
  }
  const storedCredential = decryptGoogleCredential(account.tokenCiphertext, encryptionKey);
  const credential = await refreshCredentialIfRequired(accountId, storedCredential);
  return { account, credential };
}

async function runGmailPage(job: WorkflowStepJob) {
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

async function runGmailThreadBatch(job: WorkflowStepJob) {
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
  // Hot-window threads reserve the live lane before Batch admission runs, so
  // recent inbox threads get labels without waiting on an OpenAI Batch. This
  // runs before failure classification so partial batches still label.
  let hotWindowEnqueuedCount = 0;
  if (
    mailLabelHotWindowDays > 0 &&
    isAiConfigured() &&
    changedThreadIds.length > 0
  ) {
    const hotWindow = await enqueueInitialSyncLiveThreadLabelAnalyses({
      runId,
      userId: account.userId,
      accountId: account.id,
      threadIds: changedThreadIds,
      hotWindowDays: mailLabelHotWindowDays,
      maxThreads: mailLabelHotWindowMaxThreads,
    });
    if (hotWindow.status === "enqueued") {
      hotWindowEnqueuedCount = hotWindow.enqueuedCount;
    }
  }
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
  const labelBatchAdmission = await enqueueInitialThreadLabelBatchIfReady({
    runId,
    userId: account.userId,
    accountId: account.id,
    sourceKey: `gmail-thread-storage:${job.id}`,
  });
  return {
    status: "complete",
    runId,
    threadCount: providerThreadIds.length,
    hotWindowLiveLabelCount: hotWindowEnqueuedCount,
    labelBatchAdmission: labelBatchAdmission.status,
  };
}

async function runGmailMessageRefresh(job: WorkflowStepJob) {
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

function gmailPubSubTopic(): string {
  const topicName = process.env.GMAIL_PUBSUB_TOPIC?.trim();
  if (!topicName) {
    throw new Error("GMAIL_PUBSUB_TOPIC is required for Gmail watch state.");
  }
  return topicName;
}

async function renewGmailWatch(accountId: string, accessToken: string) {
  const topicName = gmailPubSubTopic();
  const watch = await startGmailWatch(accessToken, { topicName });
  const expiration = Number(watch.expiration);
  if (!Number.isFinite(expiration)) {
    throw new Error("Gmail returned an invalid watch expiration.");
  }
  const renewedAt = new Date();
  const expirationAt = new Date(expiration);
  await saveGmailWatchState({
    accountId,
    watch: {
      topicName,
      historyId: watch.historyId,
      expirationAt,
    },
    renewedAt,
  });
  return { historyId: watch.historyId, expirationAt, renewedAt };
}

async function ensureGmailWatch(accountId: string, accessToken: string) {
  const watch = await getGmailWatchContext(accountId);
  if (watch?.status === "active" && watch.expirationAt.getTime() > Date.now()) {
    return;
  }
  await renewGmailWatch(accountId, accessToken);
}

async function repairExpiredHistory(options: {
  accessToken: string;
  userId: string;
  accountId: string;
}) {
  const baseline = await getGmailProfile(options.accessToken);
  await renewGmailWatch(options.accountId, options.accessToken);
  const runId = await createRepairMailSyncRun({
    userId: options.userId,
    accountId: options.accountId,
    startingHistoryCursor: baseline.historyId,
  });
  return { runId, startingHistoryCursor: baseline.historyId };
}

async function catchUpGmailHistory(options: {
  accountId: string;
  sourceStepId: string;
  resumeNonReady?: boolean;
  resumeFailedReplica?: boolean;
}) {
  const replica = await getGmailReplicaContext(options.accountId);
  if (!replica) throw new Error("The Gmail replica state was not found.");
  const activeRepairRun =
    replica.state === "repairing"
      ? await getActiveRepairMailSyncRunContext(options.accountId)
      : null;
  const plan = planGmailHistoryCatchup({
    replicaState: replica.state,
    initialHistoryId: replica.initialHistoryId,
    historyCursor: replica.historyCursor,
    repairStartingHistoryCursor: activeRepairRun?.startingHistoryCursor,
  });
  if (plan.kind === "defer") {
    if (shouldRepairNonReadyGmailReplica({
      isFailed: replica.state === "failed",
      resumeNonReady: options.resumeNonReady,
      resumeFailedReplica: options.resumeFailedReplica,
    })) {
      const { account, credential } = await getMailSyncContext(options.accountId);
      const repair = await repairExpiredHistory({
        accessToken: credential.accessToken,
        userId: account.userId,
        accountId: account.id,
      });
      return { status: "repair_queued", ...repair, changedThreadCount: 0 };
    }
    return {
      status: "deferred",
      state: plan.state,
      historyCursor: replica.historyCursor,
    };
  }
  const { account, credential } = await getMailSyncContext(options.accountId);
  const apply = () =>
    applyHistoryRange({
      accessToken: credential.accessToken,
      userId: account.userId,
      accountId: account.id,
      accountEmail: account.email,
      startHistoryId: plan.startHistoryId,
      expectedCursor: plan.expectedCursor,
      stateAfterApply: plan.stateAfterApply,
      ingestionMode: plan.ingestionMode,
      isLiveDelivery: true,
      continuationSourceStepId: options.sourceStepId,
    });
  const replayOrRepair = plan.shouldRepairExpiredCursor
    ? await applyGmailHistoryWithExpiredCursorRepair({
        apply,
        repair: () =>
          repairExpiredHistory({
            accessToken: credential.accessToken,
            userId: account.userId,
            accountId: account.id,
          }),
      })
    : { outcome: "applied" as const, result: await apply() };
  if (replayOrRepair.outcome === "repaired") {
    return {
      status: "repair_queued",
      ...replayOrRepair.result,
      changedThreadCount: 0,
    };
  }
  const replay = replayOrRepair.result;
  const disposition = gmailHistoryCatchupDisposition(replay);
  if (disposition === "superseded") {
    return {
      status: "superseded",
      historyCursor: replay.historyId,
      changedThreadCount: 0,
    };
  }
  if (replay.changedThreadIds.length > 0) {
    await enqueueThreadLabelBatchSubmission({
      userId: account.userId,
      accountId: account.id,
      sourceKey: `gmail-history:${options.sourceStepId}:${replay.historyId}`,
      flushRemainder: true,
    });
  }
  if (disposition === "continue_durably") {
    const pendingHistoryCursor = replay.pendingHistoryCursor;
    if (!pendingHistoryCursor) {
      throw new Error("The Gmail history continuation cursor is missing.");
    }
    const continuationStepId = replay.continuationStepId;
    if (!continuationStepId) {
      throw new Error("The Gmail history continuation step is missing.");
    }
    return {
      status: "continued",
      historyCursor: replay.historyId,
      pendingHistoryCursor,
      continuationStepId,
      changedThreadCount: replay.changedThreadIds.length,
    };
  }
  return {
    status: plan.stateAfterApply === "ready" ? "complete" : "live_applied",
    historyCursor: replay.historyId,
    changedThreadCount: replay.changedThreadIds.length,
  };
}

async function runGmailFinalize(job: WorkflowStepJob) {
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
  await enqueueThreadLabelBatchSubmission({
    userId: account.userId,
    accountId: account.id,
    sourceKey: `gmail-finalize:${runId}`,
    flushRemainder: true,
  });
  return {
    status: "complete",
    runId,
    historyCursor,
    runType: run.runType,
  };
}

async function runGmailHistoryCatchup(job: WorkflowStepJob) {
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

async function runGmailWatchRenewal(job: WorkflowStepJob) {
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

async function runGmailAccountCleanup(job: WorkflowStepJob) {
  if (!job.accountId) throw new Error("The Gmail cleanup has no account.");
  const cleanupId = requiredString(job.payload.cleanupId, "Gmail cleanup ID");
  await markGmailAccountCleanupRunning(cleanupId);
  const account = await getWorkerAccount(job.accountId);
  if (account) {
    const credential = decryptGoogleCredential(account.tokenCiphertext, encryptionKey);
    try {
      await stopGmailWatch(credential.accessToken);
    } catch (error) {
      if (
        !(error instanceof GmailApiError) ||
        ![400, 401, 403, 404].includes(error.status)
      ) {
        throw error;
      }
    }
  }
  const objectKeys = await listGmailObjectKeysForAccount(job.accountId);
  await objectStorage.deleteObjects(objectKeys);
  return { objectCount: objectKeys.length };
}

async function runGmailObjectDelete(job: WorkflowStepJob) {
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

type StoredMemoryThread = Awaited<ReturnType<typeof getMemoryAnalysisThreads>>[number];

type MemorySubmissionResult = {
  provider: BatchProvider;
  providerBatchId: string;
  inputFileId: string;
  modelId: string;
  requestCount: number;
  manifest: MemoryBatchManifestEntry[];
  batchAttempt: number;
  rootSubmissionJobId: string;
  replaceExisting: boolean;
  pendingScope: {
    mode: "global" | "contact";
    contactEmail: string | null;
  } | null;
};

function toMemoryAnalysisThreads(
  threads: StoredMemoryThread[],
  ownerEmail: string,
): MemoryAnalysisThread[] {
  return threads.map((thread) => ({
    id: thread.id,
    subject: thread.subject,
    messages: thread.messages.map((message) => ({
      id: message.id,
      direction: message.direction,
      sender: extractEmailAddress(message.sender.raw || message.sender.email),
      recipients: normalizedEmails(message.recipients, ownerEmail),
      bodyText: message.bodyText,
      sentAt: message.sentAt.toISOString(),
      ownerEvidence: message.ownerEvidence,
    })),
  }));
}

function parseManifest(value: unknown): MemoryBatchManifestEntry[] {
  if (!Array.isArray(value)) throw new Error("The Memory batch manifest is missing.");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") {
      throw new Error("The Memory batch manifest is invalid.");
    }
    const key = "key" in entry ? entry.key : undefined;
    const mode = "mode" in entry ? entry.mode : undefined;
    const contactEmail = "contactEmail" in entry ? entry.contactEmail : undefined;
    const messageIds = "messageIds" in entry ? entry.messageIds : undefined;
    if (
      typeof key !== "string" ||
      (mode !== "global" && mode !== "contact") ||
      (contactEmail !== null && typeof contactEmail !== "string") ||
      !Array.isArray(messageIds) ||
      messageIds.some((id) => typeof id !== "string")
    ) {
      throw new Error("The Memory batch manifest is invalid.");
    }
    if (mode === "contact" && !contactEmail) {
      throw new Error("A contact Memory batch scope has no contact address.");
    }
    if (mode === "global" && contactEmail !== null) {
      throw new Error("A global Memory batch scope cannot have a contact address.");
    }
    return { key, mode, contactEmail, messageIds };
  });
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is missing from the batch job.`);
  }
  return value;
}

function requiredInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} is invalid in the batch job.`);
  }
  return value;
}

function parseSubmissionResult(value: unknown): MemorySubmissionResult | null {
  if (!value || typeof value !== "object") {
    throw new Error("The Memory Batch submission result is missing.");
  }
  const result = value as Record<string, unknown>;
  if (!batchProviders.includes(result.provider as BatchProvider)) {
    return null;
  }
  const provider = result.provider as BatchProvider;
  if (typeof result.replaceExisting !== "boolean") {
    throw new Error("The Memory Batch replacement state is missing.");
  }
  let pendingScope: MemorySubmissionResult["pendingScope"] = null;
  if (result.pendingScope !== null && result.pendingScope !== undefined) {
    if (!result.pendingScope || typeof result.pendingScope !== "object") {
      throw new Error("The incremental Memory scope is invalid.");
    }
    const mode = "mode" in result.pendingScope ? result.pendingScope.mode : undefined;
    const contactEmail =
      "contactEmail" in result.pendingScope
        ? result.pendingScope.contactEmail
        : undefined;
    if (
      (mode !== "global" && mode !== "contact") ||
      (mode === "global" && contactEmail !== null) ||
      (mode === "contact" &&
        (typeof contactEmail !== "string" || !contactEmail.trim()))
    ) {
      throw new Error("The incremental Memory scope is invalid.");
    }
    pendingScope = {
      mode,
      contactEmail: mode === "contact" ? String(contactEmail) : null,
    };
  }
  const manifest = parseManifest(result.manifest);
  const requestCount = requiredInteger(
    result.requestCount,
    "Memory Batch request count",
  );
  if (
    manifest.length !== requestCount ||
    new Set(manifest.map((entry) => entry.key)).size !== manifest.length
  ) {
    throw new Error(
      "The Memory Batch manifest does not match its request count.",
    );
  }
  return {
    provider,
    providerBatchId: requiredString(
      result.providerBatchId,
      "provider batch ID",
    ),
    inputFileId: requiredString(result.inputFileId, "provider input file"),
    modelId: requiredString(result.modelId, "Memory Batch model"),
    requestCount,
    manifest,
    batchAttempt: requiredInteger(
      result.batchAttempt,
      "Memory Batch attempt",
    ),
    rootSubmissionJobId: requiredString(
      result.rootSubmissionJobId,
      "Root Memory submission job ID",
    ),
    replaceExisting: result.replaceExisting,
    pendingScope,
  };
}

function deduplicateCandidates(candidates: MessageMemoryCandidate[]) {
  const unique = new Map<string, MessageMemoryCandidate>();
  for (const candidate of candidates) {
    const statement = candidate.statement.trim().replace(/\s+/g, " ");
    const key = [
      candidate.type,
      candidate.contactEmail ?? "",
      statement.toLowerCase(),
    ].join(":");
    const existing = unique.get(key);
    if (!existing) {
      unique.set(key, { ...candidate, statement });
      continue;
    }
    unique.set(key, {
      ...existing,
      confidence: Math.max(existing.confidence, candidate.confidence),
      evidenceMessageIds: Array.from(
        new Set([...existing.evidenceMessageIds, ...candidate.evidenceMessageIds]),
      ),
    });
  }
  return Array.from(unique.values());
}

function validateBatchCandidates(input: {
  candidates: MessageMemoryCandidate[];
  manifest: MemoryBatchManifestEntry;
  messagesById: Map<string, MemoryAnalysisThread["messages"][number]>;
}): MessageMemoryCandidate[] {
  const allowedMessageIds = new Set(input.manifest.messageIds);
  const targetContact = input.manifest.contactEmail?.toLowerCase() ?? null;
  const valid: MessageMemoryCandidate[] = [];

  for (const candidate of input.candidates) {
    const evidenceMessageIds = Array.from(new Set(candidate.evidenceMessageIds));
    const evidence = evidenceMessageIds.map((id) => input.messagesById.get(id));
    if (
      evidenceMessageIds.length < 3 ||
      evidenceMessageIds.some((id) => !allowedMessageIds.has(id)) ||
      evidence.some((message) => !message?.ownerEvidence)
    ) {
      continue;
    }

    if (input.manifest.mode === "contact") {
      if (candidate.type !== "contact" || !targetContact) continue;
      if (
        evidence.some(
          (message) =>
            !message?.recipients.some(
              (recipient) => recipient.toLowerCase() === targetContact,
            ),
        )
      ) {
        continue;
      }
      valid.push({ ...candidate, contactEmail: targetContact, evidenceMessageIds });
      continue;
    }

    if (candidate.type === "contact") continue;
    if (candidate.type === "preference") {
      const contacts = new Set(
        evidence.flatMap((message) => message?.recipients ?? []),
      );
      if (contacts.size < 3) continue;
    }
    valid.push({ ...candidate, contactEmail: null, evidenceMessageIds });
  }

  return valid;
}

async function clearMemoryEvidenceUsedByCandidates(
  accountId: string,
  memories: MessageMemoryCandidate[],
) {
  const evidenceByScope = new Map<
    string,
    {
      mode: "global" | "contact";
      contactEmail: string | null;
      messageIds: Set<string>;
    }
  >();
  for (const memory of memories) {
    const mode = memory.type === "contact" ? "contact" : "global";
    const contactEmail = mode === "contact" ? memory.contactEmail : null;
    if (mode === "contact" && !contactEmail) continue;
    const key = `${mode}:${contactEmail ?? ""}`;
    const scope = evidenceByScope.get(key) ?? {
      mode,
      contactEmail,
      messageIds: new Set<string>(),
    };
    for (const messageId of memory.evidenceMessageIds) {
      scope.messageIds.add(messageId);
    }
    evidenceByScope.set(key, scope);
  }

  await Promise.all(
    Array.from(evidenceByScope.values()).map((scope) =>
      clearPendingMemoryEvidence({
        accountId,
        mode: scope.mode,
        contactEmail: scope.contactEmail,
        messageIds: Array.from(scope.messageIds),
      }),
    ),
  );
}

async function runMemoryExtraction(job: WorkflowStepJob) {
  if (!job.accountId) throw new Error("The memory job has no connected account.");
  if (job.payload.schemaVersion !== MEMORY_SCHEMA_VERSION) {
    return {
      status: "superseded",
      requestedSchemaVersion: job.payload.schemaVersion ?? null,
      currentSchemaVersion: MEMORY_SCHEMA_VERSION,
    };
  }
  const account = await getWorkerAccount(job.accountId);
  if (!account) throw new Error("The connected Gmail account was not found.");

  const indexedThreads = await getMemoryAnalysisThreads(account.id);
  const threads = toMemoryAnalysisThreads(indexedThreads, account.email);
  const evidenceMessageCount = threads.reduce(
    (total, thread) =>
      total + thread.messages.filter((message) => message.ownerEvidence).length,
    0,
  );
  if (evidenceMessageCount < 3) {
    await saveExtractedMemories({
      userId: account.userId,
      accountId: account.id,
      source: "inferred",
      modelId: null,
      memories: [],
    });
    await enqueuePendingAnalysisWorkflowSteps();
    return {
      status: "complete",
      threadCount: threads.length,
      evidenceMessageCount,
      memoryCount: 0,
    };
  }
  if (!isMemoryBatchConfigured()) throw new MemoryBatchConfigurationError();

  await setMemorySyncStage(account.id, "running");
  const submission = await submitMemoryBatch({
    submissionId: job.id,
    batchAttempt: 1,
    threads,
    protectedMemories: await getUserAuthoredMemories(account.id),
  });
  if (!submission) {
    await saveExtractedMemories({
      userId: account.userId,
      accountId: account.id,
      source: "inferred",
      modelId: null,
      memories: [],
    });
    await enqueuePendingAnalysisWorkflowSteps();
    return {
      status: "complete",
      threadCount: threads.length,
      evidenceMessageCount,
      memoryCount: 0,
    };
  }

  return {
    status: "submitted",
    ...submission,
    batchAttempt: 1,
    rootSubmissionJobId: job.id,
    replaceExisting: true,
    pendingScope: null,
    threadCount: threads.length,
    evidenceMessageCount,
  };
}

async function runIncrementalMemoryExtraction(job: WorkflowStepJob) {
  if (!job.accountId) throw new Error("The incremental Memory job has no account.");
  if (job.payload.schemaVersion !== MEMORY_SCHEMA_VERSION) {
    return {
      status: "superseded",
      requestedSchemaVersion: job.payload.schemaVersion ?? null,
      currentSchemaVersion: MEMORY_SCHEMA_VERSION,
    };
  }
  const mode = job.payload.mode;
  const contactEmail = job.payload.contactEmail;
  const evidenceMessageIds = job.payload.evidenceMessageIds;
  if (
    (mode !== "global" && mode !== "contact") ||
    (mode === "global" && contactEmail !== null) ||
    (mode === "contact" &&
      (typeof contactEmail !== "string" || !contactEmail.trim())) ||
    !Array.isArray(evidenceMessageIds) ||
    evidenceMessageIds.some((id) => typeof id !== "string")
  ) {
    throw new Error("The incremental Memory evidence scope is invalid.");
  }
  const normalizedContactEmail =
    mode === "contact" ? String(contactEmail).trim().toLowerCase() : null;

  const account = await getWorkerAccount(job.accountId);
  if (!account) throw new Error("The connected Gmail account was not found.");
  const threads = toMemoryAnalysisThreads(
    await getMemoryAnalysisThreads(account.id, evidenceMessageIds),
    account.email,
  );
  const availableEvidenceIds = new Set(
    threads.flatMap((thread) =>
      thread.messages
        .filter((message) => message.ownerEvidence)
        .map((message) => message.id),
    ),
  );
  const currentEvidenceMessageIds = evidenceMessageIds.filter((id) =>
    availableEvidenceIds.has(id),
  );
  if (currentEvidenceMessageIds.length < 3) {
    return {
      status: "waiting_for_repetition",
      evidenceMessageCount: currentEvidenceMessageIds.length,
    };
  }
  if (!isMemoryBatchConfigured()) throw new MemoryBatchConfigurationError();

  const submission = await submitMemoryBatch({
    submissionId: job.id,
    batchAttempt: 1,
    threads,
    protectedMemories: await getUserAuthoredMemories(account.id),
    scopeSelection: {
      mode,
      contactEmail: normalizedContactEmail,
    },
  });
  if (!submission) {
    throw new Error("The incremental Memory Batch produced no requests.");
  }
  return {
    status: "submitted",
    ...submission,
    batchAttempt: 1,
    rootSubmissionJobId: job.id,
    replaceExisting: false,
    pendingScope: {
      mode,
      contactEmail: normalizedContactEmail,
    },
  };
}

async function runMemoryBatchRetry(job: WorkflowStepJob) {
  if (!job.accountId) throw new Error("The Memory retry has no connected account.");
  const parentSubmissionJobId = requiredString(
    job.payload.parentSubmissionJobId,
    "Parent Memory submission job ID",
  );
  const parentSubmission = await getBatchSubmission(parentSubmissionJobId);
  if (parentSubmission?.accountId !== job.accountId) {
    throw new Error("The parent Memory submission could not be matched to this account.");
  }
  const parentDetails = parseSubmissionResult(parentSubmission.result);
  if (!parentDetails) {
    return { status: "superseded", provider: "unsupported" };
  }

  const account = await getWorkerAccount(job.accountId);
  if (!account) throw new Error("The connected Gmail account was not found.");
  if (!isMemoryBatchProviderConfigured(parentDetails.provider)) {
    throw new MemoryBatchConfigurationError(
      `The ${parentDetails.provider} provider used by this Memory Batch retry is not configured.`,
    );
  }

  const batchAttempt = requiredInteger(
    job.payload.batchAttempt,
    "Memory Batch attempt",
  );
  const rootSubmissionJobId = requiredString(
    job.payload.rootSubmissionJobId,
    "Root Memory submission job ID",
  );
  if (typeof job.payload.replaceExisting !== "boolean") {
    throw new Error("The Memory retry replacement state is missing.");
  }
  const manifest = parseManifest(job.payload.manifest);
  const threads = toMemoryAnalysisThreads(
    await getMemoryAnalysisThreads(account.id),
    account.email,
  );
  const submission = await submitMemoryBatch({
    provider: parentDetails.provider,
    submissionId: job.id,
    batchAttempt,
    threads,
    protectedMemories: await getUserAuthoredMemories(account.id),
    retryManifest: manifest,
  });
  if (!submission) {
    throw new Error("The Memory Batch retry produced no requests.");
  }

  return {
    status: "submitted",
    ...submission,
    batchAttempt,
    rootSubmissionJobId,
    replaceExisting: job.payload.replaceExisting,
    pendingScope: parentDetails.pendingScope,
  };
}

async function runMemoryBatchEvent(job: WorkflowStepJob) {
  if (!job.accountId) throw new Error("The Memory batch event has no account.");
  const submissionJobId = requiredString(
    job.payload.submissionJobId,
    "Memory submission job ID",
  );
  const submission = await getBatchSubmission(submissionJobId);
  if (!submission?.accountId || !submission.userId || submission.accountId !== job.accountId) {
    throw new Error("The Memory Batch submission could not be matched to this account.");
  }
  const details = parseSubmissionResult(submission.result);
  if (!details) {
    return { status: "superseded", provider: "unsupported" };
  }
  const providerBatchId = requiredString(
    job.payload.providerBatchId,
    "provider event batch ID",
  );
  if (job.payload.provider !== details.provider) {
    throw new Error("The provider event does not match its Memory submission.");
  }
  if (providerBatchId !== details.providerBatchId) {
    throw new Error("The provider event does not match its Memory submission.");
  }

  const account = await getWorkerAccount(job.accountId);
  if (!account) throw new Error("The connected Gmail account was not found.");
  const threads = toMemoryAnalysisThreads(
    await getMemoryAnalysisThreads(account.id),
    account.email,
  );
  const messagesById = new Map(
    threads.flatMap((thread) =>
      thread.messages.map((message) => [message.id, message] as const),
    ),
  );
  const batch = await readMemoryBatch({
    provider: details.provider,
    providerBatchId: details.providerBatchId,
    modelId: details.modelId,
    expectedKeys: details.manifest.map((entry) => entry.key),
  });
  const terminalState =
    batch.state === "completed" ||
    batch.state === "failed" ||
    batch.state === "cancelled" ||
    batch.state === "expired";
  if (!terminalState) {
    throw new Error(
      `${details.provider} emitted a terminal event while the batch is ${batch.state}.`,
    );
  }

  const failedKeys = new Set(batch.failedKeys);
  const candidates: MessageMemoryCandidate[] = [];
  for (const entry of details.manifest) {
    if (failedKeys.has(entry.key)) continue;
    candidates.push(
      ...validateBatchCandidates({
        candidates: batch.candidatesByKey.get(entry.key) ?? [],
        manifest: entry,
        messagesById,
      }),
    );
  }
  const memories = deduplicateCandidates(candidates);
  const failedManifest = details.manifest.filter((entry) => failedKeys.has(entry.key));
  const hasSuccessfulRequests = failedManifest.length < details.manifest.length;

  if (hasSuccessfulRequests) {
    await saveExtractedMemories({
      userId: submission.userId,
      accountId: submission.accountId,
      source: "inferred",
      modelId: batch.modelId,
      memories,
      replaceExisting: details.replaceExisting,
      markComplete:
        details.pendingScope === null && failedManifest.length === 0,
    });
    await clearMemoryEvidenceUsedByCandidates(submission.accountId, memories);

    if (details.pendingScope === null && failedManifest.length === 0) {
      await enqueuePendingAnalysisWorkflowSteps();
    }
  }

  let retryJobId: string | null = null;
  if (failedManifest.length > 0 && details.batchAttempt < submission.maxAttempts) {
    retryJobId = await enqueueMemoryBatchRetry({
      userId: submission.userId,
      accountId: submission.accountId,
      parentSubmissionJobId: submission.id,
      rootSubmissionJobId: details.rootSubmissionJobId,
      batchAttempt: details.batchAttempt + 1,
      replaceExisting: hasSuccessfulRequests ? false : details.replaceExisting,
      manifest: failedManifest,
    });
  } else if (failedManifest.length > 0) {
    await setMemorySyncStage(submission.accountId, "failed");
  } else if (!hasSuccessfulRequests && details.pendingScope === null) {
    await setMemorySyncStage(submission.accountId, "complete");
  }

  const cleanupFailures = await deleteMemoryBatchFiles({
    provider: details.provider,
    inputFileId: details.inputFileId,
    outputFileId: batch.outputFileId,
    errorFileId: batch.errorFileId,
  });
  if (cleanupFailures.length > 0) {
    console.error("worker: Memory Batch files could not be deleted", {
      provider: details.provider,
      submissionJobId: submission.id,
      fileCount: cleanupFailures.length,
    });
  }

  return {
    status:
      failedManifest.length === 0
        ? "complete"
        : retryJobId
          ? "retry_submitted"
          : "failed",
    providerState: batch.state,
    provider: details.provider,
    providerError: batch.providerError,
    candidateCount: candidates.length,
    memoryCount: memories.length,
    failedRequestCount: failedManifest.length,
    retryJobId,
  };
}

async function runMemoryFeedback(job: WorkflowStepJob) {
  if (!job.accountId) throw new Error("The feedback job has no connected account.");
  const account = await getWorkerAccount(job.accountId);
  if (!account) throw new Error("The connected Gmail account was not found.");

  const samples = await getDraftFeedbackSamples(
    account.id,
    DRAFT_FEEDBACK_VERSION,
    feedbackBatchSize,
  );
  if (samples.length < 3) {
    return { status: "waiting_for_repetition", sampleCount: samples.length };
  }
  if (!isAiConfigured()) throw new AiConfigurationError();

  const protectedMemories = await getUserAuthoredMemories(account.id);
  const analysis = await extractFeedbackMemories({
    protectedMemories,
    samples: samples.flatMap((sample) =>
      sample.generatedText
        ? [
            {
              id: sample.id,
              subject: sample.subject,
              contactEmails: normalizedEmails(sample.participants, account.email),
              generatedText: sample.generatedText,
              editedText: sample.editedText,
            },
          ]
        : [],
    ),
  });

  const samplesById = new Map(samples.map((sample) => [sample.id, sample]));
  const validMemories: FeedbackMemoryCandidate[] = [];
  for (const memory of analysis.memories) {
    const evidenceDraftIds = Array.from(new Set(memory.evidenceDraftIds));
    if (
      evidenceDraftIds.length < 3 ||
      evidenceDraftIds.some((id) => !samplesById.has(id))
    ) {
      continue;
    }

    if (memory.type === "contact") {
      const contactEmail = memory.contactEmail?.trim().toLowerCase();
      if (!contactEmail) continue;
      const repeatedForContact = evidenceDraftIds.every((id) => {
        const sample = samplesById.get(id);
        return Boolean(
          sample && normalizedEmails(sample.participants, account.email).includes(contactEmail),
        );
      });
      if (!repeatedForContact) continue;
      validMemories.push({ ...memory, contactEmail, evidenceDraftIds });
      continue;
    }

    if (memory.type === "preference") {
      const contacts = new Set(
        evidenceDraftIds.flatMap((id) => {
          const sample = samplesById.get(id);
          return sample ? normalizedEmails(sample.participants, account.email) : [];
        }),
      );
      if (contacts.size < 3) continue;
    }
    validMemories.push({ ...memory, contactEmail: null, evidenceDraftIds });
  }

  const savedCount = await saveExtractedMemories({
    userId: account.userId,
    accountId: account.id,
    source: "feedback",
    modelId: analysis.modelId,
    memories: validMemories,
  });

  const signalsByDraft = new Map<
    string,
    Array<{ type: MemoryType; statement: string }>
  >();
  for (const memory of validMemories) {
    for (const draftId of memory.evidenceDraftIds) {
      const signals = signalsByDraft.get(draftId) ?? [];
      signals.push({ type: memory.type, statement: memory.statement });
      signalsByDraft.set(draftId, signals);
    }
  }
  await markDraftFeedbackAnalyzed({
    draftIds: samples.map((sample) => sample.id),
    signalsByDraft,
  });

  return {
    status: "complete",
    sampleCount: samples.length,
    memoryCount: savedCount,
  };
}

async function persistWorkflowFailure(
  job: WorkflowStepJob,
  message: string,
  terminal: boolean,
  reconnectRequired: boolean,
) {
  const stepUpdated = await failWorkflowStep({
    step: job,
    message,
    terminal,
    reconnectRequired,
  });
  if (!stepUpdated) return;
}

async function runWorkflowStepHandler(
  job: WorkflowStepJob,
): Promise<Record<string, unknown>> {
  const run = async (): Promise<Record<string, unknown>> => {
    switch (job.stepType) {
      case "gmail.sync.page":
        return runGmailPage(job);
      case "gmail.sync.thread.batch":
        return runGmailThreadBatch(job);
      case "gmail.sync.finalize":
        return runGmailFinalize(job);
      case "gmail.history.catchup":
        return runGmailHistoryCatchup(job);
      case "gmail.message.refresh":
        return runGmailMessageRefresh(job);
      case "gmail.watch.renew":
        return runGmailWatchRenewal(job);
      case "gmail.objects.delete":
        return runGmailObjectDelete(job);
      case "gmail.account.cleanup":
        return runGmailAccountCleanup(job);
      case "memory.extract":
        return runMemoryExtraction(job);
      case "memory.incremental":
        return runIncrementalMemoryExtraction(job);
      case "memory.batch.retry":
        return runMemoryBatchRetry(job);
      case "memory.batch.event":
        return runMemoryBatchEvent(job);
      case "memory.feedback":
        return runMemoryFeedback(job);
      case "label.historical.scan":
      case "label.thread.assign":
      case "label.thread.scan":
        return runLabelSubmission(job);
      case "label.batch.submit":
        return runThreadLabelBatchSubmission(job);
      case "label.batch.event":
        return runThreadLabelBatchEvent(job);
      default:
        throw new Error(`Unsupported Temporal workflow step: ${job.stepType}`);
    }
  };
  if (
    job.accountId &&
    (job.stepType === "gmail.sync.finalize" ||
      job.stepType === "gmail.history.catchup" ||
      job.stepType === "gmail.message.refresh" ||
      job.stepType === "gmail.watch.renew" ||
      job.stepType === "gmail.objects.delete" ||
      job.stepType === "gmail.account.cleanup")
  ) {
    return withGmailAccountControlLock(job.accountId, run);
  }
  return run();
}

function workflowStepJobFromActivity(
  input: WorkflowStepExecution,
): WorkflowStepJob {
  return {
    id: input.id,
    userId: input.userId,
    accountId: input.accountId,
    runId: input.runId,
    stepType: input.stepType,
    payload: input.payload,
    attempts: input.attempts + activityInfo().attempt,
    maxAttempts: input.maxAttempts,
  };
}

export async function runWorkflowStepActivity(
  input: WorkflowStepExecution,
): Promise<WorkflowStepResult> {
  const job = workflowStepJobFromActivity(input);
  const started = await markWorkflowStepRunning(job.id, job.attempts);
  if (!started.shouldExecute) return { result: started.result };
  try {
    const result = await runWorkflowStepHandler(job);
    await completeWorkflowStep(job.id, result);
    return { result };
  } catch (error) {
    const failure = classifyGmailWorkflowFailure(error, {
      attempt: job.attempts,
      maxAttempts: job.maxAttempts,
    });
    const persistedMessage =
      isThreadLabelWorkflowStep(job.stepType)
        ? threadLabelAnalysisErrorCode(error)
        : failure.persistedMessage;
    if (failure.isTerminal) {
      await failTerminalThreadLabelAnalysis(job, error);
    }
    await persistWorkflowFailure(
      job,
      persistedMessage,
      failure.isTerminal,
      failure.isReconnectRequired,
    );
    if (failure.isReconnectRequired) {
      throw ApplicationFailure.nonRetryable(
        "gmail_reconnect_required",
        "GmailReconnectRequired",
      );
    }
    if (failure.isTerminal) {
      throw ApplicationFailure.nonRetryable(
        "workflow_step_terminal_failure",
        "WorkflowStepTerminalFailure",
      );
    }
    throw ApplicationFailure.create({
      message: "workflow_step_retryable_failure",
      type: "WorkflowStepRetryableFailure",
      nonRetryable: false,
    });
  }
}

export async function reconcileWorkflowStepFailureActivity(
  input: WorkflowStepExecution,
): Promise<void> {
  const job: WorkflowStepJob = {
    id: input.id,
    userId: input.userId,
    accountId: input.accountId,
    runId: input.runId,
    stepType: input.stepType,
    payload: input.payload,
    attempts: input.maxAttempts,
    maxAttempts: input.maxAttempts,
  };
  const error = new Error("temporal_activity_terminal_failure");
  await failTerminalThreadLabelAnalysis(job, error);
  await persistWorkflowFailure(
    job,
    isThreadLabelWorkflowStep(job.stepType)
      ? threadLabelAnalysisErrorCode(error)
      : job.stepType.startsWith("gmail.")
        ? "gmail_workflow_activity_failed"
        : "temporal_activity_failed",
    true,
    false,
  );
}

async function reconcileSubmittedThreadLabelBatches() {
  if (!isThreadLabelBatchConfigured()) return;
  const providerBatchIds = await listSubmittedThreadLabelBatchIds();
  let enqueued = 0;
  for (const providerBatchId of providerBatchIds) {
    try {
      const state = await getThreadLabelBatchState(providerBatchId);
      if (!terminalProviderBatchStates.has(state)) continue;
      const event = await enqueueBatchEvent({
        provider: "openai",
        webhookId: `worker-startup:thread-label:${providerBatchId}:${state}`,
        eventType: `batch.${state}`,
        providerBatchId,
      });
      if (event) enqueued += 1;
    } catch (error) {
      console.error("worker: submitted thread-label Batch reconciliation failed", {
        providerBatchId,
        name: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
  if (providerBatchIds.length > 0) {
    console.info("worker: submitted thread-label Batches reconciled", {
      checked: providerBatchIds.length,
      enqueued,
    });
  }
}

async function runTemporalCommandLoop(
  signal: ReturnType<typeof createJobSignal>,
  isStopped: () => boolean,
  runtime: TemporalRuntime,
) {
  while (!isStopped()) {
    await signal.wait();
    if (isStopped()) break;
    await runtime.ensureTenantWorkers(await listActiveTemporalTenantIds());
    while (!isStopped()) {
      const result = await dispatchTemporalCommandBatch((jobs) =>
        runtime.dispatch(jobs),
      );
      if (result.failed) {
        throw new Error("Temporal command dispatch failed.");
      }
      if (result.dispatched === 0) break;
    }
  }
}

async function run() {
  const runtime = await TemporalRuntime.create({
    activities: {
      runWorkflowStepActivity,
      reconcileWorkflowStepFailureActivity,
    },
  });
  const outboxSignal = createJobSignal();
  let stopRequested = false;
  let fatalError: Error | null = null;
  const requestStop = () => {
    stopRequested = true;
    outboxSignal.notify();
  };
  const workerRun = runtime.run().catch((error: unknown) => {
    fatalError =
      error instanceof Error ? error : new Error("Unknown Temporal worker error.");
    requestStop();
  });
  const stopOutboxListening = await listenForTemporalCommandNotifications({
    onEntryAvailable: outboxSignal.notify,
    onSubscriptionLost: () => {
      fatalError ??= new Error(
        "The Temporal command notification subscription was lost.",
      );
      requestStop();
    },
  });

  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);

  try {
    const deletedPreviewReceiptCount =
      await deleteExpiredLabelPreviewReceipts();
    if (deletedPreviewReceiptCount > 0) {
      console.info("worker: expired label preview receipts deleted", {
        count: deletedPreviewReceiptCount,
      });
    }
    await enqueueImplausibleGmailMessageDateRepairs({
      latestAllowedAt: new Date(
        Date.now() + GMAIL_MESSAGE_FUTURE_TOLERANCE_MS,
      ),
    });
    await enqueueMissingMailSyncRuns();
    await enqueueFailedInitialGmailRepairRecoveries();
    await enqueuePendingGmailHistoryCatchups();
    await enqueueReadyMailSyncFinalizers();
    await ensureDailyGmailWatchRenewals();
    await enqueuePostSyncWorkflowSteps();
    await requeueRetryableThreadLabelBatchFailures();
    await enqueueStartupThreadLabelBatchSubmissions();
    await enqueuePendingAnalysisWorkflowSteps();
    await reconcileSubmittedThreadLabelBatches();
    outboxSignal.notify();
    await runTemporalCommandLoop(outboxSignal, () => stopRequested, runtime);
    if (fatalError) throw fatalError;
  } finally {
    process.removeListener("SIGINT", requestStop);
    process.removeListener("SIGTERM", requestStop);
    await stopOutboxListening();
    await runtime.close();
    await workerRun;
  }
}

run().catch(terminateWorkerAfterFatalError);
