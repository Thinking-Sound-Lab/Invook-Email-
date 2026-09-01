import type { MailboxView, StaticMailboxView } from "@invook/contracts";
import { sql } from "drizzle-orm";

import {
  labels,
  messageLabels,
  messages,
  threadLabelAssignments,
  threads,
} from "./schema";

export const MAILBOX_PAGE_SIZE = 100;

const gmailProviderLabelByMailboxView = {
  starred: "STARRED",
  drafts: "DRAFT",
  sent: "SENT",
  spam: "SPAM",
  trash: "TRASH",
} as const satisfies Record<
  Exclude<StaticMailboxView, "all" | "important">,
  string
>;

export const countedGmailProviderLabelIds = Object.values(
  gmailProviderLabelByMailboxView,
);

const outerThreadId = sql.raw('"threads"."id"');
const outerThreadAccountId = sql.raw('"threads"."account_id"');
const outerThreadUserId = sql.raw('"threads"."user_id"');

export function inboxThreadCondition() {
  return sql<boolean>`exists (
    select 1 from ${messages} inbox_message
    where inbox_message.thread_id = ${outerThreadId}
      and inbox_message.account_id = ${outerThreadAccountId}
      and exists (
        select 1 from ${messageLabels} inbox_membership
        inner join ${labels} inbox_label on inbox_label.id = inbox_membership.label_id
        where inbox_membership.message_id = inbox_message.id
          and inbox_membership.account_id = ${outerThreadAccountId}
          and inbox_label.account_id = ${outerThreadAccountId}
          and inbox_label.kind = 'gmail'
          and inbox_label.provider_label_id = 'INBOX'
      )
  )`;
}

export const visibleMessageCondition = sql<boolean>`true`;

export function visibleThreadCondition() {
  return sql<boolean>`true`;
}

export function mailboxViewCondition(view: MailboxView) {
  if (view.startsWith("label:")) {
    const labelId = view.slice(6);
    // One Invook label exists per connected account, so the view matches every
    // account label the signed-in user owns under the selected label's name.
    return sql<boolean>`exists (
        select 1 from ${threadLabelAssignments} assignment
        inner join ${labels} assignment_label
          on assignment_label.id = assignment.label_id
        where assignment.thread_id = ${outerThreadId}
          and assignment.account_id = ${outerThreadAccountId}
          and assignment_label.account_id = ${outerThreadAccountId}
          and assignment_label.kind = 'invook'
          and assignment_label.normalized_name = (
            select selected_label.normalized_name
            from ${labels} selected_label
            where selected_label.id = ${labelId}::uuid
              and selected_label.user_id = ${outerThreadUserId}
              and selected_label.kind = 'invook'
          )
      )`;
  }
  switch (view) {
    case "all":
      return visibleThreadCondition();
    case "important":
      return sql<boolean>`exists (
          select 1 from ${threadLabelAssignments} important_assignment
          inner join ${labels} important_label
            on important_label.id = important_assignment.label_id
          where important_assignment.thread_id = ${outerThreadId}
            and important_assignment.account_id = ${outerThreadAccountId}
            and important_label.account_id = ${outerThreadAccountId}
            and important_label.kind = 'invook'
            and important_label.system_key = 'important'
        )`;
    case "starred":
    case "drafts":
    case "sent":
    case "spam":
    case "trash": {
      const providerLabelId = gmailProviderLabelByMailboxView[view];
      return sql<boolean>`exists (
        select 1
        from ${messages}
        inner join ${messageLabels}
          on ${messageLabels.messageId} = ${messages.id}
        inner join ${labels}
          on ${labels.id} = ${messageLabels.labelId}
        where ${messages.threadId} = ${threads.id}
          and ${messages.accountId} = ${threads.accountId}
          and ${messageLabels.accountId} = ${threads.accountId}
          and ${labels.accountId} = ${threads.accountId}
          and ${labels.kind} = 'gmail'
          and ${labels.providerLabelId} = ${providerLabelId}
      )`;
    }
  }
}

export function mailboxViewForProviderLabelId(
  providerLabelId: string | null,
): Exclude<StaticMailboxView, "all"> | null {
  switch (providerLabelId) {
    case "STARRED":
      return "starred";
    case "DRAFT":
      return "drafts";
    case "SENT":
      return "sent";
    case "SPAM":
      return "spam";
    case "TRASH":
      return "trash";
    default:
      return null;
  }
}
