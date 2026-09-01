import { and, desc, DrizzleQueryError, eq, inArray, isNotNull, not, sql } from "drizzle-orm";
import postgres from "postgres";
import { v4 as uuidv4 } from "uuid";

import type { GmailForwardMessage } from "@invook/contracts/gmail-forward";

import { getDatabase, type Database, type DatabaseExecutor } from "./client";
import { withGmailIdentityLock } from "./gmail-identity";
import { insertMailboxChange } from "./mailbox-change-events";
import { visibleThreadCondition } from "./mailbox-visibility";
import { enqueueLiveInboxThreadLabelAnalyses } from "./thread-label-analysis";
import {
  deleteIndexedMessage,
  replaceGmailMessageLabels,
  upsertMailboxMessage,
} from "./repositories";
import {
  connectedAccounts,
  accountSecrets,
  drafts,
  gmailAccountCleanups,
  gmailReplicaStates,
  gmailWatchStates,
  mailboxChangeEvents,
  messageAttachments,
  messages,
  threads,
} from "./schema";
import type { IndexedMessage, WorkflowStepInput } from "./types";
import {
  enqueueWorkflowStep,
  enqueueWorkflowStepWithExecutor,
} from "./workflows";

type DatabaseTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type GmailDraftResourceInput = {
  providerDraftId: string;
  providerMessageId: string;
  providerThreadId: string;
  providerHistoryId: string | null;
  providerMetadata: Record<string, unknown>;
};

export type GmailWatchInput = {
  topicName: string;
  historyId: string;
  expirationAt: Date;
};

export type GmailProviderWriteContext = {
  userId: string;
  accountId: string;
  email: string;
  tokenCiphertext: string;
};

async function queryGmailProviderWriteContext(
  input: { userId: string; accountId?: string },
  database: Database = getDatabase(),
): Promise<GmailProviderWriteContext | null> {
  const [context] = await database
    .select({
      userId: connectedAccounts.userId,
      accountId: connectedAccounts.id,
      email: connectedAccounts.email,
      tokenCiphertext: accountSecrets.tokenCiphertext,
    })
    .from(connectedAccounts)
    .innerJoin(accountSecrets, eq(accountSecrets.accountId, connectedAccounts.id))
    .innerJoin(
      gmailReplicaStates,
      eq(gmailReplicaStates.accountId, connectedAccounts.id),
    )
    .where(
      and(
        input.accountId === undefined
          ? undefined
          : eq(connectedAccounts.id, input.accountId),
        eq(connectedAccounts.userId, input.userId),
        eq(connectedAccounts.status, "connected"),
      ),
    )
    .limit(1);
  return context ?? null;
}

export async function getGmailProviderWriteContext(
  userId: string,
  database: Database = getDatabase(),
): Promise<GmailProviderWriteContext | null> {
  return queryGmailProviderWriteContext({ userId }, database);
}

export async function getGmailProviderWriteContextForAccount(
  input: { userId: string; accountId: string },
  database: Database = getDatabase(),
): Promise<GmailProviderWriteContext | null> {
  return queryGmailProviderWriteContext(input, database);
}

export async function getGmailMessageMutationContext(
  input: { userId: string; messageId: string },
  database: Database = getDatabase(),
) {
  const [message] = await database
    .select({
      accountId: messages.accountId,
      providerMessageId: messages.providerMessageId,
    })
    .from(messages)
    .innerJoin(connectedAccounts, eq(connectedAccounts.id, messages.accountId))
    .where(
      and(
        eq(messages.id, input.messageId),
        eq(connectedAccounts.userId, input.userId),
        eq(connectedAccounts.status, "connected"),
      ),
    )
    .limit(1);
  return message ?? null;
}

export async function getGmailThreadMutationContext(
  input: { userId: string; threadId: string },
  database: Database = getDatabase(),
): Promise<{ accountId: string; providerThreadId: string } | null> {
  const [thread] = await database
    .select({
      accountId: threads.accountId,
      providerThreadId: threads.providerThreadId,
    })
    .from(threads)
    .innerJoin(connectedAccounts, eq(connectedAccounts.id, threads.accountId))
    .where(
      and(
        eq(threads.id, input.threadId),
        eq(threads.userId, input.userId),
        eq(connectedAccounts.userId, input.userId),
        eq(connectedAccounts.status, "connected"),
        visibleThreadCondition(),
      ),
    )
    .limit(1);
  return thread ?? null;
}

export interface GmailReplyContext {
  providerThreadId: string;
  subject: string;
  headerLines: { key: string; line: string }[];
}

export async function getGmailReplyContext(
  input: { userId: string; accountId: string; messageId: string },
  database: Database = getDatabase(),
): Promise<GmailReplyContext | null> {
  const [message] = await database
    .select({
      providerThreadId: threads.providerThreadId,
      subject: messages.subject,
      headerLines: messages.headerLines,
    })
    .from(messages)
    .innerJoin(
      threads,
      and(
        eq(threads.id, messages.threadId),
        eq(threads.accountId, messages.accountId),
        eq(threads.userId, messages.userId),
      ),
    )
    .innerJoin(connectedAccounts, eq(connectedAccounts.id, messages.accountId))
    .where(
      and(
        eq(messages.id, input.messageId),
        eq(messages.userId, input.userId),
        eq(messages.accountId, input.accountId),
        eq(connectedAccounts.userId, input.userId),
        eq(connectedAccounts.status, "connected"),
        visibleThreadCondition(),
      ),
    )
    .limit(1);
  return message ?? null;
}

export async function getGmailForwardContext(
  input: { userId: string; accountId: string; messageId: string },
  database: Database = getDatabase(),
): Promise<GmailForwardMessage | null> {
  const [message] = await database
    .select({
      sender: messages.sender,
      subject: messages.subject,
      headerLines: messages.headerLines,
      bodyText: messages.bodyText,
      bodyHtml: messages.bodyHtml,
      sentAt: messages.sentAt,
    })
    .from(messages)
    .innerJoin(connectedAccounts, eq(connectedAccounts.id, messages.accountId))
    .where(
      and(
        eq(messages.id, input.messageId),
        eq(messages.userId, input.userId),
        eq(messages.accountId, input.accountId),
        eq(connectedAccounts.userId, input.userId),
        eq(connectedAccounts.status, "connected"),
      ),
    )
    .limit(1);
  if (!message) return null;
  return {
    sender: message.sender,
    subject: message.subject,
    bodyText: message.bodyText,
    bodyHtml: message.bodyHtml,
    sentAt: message.sentAt.toISOString(),
    headers: message.headerLines.map((header) => {
      const separator = header.line.indexOf(":");
      return {
        name: header.key,
        value: separator >= 0 ? header.line.slice(separator + 1).trimStart() : "",
      };
    }),
  };
}

export async function getGmailDraftResourceForUser(
  input: { userId: string; gmailDraftId: string },
  database: Database = getDatabase(),
) {
  const [draft] = await database
    .select({
      id: drafts.id,
      accountId: drafts.accountId,
      providerDraftId: drafts.providerDraftId,
      providerThreadId: drafts.providerThreadId,
    })
    .from(drafts)
    .innerJoin(connectedAccounts, eq(connectedAccounts.id, drafts.accountId))
    .innerJoin(messages, eq(messages.id, drafts.messageId))
    .where(
      and(
        eq(drafts.id, input.gmailDraftId),
        eq(drafts.kind, "gmail"),
        eq(connectedAccounts.userId, input.userId),
        eq(connectedAccounts.status, "connected"),
      ),
    )
    .limit(1);
  if (!draft?.providerDraftId || !draft.providerThreadId) return null;
  return {
    id: draft.id,
    accountId: draft.accountId,
    providerDraftId: draft.providerDraftId,
    providerThreadId: draft.providerThreadId,
  };
}

export async function getAiReplyDraftForGmailSave(
  input: { userId: string; draftId: string },
  database: Database = getDatabase(),
) {
  const [draft] = await database
    .select({
      id: drafts.id,
      currentText: drafts.currentText,
      updatedAt: drafts.updatedAt,
      threadId: threads.id,
      providerThreadId: threads.providerThreadId,
      subject: threads.subject,
      accountId: connectedAccounts.id,
      accountEmail: connectedAccounts.email,
    })
    .from(drafts)
    .innerJoin(threads, eq(threads.id, drafts.threadId))
    .innerJoin(connectedAccounts, eq(connectedAccounts.id, drafts.accountId))
    .where(
      and(
        eq(drafts.id, input.draftId),
        eq(drafts.kind, "invook"),
        eq(drafts.userId, input.userId),
        eq(drafts.status, "editing"),
        eq(connectedAccounts.userId, input.userId),
        eq(connectedAccounts.status, "connected"),
      ),
    )
    .limit(1);
  if (!draft) return null;
  const [replyTarget] = await database
    .select({
      sender: messages.sender,
      headerLines: messages.headerLines,
    })
    .from(messages)
    .where(
      and(
        eq(messages.threadId, draft.threadId),
        eq(messages.direction, "incoming"),
      ),
    )
    .orderBy(desc(messages.internalDate), desc(messages.id))
    .limit(1);
  return { ...draft, replyTarget: replyTarget ?? null };
}

export async function recordMailboxMessageRefresh(
  input: { userId: string; accountId: string; threadId: string },
  database: Database = getDatabase(),
): Promise<boolean> {
  return database.transaction(async (transaction) => {
    const [account] = await transaction
      .select({ id: connectedAccounts.id })
      .from(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.id, input.accountId),
          eq(connectedAccounts.userId, input.userId),
          eq(connectedAccounts.status, "connected"),
        ),
      )
      .limit(1);
    if (!account) return false;
    await enqueueLiveInboxThreadLabelAnalyses(
      { ...input, threadIds: [input.threadId] },
      transaction,
    );
    await insertMailboxChange(transaction, {
      userId: input.userId,
      accountId: input.accountId,
      changeType: "history_applied",
      payload: {
        changedThreadIds: [input.threadId],
        refreshedThreadIds: [input.threadId],
        reason: "message_refresh",
      },
    });
    return true;
  });
}

export async function recordMailboxMessageBatchRefresh(
  input: { userId: string; accountId: string; threadIds: string[] },
  database: Database = getDatabase(),
): Promise<boolean> {
  const threadIds = Array.from(new Set(input.threadIds));
  if (threadIds.length === 0) return false;
  return database.transaction(async (transaction) => {
    const [account] = await transaction
      .select({ id: connectedAccounts.id })
      .from(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.id, input.accountId),
          eq(connectedAccounts.userId, input.userId),
          eq(connectedAccounts.status, "connected"),
        ),
      )
      .limit(1);
    if (!account) return false;
    await insertMailboxChange(transaction, {
      userId: input.userId,
      accountId: input.accountId,
      changeType: "history_applied",
      payload: {
        changedThreadIds: threadIds,
        refreshedThreadIds: threadIds,
        reason: "message_refresh",
      },
    });
    return true;
  });
}

async function listLocalThreadIdsForProviderThreadIds(
  transaction: DatabaseTransaction,
  input: { userId: string; accountId: string; providerThreadIds: string[] },
): Promise<string[]> {
  const providerThreadIds = [...new Set(input.providerThreadIds)];
  if (providerThreadIds.length === 0) return [];
  const rows = await transaction
    .select({ id: threads.id })
    .from(threads)
    .where(
      and(
        eq(threads.userId, input.userId),
        eq(threads.accountId, input.accountId),
        inArray(threads.providerThreadId, providerThreadIds),
      ),
    );
  return rows.map((thread) => thread.id);
}

export async function replaceGmailDraftResources(
  input: {
    userId: string;
    accountId: string;
    drafts: GmailDraftResourceInput[];
    notify?: boolean;
  },
  database: Database = getDatabase(),
) {
  await database.transaction(async (transaction) => {
    const [account] = await transaction
      .select({ id: connectedAccounts.id })
      .from(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.id, input.accountId),
          eq(connectedAccounts.status, "connected"),
        ),
      )
      .for("update")
      .limit(1);
    if (!account) return false;
    const existingDrafts = await transaction
      .select({ providerThreadId: drafts.providerThreadId })
      .from(drafts)
      .where(
        and(
          eq(drafts.userId, input.userId),
          eq(drafts.accountId, input.accountId),
          eq(drafts.kind, "gmail"),
        ),
      );
    const providerDraftIds = input.drafts.map((draft) => draft.providerDraftId);
    if (providerDraftIds.length === 0) {
      await transaction
        .delete(drafts)
        .where(
          and(eq(drafts.accountId, input.accountId), eq(drafts.kind, "gmail")),
        );
    } else {
      await transaction
        .delete(drafts)
        .where(
          and(
            eq(drafts.accountId, input.accountId),
            eq(drafts.kind, "gmail"),
            not(inArray(drafts.providerDraftId, providerDraftIds)),
          ),
        );
    }
    for (const draft of input.drafts) {
      const [message] = await transaction
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.accountId, input.accountId),
            eq(messages.providerMessageId, draft.providerMessageId),
          ),
        )
        .limit(1);
      await transaction
        .insert(drafts)
        .values({
          userId: input.userId,
          accountId: input.accountId,
          kind: "gmail",
          ...draft,
          messageId: message?.id ?? null,
        })
        .onConflictDoUpdate({
          target: [drafts.accountId, drafts.providerDraftId],
          targetWhere: isNotNull(drafts.providerDraftId),
          set: {
            providerMessageId: draft.providerMessageId,
            providerThreadId: draft.providerThreadId,
            providerHistoryId: draft.providerHistoryId,
            providerMetadata: draft.providerMetadata,
            messageId: message?.id ?? null,
            updatedAt: new Date(),
          },
        });
    }
    if (input.notify) {
      const affectedThreadIds = await listLocalThreadIdsForProviderThreadIds(
        transaction,
        {
          userId: input.userId,
          accountId: input.accountId,
          providerThreadIds: [
            ...existingDrafts.flatMap((draft) =>
              draft.providerThreadId ? [draft.providerThreadId] : [],
            ),
            ...input.drafts.map((draft) => draft.providerThreadId),
          ],
        },
      );
      await insertMailboxChange(transaction, {
        userId: input.userId,
        accountId: input.accountId,
        changeType: "drafts_changed",
        payload: { kind: "snapshot", affectedThreadIds },
      });
    }
  });
}

export async function saveGmailDraftResource(
  input: {
    userId: string;
    accountId: string;
    draft: GmailDraftResourceInput;
    notify?: boolean;
  },
  database: Database = getDatabase(),
) {
  await database.transaction(async (transaction) => {
    const [message] = await transaction
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.accountId, input.accountId),
          eq(messages.providerMessageId, input.draft.providerMessageId),
        ),
      )
      .limit(1);
    await transaction
      .insert(drafts)
      .values({
        userId: input.userId,
        accountId: input.accountId,
        kind: "gmail",
        ...input.draft,
        messageId: message?.id ?? null,
      })
      .onConflictDoUpdate({
        target: [drafts.accountId, drafts.providerDraftId],
        targetWhere: isNotNull(drafts.providerDraftId),
        set: {
          providerMessageId: input.draft.providerMessageId,
          providerThreadId: input.draft.providerThreadId,
          providerHistoryId: input.draft.providerHistoryId,
          providerMetadata: input.draft.providerMetadata,
          messageId: message?.id ?? null,
          updatedAt: new Date(),
        },
      });
    if (input.notify) {
      const affectedThreadIds = await listLocalThreadIdsForProviderThreadIds(
        transaction,
        {
          userId: input.userId,
          accountId: input.accountId,
          providerThreadIds: [input.draft.providerThreadId],
        },
      );
      await insertMailboxChange(transaction, {
        userId: input.userId,
        accountId: input.accountId,
        changeType: "drafts_changed",
        payload: { kind: "upsert", affectedThreadIds },
      });
    }
  });
}

export async function deleteGmailDraftResourceByMessageId(
  input: { userId: string; accountId: string; providerMessageId: string },
  database: Database = getDatabase(),
) {
  await database.transaction(async (transaction) => {
    const deleted = await transaction
      .delete(drafts)
      .where(
        and(
          eq(drafts.accountId, input.accountId),
          eq(drafts.kind, "gmail"),
          eq(drafts.providerMessageId, input.providerMessageId),
        ),
      )
      .returning({ providerThreadId: drafts.providerThreadId });
    if (deleted.length > 0) {
      const affectedThreadIds = await listLocalThreadIdsForProviderThreadIds(
        transaction,
        {
          userId: input.userId,
          accountId: input.accountId,
          providerThreadIds: deleted.flatMap((draft) =>
            draft.providerThreadId ? [draft.providerThreadId] : [],
          ),
        },
      );
      await insertMailboxChange(transaction, {
        userId: input.userId,
        accountId: input.accountId,
        changeType: "drafts_changed",
        payload: { kind: "delete", affectedThreadIds },
      });
    }
  });
}

export async function getGmailReplicaContext(
  accountId: string,
  database: Database = getDatabase(),
) {
  const [state] = await database
    .select({
      accountId: gmailReplicaStates.accountId,
      initialHistoryId: gmailReplicaStates.initialHistoryId,
      historyCursor: gmailReplicaStates.historyCursor,
      pendingHistoryCursor: gmailReplicaStates.pendingHistoryCursor,
      state: gmailReplicaStates.state,
      userId: connectedAccounts.userId,
      email: connectedAccounts.email,
    })
    .from(gmailReplicaStates)
    .innerJoin(
      connectedAccounts,
      eq(connectedAccounts.id, gmailReplicaStates.accountId),
    )
    .where(eq(gmailReplicaStates.accountId, accountId))
    .limit(1);
  return state ?? null;
}

export async function getGmailWatchContext(
  accountId: string,
  database: Database = getDatabase(),
) {
  const [watch] = await database
    .select({
      status: gmailWatchStates.status,
      expirationAt: gmailWatchStates.expirationAt,
    })
    .from(gmailWatchStates)
    .where(eq(gmailWatchStates.accountId, accountId))
    .limit(1);
  return watch ?? null;
}

export async function setGmailReplicaState(
  input: {
    accountId: string;
    state: "pending" | "snapshotting" | "replaying" | "ready" | "repairing" | "failed" | "deleting";
    lastError?: string | null;
  },
  database: Database = getDatabase(),
) {
  await database.transaction(async (transaction) => {
    const [account] = await transaction
      .select({ id: connectedAccounts.id })
      .from(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.id, input.accountId),
          eq(connectedAccounts.status, "connected"),
        ),
      )
      .for("update")
      .limit(1);
    if (!account) return;
    await transaction
      .update(gmailReplicaStates)
      .set({
        state: input.state,
        lastError: input.lastError ?? null,
        updatedAt: new Date(),
      })
      .where(eq(gmailReplicaStates.accountId, input.accountId));
  });
}

export async function saveGmailWatchState(
  input: { accountId: string; watch: GmailWatchInput; renewedAt: Date },
  database: DatabaseExecutor = getDatabase(),
) {
  await database.transaction(async (transaction) => {
    const [account] = await transaction
      .select({ id: connectedAccounts.id })
      .from(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.id, input.accountId),
          eq(connectedAccounts.status, "connected"),
        ),
      )
      .for("update")
      .limit(1);
    if (!account) return;
    await transaction
      .insert(gmailWatchStates)
      .values({
        accountId: input.accountId,
        ...input.watch,
        lastRenewedAt: input.renewedAt,
      })
      .onConflictDoUpdate({
        target: gmailWatchStates.accountId,
        set: {
          ...input.watch,
          status: "active",
          lastRenewedAt: input.renewedAt,
          lastError: null,
          updatedAt: input.renewedAt,
        },
      });
  });
}

type GmailConnectionPushResult =
  | { status: "retry" }
  | { status: "ignored"; accountId: null }
  | { status: "coalesced" | "queued"; accountId: string; stepId: string };

type GmailPushNotificationResult = {
  status: "retry" | "accepted";
  connections: GmailConnectionPushResult[];
};

export async function recordGmailPushNotification(
  input: {
    emailAddress: string;
    notificationHistoryId: string;
  },
  database?: Database,
): Promise<GmailPushNotificationResult> {
  if (!/^\d+$/.test(input.notificationHistoryId)) {
    throw new Error("The Gmail notification history cursor is invalid.");
  }
  const executor = database ?? getDatabase();
  const accounts = await executor.select({ id: connectedAccounts.id })
    .from(connectedAccounts).where(and(
      eq(connectedAccounts.provider, "gmail"),
      sql`lower(${connectedAccounts.email}) = ${input.emailAddress.trim().toLowerCase()}`,
      eq(connectedAccounts.status, "connected"),
    ));
  const connections: GmailConnectionPushResult[] = [];
  // Independent commits preserve successful admissions when a sibling is busy.
  // Sequential, non-waiting admission also bounds query-pool use for fan-out.
  for (const account of accounts) {
    connections.push(await recordGmailConnectionPush({
      accountId: account.id,
      notificationHistoryId: input.notificationHistoryId,
    }, executor));
  }
  return {
    status: connections.some((connection) => connection.status === "retry") ? "retry" : "accepted",
    connections,
  };
}

async function recordGmailConnectionPush(
  input: { accountId: string; notificationHistoryId: string },
  executor: Database,
): Promise<GmailConnectionPushResult> {
  return executor.transaction<GmailConnectionPushResult>(async (transaction) => {
    const [account] = await transaction
      .select({ id: connectedAccounts.id, userId: connectedAccounts.userId })
      .from(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.provider, "gmail"),
          eq(connectedAccounts.id, input.accountId),
          eq(connectedAccounts.status, "connected"),
        ),
      )
      // Reserve the parent key without waiting before admitting child work.
      // Replay locks the account before its replica state.
      .for("key share", { noWait: true })
      .limit(1);
    if (!account) return { status: "ignored", accountId: null };

    const [replica] = await transaction
      .select({ pendingHistoryCursor: gmailReplicaStates.pendingHistoryCursor })
      .from(gmailReplicaStates)
      .where(eq(gmailReplicaStates.accountId, account.id))
      // A history apply can hold this row for the entire replay transaction.
      // Pub/Sub retries must not occupy the API query pool waiting for it.
      .for("update", { noWait: true })
      .limit(1);
    if (!replica) return { status: "ignored", accountId: null };
    const currentPending = replica.pendingHistoryCursor;
    const nextPending = highestGmailHistoryCursor(
      currentPending,
      input.notificationHistoryId,
    );
    const isAdvanced = currentPending !== nextPending;
    if (isAdvanced) {
      await transaction
        .update(gmailReplicaStates)
        .set({ pendingHistoryCursor: nextPending, updatedAt: new Date() })
        .where(eq(gmailReplicaStates.accountId, account.id));
    }

    const stepId = await enqueueWorkflowStepWithExecutor(
      {
        userId: account.userId,
        accountId: account.id,
        stepType: "gmail.history.catchup",
        payload: { reason: "notification" },
        idempotencyKey: `gmail-history-notification:${account.id}:${nextPending}`,
      },
      transaction,
    );
    return {
      status: isAdvanced ? "queued" : "coalesced",
      accountId: account.id,
      stepId,
    };
  }).catch((error: unknown): GmailConnectionPushResult => {
    const cause = error instanceof DrizzleQueryError ? error.cause : error;
    if (cause instanceof postgres.PostgresError && cause.code === "55P03") {
      // The transaction has rolled back. Never acknowledge an unstored cursor.
      return { status: "retry" };
    }
    throw error;
  });
}

export function highestGmailHistoryCursor(
  currentCursor: string | null,
  candidateCursor: string,
): string {
  return currentCursor && BigInt(currentCursor) >= BigInt(candidateCursor)
    ? currentCursor
    : candidateCursor;
}

export async function enqueueGmailHistoryCatchup(
  input: {
    userId: string;
    accountId: string;
    reason: "manual" | "provider_write";
    sourceId?: string;
  },
  database: Database = getDatabase(),
) {
  return enqueueWorkflowStep(
    {
      userId: input.userId,
      accountId: input.accountId,
      stepType: "gmail.history.catchup",
      payload: { reason: input.reason },
      idempotencyKey: `gmail-history-${input.reason}:${input.accountId}:${input.sourceId ?? uuidv4()}`,
    },
    database,
  );
}

export function createGmailHistoryContinuationStep(input: {
  userId: string;
  accountId: string;
  sourceStepId: string;
  pendingHistoryCursor: string;
}): WorkflowStepInput {
  return {
    userId: input.userId,
    accountId: input.accountId,
    stepType: "gmail.history.catchup",
    payload: {
      reason: "continuation",
      pendingHistoryCursor: input.pendingHistoryCursor,
    },
    idempotencyKey: `gmail-history-continuation:${input.accountId}:${input.sourceStepId}`,
  };
}

export async function enqueueGmailHistoryCatchupForAccount(
  input: { userId: string; accountId: string },
  database: Database = getDatabase(),
): Promise<
  | { stepId: string; reason: null }
  | { stepId: null; reason: "not_found" | "replica_not_ready" }
> {
  return database.transaction(async (transaction) => {
    const [account] = await transaction
      .select({
        id: connectedAccounts.id,
        state: gmailReplicaStates.state,
      })
      .from(connectedAccounts)
      .innerJoin(
        gmailReplicaStates,
        eq(gmailReplicaStates.accountId, connectedAccounts.id),
      )
      .where(
        and(
          eq(connectedAccounts.userId, input.userId),
          eq(connectedAccounts.id, input.accountId),
          eq(connectedAccounts.status, "connected"),
        ),
      )
      .limit(1);
    if (!account) return { stepId: null, reason: "not_found" };
    if (account.state !== "ready") {
      return { stepId: null, reason: "replica_not_ready" };
    }
    const stepId = await enqueueGmailHistoryCatchup(
      { userId: input.userId, accountId: account.id, reason: "manual" },
      transaction as unknown as Database,
    );
    return { stepId, reason: null };
  });
}

export async function applyGmailHistoryBatch(
  input: {
    userId: string;
    accountId: string;
    expectedCursor: string;
    nextCursor: string;
    messages: IndexedMessage[];
    labelChanges: Array<{
      providerMessageId: string;
      providerHistoryId: string | null;
      gmailLabels: Array<{ providerLabelId: string; name: string }>;
    }>;
    deletedMessageIds: Array<{ providerMessageId: string; providerHistoryId: string | null }>;
    stateAfterApply?: "ready" | "snapshotting" | "replaying" | "repairing";
    continuationSourceStepId?: string;
  },
  database: Database = getDatabase(),
): Promise<{
  applied: boolean;
  changedThreadIds: string[];
  eventId: string | null;
  pendingHistoryCursor: string | null;
  continuationStepId: string | null;
}> {
  return database.transaction(async (transaction) => {
    const [account] = await transaction
      .select({ id: connectedAccounts.id })
      .from(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.id, input.accountId),
          eq(connectedAccounts.status, "connected"),
        ),
      )
      .for("update")
      .limit(1);
    if (!account) {
      return {
        applied: false,
        changedThreadIds: [],
        eventId: null,
        pendingHistoryCursor: null,
        continuationStepId: null,
      };
    }
    const [replica] = await transaction
      .select({
        initialHistoryId: gmailReplicaStates.initialHistoryId,
        historyCursor: gmailReplicaStates.historyCursor,
        pendingHistoryCursor: gmailReplicaStates.pendingHistoryCursor,
      })
      .from(gmailReplicaStates)
      .where(eq(gmailReplicaStates.accountId, input.accountId))
      .for("update")
      .limit(1);
    if (!replica) throw new Error("The Gmail replica state was not found.");
    const currentCursor = replica.historyCursor ?? replica.initialHistoryId;
    if (currentCursor !== input.expectedCursor) {
      return {
        applied: false,
        changedThreadIds: [],
        eventId: null,
        pendingHistoryCursor: replica.pendingHistoryCursor,
        continuationStepId: null,
      };
    }

    const changedThreadIds = new Set<string>();
    const refreshedThreadIds = new Set<string>();
    const executor = transaction as unknown as Database;
    for (const message of input.messages) {
      const result = await upsertMailboxMessage(message, executor);
      if (result.changed) {
        changedThreadIds.add(result.threadId);
      }
    }
    for (const labelChange of input.labelChanges) {
      const result = await replaceGmailMessageLabels(
        {
          userId: input.userId,
          accountId: input.accountId,
          providerMessageId: labelChange.providerMessageId,
          providerHistoryId: labelChange.providerHistoryId,
          gmailLabels: labelChange.gmailLabels,
        },
        executor,
      );
      if (result.threadId && result.isVisible) {
        refreshedThreadIds.add(result.threadId);
        if (result.changed) changedThreadIds.add(result.threadId);
      }
    }
    for (const deletion of input.deletedMessageIds) {
      const result = await deleteIndexedMessage(
        {
          accountId: input.accountId,
          providerMessageId: deletion.providerMessageId,
          providerHistoryId: deletion.providerHistoryId,
        },
        executor,
      );
      if (result.changed && result.threadId && result.wasVisible) {
        changedThreadIds.add(result.threadId);
      }
    }
    await enqueueLiveInboxThreadLabelAnalyses(
      {
        userId: input.userId,
        accountId: input.accountId,
        threadIds: Array.from(changedThreadIds),
      },
      transaction,
    );
    const pendingHistoryCursor =
      replica.pendingHistoryCursor &&
      BigInt(replica.pendingHistoryCursor) > BigInt(input.nextCursor)
        ? replica.pendingHistoryCursor
        : null;
    await transaction
      .update(gmailReplicaStates)
      .set({
        historyCursor: input.nextCursor,
        pendingHistoryCursor,
        state: input.stateAfterApply ?? "ready",
        lastHistoryAt: new Date(),
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(gmailReplicaStates.accountId, input.accountId));
    await transaction
      .update(connectedAccounts)
      .set({ lastSyncedAt: new Date(), updatedAt: new Date() })
      .where(eq(connectedAccounts.id, input.accountId));
    for (const threadId of changedThreadIds) refreshedThreadIds.add(threadId);
    const eventId = refreshedThreadIds.size > 0
      ? await insertMailboxChange(transaction, {
          userId: input.userId,
          accountId: input.accountId,
          changeType: "history_applied",
          payload: {
            reason: "history_catchup",
            changedThreadIds: Array.from(changedThreadIds),
            refreshedThreadIds: Array.from(refreshedThreadIds),
          },
        })
      : null;
    const continuationStepId =
      pendingHistoryCursor && input.continuationSourceStepId
        ? await enqueueWorkflowStepWithExecutor(
            createGmailHistoryContinuationStep({
              userId: input.userId,
              accountId: input.accountId,
              sourceStepId: input.continuationSourceStepId,
              pendingHistoryCursor,
            }),
            transaction,
          )
        : null;
    return {
      applied: true,
      changedThreadIds: Array.from(changedThreadIds),
      eventId,
      pendingHistoryCursor,
      continuationStepId,
    };
  });
}

export async function markGmailReplicaReady(
  input: { userId: string; accountId: string; historyCursor: string },
  database: Database = getDatabase(),
) {
  return database.transaction(async (transaction) => {
    const [account] = await transaction
      .select({ id: connectedAccounts.id })
      .from(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.id, input.accountId),
          eq(connectedAccounts.status, "connected"),
        ),
      )
      .for("update")
      .limit(1);
    if (!account) return false;
    const [replica] = await transaction
      .select({ pendingHistoryCursor: gmailReplicaStates.pendingHistoryCursor })
      .from(gmailReplicaStates)
      .where(eq(gmailReplicaStates.accountId, input.accountId))
      .for("update")
      .limit(1);
    if (!replica) return false;
    const pendingHistoryCursor =
      replica.pendingHistoryCursor &&
      BigInt(replica.pendingHistoryCursor) > BigInt(input.historyCursor)
        ? replica.pendingHistoryCursor
        : null;
    await transaction
      .update(gmailReplicaStates)
      .set({
        historyCursor: input.historyCursor,
        pendingHistoryCursor,
        state: "ready",
        readyAt: new Date(),
        lastHistoryAt: new Date(),
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(gmailReplicaStates.accountId, input.accountId));
    await insertMailboxChange(transaction, {
      userId: input.userId,
      accountId: input.accountId,
      changeType: "replica_ready",
      payload: {},
    });
    if (pendingHistoryCursor) {
      await enqueueWorkflowStep(
        {
          userId: input.userId,
          accountId: input.accountId,
          stepType: "gmail.history.catchup",
          payload: { reason: "post_initial_reconciliation" },
          idempotencyKey: `gmail-history-post-ready:${input.accountId}:${pendingHistoryCursor}`,
        },
        transaction as unknown as Database,
      );
    }
    return true;
  });
}

export async function getMailboxChangeEvent(
  eventId: string,
  database: Database = getDatabase(),
) {
  const [event] = await database
    .select({
      id: mailboxChangeEvents.id,
      userId: mailboxChangeEvents.userId,
      accountId: mailboxChangeEvents.accountId,
      changeType: mailboxChangeEvents.changeType,
      payload: mailboxChangeEvents.payload,
      createdAt: mailboxChangeEvents.createdAt,
    })
    .from(mailboxChangeEvents)
    .where(eq(mailboxChangeEvents.id, eventId))
    .limit(1);
  return event ?? null;
}

export async function listGmailObjectKeysForAccount(
  accountId: string,
  database: DatabaseExecutor = getDatabase(),
) {
  const attachmentObjects = await database
    .select({ key: messageAttachments.objectKey })
    .from(messageAttachments)
    .where(
      and(
        eq(messageAttachments.accountId, accountId),
        isNotNull(messageAttachments.objectKey),
      ),
    );
  return Array.from(
    new Set(
      attachmentObjects
        .map((entry) => entry.key)
        .filter((key): key is string => Boolean(key)),
    ),
  );
}

export async function markGmailReplicaDeleting(
  input: { userId: string; accountId: string },
  database: DatabaseExecutor = getDatabase(),
) {
  const [identity] = await database.select({ providerAccountId: connectedAccounts.providerAccountId })
    .from(connectedAccounts).where(and(
      eq(connectedAccounts.id, input.accountId),
      eq(connectedAccounts.userId, input.userId),
    )).limit(1);
  if (!identity) return null;
  return withGmailIdentityLock(identity.providerAccountId, async (transaction) => {
    const [account] = await transaction
      .select({ id: connectedAccounts.id })
      .from(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.id, input.accountId),
          eq(connectedAccounts.userId, input.userId),
          not(eq(connectedAccounts.status, "disconnected")),
        ),
      )
      .for("update")
      .limit(1);
    if (!account) return null;
    await transaction
      .update(gmailReplicaStates)
      .set({ state: "deleting", updatedAt: new Date() })
      .where(eq(gmailReplicaStates.accountId, input.accountId));
    await transaction
      .update(connectedAccounts)
      .set({ status: "disconnected", updatedAt: new Date() })
      .where(
        and(
          eq(connectedAccounts.id, input.accountId),
          eq(connectedAccounts.userId, input.userId),
        ),
      );
    const [cleanup] = await transaction
      .insert(gmailAccountCleanups)
      .values({ userId: input.userId, accountId: input.accountId })
      .onConflictDoUpdate({
        target: gmailAccountCleanups.accountId,
        set: {
          status: "queued",
          lastError: null,
          startedAt: null,
          completedAt: null,
          updatedAt: new Date(),
        },
      })
      .returning({ id: gmailAccountCleanups.id });
    if (!cleanup) throw new Error("The Gmail cleanup record could not be created.");
    await enqueueWorkflowStep(
      {
        userId: input.userId,
        accountId: input.accountId,
        stepType: "gmail.account.cleanup",
        payload: { cleanupId: cleanup.id },
        idempotencyKey: `gmail-account-cleanup:${cleanup.id}`,
        maxAttempts: 10,
      },
      transaction as unknown as Database,
    );
    return cleanup.id;
  }, database);
}

export async function markGmailReplicaDeletingForUser(
  userId: string,
  database: Database = getDatabase(),
): Promise<{ cleanupId: string; reason: null } | { cleanupId: null; reason: "not_found" }> {
  return database.transaction(async (transaction) => {
    const [account] = await transaction
      .select({ id: connectedAccounts.id })
      .from(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.userId, userId),
          not(eq(connectedAccounts.status, "disconnected")),
        ),
      )
      .limit(1);
    if (!account) return { cleanupId: null, reason: "not_found" };
    const cleanupId = await markGmailReplicaDeleting(
      { userId, accountId: account.id },
      transaction as unknown as Database,
    );
    return cleanupId
      ? { cleanupId, reason: null }
      : { cleanupId: null, reason: "not_found" };
  });
}

export async function markGmailAccountCleanupRunning(
  cleanupId: string,
  database: DatabaseExecutor = getDatabase(),
) {
  await database
    .update(gmailAccountCleanups)
    .set({
      status: "running",
      startedAt: new Date(),
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(gmailAccountCleanups.id, cleanupId));
}
