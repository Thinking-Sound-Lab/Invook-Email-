import { gte, lte, sql, type SQL, type SQLWrapper } from "drizzle-orm";

import { labels, messageLabels, messages, threads } from "./schema";

export const AUTOMATIC_THREAD_LABEL_WINDOW_DAYS = 14;

export function automaticThreadLabelCutoff(referenceAt: Date): Date {
  return new Date(
    referenceAt.getTime() - AUTOMATIC_THREAD_LABEL_WINDOW_DAYS * 86_400_000,
  );
}

export function inboxMessageCondition(
  messageId: SQLWrapper,
  accountId: SQLWrapper,
): SQL<boolean> {
  return sql<boolean>`exists (
    select 1 from ${messageLabels} membership
    inner join ${labels} label on label.id = membership.label_id
    where membership.message_id = ${messageId}
      and membership.account_id = ${accountId}
      and label.account_id = ${accountId}
      and label.kind = 'gmail' and label.provider_label_id = 'INBOX'
  ) and not exists (
    select 1 from ${messageLabels} membership
    inner join ${labels} label on label.id = membership.label_id
    where membership.message_id = ${messageId}
      and membership.account_id = ${accountId}
      and label.account_id = ${accountId}
      and label.kind = 'gmail' and label.provider_label_id in ('SPAM', 'TRASH')
  )`;
}

export function recentInboxThreadCondition(
  after: Date,
  before?: Date,
): SQL<boolean> {
  return sql<boolean>`exists (
    select 1 from ${messages}
    where ${messages.threadId} = ${threads.id}
      and ${messages.accountId} = ${threads.accountId}
      and ${messages.userId} = ${threads.userId}
      and ${gte(messages.sentAt, after)}
      and ${before ? lte(messages.sentAt, before) : sql`true`}
      and ${inboxMessageCondition(messages.id, threads.accountId)}
  )`;
}
