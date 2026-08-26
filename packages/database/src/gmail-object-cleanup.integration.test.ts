import assert from "node:assert/strict";
import test from "node:test";

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { v4 as uuidv4 } from "uuid";

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
        embeddingContentHash: "a".repeat(64),
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
