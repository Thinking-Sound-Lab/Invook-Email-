import assert from "node:assert/strict";
import test from "node:test";

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { v4 as uuidv4 } from "uuid";

import type { Database } from "./client";
import {
  beginHistoricalThreadLabelScan,
  completeHistoricalThreadLabelScan,
  enqueueHistoricalThreadLabelScan,
  ensureBuiltInInvookLabels,
  listInboxThreadMessages,
  setUserThreadLabel,
} from "./thread-label-analysis";
import {
  listMailboxThreads,
} from "./mailbox-resources";
import {
  replaceGmailMessageLabels,
  setInvookLabelEnabled,
} from "./repositories";
import {
  connectedAccounts,
  gmailReplicaStates,
  labels,
  messageLabels,
  messages,
  profiles,
  threadLabelAssignments,
  threads,
  workflowSteps,
} from "./schema";
import * as schema from "./schema";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test(
  "Inbox threads keep exactly one Invook label across manual replacement and Gmail moves",
  { skip: !testDatabaseUrl },
  async () => {
    if (!testDatabaseUrl) return;
    const client = postgres(testDatabaseUrl, { max: 1 });
    const database = drizzle(client, { schema }) as Database;
    const userId = uuidv4();
    const accountId = uuidv4();
    const threadId = uuidv4();
    const inboxMessageId = uuidv4();
    const spamMessageId = uuidv4();
    const sentAt = new Date();

    try {
      await database.insert(profiles).values({
        id: userId,
        email: `${userId}@example.test`,
        displayName: "Thread label test",
      });
      await database.insert(connectedAccounts).values({
        id: accountId,
        userId,
        providerAccountId: `provider-${accountId}`,
        email: "owner@example.test",
        memoryAcknowledgedAt: sentAt,
      });
      await database.insert(gmailReplicaStates).values({
        accountId,
        initialHistoryId: "100",
        historyCursor: "100",
        state: "ready",
        readyAt: sentAt,
      });
      await ensureBuiltInInvookLabels({ userId, accountId }, database);
      await database.insert(threads).values({
        id: threadId,
        userId,
        accountId,
        providerThreadId: `provider-thread-${threadId}`,
        subject: "Invoice and spam",
        snippet: "Stored Inbox content",
        participants: ["billing@example.test"],
        latestMessageAt: sentAt,
        messageCount: 2,
      });
      await database.insert(messages).values([
        {
          id: inboxMessageId,
          userId,
          accountId,
          threadId,
          providerMessageId: `provider-${inboxMessageId}`,
          direction: "incoming",
          sender: { raw: "Billing <billing@example.test>", email: "billing@example.test" },
          recipients: ["owner@example.test"],
          internalDate: sentAt,
          headerLines: [],
          subject: "Invoice",
          snippet: "Invoice is ready",
          bodyText: "Your invoice is ready.",
          embeddingContentHash: "a".repeat(64),
          sentAt,
        },
        {
          id: spamMessageId,
          userId,
          accountId,
          threadId,
          providerMessageId: `provider-${spamMessageId}`,
          direction: "incoming",
          sender: { raw: "Spam <spam@example.test>", email: "spam@example.test" },
          recipients: ["owner@example.test"],
          internalDate: new Date(sentAt.getTime() - 1_000),
          headerLines: [],
          subject: "Spam",
          snippet: "Spam content",
          bodyText: "This must not reach classification.",
          embeddingContentHash: "b".repeat(64),
          sentAt: new Date(sentAt.getTime() - 1_000),
        },
      ]);
      const gmailLabels = await database
        .insert(labels)
        .values([
          {
            userId,
            accountId,
            kind: "gmail" as const,
            providerLabelId: "INBOX",
            name: "Inbox",
            normalizedName: "inbox",
            providerType: "system" as const,
          },
          {
            userId,
            accountId,
            kind: "gmail" as const,
            providerLabelId: "SPAM",
            name: "Spam",
            normalizedName: "spam",
            providerType: "system" as const,
          },
        ])
        .returning({ id: labels.id, providerLabelId: labels.providerLabelId });
      const inboxLabelId = gmailLabels.find(
        (label) => label.providerLabelId === "INBOX",
      )?.id;
      const spamLabelId = gmailLabels.find(
        (label) => label.providerLabelId === "SPAM",
      )?.id;
      assert.ok(inboxLabelId);
      assert.ok(spamLabelId);
      await database.insert(messageLabels).values([
        { userId, accountId, messageId: inboxMessageId, labelId: inboxLabelId, source: "gmail" },
        { userId, accountId, messageId: spamMessageId, labelId: spamLabelId, source: "gmail" },
      ]);

      assert.deepEqual(
        (await listInboxThreadMessages(threadId, database)).map(({ id }) => id),
        [inboxMessageId],
      );

      const invookLabels = await database
        .select({ id: labels.id, systemKey: labels.systemKey })
        .from(labels)
        .where(and(eq(labels.accountId, accountId), eq(labels.kind, "invook")));
      const importantLabelId = invookLabels.find(
        (label) => label.systemKey === "important",
      )?.id;
      const billingLabelId = invookLabels.find(
        (label) => label.systemKey === "billing",
      )?.id;
      assert.ok(importantLabelId);
      assert.ok(billingLabelId);

      const historicalCheckpoint = {
        threadId,
        labelId: billingLabelId,
        definitionVersion: 1,
        enablementVersion: 1,
        assignmentVersion: null,
      };
      assert.equal(
        await enqueueHistoricalThreadLabelScan(
          {
            userId,
            accountId,
            labelId: billingLabelId,
            definitionVersion: 1,
            enablementVersion: 1,
            after: new Date(sentAt.getTime() - 1_000),
          },
          database,
        ),
        1,
      );
      const [historicalStep] = await database
        .select({ payload: workflowSteps.input })
        .from(workflowSteps)
        .where(eq(workflowSteps.stepType, "label.thread.scan"));
      assert.deepEqual(historicalStep?.payload, historicalCheckpoint);
      assert.equal(
        (await beginHistoricalThreadLabelScan(
          { userId, accountId, checkpoint: historicalCheckpoint },
          database,
        )).status,
        "ready",
      );
      await setInvookLabelEnabled(
        { userId, labelId: billingLabelId, isEnabled: false },
        database,
      );
      const reEnabled = await setInvookLabelEnabled(
        {
          userId,
          labelId: billingLabelId,
          isEnabled: true,
          applyToPastDays: 7,
        },
        database,
      );
      assert.deepEqual(reEnabled?.historicalAnalysis, {
        windowDays: 7,
        queuedThreadCount: 1,
      });
      const reEnabledCheckpoint = {
        ...historicalCheckpoint,
        enablementVersion: 3,
      };
      const historicalSteps = await database
        .select({ payload: workflowSteps.input })
        .from(workflowSteps)
        .where(eq(workflowSteps.stepType, "label.thread.scan"));
      assert.deepEqual(
        historicalSteps
          .map((step) => step.payload.enablementVersion)
          .sort((left, right) => Number(left) - Number(right)),
        [1, 3],
      );
      assert.equal(
        (await beginHistoricalThreadLabelScan(
          { userId, accountId, checkpoint: historicalCheckpoint },
          database,
        )).status,
        "superseded",
      );
      assert.equal(
        (await beginHistoricalThreadLabelScan(
          { userId, accountId, checkpoint: reEnabledCheckpoint },
          database,
        )).status,
        "ready",
      );
      assert.deepEqual(
        await completeHistoricalThreadLabelScan(
          {
            userId,
            accountId,
            checkpoint: reEnabledCheckpoint,
            modelId: "test-model",
            matched: true,
            confidence: 95,
          },
          database,
        ),
        { status: "complete" },
      );
      assert.deepEqual(
        await database
          .select({
            labelId: threadLabelAssignments.labelId,
            source: threadLabelAssignments.source,
            assignmentVersion: threadLabelAssignments.assignmentVersion,
          })
          .from(threadLabelAssignments)
          .where(eq(threadLabelAssignments.threadId, threadId)),
        [{ labelId: billingLabelId, source: "ai", assignmentVersion: 1 }],
      );

      await setUserThreadLabel({ userId, threadId, labelId: importantLabelId }, database);
      assert.deepEqual(
        await completeHistoricalThreadLabelScan(
          {
            userId,
            accountId,
            checkpoint: reEnabledCheckpoint,
            modelId: "test-model",
            matched: true,
            confidence: 95,
          },
          database,
        ),
        { status: "superseded" },
      );
      assert.equal(
        await enqueueHistoricalThreadLabelScan(
          {
            userId,
            accountId,
            labelId: billingLabelId,
            definitionVersion: 1,
            enablementVersion: 3,
            after: new Date(sentAt.getTime() - 1_000),
          },
          database,
        ),
        0,
      );
      const userAssignmentCheckpoint = {
        ...reEnabledCheckpoint,
        assignmentVersion: 2,
      };
      assert.equal(
        (
          await beginHistoricalThreadLabelScan(
            { userId, accountId, checkpoint: userAssignmentCheckpoint },
            database,
          )
        ).status,
        "superseded",
      );
      assert.deepEqual(
        await completeHistoricalThreadLabelScan(
          {
            userId,
            accountId,
            checkpoint: userAssignmentCheckpoint,
            modelId: "test-model",
            matched: true,
            confidence: 95,
          },
          database,
        ),
        { status: "superseded" },
      );
      assert.deepEqual(
        await database
          .select({
            labelId: threadLabelAssignments.labelId,
            source: threadLabelAssignments.source,
            assignmentVersion: threadLabelAssignments.assignmentVersion,
          })
          .from(threadLabelAssignments)
          .where(eq(threadLabelAssignments.threadId, threadId)),
        [{ labelId: importantLabelId, source: "user", assignmentVersion: 2 }],
      );
      await setUserThreadLabel({ userId, threadId, labelId: billingLabelId }, database);
      const assignments = await database
        .select()
        .from(threadLabelAssignments)
        .where(eq(threadLabelAssignments.threadId, threadId));
      assert.equal(assignments.length, 1);
      assert.equal(assignments[0]?.labelId, billingLabelId);
      assert.equal(assignments[0]?.assignmentVersion, 3);
      assert.deepEqual(
        (await listMailboxThreads(userId, { view: "all" }, database))?.threads.map(
          (thread) => [thread.id, thread.invookLabel?.labelId],
        ),
        [[threadId, billingLabelId]],
      );

      await replaceGmailMessageLabels(
        {
          userId,
          accountId,
          providerMessageId: `provider-${inboxMessageId}`,
          providerHistoryId: "101",
          gmailLabels: [],
        },
        database,
      );
      assert.deepEqual(
        (await listMailboxThreads(userId, { view: "all" }, database))?.threads,
        [],
      );
      assert.equal(
        (await database
          .select({ labelId: threadLabelAssignments.labelId })
          .from(threadLabelAssignments)
          .where(eq(threadLabelAssignments.threadId, threadId)))[0]?.labelId,
        billingLabelId,
      );

      await replaceGmailMessageLabels(
        {
          userId,
          accountId,
          providerMessageId: `provider-${inboxMessageId}`,
          providerHistoryId: "102",
          gmailLabels: [{ providerLabelId: "INBOX", name: "Inbox" }],
        },
        database,
      );
      assert.deepEqual(
        (await listMailboxThreads(userId, { view: "all" }, database))?.threads.map(
          (thread) => thread.id,
        ),
        [threadId],
      );
      assert.equal(
        await database
          .select({ id: workflowSteps.id })
          .from(workflowSteps)
          .where(eq(workflowSteps.stepType, "label.thread.assign"))
          .then((rows) => rows.length),
        0,
      );
    } finally {
      await database.delete(profiles).where(eq(profiles.id, userId));
      await client.end();
    }
  },
);
