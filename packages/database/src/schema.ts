import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  InvookSystemLabelKey,
  ThreadLabelAnalysisState,
} from "@invook/contracts";
import type { TenantTaskQueueLane } from "@invook/workflows";

import type { AccountSyncState } from "./types";

type JsonObject = Record<string, unknown>;
type JsonValue = JsonObject | unknown[];

const timestampWithTimezone = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "date" });

const searchVector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

export const profiles = pgTable(
  "profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    displayName: text("display_name").notNull(),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    memoryAcknowledgedAt: timestampWithTimezone("memory_acknowledged_at"),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [uniqueIndex("profiles_email_idx").on(table.email)],
);

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    expiresAt: timestampWithTimezone("expires_at").notNull(),
    token: text("token").notNull(),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
  },
  (table) => [
    uniqueIndex("auth_sessions_token_idx").on(table.token),
    index("auth_sessions_user_idx").on(table.userId),
    index("auth_sessions_expiration_idx").on(table.expiresAt),
  ],
);

export const authAccounts = pgTable(
  "auth_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestampWithTimezone("access_token_expires_at"),
    refreshTokenExpiresAt: timestampWithTimezone("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("auth_accounts_provider_identity_idx").on(
      table.providerId,
      table.accountId,
    ),
    index("auth_accounts_user_idx").on(table.userId),
  ],
);

export const authVerifications = pgTable(
  "auth_verifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestampWithTimezone("expires_at").notNull(),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index("auth_verifications_identifier_idx").on(table.identifier)],
);

export const connectedAccounts = pgTable(
  "connected_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    provider: text("provider").$type<"gmail">().notNull().default("gmail"),
    providerAccountId: text("provider_account_id").notNull(),
    email: text("email").notNull(),
    image: text("image"),
    status: text("status")
      .$type<"connected" | "reconnect_required" | "disconnected">()
      .notNull()
      .default("connected"),
    scopes: text("scopes").array().notNull().default(sql`ARRAY[]::text[]`),
    memoryAcknowledgedAt: timestampWithTimezone("memory_acknowledged_at").notNull(),
    syncState: jsonb("sync_state")
      .$type<AccountSyncState>()
      .notNull()
      .default({ mailSync: "pending", memory: "pending" }),
    lastSyncedAt: timestampWithTimezone("last_synced_at"),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("connected_accounts_provider_identity_idx").on(
      table.provider,
      table.providerAccountId,
    ),
    index("connected_accounts_user_created_idx").on(table.userId, table.createdAt),
    index("connected_accounts_active_user_idx")
      .on(table.userId)
      .where(sql`${table.status} <> 'disconnected'`),
    check("connected_accounts_provider_check", sql`${table.provider} = 'gmail'`),
    check(
      "connected_accounts_status_check",
      sql`${table.status} in ('connected', 'reconnect_required', 'disconnected')`,
    ),
  ],
);

export const gmailConnectionRequests = pgTable(
  "gmail_connection_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stateHash: text("state_hash").notNull(),
    codeVerifier: text("code_verifier").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").references(() => connectedAccounts.id, {
      onDelete: "cascade",
    }),
    expiresAt: timestampWithTimezone("expires_at").notNull(),
    consumedAt: timestampWithTimezone("consumed_at"),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("gmail_connection_requests_state_idx").on(table.stateHash),
    index("gmail_connection_requests_expiration_idx").on(table.expiresAt),
    index("gmail_connection_requests_user_idx").on(table.userId),
  ],
);

export const accountSecrets = pgTable("account_secrets", {
  accountId: uuid("account_id")
    .primaryKey()
    .references(() => connectedAccounts.id, { onDelete: "cascade" }),
  tokenCiphertext: text("token_ciphertext").notNull(),
  keyVersion: smallint("key_version").notNull().default(1),
  refreshedAt: timestampWithTimezone("refreshed_at"),
  createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
  updatedAt: timestampWithTimezone("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const gmailReplicaStates = pgTable("gmail_replica_states", {
  accountId: uuid("account_id")
    .primaryKey()
    .references(() => connectedAccounts.id, { onDelete: "cascade" }),
  initialHistoryId: text("initial_history_id").notNull(),
  historyCursor: text("history_cursor"),
  pendingHistoryCursor: text("pending_history_cursor"),
  state: text("state")
    .$type<
      | "pending"
      | "snapshotting"
      | "replaying"
      | "ready"
      | "repairing"
      | "failed"
      | "deleting"
    >()
    .notNull()
    .default("pending"),
  readyAt: timestampWithTimezone("ready_at"),
  lastHistoryAt: timestampWithTimezone("last_history_at"),
  lastError: text("last_error"),
  createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
  updatedAt: timestampWithTimezone("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (table) => [
  index("gmail_replica_states_state_idx").on(table.state, table.updatedAt),
  check(
    "gmail_replica_states_state_check",
    sql`${table.state} in ('pending', 'snapshotting', 'replaying', 'ready', 'repairing', 'failed', 'deleting')`,
  ),
]);

export const gmailWatchStates = pgTable("gmail_watch_states", {
  accountId: uuid("account_id")
    .primaryKey()
    .references(() => connectedAccounts.id, { onDelete: "cascade" }),
  topicName: text("topic_name").notNull(),
  historyId: text("history_id").notNull(),
  expirationAt: timestampWithTimezone("expiration_at").notNull(),
  status: text("status")
    .$type<"active" | "stopped" | "failed">()
    .notNull()
    .default("active"),
  lastRenewedAt: timestampWithTimezone("last_renewed_at").notNull().defaultNow(),
  lastError: text("last_error"),
  createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
  updatedAt: timestampWithTimezone("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (table) => [
  index("gmail_watch_states_expiration_idx").on(table.status, table.expirationAt),
  check(
    "gmail_watch_states_status_check",
    sql`${table.status} in ('active', 'stopped', 'failed')`,
  ),
]);

export const labels = pgTable(
  "labels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => connectedAccounts.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"gmail" | "invook">().notNull(),
    providerLabelId: text("provider_label_id"),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    description: text("description").notNull().default(""),
    systemKey: text("system_key").$type<InvookSystemLabelKey>(),
    definitionVersion: integer("definition_version").notNull().default(1),
    enablementVersion: integer("enablement_version").notNull().default(1),
    isEnabled: boolean("is_enabled").notNull().default(true),
    disabledAt: timestampWithTimezone("disabled_at"),
    providerType: text("provider_type").$type<"system">(),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("labels_account_provider_idx")
      .on(
        table.accountId,
        table.providerLabelId,
      )
      .where(sql`${table.providerLabelId} is not null`),
    uniqueIndex("labels_account_invook_name_idx")
      .on(table.accountId, table.normalizedName)
      .where(sql`${table.kind} = 'invook'`),
    uniqueIndex("labels_account_system_key_idx")
      .on(table.accountId, table.systemKey)
      .where(sql`${table.systemKey} is not null`),
    index("labels_account_created_idx").on(table.accountId, table.createdAt),
    index("labels_account_kind_idx").on(table.accountId, table.kind, table.name),
    check("labels_kind_check", sql`${table.kind} in ('gmail', 'invook')`),
    check("labels_name_check", sql`char_length(btrim(${table.name})) > 0`),
    check(
      "labels_normalized_name_check",
      sql`char_length(btrim(${table.normalizedName})) > 0`,
    ),
    check(
      "labels_kind_contract_check",
      sql`(${table.kind} = 'gmail' and ${table.providerLabelId} is not null and ${table.providerType} = 'system' and ${table.systemKey} is null) or (${table.kind} = 'invook' and ${table.providerLabelId} is null and ${table.providerType} is null and char_length(btrim(${table.description})) > 0)`,
    ),
    check(
      "labels_system_key_check",
      sql`${table.systemKey} is null or ${table.systemKey} in ('important', 'newsletter', 'billing', 'others')`,
    ),
    check(
      "labels_enabled_contract_check",
      sql`${table.isEnabled} or ${table.systemKey} is distinct from 'others'`,
    ),
    check("labels_definition_version_check", sql`${table.definitionVersion} > 0`),
    check("labels_enablement_version_check", sql`${table.enablementVersion} > 0`),
  ],
);

export const threads = pgTable(
  "threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => connectedAccounts.id, { onDelete: "cascade" }),
    providerThreadId: text("provider_thread_id").notNull(),
    subject: text("subject").notNull().default(""),
    snippet: text("snippet").notNull().default(""),
    participants: jsonb("participants").$type<string[]>().notNull().default([]),
    latestMessageAt: timestampWithTimezone("latest_message_at"),
    messageCount: integer("message_count").notNull().default(0),
    contentVersion: integer("content_version").notNull().default(1),
    labelAnalysisState: text("label_analysis_state")
      .$type<ThreadLabelAnalysisState>()
      .notNull()
      .default("pending"),
    labelAnalysisVersion: integer("label_analysis_version").notNull().default(1),
    labelAnalysisDefinitionHash: text("label_analysis_definition_hash"),
    labelAnalysisError: text("label_analysis_error"),
    labelAnalyzedAt: timestampWithTimezone("label_analyzed_at"),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("threads_account_provider_thread_idx").on(
      table.accountId,
      table.providerThreadId,
    ),
    index("threads_user_latest_idx").on(table.userId, table.latestMessageAt),
    index("threads_account_label_analysis_idx").on(
      table.accountId,
      table.labelAnalysisState,
      table.latestMessageAt,
    ),
    check("threads_message_count_check", sql`${table.messageCount} >= 0`),
    check("threads_content_version_check", sql`${table.contentVersion} > 0`),
    check(
      "threads_label_analysis_state_check",
      sql`${table.labelAnalysisState} in ('pending', 'running', 'complete', 'failed')`,
    ),
    check(
      "threads_label_analysis_version_check",
      sql`${table.labelAnalysisVersion} > 0`,
    ),
    check(
      "threads_label_analysis_definition_hash_check",
      sql`${table.labelAnalysisDefinitionHash} is null or ${table.labelAnalysisDefinitionHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const threadLabelAssignments = pgTable(
  "thread_label_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => connectedAccounts.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    labelId: uuid("label_id")
      .notNull()
      .references(() => labels.id),
    source: text("source").$type<"ai" | "user">().notNull(),
    confidence: numeric("confidence", { precision: 5, scale: 2 }),
    modelId: text("model_id"),
    definitionVersion: integer("definition_version").notNull(),
    assignmentVersion: integer("assignment_version").notNull().default(1),
    assignedAt: timestampWithTimezone("assigned_at").notNull().defaultNow(),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("thread_label_assignments_thread_idx").on(table.threadId),
    index("thread_label_assignments_account_label_idx").on(
      table.accountId,
      table.labelId,
    ),
    check(
      "thread_label_assignments_source_check",
      sql`${table.source} in ('ai', 'user')`,
    ),
    check(
      "thread_label_assignments_confidence_check",
      sql`${table.confidence} is null or ${table.confidence} between 0 and 100`,
    ),
    check(
      "thread_label_assignments_definition_version_check",
      sql`${table.definitionVersion} > 0`,
    ),
    check(
      "thread_label_assignments_assignment_version_check",
      sql`${table.assignmentVersion} > 0`,
    ),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => connectedAccounts.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    providerMessageId: text("provider_message_id").notNull(),
    direction: text("direction").$type<"incoming" | "outgoing">().notNull(),
    sender: jsonb("sender")
      .$type<{ raw: string; email: string }>()
      .notNull(),
    recipients: jsonb("recipients").$type<string[]>().notNull().default([]),
    providerHistoryId: text("provider_history_id"),
    internalDate: timestampWithTimezone("internal_date").notNull(),
    sizeEstimate: integer("size_estimate"),
    headerLines: jsonb("header_lines")
      .$type<Array<{ key: string; line: string }>>()
      .notNull()
      .default([]),
    subject: text("subject").notNull().default(""),
    snippet: text("snippet").notNull().default(""),
    bodyText: text("body_text").notNull().default(""),
    bodyHtml: text("body_html"),
    rawObjectKey: text("raw_object_key"),
    rawChecksumSha256: text("raw_checksum_sha256"),
    rawContentLength: integer("raw_content_length"),
    rawEtag: text("raw_etag"),
    sentAt: timestampWithTimezone("sent_at").notNull(),
    isMemoryEligible: boolean("is_memory_eligible").notNull().default(false),
    excludedFromMemory: boolean("excluded_from_memory").notNull().default(false),
    searchDocument: searchVector("search_document").generatedAlwaysAs(
      sql`to_tsvector('simple', coalesce(${sql.raw("subject")}, '') || ' ' || coalesce(${sql.raw("body_text")}, ''))`,
    ),
    metadataSearchDocument: searchVector(
      "metadata_search_document",
    ).generatedAlwaysAs(
      sql`to_tsvector('simple', coalesce(${sql.raw("sender")}->>'raw', '') || ' ' || coalesce(${sql.raw("sender")}->>'email', '') || ' ' || coalesce(${sql.raw("recipients")}::text, ''))`,
    ),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("messages_thread_provider_message_idx").on(
      table.threadId,
      table.providerMessageId,
    ),
    index("messages_thread_sent_idx").on(table.threadId, table.sentAt),
    index("messages_account_provider_idx").on(table.accountId, table.providerMessageId),
    index("messages_search_idx").using("gin", table.searchDocument),
    index("messages_metadata_search_idx").using(
      "gin",
      table.metadataSearchDocument,
    ),
    index("messages_memory_eligible_idx")
      .on(table.userId, table.sentAt)
      .where(
        sql`${table.direction} = 'outgoing' and ${table.isMemoryEligible} and not ${table.excludedFromMemory}`,
      ),
    check("messages_direction_check", sql`${table.direction} in ('incoming', 'outgoing')`),
    check(
      "messages_size_estimate_check",
      sql`${table.sizeEstimate} is null or ${table.sizeEstimate} >= 0`,
    ),
    check(
      "messages_raw_content_length_check",
      sql`${table.rawContentLength} is null or ${table.rawContentLength} >= 0`,
    ),
  ],
);

export const messageLabels = pgTable(
  "message_labels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => connectedAccounts.id, { onDelete: "cascade" }),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    labelId: uuid("label_id")
      .notNull()
      .references(() => labels.id, { onDelete: "cascade" }),
    source: text("source").$type<"gmail">().notNull(),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("message_labels_message_label_idx").on(
      table.messageId,
      table.labelId,
    ),
    index("message_labels_account_label_idx").on(
      table.accountId,
      table.labelId,
    ),
    check("message_labels_source_check", sql`${table.source} = 'gmail'`),
  ],
);

export const memoryPendingEvidence = pgTable(
  "memory_pending_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => connectedAccounts.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    scope: text("scope").$type<"global" | "contact">().notNull(),
    contactEmail: text("contact_email").notNull().default(""),
    schemaVersion: integer("schema_version").notNull(),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("memory_pending_evidence_message_scope_idx").on(
      table.messageId,
      table.scope,
      table.contactEmail,
    ),
    index("memory_pending_evidence_account_scope_idx").on(
      table.accountId,
      table.schemaVersion,
      table.scope,
      table.contactEmail,
      table.createdAt,
    ),
    check(
      "memory_pending_evidence_scope_check",
      sql`${table.scope} in ('global', 'contact')`,
    ),
    check(
      "memory_pending_evidence_contact_check",
      sql`(${table.scope} = 'global' and ${table.contactEmail} = '') or (${table.scope} = 'contact' and char_length(btrim(${table.contactEmail})) > 0)`,
    ),
    check(
      "memory_pending_evidence_schema_version_check",
      sql`${table.schemaVersion} > 0`,
    ),
  ],
);

export const messageAttachments = pgTable(
  "message_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => connectedAccounts.id, { onDelete: "cascade" }),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    providerAttachmentId: text("provider_attachment_id"),
    mimePartPath: text("mime_part_path"),
    filename: text("filename").notNull(),
    filenameSearchDocument: searchVector(
      "filename_search_document",
    ).generatedAlwaysAs(
      sql`to_tsvector('simple', regexp_replace(${sql.raw("filename")}, '[_\\.-]+', ' ', 'g'))`,
    ),
    mimeType: text("mime_type"),
    contentId: text("content_id"),
    contentDisposition: text("content_disposition"),
    size: integer("size"),
    objectKey: text("object_key"),
    checksumSha256: text("checksum_sha256"),
    contentLength: integer("content_length"),
    etag: text("etag"),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("message_attachments_message_idx").on(table.messageId),
    index("message_attachments_account_filename_idx").on(
      table.accountId,
      table.filename,
    ),
    index("message_attachments_filename_search_idx").using(
      "gin",
      table.filenameSearchDocument,
    ),
    check(
      "message_attachments_size_check",
      sql`${table.size} is null or ${table.size} >= 0`,
    ),
    check(
      "message_attachments_content_length_check",
      sql`${table.contentLength} is null or ${table.contentLength} >= 0`,
    ),
  ],
);

export const memoryEntries = pgTable(
  "memory_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => connectedAccounts.id, { onDelete: "cascade" }),
    memoryType: text("memory_type")
      .$type<"preference" | "contact" | "scheduling">()
      .notNull(),
    contactEmail: text("contact_email"),
    statement: text("statement").notNull(),
    source: text("source")
      .$type<"user" | "inferred" | "feedback">()
      .notNull(),
    confidence: numeric("confidence", { precision: 5, scale: 2 }),
    evidenceMessageIds: uuid("evidence_message_ids")
      .array()
      .notNull()
      .default(sql`ARRAY[]::uuid[]`),
    evidenceDraftIds: uuid("evidence_draft_ids")
      .array()
      .notNull()
      .default(sql`ARRAY[]::uuid[]`),
    modelId: text("model_id"),
    schemaVersion: integer("schema_version").notNull().default(1),
    fingerprint: text("fingerprint").notNull(),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("memory_entries_account_fingerprint_idx").on(
      table.accountId,
      table.fingerprint,
    ),
    index("memory_entries_account_type_contact_idx").on(
      table.accountId,
      table.memoryType,
      table.contactEmail,
    ),
    check(
      "memory_entries_type_check",
      sql`${table.memoryType} in ('preference', 'contact', 'scheduling')`,
    ),
    check(
      "memory_entries_source_check",
      sql`${table.source} in ('user', 'inferred', 'feedback')`,
    ),
    check(
      "memory_entries_contact_check",
      sql`(${table.memoryType} = 'contact' and ${table.contactEmail} is not null) or (${table.memoryType} <> 'contact' and ${table.contactEmail} is null)`,
    ),
    check(
      "memory_entries_statement_check",
      sql`char_length(${table.statement}) between 3 and 500`,
    ),
    check(
      "memory_entries_confidence_check",
      sql`${table.confidence} is null or ${table.confidence} between 0 and 100`,
    ),
  ],
);

export const memoryDeletions = pgTable(
  "memory_deletions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => connectedAccounts.id, { onDelete: "cascade" }),
    memoryType: text("memory_type")
      .$type<"preference" | "contact" | "scheduling">()
      .notNull(),
    contactEmail: text("contact_email"),
    fingerprint: text("fingerprint").notNull(),
    deletedAt: timestampWithTimezone("deleted_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("memory_deletions_account_fingerprint_idx").on(
      table.accountId,
      table.fingerprint,
    ),
    index("memory_deletions_user_deleted_idx").on(table.userId, table.deletedAt),
    check(
      "memory_deletions_type_check",
      sql`${table.memoryType} in ('preference', 'contact', 'scheduling')`,
    ),
  ],
);

export const drafts = pgTable(
  "drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => connectedAccounts.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"gmail" | "invook">().notNull().default("invook"),
    threadId: uuid("thread_id")
      .references(() => threads.id, { onDelete: "cascade" }),
    providerDraftId: text("provider_draft_id"),
    providerMessageId: text("provider_message_id"),
    providerThreadId: text("provider_thread_id"),
    messageId: uuid("message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    providerHistoryId: text("provider_history_id"),
    providerMetadata: jsonb("provider_metadata").$type<JsonObject>().notNull().default({}),
    status: text("status")
      .$type<"editing" | "sent" | "discarded" | "failed">()
      .notNull()
      .default("editing"),
    generatedText: text("generated_text"),
    currentText: text("current_text").notNull().default(""),
    finalSentText: text("final_sent_text"),
    usedMemoryIds: uuid("used_memory_ids")
      .array()
      .notNull()
      .default(sql`ARRAY[]::uuid[]`),
    generationMetadata: jsonb("generation_metadata")
      .$type<JsonObject>()
      .notNull()
      .default({}),
    editSignals: jsonb("edit_signals").$type<JsonValue[]>().notNull().default([]),
    feedbackVersion: integer("feedback_version").notNull().default(0),
    lastFeedbackAt: timestampWithTimezone("last_feedback_at"),
    generatedAt: timestampWithTimezone("generated_at"),
    sentAt: timestampWithTimezone("sent_at"),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("drafts_user_updated_idx").on(table.userId, table.updatedAt),
    uniqueIndex("drafts_account_provider_idx")
      .on(table.accountId, table.providerDraftId)
      .where(sql`${table.providerDraftId} is not null`),
    index("drafts_account_provider_thread_idx").on(
      table.accountId,
      table.providerThreadId,
    ),
    check("drafts_kind_check", sql`${table.kind} in ('gmail', 'invook')`),
    check(
      "drafts_kind_contract_check",
      sql`(${table.kind} = 'gmail' and ${table.providerDraftId} is not null and ${table.providerThreadId} is not null) or (${table.kind} = 'invook' and ${table.threadId} is not null and ${table.providerDraftId} is null and ${table.providerMessageId} is null and ${table.providerThreadId} is null and ${table.providerHistoryId} is null)`,
    ),
    check(
      "drafts_status_check",
      sql`${table.status} in ('editing', 'sent', 'discarded', 'failed')`,
    ),
  ],
);

export const gmailDraftWriteOperations = pgTable(
  "gmail_draft_write_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => connectedAccounts.id, { onDelete: "cascade" }),
    operation: text("operation")
      .$type<"create" | "update" | "send">()
      .notNull(),
    status: text("status").$type<"pending" | "complete">().notNull(),
    idempotencyKey: uuid("idempotency_key").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    providerDraftId: text("provider_draft_id"),
    providerMessageId: text("provider_message_id"),
    providerThreadId: text("provider_thread_id"),
    completedAt: timestampWithTimezone("completed_at"),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("gmail_draft_write_operations_user_key_idx").on(
      table.userId,
      table.idempotencyKey,
    ),
    index("gmail_draft_write_operations_account_status_idx").on(
      table.accountId,
      table.status,
      table.createdAt,
    ),
    check(
      "gmail_draft_write_operations_operation_check",
      sql`${table.operation} in ('create', 'update', 'send')`,
    ),
    check(
      "gmail_draft_write_operations_status_check",
      sql`${table.status} in ('pending', 'complete')`,
    ),
    check(
      "gmail_draft_write_operations_result_check",
      sql`(${table.status} = 'pending' and ${table.completedAt} is null and ((${table.providerDraftId} is null and ${table.providerMessageId} is null and ${table.providerThreadId} is null) or (${table.providerDraftId} is not null and ${table.providerMessageId} is not null and ${table.providerThreadId} is not null))) or (${table.status} = 'complete' and ${table.providerDraftId} is not null and ${table.providerMessageId} is not null and ${table.providerThreadId} is not null and ${table.completedAt} is not null)`,
    ),
  ],
);

export const mailSyncRuns = pgTable(
  "mail_sync_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => connectedAccounts.id, { onDelete: "cascade" }),
    runType: text("run_type").$type<"initial" | "repair">().notNull().default("initial"),
    status: text("status")
      .$type<"queued" | "running" | "complete" | "failed" | "superseded">()
      .notNull()
      .default("queued"),
    startingHistoryCursor: text("starting_history_cursor").notNull(),
    finalHistoryCursor: text("final_history_cursor"),
    discoveryComplete: boolean("discovery_complete").notNull().default(false),
    pageCount: integer("page_count").notNull().default(0),
    discoveredMessageCount: integer("discovered_message_count").notNull().default(0),
    processedMessageCount: integer("processed_message_count").notNull().default(0),
    failedMessageCount: integer("failed_message_count").notNull().default(0),
    lastError: text("last_error"),
    idempotencyKey: text("idempotency_key").notNull(),
    startedAt: timestampWithTimezone("started_at"),
    completedAt: timestampWithTimezone("completed_at"),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("mail_sync_runs_idempotency_key_idx").on(table.idempotencyKey),
    uniqueIndex("mail_sync_runs_single_active_account_idx")
      .on(table.accountId)
      .where(sql`${table.status} in ('queued', 'running')`),
    index("mail_sync_runs_account_created_idx").on(table.accountId, table.createdAt),
    check(
      "mail_sync_runs_status_check",
      sql`${table.status} in ('queued', 'running', 'complete', 'failed', 'superseded')`,
    ),
    check("mail_sync_runs_type_check", sql`${table.runType} in ('initial', 'repair')`),
    check("mail_sync_runs_page_count_check", sql`${table.pageCount} >= 0`),
    check(
      "mail_sync_runs_message_counts_check",
      sql`${table.discoveredMessageCount} >= 0 and ${table.processedMessageCount} >= 0 and ${table.failedMessageCount} >= 0`,
    ),
  ],
);

export const workflowSteps = pgTable(
  "workflow_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").references(() => mailSyncRuns.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => profiles.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").references(() => connectedAccounts.id, {
      onDelete: "cascade",
    }),
    stepType: text("step_type").notNull(),
    status: text("status")
      .$type<"queued" | "running" | "complete" | "failed">()
      .notNull()
      .default("queued"),
    input: jsonb("input").$type<JsonObject>().notNull().default({}),
    result: jsonb("result").$type<JsonObject>(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    lastError: text("last_error"),
    idempotencyKey: text("idempotency_key").notNull(),
    startedAt: timestampWithTimezone("started_at"),
    completedAt: timestampWithTimezone("completed_at"),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("workflow_steps_idempotency_key_idx").on(table.idempotencyKey),
    index("workflow_steps_run_created_idx").on(table.runId, table.createdAt),
    index("workflow_steps_account_type_created_idx").on(
      table.accountId,
      table.stepType,
      table.createdAt,
    ),
    index("workflow_steps_user_status_idx").on(table.userId, table.status),
    check(
      "workflow_steps_status_check",
      sql`${table.status} in ('queued', 'running', 'complete', 'failed')`,
    ),
    check("workflow_steps_attempts_check", sql`${table.attempts} >= 0`),
    check("workflow_steps_max_attempts_check", sql`${table.maxAttempts} > 0`),
  ],
);

export const threadLabelBatchSubmissions = pgTable(
  "thread_label_batch_submissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowStepId: uuid("workflow_step_id")
      .notNull()
      .references(() => workflowSteps.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => connectedAccounts.id, { onDelete: "cascade" }),
    provider: text("provider").$type<"openai">().notNull().default("openai"),
    providerBatchId: text("provider_batch_id"),
    inputFileId: text("input_file_id"),
    outputFileId: text("output_file_id"),
    errorFileId: text("error_file_id"),
    modelId: text("model_id").notNull(),
    definitionHash: text("definition_hash").notNull(),
    flushRemainder: boolean("flush_remainder").notNull().default(false),
    hasMore: boolean("has_more").notNull().default(false),
    requestCount: integer("request_count").notNull(),
    manifest: jsonb("manifest")
      .$type<Array<{
        threadId: string;
        analysisVersion: number;
        definitionHash: string;
        fallbackLabelId: string;
      }>>()
      .notNull(),
    status: text("status")
      .$type<"preparing" | "submitted" | "complete" | "failed">()
      .notNull()
      .default("preparing"),
    providerState: text("provider_state"),
    lastError: text("last_error"),
    submittedAt: timestampWithTimezone("submitted_at"),
    completedAt: timestampWithTimezone("completed_at"),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("thread_label_batch_submissions_workflow_step_idx").on(
      table.workflowStepId,
    ),
    uniqueIndex("thread_label_batch_submissions_provider_batch_idx")
      .on(table.provider, table.providerBatchId)
      .where(sql`${table.providerBatchId} is not null`),
    index("thread_label_batch_submissions_account_status_idx").on(
      table.accountId,
      table.status,
      table.createdAt,
    ),
    check(
      "thread_label_batch_submissions_provider_check",
      sql`${table.provider} = 'openai'`,
    ),
    check(
      "thread_label_batch_submissions_status_check",
      sql`${table.status} in ('preparing', 'submitted', 'complete', 'failed')`,
    ),
    check(
      "thread_label_batch_submissions_request_count_check",
      sql`${table.requestCount} between 1 and 2000`,
    ),
    check(
      "thread_label_batch_submissions_definition_hash_check",
      sql`${table.definitionHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const temporalCommands = pgTable(
  "temporal_commands",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowStepId: uuid("workflow_step_id")
      .notNull()
      .references(() => workflowSteps.id, { onDelete: "cascade" }),
    activityTaskLane: text("activity_task_lane")
      .$type<TenantTaskQueueLane>()
      .notNull(),
    dispatchAttempts: integer("dispatch_attempts").notNull().default(0),
    lastError: text("last_error"),
    dispatchedAt: timestampWithTimezone("dispatched_at"),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("temporal_commands_workflow_step_idx").on(table.workflowStepId),
    index("temporal_commands_undispatched_idx")
      .on(table.createdAt)
      .where(sql`${table.dispatchedAt} is null`),
    check(
      "temporal_commands_dispatch_attempts_check",
      sql`${table.dispatchAttempts} >= 0`,
    ),
    check(
      "temporal_commands_activity_task_lane_check",
      sql`${table.activityTaskLane} in ('control', 'live', 'bulk')`,
    ),
  ],
);

export const gmailSyncPages = pgTable(
  "gmail_sync_pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => mailSyncRuns.id, { onDelete: "cascade" }),
    pageNumber: integer("page_number").notNull(),
    pageToken: text("page_token"),
    nextPageToken: text("next_page_token"),
    discoveredMessageCount: integer("discovered_message_count").notNull().default(0),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    completedAt: timestampWithTimezone("completed_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("gmail_sync_pages_run_number_idx").on(table.runId, table.pageNumber),
    check("gmail_sync_pages_number_check", sql`${table.pageNumber} > 0`),
    check(
      "gmail_sync_pages_message_count_check",
      sql`${table.discoveredMessageCount} >= 0`,
    ),
  ],
);

export const gmailSyncItems = pgTable(
  "gmail_sync_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => mailSyncRuns.id, { onDelete: "cascade" }),
    providerMessageId: text("provider_message_id").notNull(),
    providerThreadId: text("provider_thread_id"),
    status: text("status")
      .$type<"queued" | "running" | "complete" | "failed">()
      .notNull()
      .default("queued"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    startedAt: timestampWithTimezone("started_at"),
    completedAt: timestampWithTimezone("completed_at"),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("gmail_sync_items_run_message_idx").on(
      table.runId,
      table.providerMessageId,
    ),
    index("gmail_sync_items_run_status_idx").on(table.runId, table.status),
    index("gmail_sync_items_run_thread_status_idx").on(
      table.runId,
      table.providerThreadId,
      table.status,
    ),
    check(
      "gmail_sync_items_status_check",
      sql`${table.status} in ('queued', 'running', 'complete', 'failed')`,
    ),
    check("gmail_sync_items_attempts_check", sql`${table.attempts} >= 0`),
  ],
);

export const gmailAccountCleanups = pgTable(
  "gmail_account_cleanups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").notNull(),
    status: text("status")
      .$type<"queued" | "running" | "complete" | "failed">()
      .notNull()
      .default("queued"),
    objectCount: integer("object_count"),
    lastError: text("last_error"),
    startedAt: timestampWithTimezone("started_at"),
    completedAt: timestampWithTimezone("completed_at"),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("gmail_account_cleanups_account_idx").on(table.accountId),
    index("gmail_account_cleanups_user_created_idx").on(
      table.userId,
      table.createdAt,
    ),
    check(
      "gmail_account_cleanups_status_check",
      sql`${table.status} in ('queued', 'running', 'complete', 'failed')`,
    ),
    check(
      "gmail_account_cleanups_object_count_check",
      sql`${table.objectCount} is null or ${table.objectCount} >= 0`,
    ),
  ],
);

export const mailboxChangeEvents = pgTable(
  "mailbox_change_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => connectedAccounts.id, { onDelete: "cascade" }),
    changeType: text("change_type")
      .$type<"replica_ready" | "history_applied" | "drafts_changed" | "labels_changed">()
      .notNull(),
    payload: jsonb("payload").$type<JsonObject>().notNull().default({}),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("mailbox_change_events_account_created_idx").on(
      table.accountId,
      table.createdAt,
    ),
    check(
      "mailbox_change_events_type_check",
      sql`${table.changeType} in ('replica_ready', 'history_applied', 'drafts_changed', 'labels_changed')`,
    ),
  ],
);
