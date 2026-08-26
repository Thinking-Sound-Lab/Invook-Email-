import assert from "node:assert/strict";
import test from "node:test";

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { v4 as uuidv4 } from "uuid";

import type { Database } from "./client";
import {
  ensureBuiltInInvookLabels,
  beginThreadLabelAnalysis,
  claimThreadLabelBatchSubmission,
  completeThreadLabelAnalysis,
  enqueueInitialThreadLabelBatchIfReady,
  enqueueLiveInboxThreadLabelAnalyses,
  enqueueThreadLabelBatchSubmission,
  finalizeThreadLabelBatchSubmission,
  getThreadLabelBatchSubmissionForStep,
  listInboxThreadMessages,
  setUserThreadLabel,
  THREAD_LABEL_BATCH_START_THRESHOLD,
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
        embeddingContentHash: "c".repeat(64),
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
    } finally {
      await database.delete(profiles).where(eq(profiles.id, userId));
      await client.end();
    }
  },
);

test(
  "initial synchronization durably admits one label Batch at 100 stored threads",
  { skip: !testDatabaseUrl },
  async () => {
    if (!testDatabaseUrl) return;
    const client = postgres(testDatabaseUrl, { max: 1 });
    const database = drizzle(client, { schema }) as Database;
    const userId = uuidv4();
    const accountId = uuidv4();
    const runId = uuidv4();
    const sentAt = new Date("2026-08-25T08:00:00.000Z");

    try {
      await database.insert(profiles).values({
        id: userId,
        email: `${userId}@example.test`,
        displayName: "Initial label admission test",
      });
      await database.insert(connectedAccounts).values({
        id: accountId,
        userId,
        providerAccountId: `provider-${accountId}`,
        email: "owner@example.test",
        memoryAcknowledgedAt: sentAt,
      });
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
        startingHistoryCursor: "100",
        idempotencyKey: `initial-label-admission:${runId}`,
      });

      const insertCandidates = async (count: number): Promise<void> => {
        const candidates = Array.from({ length: count }, () => ({
          threadId: uuidv4(),
          messageId: uuidv4(),
        }));
        await database.insert(threads).values(
          candidates.map(({ threadId }) => ({
            id: threadId,
            userId,
            accountId,
            providerThreadId: `provider-thread-${threadId}`,
            subject: `Candidate ${threadId}`,
            snippet: "Stored Inbox candidate",
            participants: ["sender@example.test"],
            latestMessageAt: sentAt,
            messageCount: 1,
          })),
        );
        await database.insert(messages).values(
          candidates.map(({ threadId, messageId }) => ({
            id: messageId,
            userId,
            accountId,
            threadId,
            providerMessageId: `provider-message-${messageId}`,
            direction: "incoming" as const,
            sender: {
              raw: "Sender <sender@example.test>",
              email: "sender@example.test",
            },
            recipients: ["owner@example.test"],
            internalDate: sentAt,
            headerLines: [],
            subject: `Candidate ${threadId}`,
            snippet: "Stored Inbox candidate",
            bodyText: "Please classify this stored Inbox thread.",
            embeddingContentHash: "e".repeat(64),
            sentAt,
          })),
        );
        await database.insert(messageLabels).values(
          candidates.map(({ messageId }) => ({
            userId,
            accountId,
            messageId,
            labelId: inboxLabel.id,
            source: "gmail" as const,
          })),
        );
        await database.insert(gmailSyncItems).values(
          candidates.map(({ threadId }) => ({
            runId,
            providerThreadId: `provider-thread-${threadId}`,
            status: "complete" as const,
            completedAt: sentAt,
          })),
        );
      };

      await insertCandidates(THREAD_LABEL_BATCH_START_THRESHOLD - 1);
      assert.deepEqual(
        await enqueueInitialThreadLabelBatchIfReady(
          {
            runId,
            userId,
            accountId,
            sourceKey: `below-threshold:${runId}`,
          },
          database,
        ),
        {
          status: "below_threshold",
          candidateCount: THREAD_LABEL_BATCH_START_THRESHOLD - 1,
        },
      );
      assert.equal(
        await database
          .select({ id: workflowSteps.id })
          .from(workflowSteps)
          .where(
            and(
              eq(workflowSteps.accountId, accountId),
              eq(workflowSteps.stepType, "label.batch.submit"),
            ),
          )
          .then((rows) => rows.length),
        0,
      );

      await insertCandidates(1);
      const admitted = await enqueueInitialThreadLabelBatchIfReady(
        {
          runId,
          userId,
          accountId,
          sourceKey: `threshold:${runId}`,
        },
        database,
      );
      assert.equal(admitted.status, "enqueued");
      if (admitted.status !== "enqueued") return;
      assert.equal(
        admitted.candidateCount,
        THREAD_LABEL_BATCH_START_THRESHOLD,
      );
      assert.deepEqual(
        await enqueueInitialThreadLabelBatchIfReady(
          {
            runId,
            userId,
            accountId,
            sourceKey: `duplicate-threshold:${runId}`,
          },
          database,
        ),
        { status: "busy" },
      );
      const [admissionStep] = await database
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
        .where(eq(workflowSteps.id, admitted.stepId));
      assert.deepEqual(admissionStep, {
        id: admitted.stepId,
        input: { flushRemainder: false },
        activityTaskLane: "live",
      });

      const claimed = await claimThreadLabelBatchSubmission(
        {
          workflowStepId: admitted.stepId,
          userId,
          accountId,
          flushRemainder: false,
          modelId: "test-label-batch-model",
        },
        database,
      );
      assert.equal(
        claimed?.candidates.length,
        THREAD_LABEL_BATCH_START_THRESHOLD,
      );

      await insertCandidates(1);
      assert.deepEqual(
        await enqueueInitialThreadLabelBatchIfReady(
          {
            runId,
            userId,
            accountId,
            sourceKey: `active-submission:${runId}`,
          },
          database,
        ),
        { status: "busy" },
      );
      assert.equal(
        await database
          .select({ id: workflowSteps.id })
          .from(workflowSteps)
          .where(
            and(
              eq(workflowSteps.accountId, accountId),
              eq(workflowSteps.stepType, "label.batch.submit"),
            ),
          )
          .then((rows) => rows.length),
        1,
      );

      const submission = await getThreadLabelBatchSubmissionForStep(
        admitted.stepId,
        database,
      );
      assert.ok(submission);
      await database
        .update(threadLabelBatchSubmissions)
        .set({
          status: "submitted",
          providerBatchId: `batch-${submission.id}`,
          inputFileId: `input-${submission.id}`,
        })
        .where(eq(threadLabelBatchSubmissions.id, submission.id));
      await database
        .update(mailSyncRuns)
        .set({ status: "complete", completedAt: sentAt })
        .where(eq(mailSyncRuns.id, runId));
      const completed = await finalizeThreadLabelBatchSubmission(
        {
          submissionId: submission.id,
          providerState: "completed",
          providerErrorCode: null,
          retryableFailure: false,
          outputFileId: `output-${submission.id}`,
          errorFileId: null,
          modelId: "test-label-batch-model",
          results: claimed.candidates.map((candidate) => ({
            threadId: candidate.threadId,
            labelId: candidate.fallbackLabelId,
            confidence: 90,
          })),
          failedThreadIds: [],
        },
        database,
      );
      assert.ok(completed.continuationStepId);
      const [continuationStep] = await database
        .select({ input: workflowSteps.input })
        .from(workflowSteps)
        .where(eq(workflowSteps.id, completed.continuationStepId));
      assert.deepEqual(continuationStep?.input, { flushRemainder: true });
      const remainder = await claimThreadLabelBatchSubmission(
        {
          workflowStepId: completed.continuationStepId,
          userId,
          accountId,
          flushRemainder: true,
          modelId: "test-label-batch-model",
        },
        database,
      );
      assert.equal(remainder?.candidates.length, 1);
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
        embeddingContentHash: "d".repeat(64),
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
