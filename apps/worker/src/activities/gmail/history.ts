/**
 * Applies a Gmail history range to the replica. An expired history cursor is a
 * provider data-loss condition, not a transient failure, so it escalates to a
 * repair run instead of retrying.
 */
import {
  applyGmailHistoryBatch,
  getGmailReplicaContext,
  getActiveRepairMailSyncRunContext,
  getStoredProviderMessageIds,
  createRepairMailSyncRun,
  type IndexedMessage,
} from "@invook/database";
import {
  gmailHistoryChanges,
  gmailSystemLabels,
  getGmailMessage,
  getGmailMessageState,
  getGmailProfile,
  GmailApiError,
  listGmailHistory,
} from "@invook/gmail";

import { gmailContentConcurrency } from "./concurrency";
import {
  applyGmailHistoryWithExpiredCursorRepair,
  shouldRepairNonReadyGmailReplica,
} from "./history-recovery";
import {
  gmailHistoryCatchupDisposition,
  planGmailHistoryCatchup,
} from "./history-catchup";

import { getMailSyncContext } from "./connection";
import { refreshAffectedGmailDraftResources } from "./drafts";
import {
  normalizeFullMessage,
  prepareMessage,
} from "./messages";
import { renewGmailWatch } from "./watch";

export async function applyHistoryRange(options: {
  accessToken: string;
  userId: string;
  accountId: string;
  accountEmail: string;
  startHistoryId: string;
  expectedCursor: string;
  stateAfterApply?: "ready" | "snapshotting" | "replaying" | "repairing";
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

/**
 * The outcome of one catch-up pass. `deferred` and `superseded` are ordinary
 * states, not failures: the first means the replica is still being built and
 * the cursor stays pending, the second means another pass already applied the
 * range.
 */
export type GmailHistoryCatchUpResult =
  | {
      status: "applied";
      historyCursor: string;
      hasPendingHistory: boolean;
      changedThreadCount: number;
    }
  | { status: "deferred"; historyCursor: string | null }
  | { status: "repair_started"; runId: string; startingHistoryCursor: string }
  | { status: "superseded"; historyCursor: string };

export async function catchUpGmailHistory(options: {
  accountId: string;
  resumeNonReady?: boolean;
  resumeFailedReplica?: boolean;
}): Promise<GmailHistoryCatchUpResult> {
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
      return { status: "repair_started", ...repair };
    }
    return { status: "deferred", historyCursor: replica.historyCursor };
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
    return { status: "repair_started", ...replayOrRepair.result };
  }
  const replay = replayOrRepair.result;
  const disposition = gmailHistoryCatchupDisposition(replay);
  if (disposition === "superseded") {
    return { status: "superseded", historyCursor: replay.historyId };
  }
  return {
    status: "applied",
    historyCursor: replay.historyId,
    // Gmail capped the range, so the Workflow must schedule another pass.
    hasPendingHistory: disposition === "continue_durably",
    changedThreadCount: replay.changedThreadIds.length,
  };
}
