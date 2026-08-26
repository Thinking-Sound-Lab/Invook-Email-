import { createHash } from "node:crypto";

import {
  MAIL_EMBEDDING_DIMENSIONS,
  type IndexingProgress,
  type LabelHistoryWindowDays,
  type MailSyncProgress,
} from "@invook/contracts";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  not,
  or,
  sql,
} from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";

import {
  getDatabase,
  type Database,
  type DatabaseExecutor,
  type DatabaseTransaction,
} from "./client";
import {
  areIndexingPrerequisitesReady,
  createBatchEventIdempotencyKey,
  decideEmbeddingContinuation,
  deriveIndexingProgress,
  type IndexingPrerequisiteState,
} from "./embedding-indexing";
import {
  consumeLabelPreviewReceipt,
  LabelPreviewReceiptConflictError,
} from "./label-preview-receipts";
import {
  enqueueHistoricalThreadLabelScanCoordinator,
  ensureBuiltInInvookLabels,
  refreshThreadProjection,
} from "./thread-label-analysis";
import { enqueueDailyGmailWatchRenewal } from "./gmail-watch";
import { deriveMailSyncProgress } from "./mail-sync-progress";
import {
  inboxThreadCondition,
  visibleMessageCondition,
  visibleThreadCondition,
} from "./mailbox-visibility";
import {
  accountSecrets,
  connectedAccounts,
  drafts,
  embeddingBatchSubmissions,
  gmailConnectionRequests,
  gmailReplicaStates,
  gmailWatchStates,
  labels,
  mailSyncRuns,
  memoryDeletions,
  memoryEntries,
  memoryPendingEvidence,
  messageAttachments,
  messageEmbeddings,
  messages,
  messageLabels,
  threadLabelAssignments,
  threadLabelBatchSubmissions,
  threads,
  workflowSteps,
} from "./schema";
import type {
  AccountSyncState,
  IndexedMessage,
  MailboxMessage,
} from "./types";
import {
  createInitialMailSyncRun,
  createRepairMailSyncRun,
  completeMailSyncThreadWithExecutor,
  enqueueWorkflowStep,
  enqueueWorkflowStepWithExecutor,
  enqueueWorkflowStepsWithExecutor,
  getWorkflowStepSubmission,
} from "./workflows";
import {
  DRAFT_FEEDBACK_VERSION,
  MEMORY_SCHEMA_VERSION,
} from "./versions";

const initialSyncState: AccountSyncState = {
  mailSync: "pending",
  indexing: "pending",
  memory: "pending",
};

export class InactiveMailSyncRunError extends Error {
  constructor(runId: string) {
    super(`Gmail synchronization run ${runId} is no longer active.`);
    this.name = "InactiveMailSyncRunError";
  }
}

export type MemoryType = "preference" | "contact" | "scheduling";
export type MemorySource = "user" | "inferred" | "feedback";

function equalStringArrays(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function equalSender(
  left: { raw: string; email: string },
  right: { raw: string; email: string },
): boolean {
  return left.raw === right.raw && left.email === right.email;
}

function normalizeMemoryStatement(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeContactEmail(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized || null;
}

export function createMemoryFingerprint(input: {
  type: MemoryType;
  contactEmail?: string | null;
  statement: string;
}): string {
  return createHash("sha256")
    .update(
      [
        input.type,
        normalizeContactEmail(input.contactEmail) ?? "",
        normalizeMemoryStatement(input.statement).toLowerCase(),
      ].join("\n"),
    )
    .digest("hex");
}

export async function checkDatabaseConnection(
  database: Database = getDatabase(),
): Promise<void> {
  await database.execute(sql`select 1`);
}

export async function getGmailConnectionForOAuth(
  providerAccountId: string,
  database: Database = getDatabase(),
) {
  const [connection] = await database
    .select({
      id: connectedAccounts.id,
      userId: connectedAccounts.userId,
      tokenCiphertext: accountSecrets.tokenCiphertext,
    })
    .from(connectedAccounts)
    .leftJoin(accountSecrets, eq(accountSecrets.accountId, connectedAccounts.id))
    .where(
      and(
        eq(connectedAccounts.provider, "gmail"),
        eq(connectedAccounts.providerAccountId, providerAccountId),
      ),
    )
    .limit(1);

  return connection ?? null;
}

export async function getGmailConnectionForUser(
  input: { userId: string; accountId: string },
  database: Database = getDatabase(),
) {
  const [connection] = await database
    .select({
      id: connectedAccounts.id,
      userId: connectedAccounts.userId,
      providerAccountId: connectedAccounts.providerAccountId,
      status: connectedAccounts.status,
    })
    .from(connectedAccounts)
    .where(
      and(
        eq(connectedAccounts.id, input.accountId),
        eq(connectedAccounts.userId, input.userId),
        eq(connectedAccounts.provider, "gmail"),
      ),
    )
    .limit(1);

  return connection ?? null;
}

function hashGmailConnectionState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

export async function createGmailConnectionRequest(
  input: {
    state: string;
    codeVerifier: string;
    userId: string;
    accountId: string | null;
    expiresAt: Date;
  },
  database: Database = getDatabase(),
): Promise<void> {
  await database.transaction(async (transaction) => {
    await transaction
      .delete(gmailConnectionRequests)
      .where(lte(gmailConnectionRequests.expiresAt, new Date()));
    await transaction.insert(gmailConnectionRequests).values({
      stateHash: hashGmailConnectionState(input.state),
      codeVerifier: input.codeVerifier,
      userId: input.userId,
      accountId: input.accountId,
      expiresAt: input.expiresAt,
    });
  });
}

export async function consumeGmailConnectionRequest(
  input: { state: string; consumedAt: Date },
  database: Database = getDatabase(),
): Promise<{
  userId: string;
  accountId: string | null;
  codeVerifier: string;
} | null> {
  return database.transaction(async (transaction) => {
    const [request] = await transaction
      .update(gmailConnectionRequests)
      .set({ consumedAt: input.consumedAt })
      .where(
        and(
          eq(
            gmailConnectionRequests.stateHash,
            hashGmailConnectionState(input.state),
          ),
          isNull(gmailConnectionRequests.consumedAt),
          gt(gmailConnectionRequests.expiresAt, input.consumedAt),
        ),
      )
      .returning({
        userId: gmailConnectionRequests.userId,
        accountId: gmailConnectionRequests.accountId,
        codeVerifier: gmailConnectionRequests.codeVerifier,
      });

    return request ?? null;
  });
}

type GmailAuthenticationInput = {
  userId: string;
  providerAccountId: string;
  email: string;
  image: string | null;
  scopes: string[];
  currentHistoryId: string;
  tokenCiphertext: string;
  authenticatedAt: Date;
};

type NewGmailConnectionInput = GmailAuthenticationInput & {
  initialHistoryId: string;
  watch: {
    topicName: string;
    historyId: string;
    expirationAt: Date;
    renewedAt: Date;
  };
};

type GmailAuthenticationAccount = {
  id: string;
  userId: string;
  status: typeof connectedAccounts.$inferSelect.status;
  replicaState: typeof gmailReplicaStates.$inferSelect.state | null;
  historyCursor: string | null;
};

export function getReturningGmailAuthenticationAction(input: {
  status: GmailAuthenticationAccount["status"];
  replicaState: GmailAuthenticationAccount["replicaState"];
  historyCursor: string | null;
  currentHistoryId: string;
}): "repair" | "catchup" | "none" {
  if (input.status === "reconnect_required") return "repair";
  if (
    input.replicaState === "ready" &&
    input.historyCursor &&
    input.historyCursor !== input.currentHistoryId
  ) {
    return "catchup";
  }
  return "none";
}

async function lockGmailAuthentication(
  transaction: DatabaseTransaction,
  providerAccountId: string,
) {
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`invook:gmail-auth:${providerAccountId}`}, 0))`,
  );
}

async function findGmailAuthenticationAccount(
  transaction: DatabaseTransaction,
  providerAccountId: string,
): Promise<GmailAuthenticationAccount | null> {
  const [account] = await transaction
    .select({
      id: connectedAccounts.id,
      userId: connectedAccounts.userId,
      status: connectedAccounts.status,
      replicaState: gmailReplicaStates.state,
      historyCursor: gmailReplicaStates.historyCursor,
    })
    .from(connectedAccounts)
    .leftJoin(
      gmailReplicaStates,
      eq(gmailReplicaStates.accountId, connectedAccounts.id),
    )
    .where(
      and(
        eq(connectedAccounts.provider, "gmail"),
        eq(connectedAccounts.providerAccountId, providerAccountId),
      ),
    )
    .limit(1);
  return account ?? null;
}

async function saveGmailCredential(
  transaction: DatabaseTransaction,
  input: GmailAuthenticationInput,
  accountId: string,
) {
  await transaction
    .insert(accountSecrets)
    .values({
      accountId,
      tokenCiphertext: input.tokenCiphertext,
      keyVersion: 1,
      refreshedAt: input.authenticatedAt,
    })
    .onConflictDoUpdate({
      target: accountSecrets.accountId,
      set: {
        tokenCiphertext: input.tokenCiphertext,
        keyVersion: 1,
        refreshedAt: input.authenticatedAt,
        updatedAt: new Date(),
      },
    });
}

async function saveGmailAccountAndCredential(
  transaction: DatabaseTransaction,
  input: GmailAuthenticationInput,
  accountId: string,
) {
  await transaction
    .update(connectedAccounts)
    .set({
      email: input.email,
      image: input.image,
      status: "connected",
      scopes: input.scopes,
      updatedAt: new Date(),
    })
    .where(eq(connectedAccounts.id, accountId));
  await saveGmailCredential(transaction, input, accountId);
}

async function saveStartedGmailWatch(
  transaction: DatabaseTransaction,
  input: {
    userId: string;
    accountId: string;
    watch: NewGmailConnectionInput["watch"];
  },
): Promise<void> {
  const [savedWatch] = await transaction
    .insert(gmailWatchStates)
    .values({
      accountId: input.accountId,
      topicName: input.watch.topicName,
      historyId: input.watch.historyId,
      expirationAt: input.watch.expirationAt,
      lastRenewedAt: input.watch.renewedAt,
    })
    .onConflictDoUpdate({
      target: gmailWatchStates.accountId,
      set: {
        topicName: input.watch.topicName,
        historyId: input.watch.historyId,
        expirationAt: input.watch.expirationAt,
        status: "active",
        lastRenewedAt: input.watch.renewedAt,
        lastError: null,
        updatedAt: input.watch.renewedAt,
      },
      setWhere: or(
        lt(gmailWatchStates.expirationAt, input.watch.expirationAt),
        and(
          eq(gmailWatchStates.expirationAt, input.watch.expirationAt),
          lte(gmailWatchStates.lastRenewedAt, input.watch.renewedAt),
        ),
      ),
    })
    .returning({ accountId: gmailWatchStates.accountId });
  if (!savedWatch) return;

  await enqueueDailyGmailWatchRenewal(
    {
      userId: input.userId,
      accountId: input.accountId,
      renewedAt: input.watch.renewedAt,
      expectedExpirationAt: input.watch.expirationAt,
    },
    transaction as unknown as Database,
  );
}

async function saveReturningGmailAuthentication(
  transaction: DatabaseTransaction,
  input: GmailAuthenticationInput,
  account: GmailAuthenticationAccount,
) {
  if (account.userId !== input.userId) {
    throw new Error("This Gmail account is already linked to another Invook user.");
  }
  await saveGmailAccountAndCredential(transaction, input, account.id);
  const authenticationAction = getReturningGmailAuthenticationAction({
    status: account.status,
    replicaState: account.replicaState,
    historyCursor: account.historyCursor,
    currentHistoryId: input.currentHistoryId,
  });

  if (authenticationAction === "repair") {
    await createRepairMailSyncRun(
      {
        userId: input.userId,
        accountId: account.id,
        startingHistoryCursor: input.currentHistoryId,
      },
      transaction as unknown as Database,
    );
  } else if (authenticationAction === "catchup") {
    const [activeCatchup] = await transaction
      .select({ id: workflowSteps.id })
      .from(workflowSteps)
      .where(
        and(
          eq(workflowSteps.accountId, account.id),
          eq(workflowSteps.stepType, "gmail.history.catchup"),
          inArray(workflowSteps.status, ["queued", "running"]),
        ),
      )
      .limit(1);
    if (!activeCatchup) {
      await enqueueWorkflowStep(
        {
          userId: input.userId,
          accountId: account.id,
          stepType: "gmail.history.catchup",
          payload: { reason: "oauth_reauthentication" },
          idempotencyKey: `gmail-history-reauth:${account.id}:${input.currentHistoryId}:${input.authenticatedAt.toISOString()}`,
        },
        transaction as unknown as Database,
      );
    }
  }
  await ensureBuiltInInvookLabels(
    { userId: input.userId, accountId: account.id },
    transaction,
  );
  return { id: account.id };
}

export async function refreshGmailAuthentication(
  input: GmailAuthenticationInput,
  database: Database = getDatabase(),
): Promise<{ id: string } | null> {
  return database.transaction(async (transaction) => {
    await lockGmailAuthentication(transaction, input.providerAccountId);
    const account = await findGmailAuthenticationAccount(
      transaction,
      input.providerAccountId,
    );
    if (!account) return null;
    return saveReturningGmailAuthentication(transaction, input, account);
  });
}

export async function saveNewGmailConnection(
  input: NewGmailConnectionInput,
  database: Database = getDatabase(),
): Promise<{ id: string; created: boolean }> {
  return database.transaction(async (transaction) => {
    await lockGmailAuthentication(transaction, input.providerAccountId);
    const existingAccount = await findGmailAuthenticationAccount(
      transaction,
      input.providerAccountId,
    );
    if (existingAccount) {
      const account = await saveReturningGmailAuthentication(
        transaction,
        input,
        existingAccount,
      );
      await saveStartedGmailWatch(transaction, {
        userId: input.userId,
        accountId: account.id,
        watch: input.watch,
      });
      return { ...account, created: false };
    }

    const [account] = await transaction
      .insert(connectedAccounts)
      .values({
        userId: input.userId,
        provider: "gmail",
        providerAccountId: input.providerAccountId,
        email: input.email,
        image: input.image,
        status: "connected",
        scopes: input.scopes,
        memoryAcknowledgedAt: input.authenticatedAt,
        syncState: initialSyncState,
      })
      .returning({ id: connectedAccounts.id });

    if (!account) throw new Error("The Gmail connection could not be saved.");

    await ensureBuiltInInvookLabels(
      { userId: input.userId, accountId: account.id },
      transaction,
    );

    await transaction
      .insert(gmailReplicaStates)
      .values({
        accountId: account.id,
        initialHistoryId: input.initialHistoryId,
        historyCursor: null,
        state: "pending",
      });
    await saveGmailCredential(transaction, input, account.id);

    await createInitialMailSyncRun(
      {
        userId: input.userId,
        accountId: account.id,
        startingHistoryCursor: input.initialHistoryId,
      },
      transaction as unknown as Database,
    );
    await saveStartedGmailWatch(transaction, {
      userId: input.userId,
      accountId: account.id,
      watch: input.watch,
    });

    return { ...account, created: true };
  });
}

export async function hasConnectedGmailAccount(
  userId: string,
  database: Database = getDatabase(),
): Promise<boolean> {
  const [account] = await database
    .select({ id: connectedAccounts.id })
    .from(connectedAccounts)
    .where(
      and(
        eq(connectedAccounts.userId, userId),
        eq(connectedAccounts.provider, "gmail"),
        eq(connectedAccounts.status, "connected"),
      ),
    )
    .limit(1);

  return Boolean(account);
}

export async function getMailboxSetupSummary(
  userId: string,
  database: Database = getDatabase(),
) {
  const [account] = await database
    .select({
      id: connectedAccounts.id,
      email: connectedAccounts.email,
      status: connectedAccounts.status,
      syncState: connectedAccounts.syncState,
      lastSyncedAt: connectedAccounts.lastSyncedAt,
      replicaState: gmailReplicaStates.state,
      replicaReadyAt: gmailReplicaStates.readyAt,
    })
    .from(connectedAccounts)
    .innerJoin(
      gmailReplicaStates,
      eq(gmailReplicaStates.accountId, connectedAccounts.id),
    )
    .where(
      and(
        eq(connectedAccounts.userId, userId),
        not(eq(connectedAccounts.status, "disconnected")),
      ),
    )
    .orderBy(desc(connectedAccounts.createdAt))
    .limit(1);

  if (!account) return null;

  const [[threadTotal], [messageTotal], [memoryTotal]] = await Promise.all([
    database
      .select({ value: count(threads.id) })
      .from(threads)
      .where(eq(threads.accountId, account.id)),
    database
      .select({ value: count(messages.id) })
      .from(messages)
      .innerJoin(threads, eq(messages.threadId, threads.id))
      .where(eq(threads.accountId, account.id)),
    database
      .select({ value: count(memoryEntries.id) })
      .from(memoryEntries)
      .where(eq(memoryEntries.accountId, account.id)),
  ]);

  return {
    account,
    threadCount: threadTotal?.value ?? 0,
    messageCount: messageTotal?.value ?? 0,
    memoryCount: memoryTotal?.value ?? 0,
  };
}

type SearchRow = {
  messageId: string;
  threadId: string;
  subject: string;
  snippet: string;
  bodyText: string;
  sender: { raw: string; email: string };
  sentAt: Date;
};

type RankedSearchRow = SearchRow & {
  fullTextMatch?: boolean;
  metadataMatch?: boolean;
  lexicalRank?: number;
  semanticSimilarity?: number;
};

export async function searchMailbox(
  input: {
    userId: string;
    query: string;
    limit?: number;
    embedding?: {
      values: number[];
      modelId: string;
      dimensions: number;
      indexVersion: number;
    };
  },
  database: Database = getDatabase(),
) {
  const query = input.query.trim();
  if (!query) return [];
  if (
    input.embedding &&
    input.embedding.dimensions !== MAIL_EMBEDDING_DIMENSIONS
  ) {
    throw new Error(
      `Mailbox search embeddings must have ${MAIL_EMBEDDING_DIMENSIONS} dimensions.`,
    );
  }
  const limit = Math.max(1, Math.min(input.limit ?? 20, 50));
  const candidateLimit = Math.max(limit * 3, 30);
  const tsQuery = sql`websearch_to_tsquery('simple', ${query})`;
  const fullTextMatch = sql<boolean>`${messages.searchDocument} @@ ${tsQuery}`;
  const metadataMatch = sql<boolean>`${messages.metadataSearchDocument} @@ ${tsQuery}`;

  const lexicalRows = await database
    .select({
      messageId: messages.id,
      threadId: threads.id,
      subject: messages.subject,
      snippet: threads.snippet,
      bodyText: messages.bodyText,
      sender: messages.sender,
      sentAt: messages.sentAt,
      fullTextMatch,
      metadataMatch,
      lexicalRank: sql<number>`greatest(
        ts_rank_cd(${messages.searchDocument}, ${tsQuery}),
        ts_rank_cd(${messages.metadataSearchDocument}, ${tsQuery})
      )`,
    })
    .from(messages)
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .innerJoin(connectedAccounts, eq(connectedAccounts.id, messages.accountId))
    .where(
      and(
        eq(messages.userId, input.userId),
        eq(threads.userId, input.userId),
        eq(connectedAccounts.userId, input.userId),
        eq(threads.accountId, connectedAccounts.id),
        eq(connectedAccounts.status, "connected"),
        visibleMessageCondition,
        or(fullTextMatch, metadataMatch),
      ),
    )
    .orderBy(
      desc(sql`greatest(
        ts_rank_cd(${messages.searchDocument}, ${tsQuery}),
        ts_rank_cd(${messages.metadataSearchDocument}, ${tsQuery})
      )`),
      desc(messages.sentAt),
    )
    .limit(candidateLimit);

  const attachmentRows = await database
    .select({
      messageId: messages.id,
      threadId: threads.id,
      subject: messages.subject,
      snippet: threads.snippet,
      bodyText: messages.bodyText,
      sender: messages.sender,
      sentAt: messages.sentAt,
    })
    .from(messageAttachments)
    .innerJoin(messages, eq(messages.id, messageAttachments.messageId))
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .innerJoin(connectedAccounts, eq(connectedAccounts.id, messages.accountId))
    .where(
      and(
        eq(messageAttachments.userId, input.userId),
        eq(messages.userId, input.userId),
        eq(threads.userId, input.userId),
        eq(connectedAccounts.userId, input.userId),
        eq(messageAttachments.accountId, connectedAccounts.id),
        eq(threads.accountId, connectedAccounts.id),
        eq(connectedAccounts.status, "connected"),
        visibleMessageCondition,
        sql`${messageAttachments.filenameSearchDocument} @@ ${tsQuery}`,
      ),
    )
    .orderBy(desc(messages.sentAt))
    .limit(candidateLimit);

  const semanticRows: RankedSearchRow[] = input.embedding
    ? await database
        .select({
          messageId: messages.id,
          threadId: threads.id,
          subject: messages.subject,
          snippet: threads.snippet,
          bodyText: messages.bodyText,
          sender: messages.sender,
          sentAt: messages.sentAt,
          semanticSimilarity: sql<number>`1 - (${messageEmbeddings.embedding} <=> ${`[${input.embedding.values.join(",")}]`}::vector(1536))`,
        })
        .from(messageEmbeddings)
        .innerJoin(messages, eq(messages.id, messageEmbeddings.messageId))
        .innerJoin(threads, eq(threads.id, messages.threadId))
        .innerJoin(connectedAccounts, eq(connectedAccounts.id, messages.accountId))
        .innerJoin(
          gmailReplicaStates,
          eq(gmailReplicaStates.accountId, connectedAccounts.id),
        )
        .where(
          and(
            eq(messageEmbeddings.userId, input.userId),
            eq(messages.userId, input.userId),
            eq(threads.userId, input.userId),
            eq(connectedAccounts.userId, input.userId),
            eq(threads.accountId, connectedAccounts.id),
            eq(connectedAccounts.status, "connected"),
            visibleMessageCondition,
            eq(gmailReplicaStates.state, "ready"),
            eq(messageEmbeddings.modelId, input.embedding.modelId),
            eq(messageEmbeddings.dimensions, input.embedding.dimensions),
            eq(messageEmbeddings.indexVersion, input.embedding.indexVersion),
            eq(messageEmbeddings.status, "complete"),
            isNotNull(messageEmbeddings.embedding),
          ),
        )
        .orderBy(
          asc(
            sql`${messageEmbeddings.embedding} <=> ${`[${input.embedding.values.join(",")}]`}::vector(1536)`,
          ),
        )
        .limit(candidateLimit)
    : [];

  const results = new Map<
    string,
    SearchRow & { score: number; matches: Set<string> }
  >();
  const merge = (
    row: SearchRow,
    match: "full_text" | "metadata" | "attachment" | "semantic",
    score: number,
  ) => {
    const existing = results.get(row.messageId);
    if (!existing) {
      results.set(row.messageId, {
        ...row,
        score,
        matches: new Set([match]),
      });
      return;
    }
    existing.matches.add(match);
    existing.score = Math.min(1, Math.max(existing.score, score) + 0.08);
  };

  for (const row of lexicalRows) {
    const rank = Number(row.lexicalRank);
    const normalizedRank = Number.isFinite(rank) ? rank / (rank + 1) : 0;
    if (row.fullTextMatch) merge(row, "full_text", 0.55 + 0.35 * normalizedRank);
    if (row.metadataMatch) merge(row, "metadata", 0.48 + 0.3 * normalizedRank);
  }
  for (const row of attachmentRows) merge(row, "attachment", 0.9);
  for (const row of semanticRows) {
    const similarity = Number(row.semanticSimilarity);
    const normalized = Number.isFinite(similarity)
      ? Math.max(0, Math.min(1, (similarity + 1) / 2))
      : 0;
    merge(row, "semantic", normalized * 0.82);
  }

  const ranked = [...results.values()]
    .sort(
      (left, right) =>
        right.score - left.score || right.sentAt.getTime() - left.sentAt.getTime(),
    )
    .slice(0, limit);
  const messageIds = ranked.map((row) => row.messageId);
  const attachments =
    messageIds.length > 0
      ? await database
          .select({
            id: messageAttachments.id,
            messageId: messageAttachments.messageId,
            providerAttachmentId: messageAttachments.providerAttachmentId,
            filename: messageAttachments.filename,
            mimeType: messageAttachments.mimeType,
            size: messageAttachments.size,
            contentId: messageAttachments.contentId,
            contentDisposition: messageAttachments.contentDisposition,
            checksumSha256: messageAttachments.checksumSha256,
            contentLength: messageAttachments.contentLength,
          })
          .from(messageAttachments)
          .where(inArray(messageAttachments.messageId, messageIds))
          .orderBy(asc(messageAttachments.filename))
      : [];

  return ranked.map((row) => ({
    messageId: row.messageId,
    threadId: row.threadId,
    subject: row.subject,
    snippet: row.snippet,
    bodyPreview: row.bodyText.slice(0, 800),
    sender: row.sender,
    sentAt: row.sentAt,
    attachments: attachments.filter(
      (attachment) => attachment.messageId === row.messageId,
    ),
    matches: [...row.matches] as Array<
      "full_text" | "metadata" | "attachment" | "semantic"
    >,
    score: row.score,
  }));
}

export async function getMailboxThreadForAgent(
  userId: string,
  threadId: string,
  database: Database = getDatabase(),
) {
  const [thread] = await database
    .select({
      id: threads.id,
      subject: threads.subject,
      participants: threads.participants,
    })
    .from(threads)
    .innerJoin(connectedAccounts, eq(connectedAccounts.id, threads.accountId))
    .where(
      and(
        eq(threads.id, threadId),
        eq(threads.userId, userId),
        eq(connectedAccounts.userId, userId),
        eq(connectedAccounts.status, "connected"),
        visibleThreadCondition(),
      ),
    )
    .limit(1);
  if (!thread) return null;

  const threadMessages = await database
    .select({
      id: messages.id,
      direction: messages.direction,
      sender: messages.sender,
      recipients: messages.recipients,
      bodyText: messages.bodyText,
      sentAt: messages.sentAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.threadId, thread.id),
        eq(messages.userId, userId),
        visibleMessageCondition,
      ),
    )
    .orderBy(asc(messages.sentAt));
  const messageIds = threadMessages.map((message) => message.id);
  const attachmentRows =
    messageIds.length > 0
      ? await database
          .select({
            id: messageAttachments.id,
            messageId: messageAttachments.messageId,
            filename: messageAttachments.filename,
            mimeType: messageAttachments.mimeType,
            size: messageAttachments.size,
          })
          .from(messageAttachments)
          .where(
            and(
              eq(messageAttachments.userId, userId),
              inArray(messageAttachments.messageId, messageIds),
            ),
          )
          .orderBy(asc(messageAttachments.filename))
      : [];

  return {
    ...thread,
    messages: threadMessages.map((message) => ({
      ...message,
      attachments: attachmentRows.filter(
        (attachment) => attachment.messageId === message.id,
      ),
    })),
  };
}

export async function listMailboxThreadAttachments(
  userId: string,
  threadId: string,
  database: Database = getDatabase(),
) {
  return database
    .select({
      id: messageAttachments.id,
      messageId: messageAttachments.messageId,
      filename: messageAttachments.filename,
      mimeType: messageAttachments.mimeType,
      size: messageAttachments.size,
    })
    .from(messageAttachments)
    .innerJoin(messages, eq(messages.id, messageAttachments.messageId))
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .innerJoin(connectedAccounts, eq(connectedAccounts.id, messages.accountId))
    .where(
      and(
        eq(messageAttachments.userId, userId),
        eq(messages.userId, userId),
        eq(threads.id, threadId),
        eq(threads.userId, userId),
        eq(connectedAccounts.userId, userId),
        eq(messageAttachments.accountId, connectedAccounts.id),
        eq(threads.accountId, connectedAccounts.id),
        eq(connectedAccounts.status, "connected"),
        visibleMessageCondition,
      ),
    )
    .orderBy(asc(messageAttachments.filename));
}

export type MailboxAttachmentDownload = {
  id: string;
  filename: string;
  mimeType: string | null;
  objectKey: string | null;
  checksumSha256: string | null;
  contentLength: number | null;
  etag: string | null;
};

export async function getMailboxAttachmentDownloadForUser(
  input: { userId: string; attachmentId: string },
  database: Database = getDatabase(),
): Promise<MailboxAttachmentDownload | null> {
  const [attachment] = await database
    .select({
      id: messageAttachments.id,
      filename: messageAttachments.filename,
      mimeType: messageAttachments.mimeType,
      objectKey: messageAttachments.objectKey,
      checksumSha256: messageAttachments.checksumSha256,
      contentLength: messageAttachments.contentLength,
      etag: messageAttachments.etag,
    })
    .from(messageAttachments)
    .innerJoin(messages, eq(messages.id, messageAttachments.messageId))
    .where(
      and(
        eq(messageAttachments.id, input.attachmentId),
        eq(messageAttachments.userId, input.userId),
        eq(messages.userId, input.userId),
        visibleMessageCondition,
      ),
    )
    .limit(1);
  return attachment ?? null;
}

export async function getMailSyncProgressForAccount(
  input: { accountId: string },
  database: Database = getDatabase(),
): Promise<MailSyncProgress | null> {
  const [account] = await database
    .select({ syncState: connectedAccounts.syncState })
    .from(connectedAccounts)
    .where(eq(connectedAccounts.id, input.accountId))
    .limit(1);
  if (!account) return null;

  const isActive =
    account.syncState.mailSync === "pending" ||
    account.syncState.mailSync === "running";
  const runStatusCondition = isActive
    ? inArray(mailSyncRuns.status, ["queued", "running"])
    : eq(
        mailSyncRuns.status,
        account.syncState.mailSync === "complete" ? "complete" : "failed",
      );
  const [run] = await database
    .select({
      discoveryComplete: mailSyncRuns.discoveryComplete,
      discoveredThreadCount: mailSyncRuns.discoveredThreadCount,
      processedThreadCount: mailSyncRuns.processedThreadCount,
      failedThreadCount: mailSyncRuns.failedThreadCount,
    })
    .from(mailSyncRuns)
    .where(and(eq(mailSyncRuns.accountId, input.accountId), runStatusCondition))
    .orderBy(desc(mailSyncRuns.createdAt))
    .limit(1);

  return deriveMailSyncProgress({
    state: account.syncState.mailSync,
    run: run ?? null,
  });
}

export async function getAccountSyncStateForAccount(
  input: { accountId: string },
  database: Database = getDatabase(),
): Promise<AccountSyncState | null> {
  const [account] = await database
    .select({ syncState: connectedAccounts.syncState })
    .from(connectedAccounts)
    .where(eq(connectedAccounts.id, input.accountId))
    .limit(1);

  return account?.syncState ?? null;
}

async function getIndexingProgressWithExecutor(
  input: {
    accountId: string;
    modelId: string | null;
    indexVersion: number;
  },
  database: DatabaseExecutor,
): Promise<IndexingProgress | null> {
  const [account] = await database
    .select({
      accountId: connectedAccounts.id,
      accountStatus: connectedAccounts.status,
      syncState: connectedAccounts.syncState,
      replicaState: gmailReplicaStates.state,
    })
    .from(connectedAccounts)
    .innerJoin(
      gmailReplicaStates,
      eq(gmailReplicaStates.accountId, connectedAccounts.id),
    )
    .where(eq(connectedAccounts.id, input.accountId))
    .limit(1);
  if (!account) return null;

  const [counts] = input.modelId
    ? await database
        .select({
          totalMessageCount: count(messages.id),
          completedMessageCount: count(
            sql`case when ${messageEmbeddings.status} = 'complete'
              and ${messageEmbeddings.contentHash} = ${messages.embeddingContentHash}
              and ${messageEmbeddings.dimensions} = ${MAIL_EMBEDDING_DIMENSIONS}
              and ${messageEmbeddings.embedding} is not null
              then 1 end`,
          ),
          failedMessageCount: count(
            sql`case when ${messageEmbeddings.status} = 'failed'
              and ${messageEmbeddings.contentHash} = ${messages.embeddingContentHash}
              and ${messageEmbeddings.dimensions} = ${MAIL_EMBEDDING_DIMENSIONS}
              then 1 end`,
          ),
        })
        .from(messages)
        .leftJoin(
          messageEmbeddings,
          and(
            eq(messageEmbeddings.messageId, messages.id),
            eq(messageEmbeddings.modelId, input.modelId),
            eq(messageEmbeddings.indexVersion, input.indexVersion),
          ),
        )
        .where(eq(messages.accountId, input.accountId))
    : await database
        .select({
          totalMessageCount: count(messages.id),
          completedMessageCount: sql<number>`0`,
          failedMessageCount: sql<number>`0`,
        })
        .from(messages)
        .where(eq(messages.accountId, input.accountId));
  const prerequisites: IndexingPrerequisiteState = {
    accountStatus: account.accountStatus,
    mailSyncStage: account.syncState.mailSync,
    replicaState: account.replicaState,
  };
  return deriveIndexingProgress({
    persistedStage: account.syncState.indexing,
    prerequisites,
    isModelConfigured: input.modelId !== null,
    completedMessageCount: counts?.completedMessageCount ?? 0,
    failedMessageCount: counts?.failedMessageCount ?? 0,
    totalMessageCount: counts?.totalMessageCount ?? 0,
  });
}

export async function getIndexingProgressForAccount(
  input: {
    accountId: string;
    modelId: string | null;
    indexVersion: number;
  },
  database: Database = getDatabase(),
): Promise<IndexingProgress | null> {
  return getIndexingProgressWithExecutor(input, database);
}

export async function getIndexingProgressForUser(
  input: { userId: string; modelId: string | null; indexVersion: number },
  database: Database = getDatabase(),
): Promise<{ accountId: string; progress: IndexingProgress } | null> {
  const [account] = await database
    .select({ accountId: connectedAccounts.id })
    .from(connectedAccounts)
    .where(
      and(
        eq(connectedAccounts.userId, input.userId),
        not(eq(connectedAccounts.status, "disconnected")),
      ),
    )
    .orderBy(desc(connectedAccounts.createdAt))
    .limit(1);

  if (!account) return null;
  const progress = await getIndexingProgressWithExecutor(
    {
      accountId: account.accountId,
      modelId: input.modelId,
      indexVersion: input.indexVersion,
    },
    database,
  );
  return progress ? { accountId: account.accountId, progress } : null;
}

export async function getWorkerAccount(
  accountId: string,
  database: Database = getDatabase(),
) {
  const [account] = await database
    .select({
      id: connectedAccounts.id,
      userId: connectedAccounts.userId,
      email: connectedAccounts.email,
      status: connectedAccounts.status,
      historyCursor: gmailReplicaStates.historyCursor,
      initialHistoryId: gmailReplicaStates.initialHistoryId,
      replicaState: gmailReplicaStates.state,
      syncState: connectedAccounts.syncState,
      tokenCiphertext: accountSecrets.tokenCiphertext,
    })
    .from(connectedAccounts)
    .innerJoin(accountSecrets, eq(accountSecrets.accountId, connectedAccounts.id))
    .innerJoin(
      gmailReplicaStates,
      eq(gmailReplicaStates.accountId, connectedAccounts.id),
    )
    .where(eq(connectedAccounts.id, accountId))
    .limit(1);

  return account ?? null;
}

export async function updateStoredCredential(
  accountId: string,
  tokenCiphertext: string,
  database: Database = getDatabase(),
) {
  await database
    .update(accountSecrets)
    .set({ tokenCiphertext, refreshedAt: new Date(), updatedAt: new Date() })
    .where(eq(accountSecrets.accountId, accountId));
}

export async function setAccountSyncState(
  accountId: string,
  syncState: AccountSyncState,
  database: Database = getDatabase(),
) {
  await database.transaction(async (transaction) => {
    await transaction
      .update(connectedAccounts)
      .set({ syncState, updatedAt: new Date() })
      .where(eq(connectedAccounts.id, accountId));
    await transaction.execute(
      sql`select pg_notify('invook_account_sync', ${JSON.stringify({ accountId })})`,
    );
  });
}

async function lockEmbeddingIndex(
  transaction: DatabaseTransaction,
  accountId: string,
): Promise<void> {
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`embedding-index:${accountId}`}, 0))`,
  );
}

async function upsertMailboxMessageWithTransaction(
  input: IndexedMessage,
  transaction: DatabaseTransaction,
  activeRunId?: string,
) {
    if (activeRunId) {
      const [activeRun] = await transaction
        .select({ id: mailSyncRuns.id })
        .from(mailSyncRuns)
        .innerJoin(
          connectedAccounts,
          eq(connectedAccounts.id, mailSyncRuns.accountId),
        )
        .where(
          and(
            eq(mailSyncRuns.id, activeRunId),
            eq(mailSyncRuns.accountId, input.accountId),
            inArray(mailSyncRuns.status, ["queued", "running"]),
            eq(connectedAccounts.status, "connected"),
          ),
        )
        .for("update")
        .limit(1);
      if (!activeRun) throw new InactiveMailSyncRunError(activeRunId);
    }
    if (input.ingestionMode === "incremental") {
      await lockEmbeddingIndex(transaction, input.accountId);
    }
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${input.accountId}:${input.providerThreadId}`}, 0))`,
    );
    const [existingThread] = await transaction
      .select({ id: threads.id })
      .from(threads)
      .where(
        and(
          eq(threads.accountId, input.accountId),
          eq(threads.providerThreadId, input.providerThreadId),
        ),
      )
      .limit(1);

    let threadId = existingThread?.id;
    if (!threadId) {
      const [insertedThread] = await transaction
      .insert(threads)
        .values({
          userId: input.userId,
          accountId: input.accountId,
          providerThreadId: input.providerThreadId,
          subject: input.subject,
          snippet: input.snippet,
          participants: input.participants,
          latestMessageAt: input.sentAt,
        })
        .onConflictDoNothing({
          target: [threads.accountId, threads.providerThreadId],
        })
        .returning({ id: threads.id });

      threadId = insertedThread?.id;
      if (!threadId) {
        const [concurrentThread] = await transaction
          .select({ id: threads.id })
          .from(threads)
          .where(
            and(
              eq(threads.accountId, input.accountId),
              eq(threads.providerThreadId, input.providerThreadId),
            ),
          )
          .limit(1);
        threadId = concurrentThread?.id;
      }
    }

    if (!threadId) throw new Error("The Gmail thread could not be stored.");

    const [threadEligibilityBefore] = await transaction
      .select({ isInbox: inboxThreadCondition() })
      .from(threads)
      .where(eq(threads.id, threadId))
      .limit(1);

    const [existingMessage] = await transaction
      .select({
        id: messages.id,
        direction: messages.direction,
        sender: messages.sender,
        recipients: messages.recipients,
        providerHistoryId: messages.providerHistoryId,
        internalDate: messages.internalDate,
        sizeEstimate: messages.sizeEstimate,
        headerLines: messages.headerLines,
        subject: messages.subject,
        snippet: messages.snippet,
        bodyText: messages.bodyText,
        bodyHtml: messages.bodyHtml,
        sentAt: messages.sentAt,
        isMemoryEligible: messages.isMemoryEligible,
        embeddingContentHash: messages.embeddingContentHash,
      })
      .from(messages)
      .where(
        and(
          eq(messages.threadId, threadId),
          eq(messages.providerMessageId, input.providerMessageId),
        ),
      )
      .limit(1);
    const existingMemberships = existingMessage
      ? await transaction
          .select({ providerLabelId: labels.providerLabelId })
          .from(messageLabels)
          .innerJoin(labels, eq(labels.id, messageLabels.labelId))
          .where(
            and(
              eq(messageLabels.messageId, existingMessage.id),
              eq(labels.kind, "gmail"),
            ),
          )
      : [];
    const currentGmailLabelIds = existingMemberships.flatMap((membership) =>
      membership.providerLabelId ? [membership.providerLabelId] : [],
    );
    const contentHash = createMessageContentHash(input);
    const contentChanged =
      !existingMessage || existingMessage.embeddingContentHash !== contentHash;
    const storedDataChanged =
      !existingMessage ||
      existingMessage.direction !== input.direction ||
      !equalSender(existingMessage.sender, input.sender) ||
      !equalStringArrays(existingMessage.recipients, input.recipients) ||
      existingMessage.providerHistoryId !== input.providerHistoryId ||
      existingMessage.internalDate.getTime() !== input.internalDate.getTime() ||
      existingMessage.sizeEstimate !== input.sizeEstimate ||
      JSON.stringify(existingMessage.headerLines) !==
        JSON.stringify(input.headerLines) ||
      existingMessage.subject !== input.subject ||
      existingMessage.bodyText !== input.bodyText ||
      existingMessage.bodyHtml !== input.bodyHtml ||
      existingMessage.sentAt.getTime() !== input.sentAt.getTime() ||
      existingMessage.isMemoryEligible !== input.isMemoryEligible;
    const changed =
      storedDataChanged ||
      !equalStringArrays(
        currentGmailLabelIds,
        input.gmailLabels.map((label) => label.providerLabelId),
      ) ||
      (existingMessage?.snippet ?? "") !== input.snippet;

    let messageId = existingMessage?.id;
    if (changed) {
      const [storedMessage] = await transaction
        .insert(messages)
        .values({
          userId: input.userId,
          accountId: input.accountId,
          threadId,
          providerMessageId: input.providerMessageId,
          direction: input.direction,
          sender: input.sender,
          recipients: input.recipients,
          providerHistoryId: input.providerHistoryId,
          internalDate: input.internalDate,
          sizeEstimate: input.sizeEstimate,
          headerLines: input.headerLines,
          subject: input.subject,
          snippet: input.snippet,
          bodyText: input.bodyText,
          embeddingContentHash: contentHash,
          bodyHtml: input.bodyHtml,
          sentAt: input.sentAt,
          isMemoryEligible: input.isMemoryEligible,
        })
        .onConflictDoUpdate({
          target: [messages.threadId, messages.providerMessageId],
          set: {
            direction: input.direction,
            sender: input.sender,
            recipients: input.recipients,
            providerHistoryId: input.providerHistoryId,
            internalDate: input.internalDate,
            sizeEstimate: input.sizeEstimate,
            headerLines: input.headerLines,
            subject: input.subject,
            snippet: input.snippet,
            bodyText: input.bodyText,
            embeddingContentHash: contentHash,
            bodyHtml: input.bodyHtml,
            sentAt: input.sentAt,
            isMemoryEligible: input.isMemoryEligible,
            updatedAt: new Date(),
          },
        })
        .returning({ id: messages.id });
      messageId = storedMessage?.id;
      if (!storedMessage || !messageId) {
        throw new Error("The Gmail message could not be stored.");
      }

      const requestedGmailLabels = Array.from(
        new Map(
          input.gmailLabels.map((label) => [label.providerLabelId, label]),
        ).values(),
      );
      const requestedProviderLabelIds = requestedGmailLabels.map(
        (label) => label.providerLabelId,
      );
      let providerLabels: Array<{ id: string; providerLabelId: string }> = [];
      if (requestedProviderLabelIds.length > 0) {
        await transaction
          .insert(labels)
          .values(
            requestedGmailLabels.map((label) => ({
              userId: input.userId,
              accountId: input.accountId,
              kind: "gmail" as const,
              providerLabelId: label.providerLabelId,
              name: label.name,
              normalizedName: label.name.toLowerCase(),
              description: "",
              providerType: "system" as const,
            })),
          )
          .onConflictDoUpdate({
            target: [labels.accountId, labels.providerLabelId],
            targetWhere: isNotNull(labels.providerLabelId),
            set: {
              name: sql`excluded.name`,
              normalizedName: sql`excluded.normalized_name`,
              providerType: "system",
              updatedAt: new Date(),
            },
          });
        const providerLabelRows = await transaction
          .select({
            id: labels.id,
            providerLabelId: labels.providerLabelId,
          })
          .from(labels)
          .where(
            and(
              eq(labels.accountId, input.accountId),
              eq(labels.kind, "gmail"),
              inArray(labels.providerLabelId, requestedProviderLabelIds),
            ),
          );
        providerLabels = providerLabelRows.flatMap((label) =>
          label.providerLabelId
            ? [{ id: label.id, providerLabelId: label.providerLabelId }]
            : [],
        );
      }
      await transaction
        .delete(messageLabels)
        .where(
          and(
            eq(messageLabels.messageId, messageId),
            eq(messageLabels.source, "gmail"),
          ),
        );
      if (providerLabels.length > 0) {
        await transaction.insert(messageLabels).values(
          providerLabels.map((label) => ({
            userId: input.userId,
            accountId: input.accountId,
            messageId,
            labelId: label.id,
            source: "gmail" as const,
          })),
        );
      }

      if (contentChanged && input.ingestionMode === "incremental") {
        await transaction
          .delete(memoryPendingEvidence)
          .where(eq(memoryPendingEvidence.messageId, messageId));
        if (input.direction === "outgoing" && input.isMemoryEligible) {
          const contactEmails = Array.from(
            new Set(input.memoryContactEmails.map(normalizeContactEmail).filter(Boolean)),
          ) as string[];
          await transaction
            .insert(memoryPendingEvidence)
            .values([
              {
                userId: input.userId,
                accountId: input.accountId,
                threadId,
                messageId,
                scope: "global" as const,
                contactEmail: "",
                schemaVersion: MEMORY_SCHEMA_VERSION,
              },
              ...contactEmails.map((contactEmail) => ({
                userId: input.userId,
                accountId: input.accountId,
                threadId,
                messageId,
                scope: "contact" as const,
                contactEmail,
                schemaVersion: MEMORY_SCHEMA_VERSION,
              })),
            ])
            .onConflictDoNothing({
              target: [
                memoryPendingEvidence.messageId,
                memoryPendingEvidence.scope,
                memoryPendingEvidence.contactEmail,
              ],
            });
        }
      }

      await transaction
        .delete(messageAttachments)
        .where(eq(messageAttachments.messageId, messageId));
      const attachments = input.attachments ?? [];
      if (attachments.length > 0) {
        await transaction.insert(messageAttachments).values(
          attachments.map((attachment) => ({
            userId: input.userId,
            accountId: input.accountId,
            messageId,
            providerAttachmentId: attachment.providerAttachmentId,
            mimePartPath: attachment.mimePartPath,
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            contentId: attachment.contentId,
            contentDisposition: attachment.contentDisposition,
            size: attachment.size,
            objectKey: attachment.objectKey,
            checksumSha256: attachment.checksumSha256,
            contentLength: attachment.contentLength,
            etag: attachment.etag,
          })),
        );
      }

      if (contentChanged) {
        await transaction
          .delete(messageEmbeddings)
          .where(
            and(
              eq(messageEmbeddings.messageId, messageId),
              ne(messageEmbeddings.contentHash, contentHash),
            ),
          );
        if (input.ingestionMode === "incremental") {
          await enqueueWorkflowStep(
            {
              userId: input.userId,
              accountId: input.accountId,
              stepType: "embedding.incremental",
              payload: { messageId },
              idempotencyKey: `embedding.incremental:${messageId}:${contentHash}`,
            },
            transaction as unknown as Database,
          );
          const [indexingChanged] = await transaction
            .update(connectedAccounts)
            .set({
              syncState: sql`jsonb_set(${connectedAccounts.syncState}, '{indexing}', to_jsonb(${"running"}::text), true)`,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(connectedAccounts.id, input.accountId),
                sql`${connectedAccounts.syncState}->>'mailSync' = 'complete'`,
                sql`${connectedAccounts.syncState}->>'indexing' = 'complete'`,
                sql`exists (
                  select 1
                  from ${gmailReplicaStates}
                  where ${gmailReplicaStates.accountId} = ${input.accountId}
                    and ${gmailReplicaStates.state} = 'ready'
                )`,
              ),
            )
            .returning({ id: connectedAccounts.id });
          if (indexingChanged) {
            await transaction.execute(
              sql`select pg_notify('invook_account_sync', ${JSON.stringify({ accountId: input.accountId })})`,
            );
          }
        }
      }
    }

    if (changed) {
      await refreshThreadProjection(transaction, threadId, {
        incrementContentVersion: contentChanged,
      });
      const [currentThread] = await transaction
        .select({
          isInbox: inboxThreadCondition(),
          assignmentId: threadLabelAssignments.id,
          assignmentSource: threadLabelAssignments.source,
        })
        .from(threads)
        .leftJoin(
          threadLabelAssignments,
          eq(threadLabelAssignments.threadId, threads.id),
        )
        .where(eq(threads.id, threadId))
        .limit(1);
      const shouldPlanIncrementalLabel =
        input.ingestionMode === "incremental" &&
        currentThread?.isInbox &&
        !currentThread.assignmentId &&
        (contentChanged || !threadEligibilityBefore?.isInbox);
      const shouldRefreshSnapshotLabel =
        Boolean(activeRunId) &&
        currentThread?.isInbox &&
        currentThread.assignmentSource !== "user" &&
        (contentChanged || !threadEligibilityBefore?.isInbox);
      if (shouldPlanIncrementalLabel || shouldRefreshSnapshotLabel) {
        await transaction
          .update(threads)
          .set({
            labelAnalysisVersion: sql`${threads.labelAnalysisVersion} + 1`,
            labelAnalysisState: "pending",
            labelAnalysisError: null,
            labelAnalyzedAt: null,
            updatedAt: new Date(),
          })
          .where(eq(threads.id, threadId));
      }
    }

    return { messageId, threadId, changed };
}

export async function upsertMailboxMessage(
  input: IndexedMessage,
  database: Database = getDatabase(),
  activeRunId?: string,
) {
  return database.transaction((transaction) =>
    upsertMailboxMessageWithTransaction(input, transaction, activeRunId),
  );
}

export async function upsertMailboxThreadMessages(
  input: { messages: IndexedMessage[]; activeRunId: string },
  database: Database = getDatabase(),
): Promise<{ threadId: string; changed: boolean }> {
  if (input.messages.length === 0) {
    throw new Error("A Gmail thread must contain at least one message.");
  }
  const [firstMessage] = input.messages;
  if (!firstMessage) {
    throw new Error("A Gmail thread must contain at least one message.");
  }
  if (
    input.messages.some(
      (message) =>
        message.userId !== firstMessage.userId ||
        message.accountId !== firstMessage.accountId ||
        message.providerThreadId !== firstMessage.providerThreadId ||
        message.ingestionMode !== "initial",
    )
  ) {
    throw new Error("A Gmail thread batch has inconsistent message ownership.");
  }

  return database.transaction(async (transaction) => {
    let threadId: string | null = null;
    let changed = false;
    for (const message of input.messages) {
      const stored = await upsertMailboxMessageWithTransaction(
        message,
        transaction,
        input.activeRunId,
      );
      if (threadId && stored.threadId !== threadId) {
        throw new Error("Gmail thread messages mapped to different local threads.");
      }
      threadId = stored.threadId;
      changed ||= stored.changed;
    }
    if (!threadId) throw new Error("The Gmail thread stored no messages.");
    const completed = await completeMailSyncThreadWithExecutor(
      {
        runId: input.activeRunId,
        providerThreadId: firstMessage.providerThreadId,
      },
      transaction,
    );
    if (!completed) throw new InactiveMailSyncRunError(input.activeRunId);
    return { threadId, changed };
  });
}

export async function deleteIndexedMessage(
  input: {
    accountId: string;
    providerMessageId: string;
    providerHistoryId?: string | null;
  },
  database: Database = getDatabase(),
) {
  return database.transaction(async (transaction) => {
    await lockEmbeddingIndex(transaction, input.accountId);
    const [storedMessage] = await transaction
      .select({
        id: messages.id,
        userId: messages.userId,
        threadId: messages.threadId,
        providerThreadId: threads.providerThreadId,
        providerHistoryId: messages.providerHistoryId,
        assignmentId: threadLabelAssignments.id,
        updatedAt: messages.updatedAt,
      })
      .from(messages)
      .innerJoin(threads, eq(threads.id, messages.threadId))
      .leftJoin(
        threadLabelAssignments,
        eq(threadLabelAssignments.threadId, threads.id),
      )
      .where(
        and(
          eq(threads.accountId, input.accountId),
          eq(messages.providerMessageId, input.providerMessageId),
        ),
      )
      .limit(1);
    if (!storedMessage) {
      return { changed: false, threadId: null, wasVisible: false };
    }

    const attachmentObjects = await transaction
      .select({ objectKey: messageAttachments.objectKey })
      .from(messageAttachments)
      .where(eq(messageAttachments.messageId, storedMessage.id));
    const objectKeys = attachmentObjects
      .map((attachment) => attachment.objectKey)
      .filter((key): key is string => Boolean(key))
      .sort();
    await enqueueWorkflowStepWithExecutor(
      {
        userId: storedMessage.userId,
        accountId: input.accountId,
        stepType: "gmail.objects.delete",
        payload: {
          manifest: {
            providerMessageId: input.providerMessageId,
            providerThreadId: storedMessage.providerThreadId,
            providerHistoryId:
              input.providerHistoryId ?? storedMessage.providerHistoryId,
            objectKeys,
          },
        },
        idempotencyKey: `gmail-object-delete:${input.accountId}:${input.providerMessageId}:${storedMessage.updatedAt.toISOString()}`,
        maxAttempts: 10,
      },
      transaction,
    );

    await transaction.delete(messages).where(eq(messages.id, storedMessage.id));
    await refreshThreadProjection(transaction, storedMessage.threadId);

    return {
      changed: true,
      threadId: storedMessage.threadId,
      objectKeys,
      wasVisible: storedMessage.assignmentId !== null,
    };
  });
}

export async function getIndexedMessageIds(
  accountId: string,
  database: Database = getDatabase(),
) {
  const storedMessages = await database
    .select({ providerMessageId: messages.providerMessageId })
    .from(messages)
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .where(eq(threads.accountId, accountId));
  return storedMessages.map((message) => message.providerMessageId);
}

export async function getStoredProviderMessageIds(
  input: { accountId: string; providerMessageIds: string[] },
  database: Database = getDatabase(),
): Promise<string[]> {
  if (input.providerMessageIds.length === 0) return [];
  const storedMessages = await database
    .select({ providerMessageId: messages.providerMessageId })
    .from(messages)
    .where(
      and(
        eq(messages.accountId, input.accountId),
        inArray(messages.providerMessageId, input.providerMessageIds),
      ),
    );
  return storedMessages.map((message) => message.providerMessageId);
}

export function createMessageContentHash(
  input: Pick<
    MailboxMessage,
    "direction" | "sender" | "recipients" | "subject" | "bodyText"
  >,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        direction: input.direction,
        sender: input.sender,
        recipients: input.recipients,
        subject: input.subject.trim(),
        bodyText: input.bodyText.trim(),
      }),
    )
    .digest("hex");
}

export async function replaceGmailMessageLabels(
  input: {
    userId: string;
    accountId: string;
    providerMessageId: string;
    providerHistoryId: string | null;
    gmailLabels: Array<{ providerLabelId: string; name: string }>;
  },
  database: Database = getDatabase(),
): Promise<{
  found: boolean;
  changed: boolean;
  threadId: string | null;
  isVisible: boolean;
}> {
  return database.transaction(async (transaction) => {
    const [message] = await transaction
      .select({
        id: messages.id,
        threadId: messages.threadId,
      })
      .from(messages)
      .where(
        and(
          eq(messages.accountId, input.accountId),
          eq(messages.providerMessageId, input.providerMessageId),
        ),
      )
      .for("update")
      .limit(1);
    if (!message) {
      return { found: false, changed: false, threadId: null, isVisible: false };
    }
    const [threadBefore] = await transaction
      .select({
        isInbox: inboxThreadCondition(),
        assignmentId: threadLabelAssignments.id,
      })
      .from(threads)
      .leftJoin(
        threadLabelAssignments,
        eq(threadLabelAssignments.threadId, threads.id),
      )
      .where(eq(threads.id, message.threadId))
      .limit(1);

    const requestedProviderLabelIds = Array.from(
      new Set(input.gmailLabels.map((label) => label.providerLabelId)),
    );
    if (input.gmailLabels.length > 0) {
      await transaction
        .insert(labels)
        .values(
          input.gmailLabels.map((label) => ({
            userId: input.userId,
            accountId: input.accountId,
            kind: "gmail" as const,
            providerLabelId: label.providerLabelId,
            name: label.name,
            normalizedName: label.name.toLowerCase(),
            description: "",
            providerType: "system" as const,
          })),
        )
        .onConflictDoUpdate({
          target: [labels.accountId, labels.providerLabelId],
          targetWhere: isNotNull(labels.providerLabelId),
          set: {
            name: sql`excluded.name`,
            normalizedName: sql`excluded.normalized_name`,
            providerType: "system",
            updatedAt: new Date(),
          },
        });
    }
    const providerLabelRows =
      requestedProviderLabelIds.length > 0
        ? await transaction
            .select({ id: labels.id, providerLabelId: labels.providerLabelId })
            .from(labels)
            .where(
              and(
                eq(labels.accountId, input.accountId),
                eq(labels.kind, "gmail"),
                inArray(labels.providerLabelId, requestedProviderLabelIds),
              ),
            )
        : [];
    const providerLabels = providerLabelRows.flatMap((label) =>
      label.providerLabelId
        ? [{ id: label.id, providerLabelId: label.providerLabelId }]
        : [],
    );
    const existingMemberships = await transaction
      .select({ providerLabelId: labels.providerLabelId })
      .from(messageLabels)
      .innerJoin(labels, eq(labels.id, messageLabels.labelId))
      .where(
        and(
          eq(messageLabels.messageId, message.id),
          eq(messageLabels.source, "gmail"),
        ),
      );
    const currentProviderLabelIds = existingMemberships.flatMap((membership) =>
      membership.providerLabelId ? [membership.providerLabelId] : [],
    );
    const changed = !equalStringArrays(
      currentProviderLabelIds,
      requestedProviderLabelIds,
    );
    if (changed) {
      await transaction
        .delete(messageLabels)
        .where(
          and(
            eq(messageLabels.messageId, message.id),
            eq(messageLabels.source, "gmail"),
          ),
        );
      if (providerLabels.length > 0) {
        await transaction.insert(messageLabels).values(
          providerLabels.map((label) => ({
            userId: input.userId,
            accountId: input.accountId,
            messageId: message.id,
            labelId: label.id,
            source: "gmail" as const,
          })),
        );
      }
    }
    await transaction
      .update(messages)
      .set({
        providerHistoryId: input.providerHistoryId,
        updatedAt: new Date(),
      })
      .where(eq(messages.id, message.id));
    const assignmentId = threadBefore?.assignmentId ?? null;
    if (changed && !threadBefore?.isInbox && !assignmentId) {
      const [threadAfter] = await transaction
        .select({ isInbox: inboxThreadCondition() })
        .from(threads)
        .where(eq(threads.id, message.threadId))
        .limit(1);
      if (threadAfter?.isInbox) {
        await transaction
          .update(threads)
          .set({
            labelAnalysisVersion: sql`${threads.labelAnalysisVersion} + 1`,
            labelAnalysisState: "pending",
            labelAnalysisError: null,
            labelAnalyzedAt: null,
            updatedAt: new Date(),
          })
          .where(eq(threads.id, message.threadId));
      }
    }
    return {
      found: true,
      changed,
      threadId: message.threadId,
      isVisible: true,
    };
  });
}

export async function countMemoryEligibleMessages(
  accountId: string,
  database: Database = getDatabase(),
): Promise<number> {
  const [total] = await database
    .select({ value: count(messages.id) })
    .from(messages)
    .innerJoin(threads, eq(messages.threadId, threads.id))
    .where(
      and(
        eq(threads.accountId, accountId),
        eq(messages.direction, "outgoing"),
        eq(messages.isMemoryEligible, true),
        eq(messages.excludedFromMemory, false),
      ),
    );

  return total?.value ?? 0;
}

export class LabelConflictError extends Error {
  constructor(message = "A label with this name already exists.") {
    super(message);
    this.name = "LabelConflictError";
  }
}

export type LabelMutationOperation = "create" | "update" | "set_enabled";

export class LabelMutationError extends Error {
  readonly operation: LabelMutationOperation;

  constructor(operation: LabelMutationOperation, cause: unknown) {
    super("The label change could not be completed.", { cause });
    this.name = "LabelMutationError";
    this.operation = operation;
  }
}

function normalizeLabelName(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function isUniqueViolation(error: unknown) {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "23505",
  );
}

export async function createInvookLabel(
  input: {
    userId: string;
    name: string;
    description: string;
    applyToPastDays?: LabelHistoryWindowDays | null;
    previewReceiptId?: string | null;
  },
  database: DatabaseExecutor = getDatabase(),
) {
  try {
    return await database.transaction(async (transaction) => {
      const [account] = await transaction
        .select({
          id: connectedAccounts.id,
        })
        .from(connectedAccounts)
        .where(
          and(
            eq(connectedAccounts.userId, input.userId),
            eq(connectedAccounts.status, "connected"),
          ),
        )
        .orderBy(desc(connectedAccounts.createdAt))
        .limit(1);
      if (!account) return null;

      const normalizedName = normalizeLabelName(input.name);
      const [existing] = await transaction
        .select({ id: labels.id })
        .from(labels)
        .where(
          and(
            eq(labels.accountId, account.id),
            eq(labels.kind, "invook"),
            eq(labels.normalizedName, normalizedName),
          ),
        )
        .limit(1);
      if (existing) throw new LabelConflictError();

      const [label] = await transaction
        .insert(labels)
        .values({
          userId: input.userId,
          accountId: account.id,
          kind: "invook",
          name: input.name.trim().replace(/\s+/g, " "),
          normalizedName,
          description: input.description.trim().replace(/\s+/g, " "),
          definitionVersion: 1,
          isEnabled: true,
        })
        .returning();
      if (!label) throw new Error("The label could not be created.");
      const windowDays = input.applyToPastDays ?? null;
      const admittedAt = new Date();
      if (windowDays) {
        const historicalScanId = uuidv4();
        if (input.previewReceiptId) {
          await consumeLabelPreviewReceipt(
            {
              receiptId: input.previewReceiptId,
              userId: input.userId,
              accountId: account.id,
              name: label.name,
              description: label.description,
              historicalScanId,
              consumedAt: admittedAt,
            },
            transaction,
          );
        }
        await enqueueHistoricalThreadLabelScanCoordinator(
          {
            historicalScanId,
            previewReceiptId: input.previewReceiptId ?? null,
            userId: input.userId,
            accountId: account.id,
            labelId: label.id,
            definitionVersion: label.definitionVersion,
            enablementVersion: label.enablementVersion,
            after: new Date(
              admittedAt.getTime() - windowDays * 24 * 60 * 60 * 1_000,
            ),
          },
          transaction,
        );
      }
      return {
        id: label.id,
        name: label.name,
        description: label.description,
        systemKey: label.systemKey,
        definitionVersion: label.definitionVersion,
        isEnabled: label.isEnabled,
        historicalAnalysis: windowDays
          ? { windowDays, status: "queued" as const }
          : null,
      };
    });
  } catch (error) {
    if (error instanceof LabelPreviewReceiptConflictError) throw error;
    if (error instanceof LabelConflictError || isUniqueViolation(error)) {
      throw new LabelConflictError();
    }
    throw new LabelMutationError("create", error);
  }
}

export async function updateInvookLabel(
  input: {
    userId: string;
    labelId: string;
    name: string;
    description: string;
  },
  database: Database = getDatabase(),
) {
  try {
    const [label] = await database
      .update(labels)
      .set({
        name: input.name.trim().replace(/\s+/g, " "),
        normalizedName: normalizeLabelName(input.name),
        description: input.description.trim().replace(/\s+/g, " "),
        definitionVersion: sql`${labels.definitionVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(labels.id, input.labelId),
          eq(labels.userId, input.userId),
          eq(labels.kind, "invook"),
          isNull(labels.systemKey),
        ),
      )
      .returning({
        id: labels.id,
        name: labels.name,
        description: labels.description,
        systemKey: labels.systemKey,
        definitionVersion: labels.definitionVersion,
        isEnabled: labels.isEnabled,
      });
    return label ?? null;
  } catch (error) {
    if (error instanceof LabelConflictError || isUniqueViolation(error)) {
      throw new LabelConflictError();
    }
    throw new LabelMutationError("update", error);
  }
}

export async function setInvookLabelEnabled(
  input: {
    userId: string;
    labelId: string;
    isEnabled: boolean;
    applyToPastDays?: LabelHistoryWindowDays | null;
  },
  database: Database = getDatabase(),
) {
  return database.transaction(async (transaction) => {
    const [currentLabel] = await transaction
      .select({
        id: labels.id,
        accountId: labels.accountId,
        name: labels.name,
        description: labels.description,
        systemKey: labels.systemKey,
        definitionVersion: labels.definitionVersion,
        isEnabled: labels.isEnabled,
      })
      .from(labels)
      .where(
        and(
          eq(labels.id, input.labelId),
          eq(labels.userId, input.userId),
          eq(labels.kind, "invook"),
        ),
      )
      .for("update")
      .limit(1);
    if (!currentLabel) return null;
    if (currentLabel.systemKey === "others" && !input.isEnabled) {
      throw new LabelConflictError("The Others fallback label cannot be disabled.");
    }
    const [label] = await transaction
      .update(labels)
      .set({
        isEnabled: input.isEnabled,
        disabledAt: input.isEnabled ? null : new Date(),
        ...(input.isEnabled === currentLabel.isEnabled
          ? {}
          : {
              enablementVersion: sql`${labels.enablementVersion} + 1`,
            }),
        updatedAt: new Date(),
      })
      .where(
        and(eq(labels.id, currentLabel.id), eq(labels.userId, input.userId)),
      )
      .returning({
        id: labels.id,
        name: labels.name,
        description: labels.description,
        systemKey: labels.systemKey,
        definitionVersion: labels.definitionVersion,
        enablementVersion: labels.enablementVersion,
        isEnabled: labels.isEnabled,
      });
    if (!label) throw new Error("The label state could not be saved.");
    const windowDays =
      input.isEnabled && !currentLabel.isEnabled
        ? input.applyToPastDays ?? null
        : null;
    if (windowDays) {
      await enqueueHistoricalThreadLabelScanCoordinator(
        {
          historicalScanId: uuidv4(),
          previewReceiptId: null,
          userId: input.userId,
          accountId: currentLabel.accountId,
          labelId: label.id,
          definitionVersion: label.definitionVersion,
          enablementVersion: label.enablementVersion,
          after: new Date(Date.now() - windowDays * 24 * 60 * 60 * 1_000),
        },
        transaction,
      );
    }
    return {
      id: label.id,
      name: label.name,
      description: label.description,
      systemKey: label.systemKey,
      definitionVersion: label.definitionVersion,
      isEnabled: label.isEnabled,
      historicalAnalysis: windowDays
        ? { windowDays, status: "queued" as const }
        : null,
    };
  }).catch((error: unknown) => {
    if (error instanceof LabelConflictError || isUniqueViolation(error)) {
      throw error instanceof LabelConflictError
        ? error
        : new LabelConflictError();
    }
    throw new LabelMutationError("set_enabled", error);
  });
}

export async function getMemoryAnalysisThreads(
  accountId: string,
  evidenceMessageIds?: string[],
  database: Database = getDatabase(),
) {
  if (evidenceMessageIds && evidenceMessageIds.length === 0) return [];
  const evidenceIdSet = evidenceMessageIds
    ? new Set(evidenceMessageIds)
    : null;
  const eligibleThreadIds = database
    .select({ id: messages.threadId })
    .from(messages)
    .where(
      and(
        eq(messages.direction, "outgoing"),
        eq(messages.isMemoryEligible, true),
        eq(messages.excludedFromMemory, false),
        ...(evidenceMessageIds
          ? [inArray(messages.id, evidenceMessageIds)]
          : []),
      ),
    )
    .groupBy(messages.threadId);

  const rows = await database
    .select({
      threadId: messages.threadId,
      threadSubject: threads.subject,
      id: messages.id,
      direction: messages.direction,
      sender: messages.sender,
      recipients: messages.recipients,
      bodyText: messages.bodyText,
      sentAt: messages.sentAt,
      isMemoryEligible: messages.isMemoryEligible,
    })
    .from(messages)
    .innerJoin(threads, eq(messages.threadId, threads.id))
    .where(
      and(
        eq(threads.accountId, accountId),
        inArray(threads.id, eligibleThreadIds),
        eq(messages.excludedFromMemory, false),
        or(
          eq(messages.direction, "incoming"),
          and(
            eq(messages.direction, "outgoing"),
            eq(messages.isMemoryEligible, true),
            ...(evidenceMessageIds
              ? [inArray(messages.id, evidenceMessageIds)]
              : []),
          ),
        ),
      ),
    )
    .orderBy(asc(messages.threadId), asc(messages.sentAt));

  const grouped = new Map<
    string,
    {
      id: string;
      subject: string;
      messages: Array<{
        id: string;
        direction: "incoming" | "outgoing";
        sender: { raw: string; email: string };
        recipients: string[];
        bodyText: string;
        sentAt: Date;
        ownerEvidence: boolean;
      }>;
    }
  >();

  for (const row of rows) {
    const thread = grouped.get(row.threadId) ?? {
      id: row.threadId,
      subject: row.threadSubject,
      messages: [],
    };
    thread.messages.push({
      id: row.id,
      direction: row.direction,
      sender: row.sender,
      recipients: row.recipients,
      bodyText: row.bodyText,
      sentAt: row.sentAt,
      ownerEvidence:
        row.direction === "outgoing" &&
        row.isMemoryEligible &&
        (!evidenceIdSet || evidenceIdSet.has(row.id)),
    });
    grouped.set(row.threadId, thread);
  }

  return Array.from(grouped.values());
}

export async function getUserAuthoredMemories(
  accountId: string,
  database: Database = getDatabase(),
) {
  return database
    .select({
      id: memoryEntries.id,
      type: memoryEntries.memoryType,
      contactEmail: memoryEntries.contactEmail,
      statement: memoryEntries.statement,
    })
    .from(memoryEntries)
    .where(
      and(eq(memoryEntries.accountId, accountId), eq(memoryEntries.source, "user")),
    )
    .orderBy(asc(memoryEntries.createdAt));
}

export async function getMemoriesForUser(
  userId: string,
  database: Database = getDatabase(),
) {
  const [account] = await database
    .select({ id: connectedAccounts.id, syncState: connectedAccounts.syncState })
    .from(connectedAccounts)
    .where(
      and(
        eq(connectedAccounts.userId, userId),
        not(eq(connectedAccounts.status, "disconnected")),
      ),
    )
    .orderBy(desc(connectedAccounts.createdAt))
    .limit(1);
  if (!account) return null;

  const entries = await database
    .select({
      id: memoryEntries.id,
      type: memoryEntries.memoryType,
      contactEmail: memoryEntries.contactEmail,
      statement: memoryEntries.statement,
      source: memoryEntries.source,
      confidence: memoryEntries.confidence,
      evidenceMessageIds: memoryEntries.evidenceMessageIds,
      evidenceDraftIds: memoryEntries.evidenceDraftIds,
      createdAt: memoryEntries.createdAt,
      updatedAt: memoryEntries.updatedAt,
    })
    .from(memoryEntries)
    .where(
      and(eq(memoryEntries.userId, userId), eq(memoryEntries.accountId, account.id)),
    )
    .orderBy(
      asc(memoryEntries.memoryType),
      asc(memoryEntries.contactEmail),
      asc(memoryEntries.createdAt),
    );

  return { account, entries };
}

type MemoryEntryInput = {
  type: MemoryType;
  contactEmail?: string | null;
  statement: string;
};

function memoryValues(input: MemoryEntryInput) {
  const statement = normalizeMemoryStatement(input.statement);
  const contactEmail =
    input.type === "contact" ? normalizeContactEmail(input.contactEmail) : null;
  return {
    type: input.type,
    contactEmail,
    statement,
    fingerprint: createMemoryFingerprint({
      type: input.type,
      contactEmail,
      statement,
    }),
  };
}

export class MemoryConflictError extends Error {
  constructor() {
    super("An identical memory already exists.");
    this.name = "MemoryConflictError";
  }
}

export async function createUserMemory(
  input: { userId: string } & MemoryEntryInput,
  database: Database = getDatabase(),
) {
  const value = memoryValues(input);
  if (input.type === "contact" && !value.contactEmail) {
    throw new Error("A contact memory requires an email address.");
  }

  return database.transaction(async (transaction) => {
    const [account] = await transaction
      .select({ id: connectedAccounts.id })
      .from(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.userId, input.userId),
          not(eq(connectedAccounts.status, "disconnected")),
        ),
      )
      .orderBy(desc(connectedAccounts.createdAt))
      .limit(1);
    if (!account) return null;

    await transaction
      .delete(memoryDeletions)
      .where(
        and(
          eq(memoryDeletions.accountId, account.id),
          eq(memoryDeletions.fingerprint, value.fingerprint),
        ),
      );

    const [memory] = await transaction
      .insert(memoryEntries)
      .values({
        userId: input.userId,
        accountId: account.id,
        memoryType: value.type,
        contactEmail: value.contactEmail,
        statement: value.statement,
        source: "user",
        confidence: null,
        fingerprint: value.fingerprint,
        schemaVersion: MEMORY_SCHEMA_VERSION,
      })
      .onConflictDoUpdate({
        target: [memoryEntries.accountId, memoryEntries.fingerprint],
        set: {
          memoryType: value.type,
          contactEmail: value.contactEmail,
          statement: value.statement,
          source: "user",
          confidence: null,
          evidenceMessageIds: [],
          evidenceDraftIds: [],
          modelId: null,
          schemaVersion: MEMORY_SCHEMA_VERSION,
          updatedAt: new Date(),
        },
      })
      .returning();
    if (!memory) throw new Error("The memory could not be saved.");
    return memory;
  });
}

export async function updateUserMemory(
  input: { userId: string; memoryId: string } & MemoryEntryInput,
  database: Database = getDatabase(),
) {
  const value = memoryValues(input);
  if (input.type === "contact" && !value.contactEmail) {
    throw new Error("A contact memory requires an email address.");
  }

  return database.transaction(async (transaction) => {
    const [existing] = await transaction
      .select({
        id: memoryEntries.id,
        userId: memoryEntries.userId,
        accountId: memoryEntries.accountId,
        memoryType: memoryEntries.memoryType,
        contactEmail: memoryEntries.contactEmail,
        fingerprint: memoryEntries.fingerprint,
      })
      .from(memoryEntries)
      .where(
        and(eq(memoryEntries.id, input.memoryId), eq(memoryEntries.userId, input.userId)),
      )
      .limit(1);
    if (!existing) return null;

    const [duplicate] = await transaction
      .select({ id: memoryEntries.id })
      .from(memoryEntries)
      .where(
        and(
          eq(memoryEntries.accountId, existing.accountId),
          eq(memoryEntries.fingerprint, value.fingerprint),
          ne(memoryEntries.id, existing.id),
        ),
      )
      .limit(1);
    if (duplicate) throw new MemoryConflictError();

    await transaction
      .delete(memoryDeletions)
      .where(
        and(
          eq(memoryDeletions.accountId, existing.accountId),
          eq(memoryDeletions.fingerprint, value.fingerprint),
        ),
      );

    if (existing.fingerprint !== value.fingerprint) {
      await transaction
        .insert(memoryDeletions)
        .values({
          userId: existing.userId,
          accountId: existing.accountId,
          memoryType: existing.memoryType,
          contactEmail: existing.contactEmail,
          fingerprint: existing.fingerprint,
        })
        .onConflictDoUpdate({
          target: [memoryDeletions.accountId, memoryDeletions.fingerprint],
          set: {
            contactEmail: existing.contactEmail,
            deletedAt: new Date(),
          },
        });
    }

    const [memory] = await transaction
      .update(memoryEntries)
      .set({
        memoryType: value.type,
        contactEmail: value.contactEmail,
        statement: value.statement,
        source: "user",
        confidence: null,
        evidenceMessageIds: [],
        evidenceDraftIds: [],
        modelId: null,
        schemaVersion: MEMORY_SCHEMA_VERSION,
        fingerprint: value.fingerprint,
        updatedAt: new Date(),
      })
      .where(eq(memoryEntries.id, existing.id))
      .returning();
    if (!memory) return null;
    return memory;
  });
}

export async function deleteUserMemory(
  input: { userId: string; memoryId: string },
  database: Database = getDatabase(),
) {
  return database.transaction(async (transaction) => {
    const [memory] = await transaction
      .select()
      .from(memoryEntries)
      .where(
        and(eq(memoryEntries.id, input.memoryId), eq(memoryEntries.userId, input.userId)),
      )
      .limit(1);
    if (!memory) return false;

    await transaction
      .insert(memoryDeletions)
      .values({
        userId: memory.userId,
        accountId: memory.accountId,
        memoryType: memory.memoryType,
        contactEmail: memory.contactEmail,
        fingerprint: memory.fingerprint,
      })
      .onConflictDoUpdate({
        target: [memoryDeletions.accountId, memoryDeletions.fingerprint],
        set: {
          contactEmail: memory.contactEmail,
          deletedAt: new Date(),
        },
      });
    await transaction.delete(memoryEntries).where(eq(memoryEntries.id, memory.id));
    return true;
  });
}

export async function saveExtractedMemories(
  input: {
    userId: string;
    accountId: string;
    source: Exclude<MemorySource, "user">;
    modelId: string | null;
    replaceExisting?: boolean;
    markComplete?: boolean;
    memories: Array<
      MemoryEntryInput & {
        confidence: number;
        evidenceMessageIds?: string[];
        evidenceDraftIds?: string[];
      }
    >;
  },
  database: Database = getDatabase(),
) {
  return database.transaction(async (transaction) => {
    const deletedRows = await transaction
      .select({ fingerprint: memoryDeletions.fingerprint })
      .from(memoryDeletions)
      .where(eq(memoryDeletions.accountId, input.accountId));
    const deletedFingerprints = new Set(deletedRows.map((row) => row.fingerprint));

    if (input.replaceExisting !== false) {
      await transaction
        .delete(memoryEntries)
        .where(
          and(
            eq(memoryEntries.accountId, input.accountId),
            eq(memoryEntries.source, input.source),
          ),
        );
    }

    let savedCount = 0;
    for (const candidate of input.memories) {
      const value = memoryValues(candidate);
      if (
        (candidate.type === "contact" && !value.contactEmail) ||
        deletedFingerprints.has(value.fingerprint)
      ) {
        continue;
      }

      const [existing] = await transaction
        .select({
          id: memoryEntries.id,
          source: memoryEntries.source,
          confidence: memoryEntries.confidence,
          evidenceMessageIds: memoryEntries.evidenceMessageIds,
          evidenceDraftIds: memoryEntries.evidenceDraftIds,
        })
        .from(memoryEntries)
        .where(
          and(
            eq(memoryEntries.accountId, input.accountId),
            eq(memoryEntries.fingerprint, value.fingerprint),
          ),
        )
        .limit(1);
      if (existing) {
        if (existing.source === input.source) {
          await transaction
            .update(memoryEntries)
            .set({
              confidence: Math.max(
                Number(existing.confidence ?? 0),
                candidate.confidence,
              ).toFixed(2),
              evidenceMessageIds: Array.from(
                new Set([
                  ...existing.evidenceMessageIds,
                  ...(candidate.evidenceMessageIds ?? []),
                ]),
              ),
              evidenceDraftIds: Array.from(
                new Set([
                  ...existing.evidenceDraftIds,
                  ...(candidate.evidenceDraftIds ?? []),
                ]),
              ),
              modelId: input.modelId,
              schemaVersion: MEMORY_SCHEMA_VERSION,
              updatedAt: new Date(),
            })
            .where(eq(memoryEntries.id, existing.id));
          savedCount += 1;
        }
        continue;
      }

      const inserted = await transaction
        .insert(memoryEntries)
        .values({
          userId: input.userId,
          accountId: input.accountId,
          memoryType: value.type,
          contactEmail: value.contactEmail,
          statement: value.statement,
          source: input.source,
          confidence: candidate.confidence.toFixed(2),
          evidenceMessageIds: Array.from(new Set(candidate.evidenceMessageIds ?? [])),
          evidenceDraftIds: Array.from(new Set(candidate.evidenceDraftIds ?? [])),
          modelId: input.modelId,
          schemaVersion: MEMORY_SCHEMA_VERSION,
          fingerprint: value.fingerprint,
        })
        .onConflictDoNothing({
          target: [memoryEntries.accountId, memoryEntries.fingerprint],
        })
        .returning({ id: memoryEntries.id });
      savedCount += inserted.length;
    }

    if (input.source === "inferred" && input.markComplete !== false) {
      await transaction
        .update(connectedAccounts)
        .set({
          syncState: sql`jsonb_set(${connectedAccounts.syncState}, '{memory}', to_jsonb(${"complete"}::text), true)`,
          updatedAt: new Date(),
        })
        .where(eq(connectedAccounts.id, input.accountId));
    }

    return savedCount;
  });
}

export async function setMemorySyncStage(
  accountId: string,
  stage: AccountSyncState["memory"],
  database: Database = getDatabase(),
) {
  await database.transaction(async (transaction) => {
    await transaction
      .update(connectedAccounts)
      .set({
        syncState: sql`jsonb_set(${connectedAccounts.syncState}, '{memory}', to_jsonb(${stage}::text), true)`,
        updatedAt: new Date(),
      })
      .where(eq(connectedAccounts.id, accountId));
    await transaction.execute(
      sql`select pg_notify('invook_account_sync', ${JSON.stringify({ accountId })})`,
    );
  });
}

export async function setIndexingSyncStage(
  accountId: string,
  stage: AccountSyncState["indexing"],
  database: Database = getDatabase(),
) {
  await database.transaction(async (transaction) => {
    await transaction
      .update(connectedAccounts)
      .set({
        syncState: sql`jsonb_set(${connectedAccounts.syncState}, '{indexing}', to_jsonb(${stage}::text), true)`,
        updatedAt: new Date(),
      })
      .where(eq(connectedAccounts.id, accountId));
    await transaction.execute(
      sql`select pg_notify('invook_account_sync', ${JSON.stringify({ accountId })})`,
    );
  });
}

export async function getEmbeddingCandidates(
  input: {
    accountId: string;
    modelId: string;
    indexVersion: number;
    limit?: number;
    messageIds?: string[];
    includeFailed?: boolean;
  },
  database: Database = getDatabase(),
) {
  if (input.messageIds?.length === 0) return [];
  const rows = await database
    .select({
      messageId: messages.id,
      userId: messages.userId,
      subject: messages.subject,
      bodyText: messages.bodyText,
      contentHash: messages.embeddingContentHash,
      embeddingStatus: messageEmbeddings.status,
      embeddedContentHash: messageEmbeddings.contentHash,
      embeddingDimensions: messageEmbeddings.dimensions,
      hasEmbedding: sql<boolean>`${messageEmbeddings.embedding} is not null`,
    })
    .from(messages)
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .leftJoin(
      messageEmbeddings,
      and(
        eq(messageEmbeddings.messageId, messages.id),
        eq(messageEmbeddings.modelId, input.modelId),
        eq(messageEmbeddings.indexVersion, input.indexVersion),
      ),
    )
    .where(
      and(
        eq(threads.accountId, input.accountId),
        input.messageIds ? inArray(messages.id, input.messageIds) : undefined,
        or(
          isNull(messageEmbeddings.id),
          ne(messageEmbeddings.contentHash, messages.embeddingContentHash),
          ne(messageEmbeddings.dimensions, MAIL_EMBEDDING_DIMENSIONS),
          and(
            eq(messageEmbeddings.status, "complete"),
            isNull(messageEmbeddings.embedding),
          ),
          input.includeFailed === false
            ? not(
                inArray(messageEmbeddings.status, [
                  "complete",
                  "submitted",
                  "failed",
                ]),
              )
            : not(inArray(messageEmbeddings.status, ["complete", "submitted"])),
        ),
      ),
    )
    .orderBy(asc(messages.sentAt), asc(messages.id))
    .limit(input.limit ?? 50_000);

  return rows.flatMap((row) => {
    const isCurrentContract =
      row.embeddedContentHash === row.contentHash &&
      row.embeddingDimensions === MAIL_EMBEDDING_DIMENSIONS;
    if (
      isCurrentContract &&
      (row.embeddingStatus === "submitted" ||
        (row.embeddingStatus === "complete" && row.hasEmbedding))
    ) {
      return [];
    }
    if (
      isCurrentContract &&
      row.embeddingStatus === "failed" &&
      input.includeFailed === false
    ) {
      return [];
    }
    return [row];
  });
}

type EmbeddingBatchManifest = Array<{
  key: string;
  messageId: string;
  contentHash: string;
}>;

export async function getEmbeddingBatchSubmissionForStep(
  workflowStepId: string,
  database: Database = getDatabase(),
) {
  const [submission] = await database
    .select()
    .from(embeddingBatchSubmissions)
    .where(eq(embeddingBatchSubmissions.workflowStepId, workflowStepId))
    .limit(1);
  return submission ?? null;
}

export async function getActiveEmbeddingBatchSubmissionForAccount(
  accountId: string,
  database: Database = getDatabase(),
) {
  const [submission] = await database
    .select({
      id: embeddingBatchSubmissions.id,
      workflowStepId: embeddingBatchSubmissions.workflowStepId,
      providerBatchId: embeddingBatchSubmissions.providerBatchId,
      status: embeddingBatchSubmissions.status,
    })
    .from(embeddingBatchSubmissions)
    .where(
      and(
        eq(embeddingBatchSubmissions.accountId, accountId),
        inArray(embeddingBatchSubmissions.status, ["preparing", "submitted"]),
      ),
    )
    .limit(1);
  return submission ?? null;
}

export async function prepareEmbeddingBatchSubmission(
  input: {
    workflowStepId: string;
    userId: string;
    accountId: string;
    modelId: string;
    dimensions: number;
    indexVersion: number;
    batchAttempt: number;
    hasMore: boolean;
    manifest: EmbeddingBatchManifest;
  },
  database: Database = getDatabase(),
) {
  const [inserted] = await database
    .insert(embeddingBatchSubmissions)
    .values({
      workflowStepId: input.workflowStepId,
      userId: input.userId,
      accountId: input.accountId,
      modelId: input.modelId,
      dimensions: input.dimensions,
      indexVersion: input.indexVersion,
      batchAttempt: input.batchAttempt,
      hasMore: input.hasMore,
      requestCount: input.manifest.length,
      manifest: input.manifest,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) return inserted;

  const existing = await getEmbeddingBatchSubmissionForStep(
    input.workflowStepId,
    database,
  );
  return existing;
}

export async function refreshPreparingEmbeddingBatchSubmission(
  input: {
    submissionId: string;
    modelId: string;
    dimensions: number;
    indexVersion: number;
    batchAttempt: number;
    hasMore: boolean;
    manifest: EmbeddingBatchManifest;
  },
  database: Database = getDatabase(),
) {
  const [submission] = await database
    .update(embeddingBatchSubmissions)
    .set({
      modelId: input.modelId,
      dimensions: input.dimensions,
      indexVersion: input.indexVersion,
      batchAttempt: input.batchAttempt,
      hasMore: input.hasMore,
      requestCount: input.manifest.length,
      manifest: input.manifest,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(embeddingBatchSubmissions.id, input.submissionId),
        eq(embeddingBatchSubmissions.status, "preparing"),
        isNull(embeddingBatchSubmissions.inputFileId),
        isNull(embeddingBatchSubmissions.providerBatchId),
      ),
    )
    .returning();
  return submission ?? null;
}

export async function recordEmbeddingBatchInputFile(
  input: { submissionId: string; inputFileId: string },
  database: Database = getDatabase(),
): Promise<string> {
  const [submission] = await database
    .update(embeddingBatchSubmissions)
    .set({
      inputFileId: sql`coalesce(${embeddingBatchSubmissions.inputFileId}, ${input.inputFileId})`,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(embeddingBatchSubmissions.id, input.submissionId),
        eq(embeddingBatchSubmissions.status, "preparing"),
      ),
    )
    .returning({ inputFileId: embeddingBatchSubmissions.inputFileId });
  if (!submission?.inputFileId) {
    throw new Error("The embedding batch input file could not be recorded.");
  }
  return submission.inputFileId;
}

export async function recordEmbeddingProviderBatch(
  input: {
    submissionId: string;
    providerBatchId: string;
    inputFileId: string;
  },
  database: Database = getDatabase(),
) {
  const [submission] = await database
    .update(embeddingBatchSubmissions)
    .set({
      providerBatchId: input.providerBatchId,
      inputFileId: input.inputFileId,
      status: "submitted",
      submittedAt: sql`coalesce(${embeddingBatchSubmissions.submittedAt}, now())`,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(embeddingBatchSubmissions.id, input.submissionId),
        inArray(embeddingBatchSubmissions.status, ["preparing", "submitted"]),
      ),
    )
    .returning();
  if (!submission) {
    throw new Error("The OpenAI embedding batch could not be recorded.");
  }
  return submission;
}

export async function finalizeEmptyEmbeddingBackfill(
  input: {
    accountId: string;
    modelId: string;
    indexVersion: number;
    submissionId?: string;
  },
  database: Database = getDatabase(),
): Promise<{
  stage: AccountSyncState["indexing"];
  incompleteMessageCount: number;
}> {
  return database.transaction(async (transaction) => {
    await lockEmbeddingIndex(transaction, input.accountId);
    if (input.submissionId) {
      await transaction
        .update(embeddingBatchSubmissions)
        .set({
          status: "complete",
          providerState: "not_submitted",
          lastError: null,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(embeddingBatchSubmissions.id, input.submissionId),
            eq(embeddingBatchSubmissions.accountId, input.accountId),
            eq(embeddingBatchSubmissions.status, "preparing"),
          ),
        );
    }
    const [account] = await transaction
      .select({
        accountStatus: connectedAccounts.status,
        syncState: connectedAccounts.syncState,
        replicaState: gmailReplicaStates.state,
      })
      .from(connectedAccounts)
      .innerJoin(
        gmailReplicaStates,
        eq(gmailReplicaStates.accountId, connectedAccounts.id),
      )
      .where(eq(connectedAccounts.id, input.accountId))
      .limit(1);
    const progress = await getIndexingProgressWithExecutor(input, transaction);
    if (!account || !progress) {
      throw new Error("The embedding account is unavailable.");
    }
    const prerequisites: IndexingPrerequisiteState = {
      accountStatus: account.accountStatus,
      mailSyncStage: account.syncState.mailSync,
      replicaState: account.replicaState,
    };
    const incompleteMessageCount =
      progress.totalMessageCount - progress.completedMessageCount;
    const stage =
      areIndexingPrerequisitesReady(prerequisites) &&
      incompleteMessageCount === 0
        ? "complete"
        : "failed";
    await transaction
      .update(connectedAccounts)
      .set({
        syncState: sql`jsonb_set(${connectedAccounts.syncState}, '{indexing}', to_jsonb(${stage}::text), true)`,
        updatedAt: new Date(),
      })
      .where(eq(connectedAccounts.id, input.accountId));
    await transaction.execute(
      sql`select pg_notify('invook_account_sync', ${JSON.stringify({ accountId: input.accountId })})`,
    );
    return { stage, incompleteMessageCount };
  });
}

export async function markEmbeddingBatchSubmitted(
  input: {
    accountId: string;
    modelId: string;
    dimensions: number;
    indexVersion: number;
    providerBatchId: string;
    messages: Array<{ messageId: string; userId: string; contentHash: string }>;
  },
  database: Database = getDatabase(),
) {
  if (input.messages.length === 0) return;
  await database.transaction(async (transaction) => {
    await lockEmbeddingIndex(transaction, input.accountId);
    const [activeSubmission] = await transaction
      .select({ id: embeddingBatchSubmissions.id })
      .from(embeddingBatchSubmissions)
      .where(
        and(
          eq(embeddingBatchSubmissions.accountId, input.accountId),
          eq(embeddingBatchSubmissions.providerBatchId, input.providerBatchId),
          eq(embeddingBatchSubmissions.status, "submitted"),
        ),
      )
      .limit(1);
    if (!activeSubmission) return;
    const currentMessages = await transaction
      .select({
        id: messages.id,
        contentHash: messages.embeddingContentHash,
      })
      .from(messages)
      .where(
        and(
          eq(messages.accountId, input.accountId),
          inArray(
            messages.id,
            input.messages.map((message) => message.messageId),
          ),
        ),
      );
    const currentHashes = new Map(
      currentMessages.map((message) => [message.id, message.contentHash]),
    );
    const currentBatchMessages = input.messages.filter(
      (message) => currentHashes.get(message.messageId) === message.contentHash,
    );
    if (currentBatchMessages.length === 0) return;
    await transaction
      .insert(messageEmbeddings)
      .values(
        currentBatchMessages.map((message) => ({
          userId: message.userId,
          accountId: input.accountId,
          messageId: message.messageId,
          modelId: input.modelId,
          dimensions: input.dimensions,
          indexVersion: input.indexVersion,
          contentHash: message.contentHash,
          status: "submitted" as const,
          providerBatchId: input.providerBatchId,
        })),
      )
      .onConflictDoUpdate({
        target: [
          messageEmbeddings.messageId,
          messageEmbeddings.modelId,
          messageEmbeddings.indexVersion,
        ],
        set: {
          dimensions: input.dimensions,
          contentHash: sql`excluded.content_hash`,
          status: "submitted",
          providerBatchId: input.providerBatchId,
          lastError: null,
          updatedAt: new Date(),
        },
        setWhere: or(
          ne(messageEmbeddings.status, "complete"),
          ne(messageEmbeddings.contentHash, sql`excluded.content_hash`),
        ),
      });
  });
}

export async function listSubmittedEmbeddingBatchIds(
  input: { accountId?: string } = {},
  database: Database = getDatabase(),
): Promise<string[]> {
  const rows = await database
    .select({ providerBatchId: embeddingBatchSubmissions.providerBatchId })
    .from(embeddingBatchSubmissions)
    .where(
      and(
        eq(embeddingBatchSubmissions.status, "submitted"),
        isNotNull(embeddingBatchSubmissions.providerBatchId),
        input.accountId
          ? eq(embeddingBatchSubmissions.accountId, input.accountId)
          : undefined,
      ),
    )
    .groupBy(embeddingBatchSubmissions.providerBatchId);

  return rows.flatMap(({ providerBatchId }) =>
    providerBatchId ? [providerBatchId] : [],
  );
}

type MessageEmbeddingValue = {
  messageId: string;
  userId: string;
  contentHash: string;
  embedding: number[];
};

async function saveMessageEmbeddingsWithExecutor(
  input: {
    accountId: string;
    modelId: string;
    dimensions: number;
    indexVersion: number;
    values: MessageEmbeddingValue[];
  },
  database: DatabaseExecutor,
): Promise<number> {
  if (input.values.length === 0) return 0;
  const currentMessages = await database
    .select({
      id: messages.id,
      contentHash: messages.embeddingContentHash,
    })
    .from(messages)
    .where(
      and(
        eq(messages.accountId, input.accountId),
        inArray(
          messages.id,
          input.values.map((value) => value.messageId),
        ),
      ),
    );
  const currentHashes = new Map(
    currentMessages.map((message) => [message.id, message.contentHash]),
  );
  const values = input.values.filter(
    (value) => currentHashes.get(value.messageId) === value.contentHash,
  );
  if (values.length === 0) return 0;

  await database
    .insert(messageEmbeddings)
    .values(
      values.map((value) => ({
        userId: value.userId,
        accountId: input.accountId,
        messageId: value.messageId,
        modelId: input.modelId,
        dimensions: input.dimensions,
        indexVersion: input.indexVersion,
        contentHash: value.contentHash,
        status: "complete" as const,
        embedding: value.embedding,
      })),
    )
    .onConflictDoUpdate({
      target: [
        messageEmbeddings.messageId,
        messageEmbeddings.modelId,
        messageEmbeddings.indexVersion,
      ],
      set: {
        dimensions: input.dimensions,
        contentHash: sql`excluded.content_hash`,
        status: "complete",
        embedding: sql`excluded.embedding`,
        providerBatchId: null,
        lastError: null,
        updatedAt: new Date(),
      },
    });
  return values.length;
}

export async function completeIncrementalEmbedding(
  input: {
    accountId: string;
    modelId: string;
    dimensions: number;
    indexVersion: number;
    values: MessageEmbeddingValue[];
  },
  database: Database = getDatabase(),
): Promise<{
  savedCount: number;
  incompleteMessageCount: number;
  stage: AccountSyncState["indexing"];
}> {
  return database.transaction(async (transaction) => {
    await lockEmbeddingIndex(transaction, input.accountId);
    const savedCount = await saveMessageEmbeddingsWithExecutor(input, transaction);
    const [account] = await transaction
      .select({
        accountStatus: connectedAccounts.status,
        syncState: connectedAccounts.syncState,
        replicaState: gmailReplicaStates.state,
      })
      .from(connectedAccounts)
      .innerJoin(
        gmailReplicaStates,
        eq(gmailReplicaStates.accountId, connectedAccounts.id),
      )
      .where(eq(connectedAccounts.id, input.accountId))
      .limit(1);
    const progress = await getIndexingProgressWithExecutor(input, transaction);
    if (!account || !progress) {
      throw new Error("The embedding account is unavailable.");
    }
    const prerequisites: IndexingPrerequisiteState = {
      accountStatus: account.accountStatus,
      mailSyncStage: account.syncState.mailSync,
      replicaState: account.replicaState,
    };
    const incompleteMessageCount =
      progress.totalMessageCount - progress.completedMessageCount;
    const stage = !areIndexingPrerequisitesReady(prerequisites)
      ? "failed"
      : incompleteMessageCount === 0
        ? "complete"
        : progress.failedMessageCount > 0 &&
            account.syncState.indexing === "failed"
          ? "failed"
          : "running";
    await transaction
      .update(connectedAccounts)
      .set({
        syncState: sql`jsonb_set(${connectedAccounts.syncState}, '{indexing}', to_jsonb(${stage}::text), true)`,
        updatedAt: new Date(),
      })
      .where(eq(connectedAccounts.id, input.accountId));
    await transaction.execute(
      sql`select pg_notify('invook_account_sync', ${JSON.stringify({ accountId: input.accountId })})`,
    );
    return { savedCount, incompleteMessageCount, stage };
  });
}

async function markMessageEmbeddingsFailedWithExecutor(
  input: {
    accountId: string;
    modelId: string;
    indexVersion: number;
    values: Array<{ messageId: string; contentHash: string }>;
    error: string;
  },
  database: DatabaseExecutor,
): Promise<void> {
  for (const value of input.values) {
    await database
      .update(messageEmbeddings)
      .set({
        status: "failed",
        providerBatchId: null,
        lastError: input.error,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(messageEmbeddings.messageId, value.messageId),
          eq(messageEmbeddings.modelId, input.modelId),
          eq(messageEmbeddings.indexVersion, input.indexVersion),
          eq(messageEmbeddings.contentHash, value.contentHash),
          sql`exists (
            select 1
            from ${messages}
            where ${messages.id} = ${value.messageId}
              and ${messages.accountId} = ${input.accountId}
              and ${messages.embeddingContentHash} = ${value.contentHash}
          )`,
        ),
      );
  }
}

export async function finalizeEmbeddingBatchSubmission(
  input: {
    submissionId: string;
    providerState: string;
    providerError: string | null;
    values: MessageEmbeddingValue[];
    failedValues: Array<{ messageId: string; contentHash: string }>;
    batchAttemptLimit: number;
  },
  database: Database = getDatabase(),
): Promise<{
  alreadyFinalized: boolean;
  stage: AccountSyncState["indexing"];
  savedCount: number;
  incompleteMessageCount: number;
  failedMessageCount: number;
  continuationJobId: string | null;
}> {
  return database.transaction(async (transaction) => {
    const [submissionIdentity] = await transaction
      .select({ accountId: embeddingBatchSubmissions.accountId })
      .from(embeddingBatchSubmissions)
      .where(eq(embeddingBatchSubmissions.id, input.submissionId))
      .limit(1);
    if (!submissionIdentity) {
      throw new Error("The embedding batch submission could not be matched.");
    }
    await lockEmbeddingIndex(transaction, submissionIdentity.accountId);
    const [submission] = await transaction
      .select()
      .from(embeddingBatchSubmissions)
      .where(eq(embeddingBatchSubmissions.id, input.submissionId))
      .for("update")
      .limit(1);
    if (!submission) {
      throw new Error("The embedding batch submission could not be matched.");
    }
    if (submission.status === "complete") {
      const progress = await getIndexingProgressWithExecutor(
        {
          accountId: submission.accountId,
          modelId: submission.modelId,
          indexVersion: submission.indexVersion,
        },
        transaction,
      );
      if (!progress) throw new Error("The embedding account is unavailable.");
      return {
        alreadyFinalized: true,
        stage: progress.state,
        savedCount: 0,
        incompleteMessageCount:
          progress.totalMessageCount - progress.completedMessageCount,
        failedMessageCount: progress.failedMessageCount,
        continuationJobId: null,
      };
    }
    if (submission.status !== "submitted") {
      throw new Error(`The embedding batch submission is ${submission.status}.`);
    }
    if (!submission.providerBatchId) {
      throw new Error("The embedding batch submission has no provider identity.");
    }

    const savedCount = await saveMessageEmbeddingsWithExecutor(
      {
        accountId: submission.accountId,
        modelId: submission.modelId,
        dimensions: submission.dimensions,
        indexVersion: submission.indexVersion,
        values: input.values,
      },
      transaction,
    );
    await markMessageEmbeddingsFailedWithExecutor(
      {
        accountId: submission.accountId,
        modelId: submission.modelId,
        indexVersion: submission.indexVersion,
        values: input.failedValues,
        error:
          input.providerError ??
          `OpenAI embedding batch ended as ${input.providerState}.`,
      },
      transaction,
    );
    await transaction
      .update(embeddingBatchSubmissions)
      .set({
        status: "complete",
        providerState: input.providerState,
        lastError: input.providerError,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(embeddingBatchSubmissions.id, submission.id),
          eq(embeddingBatchSubmissions.status, "submitted"),
        ),
      );

    const [account] = await transaction
      .select({
        accountStatus: connectedAccounts.status,
        syncState: connectedAccounts.syncState,
        replicaState: gmailReplicaStates.state,
      })
      .from(connectedAccounts)
      .innerJoin(
        gmailReplicaStates,
        eq(gmailReplicaStates.accountId, connectedAccounts.id),
      )
      .where(eq(connectedAccounts.id, submission.accountId))
      .limit(1);
    if (!account) throw new Error("The embedding account is unavailable.");
    const progress = await getIndexingProgressWithExecutor(
      {
        accountId: submission.accountId,
        modelId: submission.modelId,
        indexVersion: submission.indexVersion,
      },
      transaction,
    );
    if (!progress) throw new Error("The embedding account is unavailable.");
    const prerequisites: IndexingPrerequisiteState = {
      accountStatus: account.accountStatus,
      mailSyncStage: account.syncState.mailSync,
      replicaState: account.replicaState,
    };
    const incompleteMessageCount =
      progress.totalMessageCount - progress.completedMessageCount;
    const decision = decideEmbeddingContinuation({
      prerequisites,
      incompleteMessageCount,
      failedMessageCount: progress.failedMessageCount,
      currentFailedMessageIds: input.failedValues.map((value) => value.messageId),
      batchAttempt: submission.batchAttempt,
      batchAttemptLimit: input.batchAttemptLimit,
    });
    const continuationJobId = decision.continuation
      ? await enqueueWorkflowStepWithExecutor(
          {
            userId: submission.userId,
            accountId: submission.accountId,
            stepType: "embedding.backfill",
            payload: {
              modelId: submission.modelId,
              indexVersion: submission.indexVersion,
              includeFailed: decision.continuation.includeFailed,
              batchAttempt: decision.continuation.batchAttempt,
              ...(decision.continuation.reason === "retry"
                ? { messageIds: decision.continuation.messageIds }
                : {}),
            },
            idempotencyKey: `embedding.backfill.continue:${decision.continuation.reason}:${submission.providerBatchId}`,
          },
          transaction,
        )
      : null;
    await transaction
      .update(connectedAccounts)
      .set({
        syncState: sql`jsonb_set(${connectedAccounts.syncState}, '{indexing}', to_jsonb(${decision.stage}::text), true)`,
        updatedAt: new Date(),
      })
      .where(eq(connectedAccounts.id, submission.accountId));
    await transaction.execute(
      sql`select pg_notify('invook_account_sync', ${JSON.stringify({ accountId: submission.accountId })})`,
    );
    return {
      alreadyFinalized: false,
      stage: decision.stage,
      savedCount,
      incompleteMessageCount,
      failedMessageCount: progress.failedMessageCount,
      continuationJobId,
    };
  });
}

export async function getReplyDraftContext(
  userId: string,
  threadId: string,
  database: Database = getDatabase(),
) {
  const [thread] = await database
    .select({
      id: threads.id,
      accountId: threads.accountId,
      subject: threads.subject,
      participants: threads.participants,
      accountEmail: connectedAccounts.email,
    })
    .from(threads)
    .innerJoin(connectedAccounts, eq(connectedAccounts.id, threads.accountId))
    .where(
      and(
        eq(threads.id, threadId),
        eq(threads.userId, userId),
        eq(connectedAccounts.userId, userId),
        eq(connectedAccounts.status, "connected"),
        visibleThreadCondition(),
      ),
    )
    .limit(1);
  if (!thread) return null;

  const [threadMessages, memories] = await Promise.all([
    database
      .select({
        id: messages.id,
        direction: messages.direction,
        sender: messages.sender,
        recipients: messages.recipients,
        bodyText: messages.bodyText,
        sentAt: messages.sentAt,
      })
      .from(messages)
      .where(
        and(
          eq(messages.userId, userId),
          eq(messages.threadId, thread.id),
          visibleMessageCondition,
        ),
      )
      .orderBy(asc(messages.sentAt)),
    database
      .select({
        id: memoryEntries.id,
        type: memoryEntries.memoryType,
        contactEmail: memoryEntries.contactEmail,
        statement: memoryEntries.statement,
        source: memoryEntries.source,
      })
      .from(memoryEntries)
      .where(
        and(
          eq(memoryEntries.userId, userId),
          eq(memoryEntries.accountId, thread.accountId),
        ),
      )
      .orderBy(asc(memoryEntries.createdAt)),
  ]);

  return { ...thread, messages: threadMessages, memories };
}

export async function saveGeneratedDraft(
  input: {
    userId: string;
    accountId: string;
    threadId: string;
    text: string;
    usedMemoryIds: string[];
    modelId: string;
    schedulingRelevant: boolean;
  },
  database: Database = getDatabase(),
) {
  return database.transaction(async (transaction) => {
    const [thread] = await transaction
      .select({ id: threads.id })
      .from(threads)
      .where(
        and(
          eq(threads.id, input.threadId),
          eq(threads.userId, input.userId),
          eq(threads.accountId, input.accountId),
        ),
      )
      .limit(1);
    if (!thread) return null;

    await transaction
      .update(drafts)
      .set({ status: "discarded", updatedAt: new Date() })
      .where(
        and(
          eq(drafts.userId, input.userId),
          eq(drafts.kind, "invook"),
          eq(drafts.threadId, input.threadId),
          eq(drafts.status, "editing"),
        ),
      );

    const [draft] = await transaction
      .insert(drafts)
      .values({
        userId: input.userId,
        accountId: input.accountId,
        kind: "invook",
        threadId: input.threadId,
        status: "editing",
        generatedText: input.text,
        currentText: input.text,
        usedMemoryIds: Array.from(new Set(input.usedMemoryIds)),
        generationMetadata: {
          modelId: input.modelId,
          schedulingRelevant: input.schedulingRelevant,
        },
        generatedAt: new Date(),
      })
      .returning();
    return draft ?? null;
  });
}

export async function saveDraftEdit(
  input: { userId: string; draftId: string; currentText: string },
  database: Database = getDatabase(),
) {
  return database.transaction(async (transaction) => {
    const [existing] = await transaction
      .select({
        id: drafts.id,
        accountId: drafts.accountId,
        threadId: drafts.threadId,
        generatedText: drafts.generatedText,
      })
      .from(drafts)
      .where(
        and(
          eq(drafts.id, input.draftId),
          eq(drafts.userId, input.userId),
          eq(drafts.kind, "invook"),
          eq(drafts.status, "editing"),
        ),
      )
      .limit(1);
    if (!existing?.generatedText) return null;

    const [draft] = await transaction
      .update(drafts)
      .set({
        currentText: input.currentText,
        feedbackVersion: 0,
        lastFeedbackAt: null,
        editSignals: [],
        updatedAt: new Date(),
      })
      .where(eq(drafts.id, existing.id))
      .returning();
    if (!draft) return null;

    if (normalizeMemoryStatement(existing.generatedText) !== normalizeMemoryStatement(input.currentText)) {
      const contentHash = createHash("sha256").update(input.currentText).digest("hex");
      await enqueueWorkflowStep(
        {
          userId: input.userId,
          accountId: existing.accountId,
          stepType: "memory.feedback",
          payload: { draftId: existing.id, feedbackVersion: DRAFT_FEEDBACK_VERSION },
          idempotencyKey: `memory.feedback:${existing.accountId}:${existing.id}:${contentHash}`,
        },
        transaction as unknown as Database,
      );
    }
    return draft;
  });
}

export async function getDraftFeedbackSamples(
  accountId: string,
  _feedbackVersion = DRAFT_FEEDBACK_VERSION,
  limit = 60,
  database: Database = getDatabase(),
) {
  return database
    .select({
      id: drafts.id,
      threadId: drafts.threadId,
      subject: threads.subject,
      participants: threads.participants,
      generatedText: drafts.generatedText,
      editedText: drafts.currentText,
      updatedAt: drafts.updatedAt,
    })
    .from(drafts)
    .innerJoin(threads, eq(threads.id, drafts.threadId))
    .where(
      and(
        eq(drafts.accountId, accountId),
        isNotNull(drafts.generatedText),
        ne(drafts.currentText, sql`coalesce(${drafts.generatedText}, '')`),
      ),
    )
    .orderBy(desc(drafts.updatedAt))
    .limit(limit);
}

export async function markDraftFeedbackAnalyzed(
  input: {
    draftIds: string[];
    signalsByDraft: Map<string, Array<{ type: MemoryType; statement: string }>>;
    feedbackVersion?: number;
  },
  database: Database = getDatabase(),
) {
  const feedbackVersion = input.feedbackVersion ?? DRAFT_FEEDBACK_VERSION;
  await database.transaction(async (transaction) => {
    for (const draftId of input.draftIds) {
      await transaction
        .update(drafts)
        .set({
          feedbackVersion,
          lastFeedbackAt: new Date(),
          editSignals: input.signalsByDraft.get(draftId) ?? [],
          updatedAt: new Date(),
        })
        .where(eq(drafts.id, draftId));
    }
  });
}

type PendingMemoryEvidence = {
  messageId: string;
  scope: "global" | "contact";
  contactEmail: string;
};

function incrementalMemoryJobs(input: {
  userId: string;
  accountId: string;
  pendingEvidence: PendingMemoryEvidence[];
}) {
  const evidenceByScope = new Map<string, PendingMemoryEvidence[]>();
  for (const evidence of input.pendingEvidence) {
    const key = `${evidence.scope}:${evidence.contactEmail}`;
    const grouped = evidenceByScope.get(key) ?? [];
    grouped.push(evidence);
    evidenceByScope.set(key, grouped);
  }

  return Array.from(evidenceByScope.values()).flatMap((evidence) => {
    if (evidence.length < 3) return [];
    const first = evidence[0];
    if (!first) return [];
    const evidenceMessageIds = evidence.map((entry) => entry.messageId);
    const digest = createHash("sha256")
      .update(
        JSON.stringify({
          scope: first.scope,
          contactEmail: first.contactEmail,
          evidenceMessageIds,
        }),
      )
      .digest("hex");
    return [{
      userId: input.userId,
      accountId: input.accountId,
      stepType: "memory.incremental",
      payload: {
        schemaVersion: MEMORY_SCHEMA_VERSION,
        mode: first.scope,
        contactEmail: first.scope === "contact" ? first.contactEmail : null,
        evidenceMessageIds,
      },
      idempotencyKey: `memory.incremental:${input.accountId}:${digest}`,
    }];
  });
}

export async function clearPendingMemoryEvidence(
  input: {
    accountId: string;
    mode: "global" | "contact";
    contactEmail: string | null;
    messageIds: string[];
  },
  database: Database = getDatabase(),
) {
  if (input.messageIds.length === 0) return;
  await database
    .delete(memoryPendingEvidence)
    .where(
      and(
        eq(memoryPendingEvidence.accountId, input.accountId),
        eq(memoryPendingEvidence.scope, input.mode),
        eq(memoryPendingEvidence.contactEmail, input.contactEmail ?? ""),
        inArray(memoryPendingEvidence.messageId, input.messageIds),
      ),
    );
}

export async function enqueuePendingAnalysisWorkflowSteps(
  database: Database = getDatabase(),
): Promise<number> {
  const indexedAccounts = await database
    .select({
      id: connectedAccounts.id,
      userId: connectedAccounts.userId,
      syncState: connectedAccounts.syncState,
    })
    .from(connectedAccounts)
    .innerJoin(
      gmailReplicaStates,
      eq(gmailReplicaStates.accountId, connectedAccounts.id),
    )
    .where(eq(connectedAccounts.status, "connected"));

  const memoryReadyAccountIds = indexedAccounts
    .filter((account) => account.syncState.memory === "complete")
    .map((account) => account.id);
  const pendingEvidence =
    memoryReadyAccountIds.length > 0
      ? await database
          .select({
            accountId: memoryPendingEvidence.accountId,
            messageId: memoryPendingEvidence.messageId,
            scope: memoryPendingEvidence.scope,
            contactEmail: memoryPendingEvidence.contactEmail,
          })
          .from(memoryPendingEvidence)
          .where(
            and(
              inArray(memoryPendingEvidence.accountId, memoryReadyAccountIds),
              eq(memoryPendingEvidence.schemaVersion, MEMORY_SCHEMA_VERSION),
            ),
          )
          .orderBy(
            asc(memoryPendingEvidence.accountId),
            asc(memoryPendingEvidence.createdAt),
            asc(memoryPendingEvidence.id),
          )
      : [];
  const pendingEvidenceByAccount = new Map<
    string,
    PendingMemoryEvidence[]
  >();
  for (const evidence of pendingEvidence) {
    const grouped = pendingEvidenceByAccount.get(evidence.accountId) ?? [];
    grouped.push(evidence);
    pendingEvidenceByAccount.set(evidence.accountId, grouped);
  }
  const incrementalJobs = indexedAccounts.flatMap((account) =>
    account.syncState.memory === "complete"
      ? incrementalMemoryJobs({
          userId: account.userId,
          accountId: account.id,
          pendingEvidence: pendingEvidenceByAccount.get(account.id) ?? [],
        })
      : [],
  );
  const values = incrementalJobs;
  if (values.length === 0) return 0;

  const inserted = await enqueueWorkflowStepsWithExecutor(values, database);
  return inserted.length;
}

export async function enqueueBatchEvent(
  input: {
    provider: "openai" | "azure-openai";
    webhookId: string;
    eventType: string;
    providerBatchId: string;
  },
  database: Database = getDatabase(),
): Promise<{ submissionJobId: string } | null> {
  return database.transaction(async (transaction) => {
    const [embeddingSubmission] =
      input.provider === "openai"
        ? await transaction
            .select({
              id: embeddingBatchSubmissions.workflowStepId,
              userId: embeddingBatchSubmissions.userId,
              accountId: embeddingBatchSubmissions.accountId,
              stepType: workflowSteps.stepType,
            })
            .from(embeddingBatchSubmissions)
            .innerJoin(
              workflowSteps,
              eq(workflowSteps.id, embeddingBatchSubmissions.workflowStepId),
            )
            .where(
              and(
                eq(embeddingBatchSubmissions.provider, "openai"),
                eq(
                  embeddingBatchSubmissions.providerBatchId,
                  input.providerBatchId,
                ),
                inArray(embeddingBatchSubmissions.status, [
                  "submitted",
                  "complete",
                ]),
              ),
            )
            .limit(1)
        : [];
    const [derivationSubmission] = embeddingSubmission
      ? []
      : await transaction
          .select({
            id: workflowSteps.id,
            userId: workflowSteps.userId,
            accountId: workflowSteps.accountId,
            stepType: workflowSteps.stepType,
          })
          .from(workflowSteps)
          .where(
            and(
              eq(workflowSteps.status, "complete"),
              inArray(workflowSteps.stepType, [
                "memory.extract",
                "memory.incremental",
                "memory.batch.retry",
              ]),
              sql`${workflowSteps.result}->>'provider' = ${input.provider}`,
              sql`${workflowSteps.result}->>'providerBatchId' = ${input.providerBatchId}`,
            ),
          )
          .orderBy(desc(workflowSteps.updatedAt))
          .limit(1);
    const [threadLabelSubmission] =
      input.provider === "openai" && !embeddingSubmission
        ? await transaction
            .select({
              id: threadLabelBatchSubmissions.workflowStepId,
              userId: threadLabelBatchSubmissions.userId,
              accountId: threadLabelBatchSubmissions.accountId,
              stepType: workflowSteps.stepType,
            })
            .from(threadLabelBatchSubmissions)
            .innerJoin(
              workflowSteps,
              eq(workflowSteps.id, threadLabelBatchSubmissions.workflowStepId),
            )
            .where(
              and(
                eq(threadLabelBatchSubmissions.provider, "openai"),
                eq(
                  threadLabelBatchSubmissions.providerBatchId,
                  input.providerBatchId,
                ),
                inArray(threadLabelBatchSubmissions.status, [
                  "submitted",
                  "complete",
                  "failed",
                ]),
              ),
            )
            .limit(1)
        : [];
    const submission =
      embeddingSubmission ?? threadLabelSubmission ?? derivationSubmission;
    if (!submission) return null;

    const payload = {
      submissionJobId: submission.id,
      webhookId: input.webhookId,
      eventType: input.eventType,
      provider: input.provider,
      providerBatchId: input.providerBatchId,
    };
    const idempotencyKey = createBatchEventIdempotencyKey({
      provider: input.provider,
      webhookId: input.webhookId,
    });
    if (submission) {
      const eventJobType = submission.stepType.startsWith("embedding.")
        ? "embedding.batch.event"
        : submission.stepType.startsWith("label.")
          ? "label.batch.event"
          : "memory.batch.event";
      await enqueueWorkflowStep(
        {
          userId: submission.userId,
          accountId: submission.accountId,
          stepType: eventJobType,
          payload,
          idempotencyKey,
        },
        transaction as unknown as Database,
      );
    }

    return { submissionJobId: submission.id };
  });
}

export async function getBatchSubmission(
  jobId: string,
  database: Database = getDatabase(),
) {
  return getWorkflowStepSubmission(jobId, database);
}

export async function enqueueMemoryBatchRetry(
  input: {
    userId: string;
    accountId: string;
    parentSubmissionJobId: string;
    rootSubmissionJobId: string;
    batchAttempt: number;
    replaceExisting: boolean;
    manifest: Array<{
      key: string;
      mode: "global" | "contact";
      contactEmail: string | null;
      messageIds: string[];
    }>;
  },
  database: Database = getDatabase(),
) {
  const manifestHash = createHash("sha256")
    .update(
      JSON.stringify(
        input.manifest.map((entry) => ({
          key: entry.key,
          messageIds: entry.messageIds,
        })),
      ),
    )
    .digest("hex");

  const idempotencyKey = `memory.batch.retry:${input.parentSubmissionJobId}:${manifestHash}`;
  const payload = {
    parentSubmissionJobId: input.parentSubmissionJobId,
    rootSubmissionJobId: input.rootSubmissionJobId,
    batchAttempt: input.batchAttempt,
    replaceExisting: input.replaceExisting,
    manifest: input.manifest,
  };
  return enqueueWorkflowStep(
    {
      userId: input.userId,
      accountId: input.accountId,
      stepType: "memory.batch.retry",
      payload,
      idempotencyKey,
    },
    database,
  );
}
