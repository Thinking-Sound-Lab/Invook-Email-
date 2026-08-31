export const GMAIL_SYSTEM_LABEL_IDS = [
  "INBOX",
  "SENT",
  "DRAFT",
  "TRASH",
  "SPAM",
  "STARRED",
  "UNREAD",
] as const;

export type GmailSystemLabelId = (typeof GMAIL_SYSTEM_LABEL_IDS)[number];

export type GmailSystemLabel = {
  providerLabelId: GmailSystemLabelId;
  name: string;
};

const GMAIL_SYSTEM_LABEL_NAMES = {
  INBOX: "Inbox",
  SENT: "Sent",
  DRAFT: "Drafts",
  TRASH: "Trash",
  SPAM: "Spam",
  STARRED: "Starred",
  UNREAD: "Unread",
} satisfies Record<GmailSystemLabelId, string>;

const gmailSystemLabelIds = new Set<string>(GMAIL_SYSTEM_LABEL_IDS);

export function isGmailSystemLabelId(
  labelId: string,
): labelId is GmailSystemLabelId {
  return gmailSystemLabelIds.has(labelId);
}

export function filterGmailSystemLabelIds(
  labelIds: readonly string[] | undefined,
): GmailSystemLabelId[] {
  if (!labelIds) return [];
  return [...new Set(labelIds.filter(isGmailSystemLabelId))];
}

export function gmailSystemLabels(
  labelIds: readonly string[] | undefined,
): GmailSystemLabel[] {
  return filterGmailSystemLabelIds(labelIds).map((providerLabelId) => ({
    providerLabelId,
    name: GMAIL_SYSTEM_LABEL_NAMES[providerLabelId],
  }));
}
