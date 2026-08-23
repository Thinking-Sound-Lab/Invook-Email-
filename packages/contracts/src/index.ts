export * from "./gmail-compose";
export * from "./mailbox-events";

export type AccountSyncStage = "pending" | "running" | "complete" | "failed";

export type AccountSyncState = {
  mailSync: AccountSyncStage;
  memory: AccountSyncStage;
};

export type MailSyncProgress = {
  state: AccountSyncStage;
  discoveryComplete: boolean;
  discoveredMessageCount: number;
  processedMessageCount: number;
  failedMessageCount: number;
};

export type AccountSyncStatusEvent = {
  mailSync: MailSyncProgress;
  memory: AccountSyncStage;
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

export type LabelHistoryWindowDays = 7 | 30 | 90;

export type CreateInvookLabelRequest = {
  name: string;
  description: string;
  applyToPastDays?: LabelHistoryWindowDays | null;
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
  scannedThreadCount: number;
  matches: InvookLabelPreviewMatch[];
};

export type InvookLabelResponse = {
  label: InvookLabel;
};

export type CreateInvookLabelResponse = InvookLabelResponse & {
  historicalAnalysis: {
    windowDays: LabelHistoryWindowDays;
    queuedThreadCount: number;
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
    queuedThreadCount: number;
  } | null;
};

export const memoryTypes = ["preference", "contact", "scheduling"] as const;

export type MemoryType = (typeof memoryTypes)[number];
export type MemorySource = "user" | "inferred" | "feedback";

export type MemoryEntry = {
  id: string;
  type: MemoryType;
  contactEmail: string | null;
  statement: string;
  source: MemorySource;
  confidence: number | null;
  evidenceMessageIds: string[];
  evidenceDraftIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type SaveMemoryRequest = {
  type: MemoryType;
  contactEmail: string | null;
  statement: string;
};

export type MemoryEntryResponse = {
  memory: MemoryEntry;
};

export type AiReplyDraft = {
  id: string;
  threadId: string;
  status: "editing" | "sent" | "discarded" | "failed";
  generatedText: string;
  currentText: string;
  usedMemoryIds: string[];
  updatedAt: string;
};

export type CreateAiReplyDraftRequest = {
  instruction?: string;
};

export type UpdateAiReplyDraftRequest = {
  currentText: string;
};

export type AiReplyDraftResponse = {
  draft: AiReplyDraft;
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

export type GmailLabel = {
  id: string;
  providerLabelId: string;
  name: string;
  type: "system";
};

export type GmailDraftResource = {
  id: string;
  providerDraftId: string;
  providerMessageId: string;
  providerThreadId: string;
  updatedAt: string;
};

export type MailboxThreadSummary = {
  id: string;
  subject: string;
  snippet: string;
  participants: string[];
  gmailLabels: GmailLabel[];
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
  gmailLabels: GmailLabel[];
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  rawMime: {
    checksumSha256: string;
    contentLength: number;
  } | null;
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
  messageId: string;
  threadId: string;
  subject: string;
  sender: { raw: string; email: string };
  sentAt: string;
  bodyPreview: string;
  isInbox: boolean;
  isUnread: boolean;
  gmailLabels: Array<{ id: string; name: string }>;
  invookLabel: { id: string; name: string } | null;
};

export type MailboxQueryResult =
  | {
      status: "available";
      messages: MailboxQueryMessage[];
      availableGmailLabels: Array<{ id: string; name: string }>;
      availableInvookLabels: Array<{ id: string; name: string }>;
      nextCursor: string | null;
    }
  | {
      status: "unavailable";
      reason: "mailbox_not_connected";
      messages: [];
      availableGmailLabels?: never;
      availableInvookLabels?: never;
      nextCursor: null;
    };

export type MailboxSelectedThread = Omit<MailboxThreadSummary, "snippet"> & {
  messages: MailboxThreadMessage[];
  aiReplyDraft: AiReplyDraft | null;
  gmailDrafts: GmailDraftResource[];
};

export type MailboxPagination = {
  newerCursor: string | null;
  olderCursor: string | null;
};

export type MailboxSidebarCounts = {
  views: Record<StaticMailboxView, number>;
  labels: Record<string, number>;
};

export type MailboxShell = {
  aiConfigured: boolean;
  user: SignedInUser;
  account: MailboxAccount;
  invookLabels: InvookLabel[];
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
  memories: MemoryEntry[];
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
  accountId: string;
};
