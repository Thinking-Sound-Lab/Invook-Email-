import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { v4 as uuidv4 } from "uuid";

import { listReferencedGmailObjectKeys } from "./replica";
import { deleteIndexedMessage } from "./repositories";
import {
  connectedAccounts,
  messageAttachments,
  messages,
  profiles,
  temporalCommands,
  threads,
  workflowSteps,
} from "./schema";
import * as schema from "./schema";
import { markWorkflowStepRunning } from "./workflows";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const rawObjectRetirementMigrationUrl = new URL(
  "../drizzle/0035_wandering_lockheed.sql",
  import.meta.url,
);

test(
  "raw MIME retirement durably queues stored objects before dropping their keys",
  { skip: !testDatabaseUrl },
  async () => {
    if (!testDatabaseUrl) return;
    const client = postgres(testDatabaseUrl, { max: 1, prepare: false });
    const testSchema = `raw_object_retirement_${uuidv4().replaceAll("-", "")}`;
    const userId = uuidv4();
    const accountId = uuidv4();
    const threadId = uuidv4();
    const messageId = uuidv4();
    try {
      await client.unsafe(`CREATE SCHEMA "${testSchema}"`);
      await client.unsafe(`SET search_path TO "${testSchema}"`);
      await client.unsafe(`
        CREATE TABLE threads (
          id uuid PRIMARY KEY,
          provider_thread_id text NOT NULL
        );
        CREATE TABLE messages (
          id uuid PRIMARY KEY,
          user_id uuid NOT NULL,
          account_id uuid NOT NULL,
          thread_id uuid NOT NULL,
          provider_message_id text NOT NULL,
          provider_history_id text,
          raw_object_key text,
          raw_checksum_sha256 text,
          raw_content_length integer,
          raw_etag text,
          CONSTRAINT messages_raw_content_length_check
            CHECK (raw_content_length IS NULL OR raw_content_length >= 0)
        );
        CREATE TABLE workflow_steps (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id uuid,
          account_id uuid,
          step_type text NOT NULL,
          status text NOT NULL,
          input jsonb NOT NULL,
          attempts integer NOT NULL,
          max_attempts integer NOT NULL,
          idempotency_key text NOT NULL UNIQUE
        );
        CREATE TABLE temporal_commands (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          workflow_step_id uuid NOT NULL UNIQUE,
          activity_task_lane text NOT NULL,
          dispatch_attempts integer NOT NULL DEFAULT 0
        );
      `);
      await client`
        INSERT INTO threads (id, provider_thread_id)
        VALUES (${threadId}, 'provider-thread')
      `;
      await client`
        INSERT INTO messages (
          id,
          user_id,
          account_id,
          thread_id,
          provider_message_id,
          provider_history_id,
          raw_object_key,
          raw_checksum_sha256,
          raw_content_length,
          raw_etag
        ) VALUES (
          ${messageId},
          ${userId},
          ${accountId},
          ${threadId},
          'provider-message',
          '150',
          'raw/provider-message.eml',
          ${"a".repeat(64)},
          512,
          'raw-etag'
        )
      `;

      const migration = await readFile(rawObjectRetirementMigrationUrl, "utf8");
      for (const statement of migration
        .split("--> statement-breakpoint")
        .map((candidate) => candidate.trim())
        .filter(
          (candidate) =>
            candidate.startsWith('INSERT INTO "workflow_steps"') ||
            candidate.startsWith('INSERT INTO "temporal_commands"') ||
            candidate.startsWith(
              'ALTER TABLE "messages" DROP CONSTRAINT "messages_raw_content_length_check"',
            ) ||
            candidate.startsWith('ALTER TABLE "messages" DROP COLUMN "raw_'),
        )) {
        await client.unsafe(statement);
      }

      assert.deepEqual(
        Array.from(
          await client`
            SELECT step_type, status, input, max_attempts, idempotency_key
            FROM workflow_steps
          `,
        ),
        [
          {
            step_type: "gmail.objects.delete",
            status: "queued",
            input: {
              manifest: {
                providerMessageId: "provider-message",
                providerThreadId: "provider-thread",
                providerHistoryId: "150",
                objectKeys: ["raw/provider-message.eml"],
              },
            },
            max_attempts: 10,
            idempotency_key: `gmail-object-delete:raw-mime-migration:${messageId}`,
          },
        ],
      );
      assert.deepEqual(
        Array.from(
          await client`
            SELECT activity_task_lane, dispatch_attempts
            FROM temporal_commands
          `,
        ),
        [{ activity_task_lane: "bulk", dispatch_attempts: 0 }],
      );
      assert.deepEqual(
        Array.from(
          await client`
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = ${testSchema}
              AND table_name = 'messages'
              AND column_name LIKE 'raw_%'
          `,
        ),
        [],
      );
    } finally {
      await client.unsafe("SET search_path TO public");
      await client.unsafe(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`);
      await client.end();
    }
  },
);

test(
  "message deletion durably records its attachment manifest before relational cleanup",
  { skip: !testDatabaseUrl },
  async () => {
    if (!testDatabaseUrl) return;
    const client = postgres(testDatabaseUrl, { max: 1, prepare: false });
    const database = drizzle(client, { schema });
    const userId = uuidv4();
    const accountId = uuidv4();
    const threadId = uuidv4();
    const messageId = uuidv4();
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
      await database.insert(threads).values({
        id: threadId,
        userId,
        accountId,
        providerThreadId: "provider-thread",
        messageCount: 1,
      });
      await database.insert(messages).values({
        id: messageId,
        userId,
        accountId,
        threadId,
        providerMessageId: "provider-message",
        providerHistoryId: "100",
        direction: "incoming",
        sender: { raw: "Sender <sender@example.com>", email: "sender@example.com" },
        internalDate: new Date("2026-08-14T10:00:00.000Z"),
        sentAt: new Date("2026-08-14T10:00:00.000Z"),
      });
      await database.insert(messageAttachments).values({
        userId,
        accountId,
        messageId,
        filename: "document.pdf",
        objectKey: "attachments/provider-message/document.pdf",
      });
      const expectedObjectKeys = ["attachments/provider-message/document.pdf"];

      const result = await deleteIndexedMessage(
        {
          accountId,
          providerMessageId: "provider-message",
          providerHistoryId: "150",
        },
        database,
      );

      assert.deepEqual(result.objectKeys, expectedObjectKeys);
      assert.equal(
        (await database.select().from(messages).where(eq(messages.id, messageId))).length,
        0,
      );
      const [step] = await database
        .select()
        .from(workflowSteps)
        .where(
          and(
            eq(workflowSteps.accountId, accountId),
            eq(workflowSteps.stepType, "gmail.objects.delete"),
          ),
        );
      assert.ok(step);
      assert.deepEqual(step.input, {
        manifest: {
          providerMessageId: "provider-message",
          providerThreadId: "provider-thread",
          providerHistoryId: "150",
          objectKeys: expectedObjectKeys,
        },
      });
      assert.equal(step.maxAttempts, 10);
      const [outbox] = await database
        .select()
        .from(temporalCommands)
        .where(eq(temporalCommands.workflowStepId, step.id));
      assert.equal(outbox?.activityTaskLane, "bulk");

      await database
        .update(connectedAccounts)
        .set({ status: "reconnect_required" })
        .where(eq(connectedAccounts.id, accountId));
      assert.deepEqual(await markWorkflowStepRunning(step.id, 1, database), {
        shouldExecute: true,
        result: null,
      });
    } finally {
      await database.delete(profiles).where(eq(profiles.id, userId));
      await client.end();
    }
  },
);

test(
  "object cleanup can observe keys that became live again after re-ingest",
  { skip: !testDatabaseUrl },
  async () => {
    if (!testDatabaseUrl) return;
    const client = postgres(testDatabaseUrl, { max: 1, prepare: false });
    const database = drizzle(client, { schema });
    const userId = uuidv4();
    const accountId = uuidv4();
    const threadId = uuidv4();
    const messageId = uuidv4();
    const restoredMessageId = uuidv4();
    const objectKey = `${accountId}/messages/provider-message/attachments/0-abc`;
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
      await database.insert(threads).values({
        id: threadId,
        userId,
        accountId,
        providerThreadId: "provider-thread",
        messageCount: 1,
      });
      await database.insert(messages).values({
        id: messageId,
        userId,
        accountId,
        threadId,
        providerMessageId: "provider-message",
        providerHistoryId: "100",
        direction: "incoming",
        sender: { raw: "Sender <sender@example.com>", email: "sender@example.com" },
        internalDate: new Date("2026-08-14T10:00:00.000Z"),
        sentAt: new Date("2026-08-14T10:00:00.000Z"),
      });
      await database.insert(messageAttachments).values({
        userId,
        accountId,
        messageId,
        filename: "document.pdf",
        objectKey,
      });

      assert.deepEqual(
        await listReferencedGmailObjectKeys(
          { accountId, objectKeys: [objectKey, "unrelated/key"] },
          database,
        ),
        [objectKey],
      );

      await deleteIndexedMessage(
        {
          accountId,
          providerMessageId: "provider-message",
        },
        database,
      );
      assert.deepEqual(
        await listReferencedGmailObjectKeys(
          { accountId, objectKeys: [objectKey] },
          database,
        ),
        [],
      );

      await database.insert(threads).values({
        id: threadId,
        userId,
        accountId,
        providerThreadId: "provider-thread",
        messageCount: 1,
      });
      await database.insert(messages).values({
        id: restoredMessageId,
        userId,
        accountId,
        threadId,
        providerMessageId: "provider-message",
        providerHistoryId: "180",
        direction: "incoming",
        sender: { raw: "Sender <sender@example.com>", email: "sender@example.com" },
        internalDate: new Date("2026-08-14T10:00:00.000Z"),
        sentAt: new Date("2026-08-14T10:00:00.000Z"),
      });
      await database.insert(messageAttachments).values({
        userId,
        accountId,
        messageId: restoredMessageId,
        filename: "document.pdf",
        objectKey,
      });
      assert.deepEqual(
        await listReferencedGmailObjectKeys(
          { accountId, objectKeys: [objectKey] },
          database,
        ),
        [objectKey],
      );
    } finally {
      await database.delete(profiles).where(eq(profiles.id, userId));
      await client.end();
    }
  },
);
