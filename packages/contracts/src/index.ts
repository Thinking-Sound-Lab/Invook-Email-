export * from "./gmail-compose";
export * from "./mailbox-events";

export type AccountSyncStage = "pending" | "running" | "complete" | "failed";

export type AccountSyncState = {
  mailSync: AccountSyncStage;
};

export type MailSyncProgress = {
  state: AccountSyncStage;
  discoveryComplete: boolean;
  discoveredThreadCount: number;
  processedThreadCount: number;
  failedThreadCount: number;
};

export type AccountSyncStatusEvent = {
  mailSync: MailSyncProgress;
};

export const mailboxViews = [
  "all",
  "important",
  "starred",
  "drafts",
  "sent",
  "spam",
  "trash",
] as const;

export type StaticMailboxView = (typeof mailboxViews)[number];
export type MailboxView = StaticMailboxView | `label:${string}`;

export type ThreadLabelAnalysisState =
  | "not_requested"
  | "pending"
  | "running"
  | "complete"
  | "failed";

export type InvookSystemLabelKey =
  | "important"
  | "newsletter"
  | "billing"
  | "others";

export type InvookLabel = {
  id: string;
  name: string;
  description: string;
  systemKey: InvookSystemLabelKey | null;
  definitionVersion: number;
  isEnabled: boolean;
};

/**
 * Invook labels are stored once per connected account, so the normalized name
 * is the identity shared by the sibling labels that represent one user-facing
 * label across accounts. Case folding stays locale-independent because the
 * server persists this value while the browser recomputes it, and a
 * locale-sensitive rule would split one label into separate identities.
 */
export function normalizeInvookLabelName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

export type LabelHistoryWindowDays = 7 | 30 | 90;

export const LABEL_PREVIEW_STALE_ERROR =
  "The label preview is stale. Run the preview again.";

export type CreateInvookLabelRequest = {
  name: string;
  description: string;
  applyToPastDays?: LabelHistoryWindowDays | null;
  previewReceiptId?: string;
};

export type UpdateInvookLabelRequest = Pick<
  CreateInvookLabelRequest,
  "name" | "description"
>;

export type PreviewInvookLabelRequest = UpdateInvookLabelRequest;

export type InvookLabelPreviewMatch = {
  threadId: string;
  sender: string;
  subject: string;
  sentAt: string;
  confidence: number;
};

export type InvookLabelPreviewResponse = {
  previewReceiptId: string | null;
  expiresAt: string | null;
  scannedThreadCount: number;
  matches: InvookLabelPreviewMatch[];
};

export type InvookLabelResponse = {
  label: InvookLabel;
};

export type CreateInvookLabelResponse = InvookLabelResponse & {
  historicalAnalysis: {
    windowDays: LabelHistoryWindowDays;
    status: "queued";
  } | null;
};

export type InvookThreadLabel = {
  labelId: string;
  name: string;
  source: "ai" | "user";
  confidence: number | null;
};

export type SetThreadLabelRequest = {
  labelId: string;
};

export type ThreadLabelResponse = {
  label: InvookThreadLabel;
};

export type SetInvookLabelEnabledRequest = {
  isEnabled: boolean;
  applyToPastDays?: LabelHistoryWindowDays | null;
};

export type SetInvookLabelEnabledResponse = InvookLabelResponse & {
  historicalAnalysis: {
    windowDays: LabelHistoryWindowDays;
    status: "queued";
  } | null;
};

export type AcceptedMailboxSyncResponse = {
  accepted: true;
  stepId: string;
};

export type SetGmailThreadReadStateRequest = {
  isRead: boolean;
};

export type GmailThreadReadStateResponse = {
  stepId: string;
};

export type DeletedResourceResponse = {
  deleted: true;
};

export type SessionState =
  | { authenticated: false; gmailConnected: false }
  | { authenticated: true; gmailConnected: boolean };

export type MailboxAccount = {
  id: string;
  email: string;
  image: string | null;
  status: "connected" | "reconnect_required" | "disconnected";
  syncState: AccountSyncState;
  lastSyncedAt: string | null;
  replica: {
    state:
      | "pending"
      | "snapshotting"
      | "replaying"
      | "ready"
      | "repairing"
      | "failed"
      | "deleting";
    readyAt: string | null;
  };
};

export type SignedInUser = {
  email: string;
  image: string | null;
  name: string;
};

export type GmailDraftResource = {
  id: string;
  providerDraftId: string;
  providerMessageId: string;
  providerThreadId: string;
  updatedAt: string;
};

export type MailboxThreadSummary = {
  accountId: string;
  accountEmail: string;
  id: string;
  subject: string;
  snippet: string;
  participants: string[];
  isUnread: boolean;
  isStarred: boolean;
  isDraft: boolean;
  invookLabel: InvookThreadLabel | null;
  latestMessageAt: string | null;
  messageCount: number;
};

export type MailboxThreadMessage = {
  id: string;
  direction: "incoming" | "outgoing";
  sender: { raw: string; email: string };
  recipients: string[];
  providerMessageId: string;
  providerHistoryId: string | null;
  internalDate: string;
  sizeEstimate: number | null;
  headers: Array<{ name: string; value: string }>;
  isUnread: boolean;
  isStarred: boolean;
  isDraft: boolean;
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  sentAt: string;
  attachments: MailboxAttachment[];
};

export type MailboxAttachment = {
  id: string;
  messageId: string;
  providerAttachmentId: string | null;
  filename: string;
  mimeType: string | null;
  size: number | null;
  contentId: string | null;
  contentDisposition: string | null;
  checksumSha256: string | null;
  contentLength: number | null;
};

export type MailSearchMatch =
  | "full_text"
  | "metadata"
  | "attachment";

export type MailSearchResult = {
  accountId: string;
  messageId: string;
  threadId: string;
  subject: string;
  snippet: string;
  bodyPreview: string;
  sender: { raw: string; email: string };
  sentAt: string;
  attachments: MailboxAttachment[];
  matches: MailSearchMatch[];
  score: number;
};

export type MailboxQueryMessage = {
  accountId: string;
  messageId: string;
  threadId: string;
  subject: string;
  sender: { raw: string; email: string };
  sentAt: string;
  bodyPreview: string;
  isInbox: boolean;
  isUnread: boolean;
  invookLabel: { id: string; name: string } | null;
};

export type MailboxQueryResult =
  | {
      status: "available";
      messages: MailboxQueryMessage[];
      availableInvookLabels: Array<{ accountId: string; id: string; name: string }>;
      nextCursor: string | null;
    }
  | {
      status: "unavailable";
      reason: "mailbox_not_connected";
      messages: [];
      availableInvookLabels?: never;
      nextCursor: null;
    };

export type MailboxSelectedThread = Omit<MailboxThreadSummary, "snippet"> & {
  messages: MailboxThreadMessage[];
  gmailDrafts: GmailDraftResource[];
};

export type MailboxPagination = {
  newerCursor: string | null;
  olderCursor: string | null;
};

export type MailboxScopeSidebarCounts = {
  views: Record<StaticMailboxView, number>;
  labels: Record<string, number>;
};

export type MailboxSidebarCounts = {
  all: MailboxScopeSidebarCounts;
  accounts: Record<string, MailboxScopeSidebarCounts>;
};

export type MailboxAccountLabel = InvookLabel & {
  /**
   * Stored identity that a mailbox label view matches on, so a client merging
   * sibling labels across accounts follows the server instead of deriving a
   * competing identity from the display name.
   */
  normalizedName: string;
};

export type MailboxAccountLabels = {
  accountId: string;
  labels: MailboxAccountLabel[];
};

export type MailboxShell = {
  aiConfigured: boolean;
  user: SignedInUser;
  accounts: MailboxAccount[];
  accountLabels: MailboxAccountLabels[];
};

export type MailboxThreadPage = {
  pagination: MailboxPagination;
  threads: MailboxThreadSummary[];
};

export type MailboxThreadDetail = {
  thread: MailboxSelectedThread;
  invookLabels: InvookLabel[];
};

export type MailboxSettings = {
  accountId: string;
  invookLabels: InvookLabel[];
};

export type ApiProblem = {
  type: "about:blank";
  title: string;
  status: number;
  requestId: string;
};

type MailboxChangeEventBase = {
  accountId: string;
  createdAt: string;
};

export type MailboxChangeEvent = MailboxChangeEventBase & (
  | {
      changeType: "replica_ready";
    }
  | {
      changeType: "history_applied";
      reason: "history_catchup" | "message_refresh";
      changedThreadIds: string[];
      refreshedThreadIds: string[];
    }
  | {
      changeType: "drafts_changed";
      kind: "snapshot" | "upsert" | "delete";
      affectedThreadIds: string[];
    }
  | {
      changeType: "labels_changed";
      kind: "analysis_resolution" | "decision";
      affectedThreadIds: string[];
    }
  | {
      changeType: "safe_invalidation";
      reason: "legacy_or_malformed";
    }
);

export type MailboxStreamReadyEvent = {
  type: "mailbox_stream_ready";
  accountIds: string[];
};
