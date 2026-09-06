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
  threads,
  workflowSteps,
} from "./schema";
import {
  completeMailSyncThread,
  isMailSyncThreadComplete,
  recordMailSyncPage,
} from "./workflows";
import { upsertMailboxThreadMessages } from "./repositories";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test(
  "a recorded page reports the threads still owed ingestion",
  { skip: !testDatabaseUrl },
  async () => {
    if (!testDatabaseUrl) return;
    const client = postgres(testDatabaseUrl, { max: 1, prepare: false });
    const database = drizzle(client, { schema });
    const userId = uuidv4();
    const accountId = uuidv4();
    const runId = uuidv4();
    const providerThreadIds = Array.from(
      { length: 23 },
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

      const recordPage = () =>
        recordMailSyncPage(
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
        );

      assert.deepEqual(await recordPage(), {
        status: "recorded",
        pendingThreadIds: providerThreadIds,
      });

      const items = await database
        .select({ providerThreadId: gmailSyncItems.providerThreadId })
        .from(gmailSyncItems)
        .where(eq(gmailSyncItems.runId, runId));
      assert.equal(items.length, providerThreadIds.length);

      // A retried Activity attempt must still be told what it owes, so the
      // replayed call reports the same pending set rather than an empty one.
      assert.deepEqual(await recordPage(), {
        status: "recorded",
        pendingThreadIds: providerThreadIds,
      });

      // Discovery no longer enqueues durable steps: the Workflow drives both
      // pagination and ingestion.
      const steps = await database
        .select({ idempotencyKey: workflowSteps.idempotencyKey })
        .from(workflowSteps)
        .where(eq(workflowSteps.runId, runId))
        .orderBy(asc(workflowSteps.idempotencyKey));
      assert.deepEqual(steps, []);

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

      // Gmail can repeat a thread across pages when the mailbox changes
      // mid-walk; an already ingested thread must not be ingested twice.
      assert.deepEqual(
        await recordMailSyncPage(
          {
            runId,
            userId,
            accountId,
            pageNumber: 2,
            pageToken: "page-2",
            nextPageToken: null,
            providerThreadIds,
          },
          database,
        ),
        {
          status: "recorded",
          pendingThreadIds: providerThreadIds.filter(
            (providerThreadId) => providerThreadId !== completedProviderThreadId,
          ),
        },
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
        ingestionMode: "initial" as const,
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
