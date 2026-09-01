import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { validate as validateUuid } from "uuid";

import { getDatabase, type Database } from "./client";
import { resolveMailboxAccountIds } from "./mailbox-resources";
import {
  labels,
  messageLabels,
  messages,
  threadLabelAssignments,
} from "./schema";

export type QueryInvookMailboxInput = {
  userId: string;
  accountId?: string | null;
  candidateMessageIds?: string[];
  invookLabelIds?: string[];
  inboxState?: "any" | "inbox" | "not_inbox";
  readState?: "any" | "read" | "unread";
  sender?: string;
  sentAfter?: Date;
  sentBefore?: Date;
  cursor?: string;
  limit?: number;
};

type QueryCursor = { sentAt: Date; messageId: string };

function parseQueryCursor(value: string): QueryCursor | null {
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      sentAt?: unknown;
      messageId?: unknown;
    };
    if (typeof decoded.sentAt !== "string" || typeof decoded.messageId !== "string") {
      return null;
    }
    const sentAt = new Date(decoded.sentAt);
    if (!Number.isFinite(sentAt.getTime()) || !validateUuid(decoded.messageId)) {
      return null;
    }
    return { sentAt, messageId: decoded.messageId };
  } catch {
    return null;
  }
}

function createQueryCursor(message: { id: string; sentAt: Date }): string {
  return Buffer.from(
    JSON.stringify({ sentAt: message.sentAt.toISOString(), messageId: message.id }),
  ).toString("base64url");
}

function gmailMembership(providerLabelId: string) {
  return sql<boolean>`exists (
    select 1
    from ${messageLabels} membership
    inner join ${labels} label on label.id = membership.label_id
    where membership.message_id = ${messages.id}
      and membership.account_id = ${messages.accountId}
      and label.account_id = ${messages.accountId}
      and label.kind = 'gmail'
      and label.provider_label_id = ${providerLabelId}
  )`;
}

export async function queryInvookMailbox(
  input: QueryInvookMailboxInput,
  database: Database = getDatabase(),
) {
  const accountIds = await resolveMailboxAccountIds(
    { userId: input.userId, accountId: input.accountId },
    database,
  );
  if (!accountIds) {
    return { status: "unavailable" as const, reason: "mailbox_not_connected" as const };
  }

  const limit = Math.max(1, Math.min(input.limit ?? 25, 50));
  const cursor = input.cursor ? parseQueryCursor(input.cursor) : null;
  if (input.cursor && !cursor) throw new Error("The mailbox query cursor is invalid.");

  const availableInvookLabels = await database
    .select({ accountId: labels.accountId, id: labels.id, name: labels.name })
    .from(labels)
    .where(and(inArray(labels.accountId, accountIds), eq(labels.kind, "invook")))
    .orderBy(asc(labels.name));
  if (input.candidateMessageIds && input.candidateMessageIds.length === 0) {
    return {
      status: "available" as const,
      messages: [],
      availableInvookLabels,
      nextCursor: null,
    };
  }

  const conditions = [
    eq(messages.userId, input.userId),
    inArray(messages.accountId, accountIds),
  ];
  if (input.candidateMessageIds) {
    conditions.push(inArray(messages.id, input.candidateMessageIds));
  }
  for (const labelId of input.invookLabelIds ?? []) {
    conditions.push(sql<boolean>`exists (
      select 1 from ${threadLabelAssignments} assignment
      where assignment.thread_id = ${messages.threadId}
        and assignment.account_id = ${messages.accountId}
        and assignment.label_id = ${labelId}
    )`);
  }
  const isInbox = gmailMembership("INBOX");
  const isUnread = gmailMembership("UNREAD");
  if (input.inboxState === "inbox") conditions.push(isInbox);
  if (input.inboxState === "not_inbox") conditions.push(sql<boolean>`not (${isInbox})`);
  if (input.readState === "unread") conditions.push(isUnread);
  if (input.readState === "read") conditions.push(sql<boolean>`not (${isUnread})`);
  if (input.sender?.trim()) {
    const sender = input.sender.trim().toLowerCase();
    conditions.push(
      sql<boolean>`(
        lower(${messages.sender}->>'email') = ${sender}
        or lower(${messages.sender}->>'raw') like ${`%${sender}%`}
      )`,
    );
  }
  if (input.sentAfter) conditions.push(gte(messages.sentAt, input.sentAfter));
  if (input.sentBefore) conditions.push(lte(messages.sentAt, input.sentBefore));
  if (cursor) {
    const cursorCondition = or(
      lt(messages.sentAt, cursor.sentAt),
      and(eq(messages.sentAt, cursor.sentAt), lt(messages.id, cursor.messageId)),
    );
    if (cursorCondition) conditions.push(cursorCondition);
  }

  const rows = await database
    .select({
      accountId: messages.accountId,
      id: messages.id,
      threadId: messages.threadId,
      subject: messages.subject,
      bodyText: messages.bodyText,
      sender: messages.sender,
      sentAt: messages.sentAt,
    })
    .from(messages)
    .where(and(...conditions))
    .orderBy(desc(messages.sentAt), desc(messages.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const messageIds = page.map((message) => message.id);
  const threadIds = Array.from(new Set(page.map((message) => message.threadId)));
  const [memberships, assignmentRows] = messageIds.length === 0
    ? [[], []]
    : await Promise.all([
        database
          .select({
            messageId: messageLabels.messageId,
            kind: labels.kind,
            providerLabelId: labels.providerLabelId,
          })
          .from(messageLabels)
          .innerJoin(labels, eq(labels.id, messageLabels.labelId))
          .where(
            and(
              inArray(messageLabels.messageId, messageIds),
              inArray(messageLabels.accountId, accountIds),
              eq(labels.accountId, messageLabels.accountId),
            ),
          ),
        database
          .select({
            threadId: threadLabelAssignments.threadId,
            id: labels.id,
            name: labels.name,
          })
          .from(threadLabelAssignments)
          .innerJoin(labels, eq(labels.id, threadLabelAssignments.labelId))
          .where(
            and(
              inArray(threadLabelAssignments.threadId, threadIds),
              inArray(threadLabelAssignments.accountId, accountIds),
              eq(labels.accountId, threadLabelAssignments.accountId),
            ),
          ),
      ]);
  const assignmentsByThread = new Map(
    assignmentRows.map((assignment) => [assignment.threadId, assignment]),
  );

  return {
    status: "available" as const,
    messages: page.map((message) => {
      const messageMemberships = memberships.filter(
        (membership) => membership.messageId === message.id,
      );
      const gmailLabels = messageMemberships.filter(
        (membership) => membership.kind === "gmail",
      );
      return {
        accountId: message.accountId,
        messageId: message.id,
        threadId: message.threadId,
        subject: message.subject,
        bodyPreview: message.bodyText.slice(0, 800),
        sender: message.sender,
        sentAt: message.sentAt,
        isInbox: gmailLabels.some(
          (membership) => membership.providerLabelId === "INBOX",
        ),
        isUnread: gmailLabels.some(
          (membership) => membership.providerLabelId === "UNREAD",
        ),
        invookLabel: (() => {
          const assignment = assignmentsByThread.get(message.threadId);
          return assignment
            ? { id: assignment.id, name: assignment.name }
            : null;
        })(),
      };
    }),
    availableInvookLabels,
    nextCursor:
      rows.length > limit && page.length > 0
        ? createQueryCursor(page[page.length - 1]!)
        : null,
  };
}
