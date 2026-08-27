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
  mailSyncRuns,
  messages,
  profiles,
  temporalCommands,
  threads,
  workflowSteps,
} from "./schema";
import {
  completeMailSyncThread,
  GMAIL_SYNC_THREAD_BATCH_SIZE,
  getMailSyncRunProviderMessageIds,
  isMailSyncThreadComplete,
  recordMailSyncPage,
} from "./workflows";
import {
  getIndexedMessageIds,
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
  "full-thread ingest deletes local messages Gmail no longer returned",
  { skip: !testDatabaseUrl },
  async () => {
    if (!testDatabaseUrl) return;
    const client = postgres(testDatabaseUrl, { max: 1, prepare: false });
    const database = drizzle(client, { schema });
    const userId = uuidv4();
    const accountId = uuidv4();
    const initialRunId = uuidv4();
    const repairRunId = uuidv4();
    const providerThreadId = `provider-thread-${uuidv4()}`;
    const unlistedThreadId = uuidv4();
    const sentAt = new Date("2026-08-25T08:00:00.000Z");
    const attachmentObjectKey = `attachments/${accountId}/removed.pdf`;
    try {
      await database.insert(profiles).values({
        id: userId,
        displayName: "Repair thread reconcile test",
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
        id: initialRunId,
        userId,
        accountId,
        runType: "initial",
        status: "running",
        startingHistoryCursor: "100",
        idempotencyKey: `thread-reconcile-initial:${initialRunId}`,
      });
      await database.insert(gmailSyncItems).values({
        runId: initialRunId,
        providerThreadId,
        status: "running",
      });
      await database.insert(threads).values({
        id: unlistedThreadId,
        userId,
        accountId,
        providerThreadId: `unlisted-thread-${uuidv4()}`,
        subject: "Gone from Gmail",
        snippet: "Should be finalized away",
        participants: ["gone@example.test"],
        latestMessageAt: sentAt,
        messageCount: 1,
      });
      await database.insert(messages).values({
        userId,
        accountId,
        threadId: unlistedThreadId,
        providerMessageId: "unlisted-message",
        direction: "incoming",
        sender: { raw: "gone@example.test", email: "gone@example.test" },
        recipients: [`${accountId}@example.com`],
        providerHistoryId: "90",
        internalDate: sentAt,
        sentAt,
        subject: "Gone from Gmail",
        snippet: "Should be finalized away",
        bodyText: "Should be finalized away",
      });

      const message = (
        providerMessageId: string,
        options: { objectKey?: string } = {},
      ): IndexedMessage => ({
        userId,
        accountId,
        providerThreadId,
        providerMessageId,
        subject: "Keep this thread",
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
        attachments: options.objectKey
          ? [
              {
                providerAttachmentId: "attachment-1",
                mimePartPath: "1",
                filename: "removed.pdf",
                mimeType: "application/pdf",
                contentId: null,
                contentDisposition: "attachment",
                size: 32,
                objectKey: options.objectKey,
                checksumSha256: null,
                contentLength: 32,
                etag: null,
              },
            ]
          : [],
      });

      await upsertMailboxThreadMessages(
        {
          messages: [
            message("kept-message"),
            message("removed-message", { objectKey: attachmentObjectKey }),
          ],
          activeRunId: initialRunId,
        },
        database,
      );
      await database
        .update(mailSyncRuns)
        .set({ status: "complete" })
        .where(eq(mailSyncRuns.id, initialRunId));
      await database.insert(mailSyncRuns).values({
        id: repairRunId,
        userId,
        accountId,
        runType: "repair",
        status: "running",
        startingHistoryCursor: "200",
        idempotencyKey: `thread-reconcile-repair:${repairRunId}`,
      });
      await database.insert(gmailSyncItems).values({
        runId: repairRunId,
        providerThreadId,
        status: "running",
      });

      const repaired = await upsertMailboxThreadMessages(
        {
          messages: [message("kept-message")],
          activeRunId: repairRunId,
        },
        database,
      );
      assert.equal(repaired.changed, true);

      const remainingProviderMessageIds = (
        await database
          .select({ providerMessageId: messages.providerMessageId })
          .from(messages)
          .where(eq(messages.accountId, accountId))
      )
        .map((row) => row.providerMessageId)
        .sort();
      assert.deepEqual(remainingProviderMessageIds, [
        "kept-message",
        "unlisted-message",
      ]);

      const [cleanupStep] = await database
        .select({
          input: workflowSteps.input,
          maxAttempts: workflowSteps.maxAttempts,
          id: workflowSteps.id,
        })
        .from(workflowSteps)
        .where(
          and(
            eq(workflowSteps.accountId, accountId),
            eq(workflowSteps.stepType, "gmail.objects.delete"),
          ),
        );
      assert.ok(cleanupStep);
      assert.deepEqual(cleanupStep.input, {
        manifest: {
          providerMessageId: "removed-message",
          providerThreadId,
          providerHistoryId: "101",
          objectKeys: [attachmentObjectKey],
        },
      });
      assert.equal(cleanupStep.maxAttempts, 10);
      const [outbox] = await database
        .select({ activityTaskLane: temporalCommands.activityTaskLane })
        .from(temporalCommands)
        .where(eq(temporalCommands.workflowStepId, cleanupStep.id));
      assert.equal(outbox?.activityTaskLane, "bulk");

      assert.deepEqual(
        (
          await getMailSyncRunProviderMessageIds(
            { runId: repairRunId, accountId },
            database,
          )
        ).sort(),
        ["kept-message"],
      );
      assert.deepEqual((await getIndexedMessageIds(accountId, database)).sort(), [
        "kept-message",
        "unlisted-message",
      ]);
    } finally {
      await database.delete(profiles).where(eq(profiles.id, userId));
      await client.end();
    }
  },
);
