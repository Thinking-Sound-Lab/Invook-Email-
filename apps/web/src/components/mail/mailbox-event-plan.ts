import type { MailboxChangeEvent } from "@invook/contracts";

export interface MailboxEventLocation {
  accountSelection: string;
  threadId: string | null;
  view: string;
}

export type MailboxEventPlan =
  | { kind: "ignore" }
  | { kind: "refresh" }
  | { kind: "patch"; threadIds: string[] };

function affectedThreadIds(event: MailboxChangeEvent): string[] {
  switch (event.changeType) {
    case "history_applied":
      return Array.from(
        new Set([...event.changedThreadIds, ...event.refreshedThreadIds]),
      );
    case "labels_changed":
    case "drafts_changed":
      return Array.from(new Set(event.affectedThreadIds));
    case "replica_ready":
    case "safe_invalidation":
      return [];
  }
}

/**
 * Decides how a mailbox change event reaches the interface.
 *
 * Threads are cached on the client, so an event that names thread identities is
 * reconciled by reading just those threads. Account and label state stay server
 * rendered, so the events that move them still take a route refresh.
 */
export function planMailboxEvent(
  event: MailboxChangeEvent,
  location: MailboxEventLocation,
): MailboxEventPlan {
  if (
    location.accountSelection !== "all" &&
    event.accountId !== location.accountSelection
  ) {
    return { kind: "ignore" };
  }

  switch (event.changeType) {
    case "replica_ready":
    case "safe_invalidation":
      return { kind: "refresh" };
    case "history_applied":
    case "labels_changed":
    case "drafts_changed": {
      const threadIds = affectedThreadIds(event);
      if (threadIds.length === 0) return { kind: "ignore" };
      return { kind: "patch", threadIds };
    }
  }
}
