import { gmailSystemLabels } from "@invook/gmail";

const actionPrecedence = { labels: 1, upsert: 2, delete: 3 } as const;

export type GmailHistoryMessageAction = {
  action: "upsert" | "labels" | "delete";
  providerHistoryId: string | null;
  gmailLabels: ReturnType<typeof gmailSystemLabels> | null;
  isDraftRelated: boolean;
};

export type GmailHistoryMessageChange = {
  action: GmailHistoryMessageAction["action"];
  providerLabelIds: string[] | null;
  isDraftRelated: boolean;
};

/**
 * Fold one history change into the message's coalesced action for a catch-up.
 *
 * A later event without a post-change label snapshot must not keep an earlier
 * one. Gmail often omits `message.labelIds` on `labelsRemoved`, and keeping the
 * previous snapshot would restore INBOX after an archive that followed a star.
 */
export function mergeGmailHistoryMessageAction(
  current: GmailHistoryMessageAction | undefined,
  change: GmailHistoryMessageChange,
  providerHistoryId: string | null,
): GmailHistoryMessageAction {
  return {
    action:
      current &&
      actionPrecedence[current.action] > actionPrecedence[change.action]
        ? current.action
        : change.action,
    providerHistoryId,
    gmailLabels: change.providerLabelIds
      ? gmailSystemLabels(change.providerLabelIds)
      : null,
    isDraftRelated: change.isDraftRelated || (current?.isDraftRelated ?? false),
  };
}
