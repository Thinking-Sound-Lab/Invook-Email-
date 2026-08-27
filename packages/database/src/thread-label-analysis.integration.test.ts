import assert from "node:assert/strict";
import test from "node:test";

import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { v4 as uuidv4 } from "uuid";

import type { Database } from "./client";
import {
  ensureBuiltInInvookLabels,
  beginThreadLabelAnalysis,
  claimThreadLabelBatchSubmission,
  completeThreadLabelAnalysis,
  enqueueLiveInboxThreadLabelAnalyses,
  enqueueRecentInboxThreadLabelFastLane,
  enqueueThreadLabelBatchSubmission,
  finalizeThreadLabelBatchSubmission,
  getThreadLabelBatchSubmissionForStep,
  listInboxThreadMessages,
  setUserThreadLabel,
} from "./thread-label-analysis";
import {
  listMailboxThreads,
} from "./mailbox-resources";
import {
  enqueueBatchEvent,
  replaceGmailMessageLabels,
  upsertMailboxMessage,
} from "./repositories";
import {
  connectedAccounts,
  gmailReplicaStates,
  gmailSyncItems,
  labels,
  mailSyncRuns,
  messageLabels,
  messages,
  profiles,
  threadLabelAssignments,
  threadLabelBatchSubmissions,
  temporalCommands,
  threads,
  workflowSteps,
} from "./schema";
import * as schema from "./schema";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test(
  "new Inbox threads use the durable live label queue and commit one assignment",
  { skip: !testDatabaseUrl },
  async () => {
    if (!testDatabaseUrl) return;
    const client = postgres(testDatabaseUrl, { max: 1 });
    const database = drizzle(client, { schema }) as Database;
    const userId = uuidv4();
    const accountId = uuidv4();
    const threadId = uuidv4();
    const messageId = uuidv4();
    const sentAt = new Date("2026-08-20T09:00:00.000Z");

    try {
      await database.insert(profiles).values({
        id: userId,
        email: `${userId}@example.test`,
        displayName: "Live thread label test",
      });
      await database.insert(connectedAccounts).values({
        id: accountId,
        userId,
        providerAccountId: `provider-${accountId}`,
        email: "owner@example.test",
        memoryAcknowledgedAt: sentAt,
      });
      await ensureBuiltInInvookLabels({ userId, accountId }, database);
      const [inboxLabel] = await database
        .insert(labels)
        .values({
          userId,
          accountId,
          kind: "gmail",
          providerLabelId: "INBOX",
          name: "Inbox",
          normalizedName: "inbox",
          providerType: "system",
        })
        .returning({ id: labels.id });
      assert.ok(inboxLabel);
      await database.insert(threads).values({
        id: threadId,
        userId,
        accountId,
        providerThreadId: `provider-thread-${threadId}`,
        subject: "Please review",
        snippet: "Action requested",
        participants: ["sender@example.test"],
        latestMessageAt: sentAt,
      });
      await database.insert(messages).values({
        id: messageId,
        userId,
        accountId,
        threadId,
        providerMessageId: `provider-${messageId}`,
        direction: "incoming",
        sender: { raw: "Sender <sender@example.test>", email: "sender@example.test" },
        recipients: ["owner@example.test"],
        internalDate: sentAt,
        headerLines: [],
        subject: "Please review",
        snippet: "Action requested",
        bodyText: "Please review and reply today.",
        sentAt,
      });
      await database.insert(messageLabels).values({
        userId,
        accountId,
        messageId,
        labelId: inboxLabel.id,
        source: "gmail",
      });

      assert.equal(
        await enqueueLiveInboxThreadLabelAnalyses(
          { userId, accountId, threadIds: [threadId, threadId] },
          database,
        ),
        1,
      );
      const [step] = await database
        .select({
          id: workflowSteps.id,
          input: workflowSteps.input,
          activityTaskLane: temporalCommands.activityTaskLane,
        })
        .from(workflowSteps)
        .innerJoin(
          temporalCommands,
          eq(temporalCommands.workflowStepId, workflowSteps.id),
        )
        .where(
          and(
            eq(workflowSteps.accountId, accountId),
            eq(workflowSteps.stepType, "label.thread.assign"),
          ),
        )
        .limit(1);
      assert.equal(step?.activityTaskLane, "live");
      assert.equal(step?.input.threadId, threadId);
      assert.equal(step?.input.analysisVersion, 1);
      assert.equal(step?.input.lane, "live");
      assert.match(String(step?.input.definitionHash), /^[a-f0-9]{64}$/);
      const checkpoint = {
        threadId,
        analysisVersion: 1,
        definitionHash: String(step?.input.definitionHash),
      };
      const ready = await beginThreadLabelAnalysis(
        { userId, accountId, checkpoint },
        database,
      );
      assert.equal(ready.status, "ready");
      if (ready.status !== "ready") return;
      const important = ready.definitions.find(
        (definition) => definition.name === "Important",
      );
      assert.ok(important);
      assert.equal(ready.thread.messages.length, 1);
      const completed = await completeThreadLabelAnalysis(
        {
          userId,
          accountId,
          checkpoint,
          modelId: "test-live-model",
          labelId: important.id,
          confidence: 98,
        },
        database,
      );
      assert.equal(completed.status, "complete");
      assert.equal(
        await enqueueLiveInboxThreadLabelAnalyses(
          { userId, accountId, threadIds: [threadId] },
          database,
        ),
        0,
      );
      assert.deepEqual(
        await database
          .select({
            labelId: threadLabelAssignments.labelId,
            source: threadLabelAssignments.source,
          })
          .from(threadLabelAssignments)
          .where(eq(threadLabelAssignments.threadId, threadId)),
        [{ labelId: important.id, source: "ai" }],
      );

      const activeRunId = uuidv4();
      const nextProviderMessageId = `provider-next-${messageId}`;
      const nextSentAt = new Date("2026-08-20T10:00:00.000Z");
      await database.insert(mailSyncRuns).values({
        id: activeRunId,
        userId,
        accountId,
        status: "running",
        discoveryComplete: false,
        startingHistoryCursor: "100",
        idempotencyKey: `live-thread-label-sync:${activeRunId}`,
      });
      await upsertMailboxMessage(
        {
          userId,
          accountId,
          providerThreadId: `provider-thread-${threadId}`,
          providerMessageId: nextProviderMessageId,
          subject: "Invoice available",
          snippet: "Your invoice is ready",
          participants: ["billing@example.test", "owner@example.test"],
          gmailLabels: [{ providerLabelId: "INBOX", name: "Inbox" }],
          providerHistoryId: "101",
          internalDate: nextSentAt,
          sizeEstimate: 128,
          headerLines: [],
          sentAt: nextSentAt,
          direction: "incoming",
          sender: {
            raw: "Billing <billing@example.test>",
            email: "billing@example.test",
          },
          recipients: ["owner@example.test"],
          bodyText: "Your invoice is ready for payment.",
          bodyHtml: null,
          rawObject: null,
          isMemoryEligible: false,
          ingestionMode: "initial",
          memoryContactEmails: ["billing@example.test"],
          attachments: [],
        },
        database,
        activeRunId,
      );
      assert.deepEqual(
        await database
          .select({
            state: threads.labelAnalysisState,
            version: threads.labelAnalysisVersion,
            labelId: threadLabelAssignments.labelId,
            assignmentVersion: threadLabelAssignments.assignmentVersion,
          })
          .from(threads)
          .innerJoin(
            threadLabelAssignments,
            eq(threadLabelAssignments.threadId, threads.id),
          )
          .where(eq(threads.id, threadId))
          .then((rows) => rows[0]),
        {
          state: "pending",
          version: 2,
          labelId: important.id,
          assignmentVersion: 1,
        },
      );
      await database.insert(gmailSyncItems).values({
        runId: activeRunId,
        providerMessageId: nextProviderMessageId,
        providerThreadId: `provider-thread-${threadId}`,
        status: "complete",
        completedAt: nextSentAt,
      });
      assert.equal(
        await enqueueRecentInboxThreadLabelFastLane(
          {
            userId,
            accountId,
            runId: activeRunId,
            threadIds: [threadId],
          },
          database,
        ),
        1,
      );
      const [replacementStep] = await database
        .select({ input: workflowSteps.input })
        .from(workflowSteps)
        .where(
          and(
            eq(workflowSteps.accountId, accountId),
            eq(workflowSteps.stepType, "label.thread.assign"),
            sql`${workflowSteps.input}->>'analysisVersion' = '2'`,
          ),
        )
        .limit(1);
      assert.ok(replacementStep);
      assert.equal(replacementStep.input.lane, "recent");
      const replacementCheckpoint = {
        threadId,
        analysisVersion: 2,
        definitionHash: String(replacementStep.input.definitionHash),
      };
      const replacement = await beginThreadLabelAnalysis(
        { userId, accountId, checkpoint: replacementCheckpoint },
        database,
      );
      assert.equal(replacement.status, "ready");
      if (replacement.status !== "ready") return;
      const billing = replacement.definitions.find(
        (definition) => definition.name === "Billing",
      );
      assert.ok(billing);
      assert.equal(
        (
          await completeThreadLabelAnalysis(
            {
              userId,
              accountId,
              checkpoint: replacementCheckpoint,
              modelId: "test-live-model",
              labelId: billing.id,
              confidence: 97,
            },
            database,
          )
        ).status,
        "complete",
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
        [{ labelId: billing.id, source: "ai", assignmentVersion: 2 }],
      );
    } finally {
      await database.delete(profiles).where(eq(profiles.id, userId));
      await client.end();
    }
  },
);

test(
  "live analysis that loses Inbox eligibility can be requeued after unarchive",
  { skip: !testDatabaseUrl },
  async () => {
    if (!testDatabaseUrl) return;
    const client = postgres(testDatabaseUrl, { max: 1 });
    const database = drizzle(client, { schema }) as Database;
    const userId = uuidv4();
    const accountId = uuidv4();
    const threadId = uuidv4();
    const messageId = uuidv4();
    const sentAt = new Date("2026-08-25T11:00:00.000Z");

    try {
      await database.insert(profiles).values({
        id: userId,
        email: `${userId}@example.test`,
        displayName: "Ineligible live label reservation test",
      });
      await database.insert(connectedAccounts).values({
        id: accountId,
        userId,
        providerAccountId: `provider-${accountId}`,
        email: "owner@example.test",
        memoryAcknowledgedAt: sentAt,
      });
      await ensureBuiltInInvookLabels({ userId, accountId }, database);
      const [inboxLabel] = await database
        .insert(labels)
        .values({
          userId,
          accountId,
          kind: "gmail",
          providerLabelId: "INBOX",
          name: "Inbox",
          normalizedName: "inbox",
          providerType: "system",
        })
        .returning({ id: labels.id });
      assert.ok(inboxLabel);
      const [important] = await database
        .select({ id: labels.id })
        .from(labels)
        .where(
          and(
            eq(labels.accountId, accountId),
            eq(labels.kind, "invook"),
            eq(labels.systemKey, "important"),
          ),
        )
        .limit(1);
      assert.ok(important);
      await database.insert(threads).values({
        id: threadId,
        userId,
        accountId,
        providerThreadId: `provider-thread-${threadId}`,
        subject: "Please review",
        snippet: "Action requested",
        participants: ["sender@example.test"],
        latestMessageAt: sentAt,
        labelAnalysisVersion: 2,
        labelAnalysisState: "pending",
      });
      await database.insert(messages).values({
        id: messageId,
        userId,
        accountId,
        threadId,
        providerMessageId: `provider-${messageId}`,
        direction: "incoming",
        sender: { raw: "Sender <sender@example.test>", email: "sender@example.test" },
        recipients: ["owner@example.test"],
        internalDate: sentAt,
        headerLines: [],
        subject: "Please review",
        snippet: "Action requested",
        bodyText: "Please review and reply today.",
        embeddingContentHash: "d".repeat(64),
        sentAt,
      });
      await database.insert(messageLabels).values({
        userId,
        accountId,
        messageId,
        labelId: inboxLabel.id,
        source: "gmail",
      });
      await database.insert(threadLabelAssignments).values({
        userId,
        accountId,
        threadId,
        labelId: important.id,
        source: "ai",
        confidence: "90.00",
        modelId: "test-live-model",
        definitionVersion: 1,
      });

      assert.equal(
        await enqueueLiveInboxThreadLabelAnalyses(
          { userId, accountId, threadIds: [threadId] },
          database,
        ),
        1,
      );
      const [step] = await database
        .select({ input: workflowSteps.input })
        .from(workflowSteps)
        .where(
          and(
            eq(workflowSteps.accountId, accountId),
            eq(workflowSteps.stepType, "label.thread.assign"),
          ),
        )
        .limit(1);
      assert.equal(step?.input.analysisVersion, 2);
      const checkpoint = {
        threadId,
        analysisVersion: 2,
        definitionHash: String(step?.input.definitionHash),
      };

      await replaceGmailMessageLabels(
        {
          userId,
          accountId,
          providerMessageId: `provider-${messageId}`,
          providerHistoryId: "201",
          gmailLabels: [],
        },
        database,
      );
      const ineligible = await beginThreadLabelAnalysis(
        { userId, accountId, checkpoint },
        database,
      );
      assert.equal(ineligible.status, "ineligible");
      assert.deepEqual(
        await database
          .select({
            state: threads.labelAnalysisState,
            version: threads.labelAnalysisVersion,
          })
          .from(threads)
          .where(eq(threads.id, threadId))
          .then((rows) => rows[0]),
        { state: "pending", version: 3 },
      );

      await replaceGmailMessageLabels(
        {
          userId,
          accountId,
          providerMessageId: `provider-${messageId}`,
          providerHistoryId: "202",
          gmailLabels: [{ providerLabelId: "INBOX", name: "Inbox" }],
        },
        database,
      );
      assert.equal(
        (
          await database
            .select({
              state: threads.labelAnalysisState,
              version: threads.labelAnalysisVersion,
            })
            .from(threads)
            .where(eq(threads.id, threadId))
            .then((rows) => rows[0])
        )?.state,
        "pending",
      );
      assert.equal(
        await enqueueLiveInboxThreadLabelAnalyses(
          { userId, accountId, threadIds: [threadId] },
          database,
        ),
        1,
      );
      const [replay] = await database
        .select({ input: workflowSteps.input })
        .from(workflowSteps)
        .where(
          and(
            eq(workflowSteps.accountId, accountId),
            eq(workflowSteps.stepType, "label.thread.assign"),
            sql`${workflowSteps.input}->>'analysisVersion' = '3'`,
          ),
        )
        .limit(1);
      assert.equal(replay?.input.lane, "live");
    } finally {
      await database.delete(profiles).where(eq(profiles.id, userId));
      await client.end();
    }
  },
);

test(
  "recent label replans bypass a full distinct-thread fast-lane cap",
  { skip: !testDatabaseUrl },
  async () => {
    if (!testDatabaseUrl) return;
    const client = postgres(testDatabaseUrl, { max: 1 });
    const database = drizzle(client, { schema }) as Database;
    const userId = uuidv4();
    const accountId = uuidv4();
    const runId = uuidv4();
    const replanThreadId = uuidv4();
    const newThreadId = uuidv4();
    const replanMessageId = uuidv4();
    const newMessageId = uuidv4();
    const sentAt = new Date("2026-08-20T11:00:00.000Z");

    try {
      await database.insert(profiles).values({
        id: userId,
        email: `${userId}@example.test`,
        displayName: "Capped recent label replan test",
      });
      await database.insert(connectedAccounts).values({
        id: accountId,
        userId,
        providerAccountId: `provider-${accountId}`,
        email: "owner@example.test",
        memoryAcknowledgedAt: sentAt,
      });
      await ensureBuiltInInvookLabels({ userId, accountId }, database);
      const [importantLabel] = await database
        .select({ id: labels.id, definitionVersion: labels.definitionVersion })
        .from(labels)
        .where(
          and(
            eq(labels.accountId, accountId),
            eq(labels.systemKey, "important"),
          ),
        )
        .limit(1);
      assert.ok(importantLabel);
      const [inboxLabel] = await database
        .insert(labels)
        .values({
          userId,
          accountId,
          kind: "gmail",
          providerLabelId: "INBOX",
          name: "Inbox",
          normalizedName: "inbox",
          providerType: "system",
        })
        .returning({ id: labels.id });
      assert.ok(inboxLabel);
      await database.insert(mailSyncRuns).values({
        id: runId,
        userId,
        accountId,
        status: "running",
        discoveryComplete: false,
        startingHistoryCursor: "200",
        idempotencyKey: `capped-recent-label-sync:${runId}`,
      });
      await database.insert(threads).values([
        {
          id: replanThreadId,
          userId,
          accountId,
          providerThreadId: `provider-thread-${replanThreadId}`,
          subject: "Updated invoice",
          snippet: "New content needs another label analysis",
          participants: ["billing@example.test"],
          latestMessageAt: sentAt,
          labelAnalysisVersion: 2,
        },
        {
          id: newThreadId,
          userId,
          accountId,
          providerThreadId: `provider-thread-${newThreadId}`,
          subject: "New thread outside the cohort",
          snippet: "This thread must wait for batch labeling",
          participants: ["sender@example.test"],
          latestMessageAt: new Date(sentAt.getTime() - 1_000),
        },
      ]);
      await database.insert(messages).values([
        {
          id: replanMessageId,
          userId,
          accountId,
          threadId: replanThreadId,
          providerMessageId: `provider-${replanMessageId}`,
          direction: "incoming",
          sender: {
            raw: "Billing <billing@example.test>",
            email: "billing@example.test",
          },
          recipients: ["owner@example.test"],
          internalDate: sentAt,
          headerLines: [],
          subject: "Updated invoice",
          snippet: "New content needs another label analysis",
          bodyText: "The invoice changed after the first analysis.",
          sentAt,
        },
        {
          id: newMessageId,
          userId,
          accountId,
          threadId: newThreadId,
          providerMessageId: `provider-${newMessageId}`,
          direction: "incoming",
          sender: {
            raw: "Sender <sender@example.test>",
            email: "sender@example.test",
          },
          recipients: ["owner@example.test"],
          internalDate: new Date(sentAt.getTime() - 1_000),
          headerLines: [],
          subject: "New thread outside the cohort",
          snippet: "This thread must wait for batch labeling",
          bodyText: "A separate new message.",
          sentAt: new Date(sentAt.getTime() - 1_000),
        },
      ]);
      await database.insert(messageLabels).values([
        {
          userId,
          accountId,
          messageId: replanMessageId,
          labelId: inboxLabel.id,
          source: "gmail",
        },
        {
          userId,
          accountId,
          messageId: newMessageId,
          labelId: inboxLabel.id,
          source: "gmail",
        },
      ]);
      await database.insert(threadLabelAssignments).values({
        userId,
        accountId,
        threadId: replanThreadId,
        labelId: importantLabel.id,
        source: "ai",
        confidence: "95.00",
        modelId: "test-model-v1",
        definitionVersion: importantLabel.definitionVersion,
      });
      await database.insert(gmailSyncItems).values([
        {
          runId,
          providerMessageId: `provider-${replanMessageId}`,
          providerThreadId: `provider-thread-${replanThreadId}`,
          status: "complete",
          completedAt: sentAt,
        },
        {
          runId,
          providerMessageId: `provider-${newMessageId}`,
          providerThreadId: `provider-thread-${newThreadId}`,
          status: "complete",
          completedAt: sentAt,
        },
      ]);
      const admittedThreadIds = [
        replanThreadId,
        ...Array.from({ length: 199 }, () => uuidv4()),
      ];
      await database.insert(workflowSteps).values(
        admittedThreadIds.map((threadId) => ({
          runId,
          userId,
          accountId,
          stepType: "label.thread.assign",
          status: "complete" as const,
          input: {
            threadId,
            analysisVersion: 1,
            definitionHash: "f".repeat(64),
            lane: "recent",
          },
          idempotencyKey: `capped-recent-label:${runId}:${threadId}`,
        })),
      );

      assert.equal(
        await enqueueRecentInboxThreadLabelFastLane(
          {
            userId,
            accountId,
            runId,
            threadIds: [replanThreadId, newThreadId],
          },
          database,
        ),
        1,
      );
      const [replacementStep] = await database
        .select({ input: workflowSteps.input })
        .from(workflowSteps)
        .where(
          and(
            eq(workflowSteps.accountId, accountId),
            sql`${workflowSteps.input}->>'threadId' = ${replanThreadId}`,
            sql`${workflowSteps.input}->>'analysisVersion' = '2'`,
          ),
        )
        .limit(1);
      assert.equal(replacementStep?.input.lane, "recent");
      assert.deepEqual(
        await database
          .select({
            state: threads.labelAnalysisState,
            version: threads.labelAnalysisVersion,
          })
          .from(threads)
          .where(eq(threads.id, newThreadId))
          .then((rows) => rows[0]),
        { state: "pending", version: 1 },
      );
      assert.equal(
        await database
          .select({ id: workflowSteps.id })
          .from(workflowSteps)
          .where(sql`${workflowSteps.input}->>'threadId' = ${newThreadId}`)
          .then((rows) => rows.length),
        0,
      );
    } finally {
      await database.delete(profiles).where(eq(profiles.id, userId));
      await client.end();
    }
  },
);
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
    const retryThreadId = uuidv4();
    const retryMessageId = uuidv4();
    const sentAt = new Date("2026-08-18T09:00:00.000Z");

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
      assert.deepEqual(
        (await listMailboxThreads(userId, { view: "all" }, database))?.threads.map(
          (thread) => [thread.id, thread.invookLabel],
        ),
        [[threadId, null]],
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

      const activeRunId = uuidv4();
      await database.insert(mailSyncRuns).values({
        id: activeRunId,
        userId,
        accountId,
        status: "running",
        discoveryComplete: true,
        startingHistoryCursor: "100",
        idempotencyKey: `thread-label-active-sync:${activeRunId}`,
      });
      await database.insert(gmailSyncItems).values({
        runId: activeRunId,
        providerMessageId: `provider-${inboxMessageId}`,
        providerThreadId: `provider-thread-${threadId}`,
        status: "complete",
        completedAt: sentAt,
      });
      const prematureFlushStepId = await enqueueThreadLabelBatchSubmission({
        userId,
        accountId,
        sourceKey: `thread-label-premature-flush:${activeRunId}`,
        flushRemainder: true,
      }, database);
      assert.equal(
        await claimThreadLabelBatchSubmission(
          {
            workflowStepId: prematureFlushStepId,
            userId,
            accountId,
            flushRemainder: true,
            modelId: "test-label-batch-model",
          },
          database,
        ),
        null,
      );
      await database
        .update(mailSyncRuns)
        .set({ status: "complete", completedAt: sentAt })
        .where(eq(mailSyncRuns.id, activeRunId));

      const submissionStepId = await enqueueThreadLabelBatchSubmission({
        userId,
        accountId,
        sourceKey: `thread-label-batch-test:${threadId}`,
        flushRemainder: true,
      }, database);
      assert.deepEqual(
        await database
          .select({ runId: workflowSteps.runId, input: workflowSteps.input })
          .from(workflowSteps)
          .where(eq(workflowSteps.id, submissionStepId))
          .then((rows) => rows[0]),
        { runId: null, input: { flushRemainder: true } },
      );
      const claimed = await claimThreadLabelBatchSubmission(
        {
          workflowStepId: submissionStepId,
          userId,
          accountId,
          flushRemainder: true,
          modelId: "test-label-batch-model",
        },
        database,
      );
      assert.equal(claimed?.candidates.length, 1);
      const submission = await getThreadLabelBatchSubmissionForStep(
        submissionStepId,
        database,
      );
      assert.ok(submission);
      await database
        .update(threadLabelBatchSubmissions)
        .set({
          status: "submitted",
          providerBatchId: `batch-${submission.id}`,
          inputFileId: `file-${submission.id}`,
        })
        .where(eq(threadLabelBatchSubmissions.id, submission.id));
      const serializedStepId = await enqueueThreadLabelBatchSubmission(
        {
          userId,
          accountId,
          sourceKey: `thread-label-serialized-test:${threadId}`,
          flushRemainder: true,
        },
        database,
      );
      assert.equal(
        await claimThreadLabelBatchSubmission(
          {
            workflowStepId: serializedStepId,
            userId,
            accountId,
            flushRemainder: true,
            modelId: "test-label-batch-model",
          },
          database,
        ),
        null,
      );
      const matchedEvent = await enqueueBatchEvent(
        {
          provider: "openai",
          webhookId: `webhook-${submission.id}`,
          eventType: "batch.completed",
          providerBatchId: `batch-${submission.id}`,
        },
        database,
      );
      assert.equal(matchedEvent?.submissionJobId, submissionStepId);
      assert.equal(
        await database
          .select({ id: workflowSteps.id })
          .from(workflowSteps)
          .where(
            and(
              eq(workflowSteps.accountId, accountId),
              eq(workflowSteps.stepType, "label.batch.event"),
            ),
          )
          .then((rows) => rows.length),
        1,
      );

      await setUserThreadLabel({ userId, threadId, labelId: importantLabelId }, database);
      const lateCompletion = await finalizeThreadLabelBatchSubmission(
        {
          submissionId: submission.id,
          providerState: "completed",
          providerErrorCode: null,
          retryableFailure: false,
          outputFileId: `output-${submission.id}`,
          errorFileId: null,
          modelId: "test-label-batch-model",
          results: [{ threadId, labelId: billingLabelId, confidence: 99 }],
          failedThreadIds: [],
        },
        database,
      );
      assert.equal(lateCompletion.appliedCount, 0);
      assert.equal(
        (
          await finalizeThreadLabelBatchSubmission(
            {
              submissionId: submission.id,
              providerState: "completed",
              providerErrorCode: null,
              retryableFailure: false,
              outputFileId: `output-${submission.id}`,
              errorFileId: null,
              modelId: "test-label-batch-model",
              results: [{ threadId, labelId: billingLabelId, confidence: 99 }],
              failedThreadIds: [],
            },
            database,
          )
        ).alreadyFinalized,
        true,
      );

      await database.insert(threads).values({
        id: retryThreadId,
        userId,
        accountId,
        providerThreadId: `provider-thread-${retryThreadId}`,
        subject: "Capacity retry",
        snippet: "Retry this historical label",
        participants: ["sender@example.test"],
        latestMessageAt: sentAt,
      });
      await database.insert(messages).values({
        id: retryMessageId,
        userId,
        accountId,
        threadId: retryThreadId,
        providerMessageId: `provider-${retryMessageId}`,
        direction: "incoming",
        sender: { raw: "Sender <sender@example.test>", email: "sender@example.test" },
        recipients: ["owner@example.test"],
        internalDate: sentAt,
        headerLines: [],
        subject: "Capacity retry",
        snippet: "Retry this historical label",
        bodyText: "This request should return to pending after provider capacity exhaustion.",
        sentAt,
      });
      await database.insert(messageLabels).values({
        userId,
        accountId,
        messageId: retryMessageId,
        labelId: inboxLabelId,
        source: "gmail",
      });
      const retrySubmissionStepId = await enqueueThreadLabelBatchSubmission(
        {
          userId,
          accountId,
          sourceKey: `thread-label-capacity-test:${retryThreadId}`,
          flushRemainder: true,
        },
        database,
      );
      const retryClaim = await claimThreadLabelBatchSubmission(
        {
          workflowStepId: retrySubmissionStepId,
          userId,
          accountId,
          flushRemainder: true,
          modelId: "test-label-batch-model",
        },
        database,
      );
      assert.deepEqual(
        retryClaim?.candidates.map((candidate) => candidate.threadId),
        [retryThreadId],
      );
      const retrySubmission = await getThreadLabelBatchSubmissionForStep(
        retrySubmissionStepId,
        database,
      );
      assert.ok(retrySubmission);
      await database
        .update(threadLabelBatchSubmissions)
        .set({
          status: "submitted",
          providerBatchId: `batch-${retrySubmission.id}`,
          inputFileId: `file-${retrySubmission.id}`,
        })
        .where(eq(threadLabelBatchSubmissions.id, retrySubmission.id));
      const retryFinalization = await finalizeThreadLabelBatchSubmission(
        {
          submissionId: retrySubmission.id,
          providerState: "failed",
          providerErrorCode: "openai_batch_capacity_exhausted",
          retryableFailure: true,
          outputFileId: null,
          errorFileId: `error-${retrySubmission.id}`,
          modelId: "test-label-batch-model",
          results: [],
          failedThreadIds: [retryThreadId],
        },
        database,
      );
      const retryContinuationStepId = retryFinalization.continuationStepId;
      assert.ok(retryContinuationStepId);
      assert.deepEqual(
        await database
          .select({
            state: threads.labelAnalysisState,
            error: threads.labelAnalysisError,
          })
          .from(threads)
          .where(eq(threads.id, retryThreadId)),
        [{ state: "pending", error: "openai_batch_capacity_exhausted" }],
      );
      const [retryStep] = await database
        .select({ input: workflowSteps.input })
        .from(workflowSteps)
        .where(eq(workflowSteps.id, retryContinuationStepId));
      assert.equal(retryStep?.input.retryAttempt, 1);
      assert.deepEqual(retryStep?.input.threadIds, [retryThreadId]);
      assert.ok(
        typeof retryStep?.input.runAt === "string" &&
          Date.parse(retryStep.input.runAt) > Date.now(),
      );
      const invalidResultClaim = await claimThreadLabelBatchSubmission(
        {
          workflowStepId: retryContinuationStepId,
          userId,
          accountId,
          flushRemainder: true,
          modelId: "test-label-batch-model",
          threadIds: [retryThreadId],
        },
        database,
      );
      assert.deepEqual(
        invalidResultClaim?.candidates.map((candidate) => candidate.threadId),
        [retryThreadId],
      );
      const invalidResultSubmission = await getThreadLabelBatchSubmissionForStep(
        retryContinuationStepId,
        database,
      );
      assert.ok(invalidResultSubmission);
      await database
        .update(threadLabelBatchSubmissions)
        .set({
          status: "submitted",
          providerBatchId: `batch-${invalidResultSubmission.id}`,
          inputFileId: `file-${invalidResultSubmission.id}`,
        })
        .where(
          eq(threadLabelBatchSubmissions.id, invalidResultSubmission.id),
        );
      const invalidResultFinalization =
        await finalizeThreadLabelBatchSubmission(
          {
            submissionId: invalidResultSubmission.id,
            providerState: "completed",
            providerErrorCode: null,
            retryableFailure: false,
            outputFileId: `output-${invalidResultSubmission.id}`,
            errorFileId: null,
            modelId: "test-label-batch-model",
            results: [],
            failedThreadIds: [retryThreadId],
          },
          database,
        );
      const invalidResultRetryStepId =
        invalidResultFinalization.continuationStepId;
      assert.ok(invalidResultRetryStepId);
      const [invalidResultRetryStep] = await database
        .select({ input: workflowSteps.input })
        .from(workflowSteps)
        .where(eq(workflowSteps.id, invalidResultRetryStepId));
      assert.equal(invalidResultRetryStep?.input.retryAttempt, 2);
      assert.deepEqual(invalidResultRetryStep?.input.threadIds, [retryThreadId]);
      assert.equal(invalidResultRetryStep?.input.runAt, undefined);
      await database.delete(threads).where(eq(threads.id, retryThreadId));

      await setUserThreadLabel({ userId, threadId, labelId: billingLabelId }, database);
      const assignments = await database
        .select()
        .from(threadLabelAssignments)
        .where(eq(threadLabelAssignments.threadId, threadId));
      assert.equal(assignments.length, 1);
      assert.equal(assignments[0]?.labelId, billingLabelId);
      assert.equal(assignments[0]?.assignmentVersion, 2);
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
          .where(
            and(
              eq(workflowSteps.stepType, "label.thread.assign"),
              eq(workflowSteps.accountId, accountId),
            ),
          )
          .then((rows) => rows.length),
        0,
      );
    } finally {
      await database.delete(profiles).where(eq(profiles.id, userId));
      await client.end();
    }
  },
);
