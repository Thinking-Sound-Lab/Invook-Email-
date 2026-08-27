import type { MailboxChangeEvent } from "@invook/contracts";

export interface MailboxEventLocation {
  accountSelection: string;
  surface: string;
  threadId: string | null;
  view: string;
}

function hasThread(threadIds: string[], threadId: string | null): boolean {
  return Boolean(threadId && threadIds.includes(threadId));
}

export function isRelevantMailboxChange(
  event: MailboxChangeEvent,
  input: MailboxEventLocation,
): boolean {
  if (
    input.accountSelection !== "all" &&
    event.accountId !== input.accountSelection
  ) {
    return false;
  }
  switch (event.changeType) {
    case "replica_ready":
    case "safe_invalidation":
      return true;
    case "history_applied":
      return input.threadId
        ? hasThread(
            [...event.changedThreadIds, ...event.refreshedThreadIds],
            input.threadId,
          )
        : input.surface === "mail" && event.changedThreadIds.length > 0;
    case "labels_changed":
      return input.threadId
        ? hasThread(event.affectedThreadIds, input.threadId)
        : input.surface === "mail";
    case "drafts_changed":
      return input.threadId
        ? hasThread(event.affectedThreadIds, input.threadId)
        : input.surface === "mail" && input.view === "drafts";
  }
}
