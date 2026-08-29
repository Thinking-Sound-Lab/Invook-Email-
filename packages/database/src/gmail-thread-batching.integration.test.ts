import assert from "node:assert/strict";
import test from "node:test";

import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { v4 as uuidv4 } from "uuid";

import * as schema from "./schema";
import type { IndexedMessage } from "./types";
import {
  connectedAccounts,
  gmailReplicaStates,
  gmailSyncItems,
  labels,
  mailSyncRuns,
  messageLabels,
  messages,
  profiles,
  temporalCommands,
  threads,
  workflowSteps,
} from "./schema";
import {
  completeMailSyncThread,
  GMAIL_SYNC_THREAD_BATCH_SIZE,
  isMailSyncThreadComplete,
  recordMailSyncPage,
} from "./workflows";
import {
  upsertMailboxMessage,
  upsertMailboxThreadMessages,
} from "./repositories";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test(
  "mail sync pages admit bounded Temporal thread batches atomically",
  { skip: !testDatabaseUrl },
  async () => {
    if (!testDatabaseUrl) return;
    const client = postgres(testDatabaseUrl, { max: 1, prepare: false });
    const database = drizzle(client, { schema });
    const userId = uuidv4();
    const accountId = uuidv4();
    const runId = uuidv4();
    const providerThreadIds = Array.from(
      { length: GMAIL_SYNC_THREAD_BATCH_SIZE * 2 + 3 },
      (_, index) => `provider-thread-${index + 1}`,
    );
    try {
      await database.insert(profiles).values({
        id: userId,
        displayName: "Database Test User",
        email: `${userId}@example.test`,
      });
      await database.insert(connectedAccounts).values({
        id: accountId,
        userId,
        providerAccountId: `provider-${accountId}`,
        email: `${accountId}@example.com`,
        memoryAcknowledgedAt: new Date(),
      });
      await database.insert(gmailReplicaStates).values({
        accountId,
        initialHistoryId: "100",
        state: "snapshotting",
      });
      await database.insert(mailSyncRuns).values({
        id: runId,
        userId,
        accountId,
        status: "running",
        startingHistoryCursor: "100",
        idempotencyKey: `thread-batch-test:${runId}`,
      });

      assert.equal(
        await recordMailSyncPage(
          {
            runId,
            userId,
            accountId,
            pageNumber: 1,
            pageToken: null,
            nextPageToken: null,
            providerThreadIds,
          },
          database,
        ),
        true,
      );

      const items = await database
        .select({ providerThreadId: gmailSyncItems.providerThreadId })
        .from(gmailSyncItems)
        .where(eq(gmailSyncItems.runId, runId));
      const batches = await database
        .select({
          idempotencyKey: workflowSteps.idempotencyKey,
          input: workflowSteps.input,
          activityTaskLane: temporalCommands.activityTaskLane,
        })
        .from(workflowSteps)
        .innerJoin(
          temporalCommands,
          eq(temporalCommands.workflowStepId, workflowSteps.id),
        )
        .where(eq(workflowSteps.runId, runId))
        .orderBy(asc(workflowSteps.idempotencyKey));

      assert.equal(items.length, providerThreadIds.length);
      assert.deepEqual(
        batches.map((batch) => ({
          idempotencyKey: batch.idempotencyKey,
          activityTaskLane: batch.activityTaskLane,
          threadCount: Array.isArray(batch.input.providerThreadIds)
            ? batch.input.providerThreadIds.length
            : 0,
        })),
        [
          {
            idempotencyKey: `gmail-thread-batch:${runId}:1:1`,
            activityTaskLane: "bulk",
            threadCount: GMAIL_SYNC_THREAD_BATCH_SIZE,
          },
          {
            idempotencyKey: `gmail-thread-batch:${runId}:1:2`,
            activityTaskLane: "bulk",
            threadCount: GMAIL_SYNC_THREAD_BATCH_SIZE,
          },
          {
            idempotencyKey: `gmail-thread-batch:${runId}:1:3`,
            activityTaskLane: "bulk",
            threadCount: 3,
          },
        ],
      );

      const completedProviderThreadId = providerThreadIds[0]!;
      const completedThreadId = uuidv4();
      await database.insert(threads).values({
        id: completedThreadId,
        userId,
        accountId,
        providerThreadId: completedProviderThreadId,
      });
      assert.equal(
        await completeMailSyncThread(
          {
            runId,
            providerThreadId: completedProviderThreadId,
          },
          database,
        ),
        true,
      );
      const [completedItem] = await database
        .select({ status: gmailSyncItems.status })
        .from(gmailSyncItems)
        .where(
          and(
            eq(gmailSyncItems.runId, runId),
            eq(gmailSyncItems.providerThreadId, completedProviderThreadId),
          ),
        );
      assert.equal(
        completedItem?.status,
        "complete",
      );

      assert.equal(
        await isMailSyncThreadComplete(
          {
            runId,
            accountId,
            providerThreadId: completedProviderThreadId,
          },
          database,
        ),
        true,
      );
      assert.equal(
        await isMailSyncThreadComplete(
          {
            runId,
            accountId,
            providerThreadId: providerThreadIds[1]!,
          },
          database,
        ),
        false,
      );
    } finally {
      await database.delete(profiles).where(eq(profiles.id, userId));
      await client.end();
    }
  },
);

test(
  "a full Gmail thread and its checkpoint roll back atomically",
  { skip: !testDatabaseUrl },
  async () => {
    if (!testDatabaseUrl) return;
    const client = postgres(testDatabaseUrl, { max: 1, prepare: false });
    const database = drizzle(client, { schema });
    const userId = uuidv4();
    const accountId = uuidv4();
    const runId = uuidv4();
    const providerThreadId = `provider-thread-${uuidv4()}`;
    const sentAt = new Date("2026-08-25T08:00:00.000Z");
    try {
      await database.insert(profiles).values({
        id: userId,
        displayName: "Atomic thread test",
        email: `${userId}@example.test`,
      });
      await database.insert(connectedAccounts).values({
        id: accountId,
        userId,
        providerAccountId: `provider-${accountId}`,
        email: `${accountId}@example.com`,
        memoryAcknowledgedAt: sentAt,
      });
      await database.insert(mailSyncRuns).values({
        id: runId,
        userId,
        accountId,
        status: "running",
        startingHistoryCursor: "100",
        idempotencyKey: `atomic-thread-test:${runId}`,
      });
      await database.insert(gmailSyncItems).values({
        runId,
        providerThreadId,
        status: "running",
      });

      const message = (providerMessageId: string): IndexedMessage => ({
        userId,
        accountId,
        providerThreadId,
        providerMessageId,
        subject: "Atomic thread",
        snippet: "Thread body",
        participants: ["sender@example.test"],
        gmailLabels: [{ providerLabelId: "INBOX", name: "Inbox" }],
        providerHistoryId: "101",
        internalDate: sentAt,
        sizeEstimate: 128,
        headerLines: [],
        sentAt,
        direction: "incoming" as const,
        sender: { raw: "sender@example.test", email: "sender@example.test" },
        recipients: [`${accountId}@example.com`],
        bodyText: "Thread body",
        bodyHtml: null,
        isMemoryEligible: false,
        ingestionMode: "initial" as const,
        memoryContactEmails: ["sender@example.test"],
        attachments: [],
      });
      const invalidSecondMessage = message("message-2");
      invalidSecondMessage.attachments = [{
        providerAttachmentId: "attachment-1",
        mimePartPath: "1",
        filename: "invalid.pdf",
        mimeType: "application/pdf",
        contentId: null,
        contentDisposition: "attachment",
        size: -1,
        objectKey: null,
        checksumSha256: null,
        contentLength: null,
        etag: null,
      }];

      await assert.rejects(
        upsertMailboxThreadMessages(
          {
            messages: [message("message-1"), invalidSecondMessage],
            activeRunId: runId,
          },
          database,
        ),
        (error: unknown) =>
          error instanceof Error &&
          error.cause instanceof Error &&
          /message_attachments_size_check/.test(error.cause.message),
      );

      assert.deepEqual(
        await database
          .select({ id: threads.id })
          .from(threads)
          .where(eq(threads.providerThreadId, providerThreadId)),
        [],
      );
      assert.deepEqual(
        await database
          .select({ id: messages.id })
          .from(messages)
          .where(eq(messages.accountId, accountId)),
        [],
      );
      const [checkpoint] = await database
        .select({ status: gmailSyncItems.status })
        .from(gmailSyncItems)
        .where(eq(gmailSyncItems.runId, runId));
      assert.equal(checkpoint?.status, "running");
    } finally {
      await database.delete(profiles).where(eq(profiles.id, userId));
      await client.end();
    }
  },
);

test(
  "a stale thread-batch snapshot does not overwrite a newer history apply",
  { skip: !testDatabaseUrl },
  async () => {
    if (!testDatabaseUrl) return;
    const client = postgres(testDatabaseUrl, { max: 1, prepare: false });
    const database = drizzle(client, { schema });
    const userId = uuidv4();
    const accountId = uuidv4();
    const runId = uuidv4();
    const providerThreadId = `provider-thread-${uuidv4()}`;
    const providerMessageId = `provider-message-${uuidv4()}`;
    const sentAt = new Date("2026-08-28T08:00:00.000Z");
    const message = (
      providerHistoryId: string,
      gmailLabels: Array<{ providerLabelId: string; name: string }>,
    ): IndexedMessage => ({
      userId,
      accountId,
      providerThreadId,
      providerMessageId,
      subject: "Live archive",
      snippet: "Archived during ingest",
      participants: ["sender@example.test"],
      gmailLabels,
      providerHistoryId,
      internalDate: sentAt,
      sizeEstimate: 128,
      headerLines: [],
      sentAt,
      direction: "incoming" as const,
      sender: { raw: "sender@example.test", email: "sender@example.test" },
      recipients: [`${accountId}@example.com`],
      bodyText: "Archived during ingest",
      bodyHtml: null,
      isMemoryEligible: false,
      ingestionMode: "initial" as const,
      memoryContactEmails: ["sender@example.test"],
      attachments: [],
    });
    try {
      await database.insert(profiles).values({
        id: userId,
        displayName: "Stale snapshot test",
        email: `${userId}@example.test`,
      });
      await database.insert(connectedAccounts).values({
        id: accountId,
        userId,
        providerAccountId: `provider-${accountId}`,
        email: `${accountId}@example.com`,
        memoryAcknowledgedAt: sentAt,
      });
      await database.insert(mailSyncRuns).values({
        id: runId,
        userId,
        accountId,
        status: "running",
        startingHistoryCursor: "100",
        idempotencyKey: `stale-snapshot-test:${runId}`,
      });
      await database.insert(gmailSyncItems).values({
        runId,
        providerThreadId,
        status: "running",
      });

      await upsertMailboxMessage(
        message("105", [{ providerLabelId: "SENT", name: "Sent" }]),
        database,
      );
      const staleWrite = await upsertMailboxThreadMessages(
        {
          messages: [
            message("100", [{ providerLabelId: "INBOX", name: "Inbox" }]),
          ],
          activeRunId: runId,
        },
        database,
      );
      assert.equal(staleWrite.changed, false);

      const [storedMessage] = await database
        .select({
          id: messages.id,
          providerHistoryId: messages.providerHistoryId,
        })
        .from(messages)
        .where(eq(messages.accountId, accountId));
      assert.ok(storedMessage);
      assert.equal(storedMessage.providerHistoryId, "105");
      const storedLabelIds = (
        await database
          .select({ providerLabelId: labels.providerLabelId })
          .from(messageLabels)
          .innerJoin(labels, eq(labels.id, messageLabels.labelId))
          .where(eq(messageLabels.messageId, storedMessage.id))
      )
        .map((row) => row.providerLabelId)
        .sort();
      assert.deepEqual(storedLabelIds, ["SENT"]);

      const newerWrite = await upsertMailboxMessage(
        message("110", [{ providerLabelId: "INBOX", name: "Inbox" }]),
        database,
      );
      assert.equal(newerWrite.changed, true);
      const [updatedMessage] = await database
        .select({ providerHistoryId: messages.providerHistoryId })
        .from(messages)
        .where(eq(messages.id, storedMessage.id));
      assert.equal(updatedMessage?.providerHistoryId, "110");
    } finally {
      await database.delete(profiles).where(eq(profiles.id, userId));
      await client.end();
    }
  },
);
