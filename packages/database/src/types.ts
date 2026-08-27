export type AccountSyncStage = "pending" | "running" | "complete" | "failed";

export type AccountSyncState = {
  mailSync: AccountSyncStage;
  memory: AccountSyncStage;
};

export type WorkflowStepJob = {
  id: string;
  userId: string | null;
  accountId: string | null;
  runId: string | null;
  stepType: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
};

export type WorkflowStepInput = {
  runId?: string | null;
  userId: string;
  accountId?: string | null;
  stepType: string;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
  idempotencyKey: string;
};

export type MailboxMessage = {
  userId: string;
  accountId: string;
  providerThreadId: string;
  providerMessageId: string;
  subject: string;
  snippet: string;
  participants: string[];
  gmailLabels: Array<{ providerLabelId: string; name: string }>;
  providerHistoryId: string | null;
  internalDate: Date;
  sizeEstimate: number | null;
  headerLines: Array<{ key: string; line: string }>;
  sentAt: Date;
  direction: "incoming" | "outgoing";
  sender: { raw: string; email: string };
  recipients: string[];
  bodyText: string;
  bodyHtml: string | null;
  rawObject: {
    key: string;
    checksumSha256: string;
    contentLength: number;
    etag: string | null;
  } | null;
  isMemoryEligible: boolean;
  ingestionMode: "initial" | "incremental";
  isLiveDelivery?: boolean;
  memoryContactEmails: string[];
  attachments: Array<{
    providerAttachmentId: string | null;
    mimePartPath: string | null;
    filename: string;
    mimeType: string | null;
    contentId: string | null;
    contentDisposition: string | null;
    size: number | null;
    objectKey: string | null;
    checksumSha256: string | null;
    contentLength: number | null;
    etag: string | null;
  }>;
};

export type IndexedMessage = Omit<MailboxMessage, "attachments"> & {
  attachments?: MailboxMessage["attachments"];
};
