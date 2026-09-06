import type {
  InvookLabel,
  InvookThreadLabel,
  MailboxAccount,
  MailboxAccountLabel,
  MailboxPagination,
  MailboxSelectedThread,
  MailboxSettings,
  MailboxScopeSidebarCounts,
  MailboxThreadMessage,
  MailboxSidebarCounts,
  MailboxThreadPage,
  MailboxThreadSummary,
  MailboxThreadUpdates,
  MailboxView,
  StaticMailboxView,
} from "@invook/contracts";
import {
  and,
  asc,
  count,
  countDistinct,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  lt,
  not,
  or,
  sql,
} from "drizzle-orm";
import { validate as validateUuid } from "uuid";

import { getDatabase, type Database } from "./client";
import {
  countedGmailProviderLabelIds,
  MAILBOX_PAGE_SIZE,
  mailboxViewCondition,
  mailboxViewForProviderLabelId,
  visibleMessageCondition,
  visibleThreadCondition,
} from "./mailbox-visibility";
import {
  connectedAccounts,
  drafts,
  gmailReplicaStates,
  labels,
  messageAttachments,
  messageLabels,
  messages,
  threadLabelAssignments,
  threads,
} from "./schema";

export type MailboxCursor = {
  direction: "newer" | "older";
  latestMessageAt: Date;
  threadId: string;
};

type MailboxAccountRow = {
  id: string;
  email: string;
  image: string | null;
  status: MailboxAccount["status"];
  syncState: MailboxAccount["syncState"];
  lastSyncedAt: Date | null;
  replicaState: MailboxAccount["replica"]["state"];
  replicaReadyAt: Date | null;
};

/**
 * The stored thread detail, before the API turns each message body into its
 * sanitized presentation. Persistence owns the raw provider HTML; deciding how
 * it is safe to render belongs to the layer that serializes the response.
 */
export type StoredMailboxThreadMessage = Omit<
  MailboxThreadMessage,
  "bodyPresentation"
> & {
  bodyHtml: string | null;
};

export type StoredMailboxSelectedThread = Omit<
  MailboxSelectedThread,
  "messages"
> & {
  messages: StoredMailboxThreadMessage[];
};

export type StoredMailboxThreadDetail = {
  thread: StoredMailboxSelectedThread;
  invookLabels: InvookLabel[];
};

type ThreadBaseRow = Omit<
  MailboxThreadSummary,
  "isUnread" | "isStarred" | "isDraft" | "invookLabel" | "latestMessageAt"
> & {
  latestMessageAt: Date | null;
};

function serializeAccount(account: MailboxAccountRow): MailboxAccount {
  return {
    id: account.id,
    email: account.email,
    image: account.image,
    status: account.status,
    syncState: account.syncState,
    lastSyncedAt: account.lastSyncedAt?.toISOString() ?? null,
    replica: {
      state: account.replicaState,
      readyAt: account.replicaReadyAt?.toISOString() ?? null,
    },
  };
}

export function parseMailboxCursor(value: string): MailboxCursor | null {
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      direction?: unknown;
      latestMessageAt?: unknown;
      threadId?: unknown;
    };
    if (
      (decoded.direction !== "newer" && decoded.direction !== "older") ||
      typeof decoded.latestMessageAt !== "string" ||
      typeof decoded.threadId !== "string" ||
      !validateUuid(decoded.threadId)
    ) {
      return null;
    }
    const latestMessageAt = new Date(decoded.latestMessageAt);
    return Number.isFinite(latestMessageAt.getTime())
      ? {
          direction: decoded.direction,
          latestMessageAt,
          threadId: decoded.threadId,
        }
      : null;
  } catch {
    return null;
  }
}

function createMailboxCursor(
  direction: MailboxCursor["direction"],
  thread: { id: string; latestMessageAt: Date | null },
): string {
  return Buffer.from(
    JSON.stringify({
      direction,
      latestMessageAt: (thread.latestMessageAt ?? new Date(0)).toISOString(),
      threadId: thread.id,
    }),
  ).toString("base64url");
}

async function listMailboxAccountContexts(
  userId: string,
  database: Database,
): Promise<MailboxAccountRow[]> {
  return database
    .select({
      id: connectedAccounts.id,
      email: connectedAccounts.email,
      image: connectedAccounts.image,
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
    .orderBy(asc(connectedAccounts.createdAt), asc(connectedAccounts.id));
}

async function resolveMailboxAccountContexts(
  input: { userId: string; accountId?: string | null },
  database: Database,
): Promise<MailboxAccountRow[] | null> {
  const accounts = await listMailboxAccountContexts(input.userId, database);
  if (!input.accountId) return accounts.length > 0 ? accounts : null;
  const account = accounts.find((candidate) => candidate.id === input.accountId);
  return account ? [account] : null;
}

export async function resolveMailboxAccountIds(
  input: { userId: string; accountId?: string | null },
  database: Database = getDatabase(),
): Promise<string[] | null> {
  const accounts = await resolveMailboxAccountContexts(input, database);
  return accounts ? accounts.map((account) => account.id) : null;
}

async function listInvookLabels(
  input: { userId: string; accountId: string },
  database: Database,
): Promise<InvookLabel[]> {
  const rows = await database
    .select({
      id: labels.id,
      name: labels.name,
      description: labels.description,
      systemKey: labels.systemKey,
      definitionVersion: labels.definitionVersion,
      isEnabled: labels.isEnabled,
    })
    .from(labels)
    .where(
      and(
        eq(labels.userId, input.userId),
        eq(labels.accountId, input.accountId),
        eq(labels.kind, "invook"),
      ),
    )
    .orderBy(asc(labels.createdAt), asc(labels.name));
  return rows.sort((left, right) => left.name.localeCompare(right.name));
}

type AccountInvookLabel = MailboxAccountLabel & { accountId: string };

async function listInvookLabelsForAccounts(
  input: { userId: string; accountIds: string[] },
  database: Database,
): Promise<AccountInvookLabel[]> {
  if (input.accountIds.length === 0) return [];
  const rows = await database
    .select({
      accountId: labels.accountId,
      id: labels.id,
      name: labels.name,
      normalizedName: labels.normalizedName,
      description: labels.description,
      systemKey: labels.systemKey,
      definitionVersion: labels.definitionVersion,
      isEnabled: labels.isEnabled,
    })
    .from(labels)
    .where(
      and(
        eq(labels.userId, input.userId),
        inArray(labels.accountId, input.accountIds),
        eq(labels.kind, "invook"),
      ),
    )
    .orderBy(asc(labels.accountId), asc(labels.createdAt), asc(labels.name));
  return rows.sort((left, right) =>
    left.accountId === right.accountId
      ? left.name.localeCompare(right.name)
      : left.accountId.localeCompare(right.accountId),
  );
}

async function attachThreadLabels<T extends ThreadBaseRow>(
  input: {
    userId: string;
    accountIds: string[];
    threadRows: T[];
  },
  database: Database,
): Promise<Array<Omit<T, "latestMessageAt"> & MailboxThreadSummary>> {
  const threadIds = input.threadRows.map((thread) => thread.id);
  if (threadIds.length === 0) return [];
  const [invookLabelRows, gmailLabelRows] = await Promise.all([
    database
      .select({
        threadId: threadLabelAssignments.threadId,
        labelId: threadLabelAssignments.labelId,
        name: labels.name,
        source: threadLabelAssignments.source,
        confidence: threadLabelAssignments.confidence,
      })
      .from(threadLabelAssignments)
      .innerJoin(labels, eq(labels.id, threadLabelAssignments.labelId))
      .where(
        and(
          eq(threadLabelAssignments.userId, input.userId),
          inArray(threadLabelAssignments.accountId, input.accountIds),
          inArray(threadLabelAssignments.threadId, threadIds),
          eq(labels.userId, input.userId),
          eq(labels.accountId, threadLabelAssignments.accountId),
          inArray(labels.accountId, input.accountIds),
          eq(labels.kind, "invook"),
        ),
      ),
    database
      .select({
        threadId: messages.threadId,
        providerLabelId: labels.providerLabelId,
      })
      .from(messages)
      .innerJoin(messageLabels, eq(messageLabels.messageId, messages.id))
      .innerJoin(labels, eq(labels.id, messageLabels.labelId))
      .where(
        and(
          eq(messages.userId, input.userId),
          inArray(messages.accountId, input.accountIds),
          inArray(messages.threadId, threadIds),
          eq(messageLabels.accountId, messages.accountId),
          eq(labels.userId, input.userId),
          eq(labels.accountId, messages.accountId),
          inArray(labels.accountId, input.accountIds),
          eq(labels.kind, "gmail"),
          eq(labels.providerType, "system"),
          visibleMessageCondition,
        ),
      ),
  ]);
  const invookLabelsByThread = new Map<string, InvookThreadLabel>();
  for (const label of invookLabelRows) {
    invookLabelsByThread.set(label.threadId, {
      labelId: label.labelId,
      name: label.name,
      source: label.source,
      confidence: label.confidence === null ? null : Number(label.confidence),
    });
  }
  const stateByThreadId = new Map<string, Set<string>>();
  for (const label of gmailLabelRows) {
    if (!label.providerLabelId) continue;
    const state = stateByThreadId.get(label.threadId) ?? new Set<string>();
    state.add(label.providerLabelId);
    stateByThreadId.set(label.threadId, state);
  }
  return input.threadRows.map((thread) => ({
    ...thread,
    latestMessageAt: thread.latestMessageAt?.toISOString() ?? null,
    isUnread: stateByThreadId.get(thread.id)?.has("UNREAD") ?? false,
    isStarred: stateByThreadId.get(thread.id)?.has("STARRED") ?? false,
    isDraft: stateByThreadId.get(thread.id)?.has("DRAFT") ?? false,
    invookLabel: invookLabelsByThread.get(thread.id) ?? null,
  }));
}

export async function getMailboxShellData(
  userId: string,
  database: Database = getDatabase(),
): Promise<{
  accounts: MailboxAccount[];
  accountLabels: Array<{ accountId: string; labels: MailboxAccountLabel[] }>;
} | null> {
  const accounts = await listMailboxAccountContexts(userId, database);
  if (accounts.length === 0) return null;
  const invookLabels = await listInvookLabelsForAccounts(
    { userId, accountIds: accounts.map((account) => account.id) },
    database,
  );
  return {
    accounts: accounts.map(serializeAccount),
    accountLabels: accounts.map((account) => ({
      accountId: account.id,
      labels: invookLabels
        .filter((label) => label.accountId === account.id)
        .map(({ accountId: _accountId, ...label }) => label),
    })),
  };
}

function emptySidebarCounts(): MailboxScopeSidebarCounts {
  return {
    views: {
      all: 0,
      important: 0,
      starred: 0,
      drafts: 0,
      sent: 0,
      spam: 0,
      trash: 0,
    },
    labels: {},
  };
}

export async function getMailboxSidebarCounts(
  userId: string,
  database: Database = getDatabase(),
): Promise<MailboxSidebarCounts | null> {
  const accounts = await listMailboxAccountContexts(userId, database);
  if (accounts.length === 0) return null;
  const accountIds = accounts.map((account) => account.id);
  const [
    invookLabels,
    allThreadCountRows,
    gmailLabelCountRows,
    invookLabelCountRows,
  ] =
    await Promise.all([
      listInvookLabelsForAccounts({ userId, accountIds }, database),
      database
        .select({ accountId: threads.accountId, value: count(threads.id) })
        .from(threads)
        .where(
          and(
            eq(threads.userId, userId),
            inArray(threads.accountId, accountIds),
            mailboxViewCondition("all"),
          ),
        )
        .groupBy(threads.accountId),
      database
        .select({
          accountId: messages.accountId,
          labelId: labels.id,
          providerLabelId: labels.providerLabelId,
          value: countDistinct(messages.threadId),
        })
        .from(messages)
        .innerJoin(messageLabels, eq(messageLabels.messageId, messages.id))
        .innerJoin(labels, eq(labels.id, messageLabels.labelId))
        .where(
          and(
            eq(messages.userId, userId),
            inArray(messages.accountId, accountIds),
            eq(messageLabels.accountId, messages.accountId),
            eq(labels.userId, userId),
            eq(labels.accountId, messages.accountId),
            inArray(labels.accountId, accountIds),
            eq(labels.kind, "gmail"),
            inArray(labels.providerLabelId, countedGmailProviderLabelIds),
          ),
        )
        .groupBy(messages.accountId, labels.id, labels.providerLabelId),
      database
        .select({
          accountId: threads.accountId,
          labelId: labels.id,
          systemKey: labels.systemKey,
          value: count(threads.id),
        })
        .from(threadLabelAssignments)
        .innerJoin(labels, eq(labels.id, threadLabelAssignments.labelId))
        .innerJoin(threads, eq(threads.id, threadLabelAssignments.threadId))
        .where(
          and(
            eq(threads.userId, userId),
            inArray(threads.accountId, accountIds),
            eq(threadLabelAssignments.accountId, threads.accountId),
            eq(labels.accountId, threads.accountId),
            mailboxViewCondition("all"),
            eq(labels.kind, "invook"),
          ),
        )
        .groupBy(threads.accountId, labels.id, labels.systemKey),
    ]);
  const countsByAccountId = new Map<string, MailboxScopeSidebarCounts>(
    accounts.map((account) => [account.id, emptySidebarCounts()]),
  );
  for (const label of invookLabels) {
    const counts = countsByAccountId.get(label.accountId);
    if (counts) counts.labels[label.id] = 0;
  }
  for (const countRow of allThreadCountRows) {
    const counts = countsByAccountId.get(countRow.accountId);
    if (counts) counts.views.all = countRow.value;
  }
  for (const countRow of invookLabelCountRows) {
    const counts = countsByAccountId.get(countRow.accountId);
    if (!counts) continue;
    counts.labels[countRow.labelId] = countRow.value;
    if (countRow.systemKey === "important") {
      counts.views.important = countRow.value;
    }
  }
  for (const countRow of gmailLabelCountRows) {
    const counts = countsByAccountId.get(countRow.accountId);
    if (!counts) continue;
    const view = mailboxViewForProviderLabelId(countRow.providerLabelId);
    if (view) counts.views[view] = countRow.value;
  }
  const all = emptySidebarCounts();
  for (const counts of countsByAccountId.values()) {
    for (const view of Object.keys(all.views) as StaticMailboxView[]) {
      all.views[view] += counts.views[view];
    }
  }
  // Sibling labels share one stored normalized name across accounts, the same
  // identity a label view matches, so the All scope reports the combined total
  // under each account label id that carries that name.
  const labelTotalsByName = new Map<string, number>();
  for (const label of invookLabels) {
    const accountCount =
      countsByAccountId.get(label.accountId)?.labels[label.id] ?? 0;
    labelTotalsByName.set(
      label.normalizedName,
      (labelTotalsByName.get(label.normalizedName) ?? 0) + accountCount,
    );
  }
  for (const label of invookLabels) {
    all.labels[label.id] = labelTotalsByName.get(label.normalizedName) ?? 0;
  }
  return {
    all,
    accounts: Object.fromEntries(countsByAccountId),
  };
}

export async function listMailboxThreads(
  userId: string,
  input: {
    accountId?: string | null;
    cursor?: MailboxCursor | null;
    view?: MailboxView;
  } = {},
  database: Database = getDatabase(),
): Promise<MailboxThreadPage | null> {
  const { accountId = null, cursor = null, view = "all" } = input;
  const accounts = await resolveMailboxAccountContexts(
    { userId, accountId },
    database,
  );
  if (!accounts) return null;
  const accountIds = accounts.map((account) => account.id);
  const mailboxSortTime = sql<Date>`coalesce(${threads.latestMessageAt}, to_timestamp(0))`;
  const cursorSortTime = cursor
    ? sql<Date>`${cursor.latestMessageAt.toISOString()}::timestamptz`
    : undefined;
  const cursorCondition = cursor && cursorSortTime
    ? or(
        cursor.direction === "newer"
          ? gt(mailboxSortTime, cursorSortTime)
          : lt(mailboxSortTime, cursorSortTime),
        and(
          eq(mailboxSortTime, cursorSortTime),
          cursor.direction === "newer"
            ? gt(threads.id, cursor.threadId)
            : lt(threads.id, cursor.threadId),
        ),
      )
    : undefined;
  const rawThreads = await database
    .select({
      accountId: threads.accountId,
      accountEmail: connectedAccounts.email,
      id: threads.id,
      subject: threads.subject,
      snippet: threads.snippet,
      participants: threads.participants,
      latestMessageAt: threads.latestMessageAt,
      messageCount: threads.messageCount,
    })
    .from(threads)
    .innerJoin(connectedAccounts, eq(connectedAccounts.id, threads.accountId))
    .where(
      and(
        eq(threads.userId, userId),
        inArray(threads.accountId, accountIds),
        visibleThreadCondition(),
        mailboxViewCondition(view),
        cursorCondition,
      ),
    )
    .orderBy(
      cursor?.direction === "newer" ? asc(mailboxSortTime) : desc(mailboxSortTime),
      cursor?.direction === "newer" ? asc(threads.id) : desc(threads.id),
    )
    .limit(MAILBOX_PAGE_SIZE + 1);
  const hasExtraPage = rawThreads.length > MAILBOX_PAGE_SIZE;
  const currentPage = rawThreads.slice(0, MAILBOX_PAGE_SIZE);
  const pageRows = cursor?.direction === "newer" ? currentPage.reverse() : currentPage;
  const firstThread = pageRows[0];
  const lastThread = pageRows.at(-1);
  const pagination: MailboxPagination = {
    newerCursor:
      Boolean(cursor) &&
      (cursor?.direction === "older" || hasExtraPage) &&
      firstThread
        ? createMailboxCursor("newer", firstThread)
        : null,
    olderCursor:
      (cursor?.direction === "newer" || hasExtraPage) && lastThread
        ? createMailboxCursor("older", lastThread)
        : null,
  };
  const pageThreads = await attachThreadLabels(
    { userId, accountIds, threadRows: pageRows },
    database,
  );
  return { pagination, threads: pageThreads };
}

/**
 * Refreshes the threads named by a mailbox change event.
 *
 * Mailbox pages are addressable only by cursor position, and a cursor points
 * into an ordering keyed on `latestMessageAt` that a new message reorders. An
 * event names thread identities instead, so reconciliation reads them directly
 * rather than refetching a page whose boundaries have already moved.
 */
export async function listMailboxThreadsByIds(
  userId: string,
  input: {
    accountId?: string | null;
    threadIds: string[];
    view?: MailboxView;
  },
  database: Database = getDatabase(),
): Promise<MailboxThreadUpdates | null> {
  const { accountId = null, threadIds, view = "all" } = input;
  const accounts = await resolveMailboxAccountContexts(
    { userId, accountId },
    database,
  );
  if (!accounts) return null;
  const requestedThreadIds = Array.from(new Set(threadIds));
  if (requestedThreadIds.length === 0) {
    return { threads: [], missingThreadIds: [] };
  }
  const accountIds = accounts.map((account) => account.id);
  const mailboxSortTime = sql<Date>`coalesce(${threads.latestMessageAt}, to_timestamp(0))`;
  const threadRows = await database
    .select({
      accountId: threads.accountId,
      accountEmail: connectedAccounts.email,
      id: threads.id,
      subject: threads.subject,
      snippet: threads.snippet,
      participants: threads.participants,
      latestMessageAt: threads.latestMessageAt,
      messageCount: threads.messageCount,
    })
    .from(threads)
    .innerJoin(connectedAccounts, eq(connectedAccounts.id, threads.accountId))
    .where(
      and(
        eq(threads.userId, userId),
        inArray(threads.accountId, accountIds),
        inArray(threads.id, requestedThreadIds),
        visibleThreadCondition(),
        mailboxViewCondition(view),
      ),
    )
    .orderBy(desc(mailboxSortTime), desc(threads.id));
  const updatedThreads = await attachThreadLabels(
    { userId, accountIds, threadRows },
    database,
  );
  const presentThreadIds = new Set(updatedThreads.map((thread) => thread.id));
  return {
    threads: updatedThreads,
    missingThreadIds: requestedThreadIds.filter(
      (threadId) => !presentThreadIds.has(threadId),
    ),
  };
}

export async function getMailboxThreadDetail(
  userId: string,
  threadId: string,
  accountId: string | null = null,
  database: Database = getDatabase(),
): Promise<StoredMailboxThreadDetail | null> {
  const accounts = await resolveMailboxAccountContexts(
    { userId, accountId },
    database,
  );
  if (!accounts) return null;
  const accountIds = accounts.map((account) => account.id);
  const [selectedThread] = await database
    .select({
      accountId: threads.accountId,
      accountEmail: connectedAccounts.email,
      id: threads.id,
      providerThreadId: threads.providerThreadId,
      subject: threads.subject,
      snippet: threads.snippet,
      participants: threads.participants,
      latestMessageAt: threads.latestMessageAt,
      messageCount: threads.messageCount,
    })
    .from(threads)
    .innerJoin(connectedAccounts, eq(connectedAccounts.id, threads.accountId))
    .where(
      and(
        eq(threads.id, threadId),
        eq(threads.userId, userId),
        inArray(threads.accountId, accountIds),
        visibleThreadCondition(),
      ),
    )
    .limit(1);
  if (!selectedThread) return null;
  const [threadRowsWithLabels, invookLabels, threadMessages, providerDrafts] =
    await Promise.all([
      attachThreadLabels(
        { userId, accountIds: [selectedThread.accountId], threadRows: [selectedThread] },
        database,
      ),
      listInvookLabels({ userId, accountId: selectedThread.accountId }, database),
      database
        .select({
          id: messages.id,
          providerMessageId: messages.providerMessageId,
          providerHistoryId: messages.providerHistoryId,
          internalDate: messages.internalDate,
          sizeEstimate: messages.sizeEstimate,
          headerLines: messages.headerLines,
          direction: messages.direction,
          sender: messages.sender,
          recipients: messages.recipients,
          subject: messages.subject,
          bodyText: messages.bodyText,
          bodyHtml: messages.bodyHtml,
          sentAt: messages.sentAt,
        })
        .from(messages)
        .where(
          and(
            eq(messages.userId, userId),
            eq(messages.accountId, selectedThread.accountId),
            eq(messages.threadId, selectedThread.id),
            visibleMessageCondition,
          ),
        )
        .orderBy(asc(messages.sentAt)),
      database
        .select({
          id: drafts.id,
          providerDraftId: drafts.providerDraftId,
          providerMessageId: drafts.providerMessageId,
          providerThreadId: drafts.providerThreadId,
          updatedAt: drafts.updatedAt,
        })
        .from(drafts)
        .innerJoin(messages, eq(messages.id, drafts.messageId))
        .where(
          and(
            eq(drafts.userId, userId),
            eq(drafts.accountId, selectedThread.accountId),
            eq(drafts.kind, "gmail"),
            eq(drafts.providerThreadId, selectedThread.providerThreadId),
            isNotNull(drafts.providerMessageId),
            eq(messages.userId, userId),
            eq(messages.accountId, selectedThread.accountId),
            visibleMessageCondition,
          ),
        )
        .orderBy(desc(drafts.updatedAt)),
    ]);
  const baseThread = threadRowsWithLabels[0];
  if (!baseThread) return null;
  const messageIds = threadMessages.map((message) => message.id);
  const [attachmentRows, messageGmailLabelRows] = messageIds.length > 0
    ? await Promise.all([
        database
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
          .innerJoin(messages, eq(messages.id, messageAttachments.messageId))
          .where(
            and(
              eq(messageAttachments.userId, userId),
              eq(messageAttachments.accountId, selectedThread.accountId),
              eq(messages.userId, userId),
              eq(messages.accountId, selectedThread.accountId),
              inArray(messageAttachments.messageId, messageIds),
            ),
          )
          .orderBy(asc(messageAttachments.filename)),
        database
          .select({
            messageId: messageLabels.messageId,
            providerLabelId: labels.providerLabelId,
          })
          .from(messageLabels)
          .innerJoin(messages, eq(messages.id, messageLabels.messageId))
          .innerJoin(labels, eq(labels.id, messageLabels.labelId))
          .where(
            and(
              eq(messages.userId, userId),
              eq(messages.accountId, selectedThread.accountId),
              inArray(messageLabels.messageId, messageIds),
              eq(labels.userId, userId),
              eq(labels.accountId, selectedThread.accountId),
              eq(labels.kind, "gmail"),
              eq(labels.providerType, "system"),
            ),
          ),
      ])
    : [[], []];
  const attachmentsByMessage = new Map<string, typeof attachmentRows>();
  for (const attachment of attachmentRows) {
    const current = attachmentsByMessage.get(attachment.messageId) ?? [];
    current.push(attachment);
    attachmentsByMessage.set(attachment.messageId, current);
  }
  const stateByMessageId = new Map<string, Set<string>>();
  for (const label of messageGmailLabelRows) {
    if (!label.providerLabelId) continue;
    const state = stateByMessageId.get(label.messageId) ?? new Set<string>();
    state.add(label.providerLabelId);
    stateByMessageId.set(label.messageId, state);
  }
  const thread: StoredMailboxSelectedThread = {
    ...baseThread,
    messages: threadMessages.map((message) => ({
      id: message.id,
      providerMessageId: message.providerMessageId,
      providerHistoryId: message.providerHistoryId,
      internalDate: message.internalDate.toISOString(),
      sizeEstimate: message.sizeEstimate,
      direction: message.direction,
      sender: message.sender,
      recipients: message.recipients,
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
      isUnread: stateByMessageId.get(message.id)?.has("UNREAD") ?? false,
      isStarred: stateByMessageId.get(message.id)?.has("STARRED") ?? false,
      isDraft: stateByMessageId.get(message.id)?.has("DRAFT") ?? false,
      attachments: attachmentsByMessage.get(message.id) ?? [],
    })),
    gmailDrafts: providerDrafts.flatMap((draft) =>
      !draft.providerDraftId || !draft.providerMessageId || !draft.providerThreadId
        ? []
        : [
            {
              id: draft.id,
              providerDraftId: draft.providerDraftId,
              providerMessageId: draft.providerMessageId,
              providerThreadId: draft.providerThreadId,
              updatedAt: draft.updatedAt.toISOString(),
            },
          ],
    ),
  };
  return { thread, invookLabels };
}

export async function getMailboxSettings(
  userId: string,
  accountId: string,
  database: Database = getDatabase(),
): Promise<MailboxSettings | null> {
  const accounts = await resolveMailboxAccountContexts(
    { userId, accountId },
    database,
  );
  const account = accounts?.[0];
  if (!account) return null;
  const invookLabels = await listInvookLabels(
    { userId, accountId: account.id },
    database,
  );
  return {
    accountId: account.id,
    invookLabels,
  };
}

export async function getMailboxEventRecoveryContextForUser(
  userId: string,
  database: Database = getDatabase(),
): Promise<{ accountIds: string[] } | null> {
  const accounts = await listMailboxAccountContexts(userId, database);
  return accounts.length > 0
    ? { accountIds: accounts.map((account) => account.id) }
    : null;
}
