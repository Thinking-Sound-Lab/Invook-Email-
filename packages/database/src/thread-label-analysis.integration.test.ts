import assert from "node:assert/strict";
import test from "node:test";

import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { v4 as uuidv4 } from "uuid";

import type { Database } from "./client";
import {
  claimThreadLabelBatchSubmission,
  enqueueHistoricalThreadLabelBatchRecoveries,
  finalizeThreadLabelBatchPreparation,
  finalizeThreadLabelBatchSubmission,
  listSubmittedThreadLabelBatchIds,
} from "./historical-thread-label-batches";
import {
  createLabelPreviewReceipt,
  LabelPreviewReceiptConflictError,
} from "./label-preview-receipts";
import {
  getMailboxThreadDetail,
  listMailboxThreads,
} from "./mailbox-resources";
import { queryInvookMailbox } from "./mailbox-query";
import {
  createInvookLabel,
  replaceGmailMessageLabels,
  setInvookLabelEnabled,
  updateInvookLabel,
  upsertMailboxThreadMessages,
} from "./repositories";
import { scanRecentThreadLabelPage } from "./recent-thread-label-recovery";
import {
  beginThreadLabelAnalysis,
  completeThreadLabelAnalysis,
  enqueueLiveInboxThreadLabelAnalyses,
  ensureBuiltInInvookLabels,
  failThreadLabelAnalysis,
  setUserThreadLabel,
} from "./thread-label-analysis";
import { automaticThreadLabelCutoff } from "./thread-label-eligibility";
import { failWorkflowStep, markWorkflowStepRunning } from "./workflows";
import * as schema from "./schema";
import {
  connectedAccounts,
  gmailReplicaStates,
  gmailSyncItems,
  historicalThreadLabelScans,
  labels,
  labelPreviewReceipts,
  mailSyncRuns,
  messageLabels,
  messages,
  profiles,
  temporalCommands,
  threadLabelAssignments,
  threadLabelBatchSubmissions,
  threads,
  workflowSteps,
} from "./schema";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const DAY_MS = 86_400_000;
interface TestContext {
  database: Database;
  userId: string;
  accountId: string;
  referenceAt: Date;
  inboxId: string;
  spamId: string;
  trashId: string;
}

async function withContext(
  run: (context: TestContext) => Promise<void>,
): Promise<void> {
  assert.ok(testDatabaseUrl);
  const client = postgres(testDatabaseUrl, { max: 4 });
  const database = drizzle(client, { schema });
  const userId = uuidv4();
  const accountId = uuidv4();
  const referenceAt = new Date();
  try {
    await database.insert(profiles).values({
      id: userId,
      email: `${userId}@example.test`,
      displayName: "Label policy test",
    });
    await database.insert(connectedAccounts).values({
      id: accountId,
      userId,
      providerAccountId: accountId,
      email: `${accountId}@example.test`,
      memoryAcknowledgedAt: referenceAt,
    });
    await database.insert(gmailReplicaStates).values({
      accountId,
      state: "ready",
      initialHistoryId: "1",
      historyCursor: "1",
    });
    await ensureBuiltInInvookLabels({ userId, accountId }, database);
    const systemRows = await database
      .insert(labels)
      .values(
        ["INBOX", "SPAM", "TRASH"].map((providerLabelId) => ({
          userId,
          accountId,
          kind: "gmail" as const,
          providerLabelId,
          name: providerLabelId,
          normalizedName: providerLabelId.toLowerCase(),
          providerType: "system" as const,
        })),
      )
      .returning({ id: labels.id, providerLabelId: labels.providerLabelId });
    const inboxId = systemRows.find(
      (row) => row.providerLabelId === "INBOX",
    )?.id;
    const spamId = systemRows.find((row) => row.providerLabelId === "SPAM")?.id;
    const trashId = systemRows.find(
      (row) => row.providerLabelId === "TRASH",
    )?.id;
    assert.ok(inboxId && spamId && trashId);
    await run({
      database,
      userId,
      accountId,
      referenceAt,
      inboxId,
      spamId,
      trashId,
    });
  } finally {
    await database.delete(profiles).where(eq(profiles.id, userId));
    await client.end();
  }
}

async function insertThreads(
  context: TestContext,
  inputs: Array<{ sentAt: Date; membershipIds?: string[] }>,
): Promise<Array<{ threadId: string; messageId: string }>> {
  const { database, userId, accountId, referenceAt } = context;
  const rows = inputs.map((input) => ({
    ...input,
    threadId: uuidv4(),
    messageId: uuidv4(),
  }));
  const createdAt = new Date(referenceAt.getTime() - DAY_MS);
  await database.insert(threads).values(
    rows.map((row) => ({
      id: row.threadId,
      userId,
      accountId,
      providerThreadId: row.threadId,
      subject: "Stored thread",
      snippet: "Stored message",
      latestMessageAt: row.sentAt,
      messageCount: 1,
      createdAt,
    })),
  );
  await database.insert(messages).values(
    rows.map((row) => ({
      id: row.messageId,
      userId,
      accountId,
      threadId: row.threadId,
      providerMessageId: row.messageId,
      direction: "incoming" as const,
      sender: { raw: "sender@example.test", email: "sender@example.test" },
      recipients: ["owner@example.test"],
      internalDate: row.sentAt,
      subject: "Stored thread",
      bodyText: "Stored content for label classification.",
      sentAt: row.sentAt,
      createdAt,
    })),
  );
  const memberships = rows.flatMap((row) =>
    (row.membershipIds ?? [context.inboxId]).map((labelId) => ({
      userId,
      accountId,
      messageId: row.messageId,
      labelId,
      source: "gmail" as const,
    })),
  );
  if (memberships.length)
    await database.insert(messageLabels).values(memberships);
  return rows.map(({ threadId, messageId }) => ({ threadId, messageId }));
}

async function createHistoricalRequest(
  context: TestContext,
  days: 7 | 30 | 90 = 30,
) {
  const label = await createInvookLabel(
    {
      userId: context.userId,
      accountId: context.accountId,
      name: `Requested ${uuidv4()}`,
      description: "Match billing records",
      applyToPastDays: days,
    },
    context.database,
  );
  assert.ok(label);
  const [scan] = await context.database
    .select()
    .from(historicalThreadLabelScans)
    .where(eq(historicalThreadLabelScans.labelId, label.id));
  assert.ok(scan);
  const [step] = await context.database
    .select()
    .from(workflowSteps)
    .where(
      and(
        eq(workflowSteps.accountId, context.accountId),
        sql`${workflowSteps.input}->>'historicalScanId' = ${scan.id}`,
      ),
    );
  assert.ok(step);
  return { label, scan, stepId: step.id };
}

async function claim(context: TestContext, stepId: string) {
  const [step] = await context.database
    .select()
    .from(workflowSteps)
    .where(eq(workflowSteps.id, stepId));
  assert.ok(step);
  const historicalScanId = step.input.historicalScanId;
  const retryAttempt = step.input.retryAttempt;
  assert.equal(typeof historicalScanId, "string");
  assert.equal(typeof retryAttempt, "number");
  if (typeof historicalScanId !== "string" || typeof retryAttempt !== "number")
    throw new Error("Invalid test request");
  const candidateIds = step.input.threadIds;
  const threadIds =
    candidateIds === undefined
      ? undefined
      : Array.isArray(candidateIds)
        ? candidateIds.filter((id): id is string => typeof id === "string")
        : [];
  const rawContinuations = step.input.continuations ?? [];
  assert.ok(Array.isArray(rawContinuations));
  const continuations = rawContinuations.map((value: unknown) => {
    assert.ok(
      value &&
        typeof value === "object" &&
        "retryAttempt" in value &&
        "threadIds" in value,
    );
    assert.equal(typeof value.retryAttempt, "number");
    assert.ok(Array.isArray(value.threadIds));
    if (typeof value.retryAttempt !== "number")
      throw new Error("Invalid test retry attempt");
    return {
      retryAttempt: value.retryAttempt,
      threadIds: value.threadIds.map((threadId: unknown) => {
        assert.equal(typeof threadId, "string");
        if (typeof threadId !== "string")
          throw new Error("Invalid test retry thread");
        return threadId;
      }),
    };
  });
  return claimThreadLabelBatchSubmission(
    {
      workflowStepId: stepId,
      historicalScanId,
      retryAttempt,
      threadIds,
      continuations,
      userId: context.userId,
      accountId: context.accountId,
      modelId: "test-model",
    },
    context.database,
  );
}

async function finish(
  context: TestContext,
  submissionId: string,
  results: Array<{ threadId: string; labelId: string; confidence: number }>,
  options: { providerState?: string; retryableFailure?: boolean } = {},
) {
  return finalizeThreadLabelBatchSubmission(
    {
      submissionId,
      providerState: options.providerState ?? "completed",
      providerErrorCode: options.providerState ? "test_provider_failure" : null,
      retryableFailure: options.retryableFailure ?? false,
      outputFileId: null,
      errorFileId: null,
      modelId: "test-model",
      results,
      failedThreadIds: [],
    },
    context.database,
  );
}

const integrationOptions = { skip: !testDatabaseUrl };

test(
  "automatic admission covers every recent Inbox thread beyond 1,000 with an exact 14-day boundary",
  integrationOptions,
  async () => {
    await withContext(async (context) => {
      const { database, userId, accountId, referenceAt } = context;
      const cutoff = automaticThreadLabelCutoff(referenceAt);
      const recent = await insertThreads(
        context,
        Array.from({ length: 1_002 }, () => ({
          sentAt: new Date(referenceAt.getTime() - DAY_MS),
        })),
      );
      const [boundary, old, spam, trash, archived] = await insertThreads(
        context,
        [
          { sentAt: cutoff },
          { sentAt: new Date(cutoff.getTime() - 1) },
          {
            sentAt: referenceAt,
            membershipIds: [context.inboxId, context.spamId],
          },
          {
            sentAt: referenceAt,
            membershipIds: [context.inboxId, context.trashId],
          },
          { sentAt: referenceAt, membershipIds: [] },
        ],
      );
      assert.ok(boundary && old && spam && trash && archived);
      // A recent non-Inbox message must not make an old Inbox message eligible.
      await database
        .update(threads)
        .set({ latestMessageAt: referenceAt })
        .where(eq(threads.id, old.threadId));
      const threadIds = [...recent, boundary, old, spam, trash, archived].map(
        (thread) => thread.threadId,
      );
      assert.equal(
        await database.transaction((transaction) =>
          enqueueLiveInboxThreadLabelAnalyses(
            { userId, accountId, referenceAt, threadIds },
            transaction,
          ),
        ),
        1_003,
      );
      assert.equal(
        await database.transaction((transaction) =>
          enqueueLiveInboxThreadLabelAnalyses(
            { userId, accountId, referenceAt, threadIds },
            transaction,
          ),
        ),
        0,
      );
      const steps = await database
        .select({
          type: workflowSteps.stepType,
          lane: temporalCommands.activityTaskLane,
        })
        .from(workflowSteps)
        .innerJoin(
          temporalCommands,
          eq(temporalCommands.workflowStepId, workflowSteps.id),
        )
        .where(eq(workflowSteps.accountId, accountId));
      assert.equal(steps.length, 1_003);
      assert.ok(
        steps.every(
          (step) => step.type === "label.thread.assign" && step.lane === "live",
        ),
      );
      const [oldThread] = await database
        .select()
        .from(threads)
        .where(eq(threads.id, old.threadId));
      assert.equal(oldThread?.labelAnalysisState, "not_requested");
      assert.equal(
        (
          await database
            .select()
            .from(threadLabelBatchSubmissions)
            .where(eq(threadLabelBatchSubmissions.accountId, accountId))
        ).length,
        0,
      );
    });
  },
);

test(
  "initial sync admits live labeling atomically and labels can finish after the sync run",
  integrationOptions,
  async () => {
    await withContext(async (context) => {
      const { database, userId, accountId, referenceAt } = context;
      const runId = uuidv4();
      const providerThreadId = uuidv4();
      await database.insert(mailSyncRuns).values({
        id: runId,
        userId,
        accountId,
        status: "running",
        startingHistoryCursor: "1",
        idempotencyKey: runId,
        createdAt: referenceAt,
      });
      await database
        .insert(gmailSyncItems)
        .values({ runId, providerThreadId, status: "running" });
      const stored = await upsertMailboxThreadMessages(
        {
          activeRunId: runId,
          messages: [
            {
              userId,
              accountId,
              providerThreadId,
              providerMessageId: uuidv4(),
              subject: "Initial thread",
              snippet: "Initial content",
              participants: [],
              gmailLabels: [{ providerLabelId: "INBOX", name: "Inbox" }],
              providerHistoryId: "1",
              internalDate: referenceAt,
              sizeEstimate: null,
              headerLines: [],
              sentAt: referenceAt,
              direction: "incoming",
              sender: {
                raw: "sender@example.test",
                email: "sender@example.test",
              },
              recipients: [],
              bodyText: "Please review",
              bodyHtml: null,
              isMemoryEligible: false,
              ingestionMode: "initial",
              memoryContactEmails: [],
            },
          ],
        },
        database,
      );
      const [step] = await database
        .select()
        .from(workflowSteps)
        .where(
          and(
            eq(workflowSteps.accountId, accountId),
            eq(workflowSteps.stepType, "label.thread.assign"),
          ),
        );
      assert.ok(step);
      assert.equal(step.runId, null);
      await database
        .update(mailSyncRuns)
        .set({ status: "complete" })
        .where(eq(mailSyncRuns.id, runId));
      assert.equal(
        (await markWorkflowStepRunning(step.id, 1, database)).shouldExecute,
        true,
      );
      const [thread] = await database
        .select()
        .from(threads)
        .where(eq(threads.id, stored.threadId));
      assert.equal(
        thread?.labelAnalysisAfter?.toISOString(),
        automaticThreadLabelCutoff(referenceAt).toISOString(),
      );
      const checkpoint = {
        threadId: stored.threadId,
        analysisVersion: Number(step.input.analysisVersion),
        definitionHash: String(step.input.definitionHash),
      };
      const ready = await beginThreadLabelAnalysis(
        { userId, accountId, checkpoint },
        database,
      );
      assert.equal(ready.status, "ready");
      if (ready.status !== "ready") throw new Error("Expected live analysis");
      const completed = await completeThreadLabelAnalysis(
        {
          userId,
          accountId,
          checkpoint,
          labelId: ready.fallback.id,
          confidence: 90,
          modelId: "test-live",
        },
        database,
      );
      assert.equal(completed.status, "complete");
      assert.equal(
        (await listMailboxThreads(userId, { view: "all", accountId }, database))
          ?.threads[0]?.invookLabel?.labelId,
        ready.fallback.id,
      );
    });
  },
);

test(
  "live failures never create Batches and newer manual assignments supersede live results",
  integrationOptions,
  async () => {
    await withContext(async (context) => {
      const { database, userId, accountId, referenceAt } = context;
      const [first, second] = await insertThreads(context, [
        { sentAt: referenceAt },
        { sentAt: referenceAt },
      ]);
      assert.ok(first && second);
      await database.transaction((transaction) =>
        enqueueLiveInboxThreadLabelAnalyses(
          {
            userId,
            accountId,
            referenceAt,
            threadIds: [first.threadId, second.threadId],
          },
          transaction,
        ),
      );
      for (const target of [first, second]) {
        const [thread] = await database
          .select()
          .from(threads)
          .where(eq(threads.id, target.threadId));
        assert.ok(thread?.labelAnalysisDefinitionHash);
        const checkpoint = {
          threadId: target.threadId,
          analysisVersion: thread.labelAnalysisVersion,
          definitionHash: thread.labelAnalysisDefinitionHash,
        };
        if (target === first) {
          assert.equal(
            await failThreadLabelAnalysis(
              {
                userId,
                accountId,
                checkpoint,
                errorCode: "label_analysis_failed",
              },
              database,
            ),
            true,
          );
        } else {
          const ready = await beginThreadLabelAnalysis(
            { userId, accountId, checkpoint },
            database,
          );
          assert.equal(ready.status, "ready");
          if (ready.status !== "ready")
            throw new Error("Expected live analysis");
          await setUserThreadLabel(
            { userId, threadId: target.threadId, labelId: ready.fallback.id },
            database,
          );
          assert.equal(
            (
              await completeThreadLabelAnalysis(
                {
                  userId,
                  accountId,
                  checkpoint,
                  labelId: ready.definitions[0]?.id ?? ready.fallback.id,
                  modelId: "test-live",
                  confidence: 99,
                },
                database,
              )
            ).status,
            "current",
          );
        }
      }
      const batchSteps = await database
        .select()
        .from(workflowSteps)
        .where(
          and(
            eq(workflowSteps.accountId, accountId),
            eq(workflowSteps.stepType, "label.batch.submit"),
          ),
        );
      assert.equal(batchSteps.length, 0);
      const [failed] = await database
        .select()
        .from(threads)
        .where(eq(threads.id, first.threadId));
      assert.equal(failed?.labelAnalysisState, "failed");
    });
  },
);

test(
  "old mail restored to Inbox stays outside automatic labeling and recovery",
  integrationOptions,
  async () => {
    await withContext(async (context) => {
      const { database, userId, accountId, referenceAt } = context;
      const [old] = await insertThreads(context, [
        {
          sentAt: new Date(referenceAt.getTime() - 40 * DAY_MS),
          membershipIds: [],
        },
      ]);
      assert.ok(old);
      await replaceGmailMessageLabels(
        {
          userId,
          accountId,
          providerMessageId: old.messageId,
          providerHistoryId: "2",
          gmailLabels: [{ providerLabelId: "INBOX", name: "Inbox" }],
        },
        database,
      );
      const recovery = await scanRecentThreadLabelPage(
        { userId, accountId, referenceAt, cursorThreadId: null },
        database,
      );
      assert.deepEqual(recovery, {
        enqueuedCount: 0,
        continuationStepId: null,
      });
      const query = await queryInvookMailbox(
        { userId, accountId, inboxState: "inbox" },
        database,
      );
      assert.equal(query.status, "available");
      assert.equal("availableGmailLabels" in query, false);
      if (query.status === "available") {
        const [message] = query.messages;
        assert.ok(message);
        assert.equal("gmailLabels" in message, false);
      }
      const detail = await getMailboxThreadDetail(
        userId,
        old.threadId,
        accountId,
        database,
      );
      assert.equal(detail?.thread.invookLabel, null);
      assert.equal("gmailLabels" in (detail?.thread ?? {}), false);
    });
  },
);

for (const windowDays of [7, 30, 90] as const) {
  test(
    `settings admission scopes Batch to its selected label and ${windowDays}-day window`,
    integrationOptions,
    async () => {
      await withContext(async (context) => {
        const { database, userId, accountId, referenceAt } = context;
        const rows = await insertThreads(
          context,
          [6, 20, 80, 100].map((days) => ({
            sentAt: new Date(referenceAt.getTime() - days * DAY_MS),
          })),
        );
        const [others] = await database
          .select()
          .from(labels)
          .where(
            and(
              eq(labels.accountId, accountId),
              eq(labels.systemKey, "others"),
            ),
          );
        assert.ok(others && rows[0]);
        await database.insert(threadLabelAssignments).values({
          userId,
          accountId,
          threadId: rows[0].threadId,
          labelId: others.id,
          source: "ai",
          modelId: "previous-model",
          confidence: "90",
          definitionVersion: 1,
        });
        await database
          .update(threads)
          .set({ labelAnalysisState: "complete" })
          .where(eq(threads.id, rows[0].threadId));
        const request = await createHistoricalRequest(context, windowDays);
        assert.equal(
          request.scan.before.getTime() - request.scan.after.getTime(),
          windowDays * DAY_MS,
        );
        const batch = await claim(context, request.stepId);
        assert.ok(batch);
        const expectedCount = windowDays === 7 ? 1 : windowDays === 30 ? 2 : 3;
        assert.equal(batch.candidates.length, expectedCount);
        assert.ok(
          batch.candidates.every(
            (entry) =>
              entry.definitions.length === 1 &&
              entry.definitions[0]?.id === request.label.id,
          ),
        );
        const [command] = await database
          .select()
          .from(temporalCommands)
          .where(eq(temporalCommands.workflowStepId, request.stepId));
        assert.equal(command?.activityTaskLane, "bulk");
        const result = await finish(
          context,
          batch.submissionId,
          batch.candidates.map((candidate) => ({
            threadId: candidate.threadId,
            labelId:
              candidate.threadId === rows[0]?.threadId
                ? candidate.fallbackLabelId
                : request.label.id,
            confidence: 95,
          })),
        );
        assert.equal(result.appliedCount, expectedCount - 1);
        assert.ok(result.continuationStepId);
        assert.equal(await claim(context, result.continuationStepId), null);
        const [unchanged] = await database
          .select()
          .from(threadLabelAssignments)
          .where(eq(threadLabelAssignments.threadId, rows[0].threadId));
        assert.equal(unchanged?.labelId, others.id);
        const [complete] = await database
          .select()
          .from(historicalThreadLabelScans)
          .where(eq(historicalThreadLabelScans.id, request.scan.id));
        assert.equal(complete?.status, "complete");
      });
    },
  );
}

test(
  "saving and enabling labels only admits Batch when historical application is explicitly selected",
  integrationOptions,
  async () => {
    await withContext(async (context) => {
      const { database, userId, accountId } = context;
      const label = await createInvookLabel(
        {
          userId,
          accountId,
          name: "Future label",
          description: "Match future mail",
        },
        database,
      );
      assert.ok(label);
      assert.equal(label.historicalAnalysis, null);
      assert.equal(
        (
          await database
            .select()
            .from(historicalThreadLabelScans)
            .where(eq(historicalThreadLabelScans.accountId, accountId))
        ).length,
        0,
      );
      await setInvookLabelEnabled(
        { userId, labelId: label.id, isEnabled: false },
        database,
      );
      await setInvookLabelEnabled(
        { userId, labelId: label.id, isEnabled: true, applyToPastDays: 7 },
        database,
      );
      const scans = await database
        .select()
        .from(historicalThreadLabelScans)
        .where(eq(historicalThreadLabelScans.accountId, accountId));
      assert.equal(scans.length, 1);
      await enqueueHistoricalThreadLabelBatchRecoveries(database);
      const steps = await database
        .select()
        .from(workflowSteps)
        .where(
          and(
            eq(workflowSteps.accountId, accountId),
            eq(workflowSteps.stepType, "label.batch.submit"),
          ),
        );
      assert.equal(steps.length, 1);
      const [step] = steps;
      assert.ok(step);
      assert.equal(await claim(context, step.id), null);
    });
  },
);

test(
  "historical pagination, truncated preparation, duplicate delivery and recovery do not widen the request",
  integrationOptions,
  async () => {
    await withContext(async (context) => {
      const { database, accountId, referenceAt } = context;
      const rows = await insertThreads(
        context,
        Array.from({ length: 2_003 }, () => ({
          sentAt: new Date(referenceAt.getTime() - 20 * DAY_MS),
        })),
      );
      const request = await createHistoricalRequest(context, 30);
      const batch = await claim(context, request.stepId);
      assert.ok(batch);
      assert.equal(batch.candidates.length, 2_000);
      const resumed = await claim(context, request.stepId);
      assert.equal(resumed?.submissionId, batch.submissionId);
      const retained = batch.candidates
        .slice(0, 10)
        .map(
          ({ thread: _thread, definitions: _definitions, ...checkpoint }) =>
            checkpoint,
        );
      await finalizeThreadLabelBatchPreparation(
        {
          submissionId: batch.submissionId,
          manifest: retained,
          excludedThreadIds: batch.candidates
            .slice(10)
            .map((entry) => entry.threadId),
        },
        database,
      );
      const completion = await finish(
        context,
        batch.submissionId,
        retained.map((entry) => ({
          threadId: entry.threadId,
          labelId: entry.fallbackLabelId,
          confidence: 85,
        })),
      );
      assert.ok(completion.continuationStepId);
      assert.equal(
        (await finish(context, batch.submissionId, [])).alreadyFinalized,
        true,
      );
      const next = await claim(context, completion.continuationStepId);
      assert.ok(next);
      assert.equal(next.candidates.length, 1_993);
      assert.equal(
        new Set(
          [...retained, ...next.candidates].map((entry) => entry.threadId),
        ).size,
        rows.length,
      );
      const finalization = await finish(
        context,
        next.submissionId,
        next.candidates.map((entry) => ({
          threadId: entry.threadId,
          labelId: entry.fallbackLabelId,
          confidence: 80,
        })),
      );
      assert.ok(finalization.continuationStepId);
      assert.equal(await claim(context, finalization.continuationStepId), null);
      const submissions = await database
        .select()
        .from(threadLabelBatchSubmissions)
        .where(eq(threadLabelBatchSubmissions.accountId, accountId));
      assert.equal(submissions.length, 2);
      assert.ok(
        submissions.every(
          (submission) => submission.historicalScanId === request.scan.id,
        ),
      );
    });
  },
);

test(
  "historical candidates exclude Spam, Trash, other accounts, and mail outside the captured range",
  integrationOptions,
  async () => {
    await withContext(async (context) => {
      const { referenceAt } = context;
      await insertThreads(context, [
        {
          sentAt: new Date(referenceAt.getTime() - DAY_MS),
          membershipIds: [context.inboxId, context.spamId],
        },
        {
          sentAt: new Date(referenceAt.getTime() - DAY_MS),
          membershipIds: [context.inboxId, context.trashId],
        },
        { sentAt: new Date(referenceAt.getTime() + DAY_MS) },
        { sentAt: new Date(referenceAt.getTime() - 100 * DAY_MS) },
      ]);
      const request = await createHistoricalRequest(context);
      await withContext(async (other) => {
        assert.equal(
          await claimThreadLabelBatchSubmission(
            {
              workflowStepId: request.stepId,
              historicalScanId: request.scan.id,
              userId: other.userId,
              accountId: other.accountId,
              modelId: "test",
              retryAttempt: 0,
            },
            other.database,
          ),
          null,
        );
      });
      assert.equal(await claim(context, request.stepId), null);
    });
  },
);

test(
  "historical results preserve newer content and manual assignments, and reject invented label IDs",
  integrationOptions,
  async () => {
    await withContext(async (context) => {
      const { database, userId, referenceAt } = context;
      const rows = await insertThreads(
        context,
        Array.from({ length: 3 }, () => ({
          sentAt: new Date(referenceAt.getTime() - 20 * DAY_MS),
        })),
      );
      const [changed, manual, invalid] = rows;
      assert.ok(changed && manual && invalid);
      const request = await createHistoricalRequest(context);
      const batch = await claim(context, request.stepId);
      assert.ok(batch);
      await database
        .update(threads)
        .set({ contentVersion: sql`${threads.contentVersion} + 1` })
        .where(eq(threads.id, changed.threadId));
      const manualLabel = await createInvookLabel(
        {
          userId,
          accountId: context.accountId,
          name: "Manual choice",
          description: "Keep this manual choice",
        },
        database,
      );
      assert.ok(manualLabel);
      await setUserThreadLabel(
        { userId, threadId: manual.threadId, labelId: manualLabel.id },
        database,
      );
      const completed = await finish(
        context,
        batch.submissionId,
        rows.map((row) => ({
          threadId: row.threadId,
          labelId: row === invalid ? uuidv4() : request.label.id,
          confidence: 90,
        })),
      );
      assert.equal(completed.appliedCount, 0);
      assert.ok(completed.continuationStepId);
      const retry = await claim(context, completed.continuationStepId);
      assert.deepEqual(
        retry?.candidates.map((entry) => entry.threadId),
        [invalid.threadId],
      );
      const [choice] = await database
        .select()
        .from(threadLabelAssignments)
        .where(eq(threadLabelAssignments.threadId, manual.threadId));
      assert.equal(choice?.labelId, manualLabel.id);
      assert.equal(choice?.source, "user");
    });
  },
);

for (const action of ["edit", "disable"] as const) {
  test(
    `a label ${action} supersedes outstanding historical Batch results`,
    integrationOptions,
    async () => {
      await withContext(async (context) => {
        await insertThreads(context, [
          { sentAt: new Date(context.referenceAt.getTime() - DAY_MS) },
        ]);
        const request = await createHistoricalRequest(context);
        const batch = await claim(context, request.stepId);
        assert.ok(batch);
        if (action === "edit")
          await updateInvookLabel(
            {
              userId: context.userId,
              labelId: request.label.id,
              name: "Changed",
              description: "Changed meaning",
            },
            context.database,
          );
        else
          await setInvookLabelEnabled(
            {
              userId: context.userId,
              labelId: request.label.id,
              isEnabled: false,
            },
            context.database,
          );
        assert.deepEqual(
          await finish(
            context,
            batch.submissionId,
            batch.candidates.map((entry) => ({
              threadId: entry.threadId,
              labelId: request.label.id,
              confidence: 95,
            })),
          ),
          {
            alreadyFinalized: false,
            appliedCount: 0,
            continuationStepId: null,
          },
        );
        const [scan] = await context.database
          .select()
          .from(historicalThreadLabelScans)
          .where(eq(historicalThreadLabelScans.id, request.scan.id));
        assert.equal(scan?.status, "superseded");
      });
    },
  );
}

test(
  "provider failures retry only the historical request and stop honestly after the retry limit",
  integrationOptions,
  async () => {
    await withContext(async (context) => {
      await insertThreads(context, [
        { sentAt: new Date(context.referenceAt.getTime() - DAY_MS) },
      ]);
      const request = await createHistoricalRequest(context);
      let stepId = request.stepId;
      for (let attempt = 0; attempt <= 6; attempt += 1) {
        const batch = await claim(context, stepId);
        assert.ok(batch);
        assert.equal(batch.candidates.length, 1);
        const failureRecordedAt = Date.now();
        const completion = await finish(context, batch.submissionId, [], {
          providerState: "expired",
          retryableFailure: true,
        });
        if (attempt < 6) {
          assert.ok(completion.continuationStepId);
          const [retryStep] = await context.database
            .select({ input: workflowSteps.input })
            .from(workflowSteps)
            .where(eq(workflowSteps.id, completion.continuationStepId));
          const runAt = retryStep?.input.runAt;
          assert.equal(typeof runAt, "string");
          if (typeof runAt !== "string") throw new Error("Retry time is missing.");
          const expectedDelay = 5 * 60 * 1_000 * 2 ** attempt;
          const actualDelay = new Date(runAt).getTime() - failureRecordedAt;
          assert.ok(actualDelay >= expectedDelay);
          assert.ok(actualDelay < expectedDelay + 10_000);
          stepId = completion.continuationStepId;
        } else assert.equal(completion.continuationStepId, null);
      }
      const [scan] = await context.database
        .select()
        .from(historicalThreadLabelScans)
        .where(eq(historicalThreadLabelScans.id, request.scan.id));
      assert.equal(scan?.status, "failed");
    });
  },
);

test(
  "preview validation and request admission commit or roll back together",
  integrationOptions,
  async () => {
    await withContext(async (context) => {
      const { database, userId, accountId } = context;
      const preview = await createLabelPreviewReceipt(
        {
          userId,
          accountId,
          name: "Previewed label",
          description: "Previewed meaning",
          results: [],
        },
        database,
      );
      await assert.rejects(
        createInvookLabel(
          {
            userId,
            accountId,
            name: "Changed label",
            description: "Previewed meaning",
            applyToPastDays: 7,
            previewReceiptId: preview.id,
          },
          database,
        ),
        LabelPreviewReceiptConflictError,
      );
      assert.equal(
        (
          await database
            .select()
            .from(historicalThreadLabelScans)
            .where(eq(historicalThreadLabelScans.accountId, accountId))
        ).length,
        0,
      );
      assert.equal(
        (
          await database
            .select()
            .from(labels)
            .where(
              and(
                eq(labels.accountId, accountId),
                eq(labels.name, "Changed label"),
              ),
            )
        ).length,
        0,
      );
      const label = await createInvookLabel(
        {
          userId,
          accountId,
          name: "Previewed label",
          description: "Previewed meaning",
          applyToPastDays: 7,
          previewReceiptId: preview.id,
        },
        database,
      );
      assert.ok(label);
      const [scan] = await database
        .select()
        .from(historicalThreadLabelScans)
        .where(eq(historicalThreadLabelScans.labelId, label.id));
      const [receipt] = await database
        .select()
        .from(labelPreviewReceipts)
        .where(eq(labelPreviewReceipts.id, preview.id));
      assert.equal(receipt?.consumedScanId, scan?.id);
      assert.equal(scan?.previewReceiptId, preview.id);
    });
  },
);

test(
  "a truncated retry retains every deferred thread without resetting retry attempts",
  integrationOptions,
  async () => {
    await withContext(async (context) => {
      const rows = await insertThreads(
        context,
        Array.from({ length: 5 }, () => ({
          sentAt: new Date(context.referenceAt.getTime() - 20 * DAY_MS),
        })),
      );
      const request = await createHistoricalRequest(context);
      const initial = await claim(context, request.stepId);
      assert.ok(initial);
      const initialFailure = await finish(context, initial.submissionId, []);
      assert.ok(initialFailure.continuationStepId);
      const retry = await claim(context, initialFailure.continuationStepId);
      assert.ok(retry);
      const retained = retry.candidates
        .slice(0, 2)
        .map(
          ({ thread: _thread, definitions: _definitions, ...entry }) => entry,
        );
      const excludedThreadIds = retry.candidates
        .slice(2)
        .map((entry) => entry.threadId);
      await assert.rejects(() =>
        finalizeThreadLabelBatchPreparation(
          {
            submissionId: retry.submissionId,
            manifest: retained,
            excludedThreadIds: [],
          },
          context.database,
        ),
      );
      await finalizeThreadLabelBatchPreparation(
        {
          submissionId: retry.submissionId,
          manifest: retained,
          excludedThreadIds,
        },
        context.database,
      );
      // A second failure retries only the retained portion before its deferred tail.
      const retryFailure = await finish(context, retry.submissionId, []);
      assert.ok(retryFailure.continuationStepId);
      const secondRetry = await claim(context, retryFailure.continuationStepId);
      assert.ok(secondRetry);
      assert.deepEqual(
        secondRetry.candidates.map((entry) => entry.threadId),
        retained.map((entry) => entry.threadId),
      );
      const success = await finish(
        context,
        secondRetry.submissionId,
        secondRetry.candidates.map((entry) => ({
          threadId: entry.threadId,
          labelId: request.label.id,
          confidence: 90,
        })),
      );
      assert.ok(success.continuationStepId);
      const tail = await claim(context, success.continuationStepId);
      assert.ok(tail);
      assert.deepEqual(
        tail.candidates.map((entry) => entry.threadId),
        excludedThreadIds,
      );
      const [tailSubmission] = await context.database
        .select()
        .from(threadLabelBatchSubmissions)
        .where(eq(threadLabelBatchSubmissions.id, tail.submissionId));
      assert.equal(tailSubmission?.retryAttempt, 1);
      const completion = await finish(
        context,
        tail.submissionId,
        tail.candidates.map((entry) => ({
          threadId: entry.threadId,
          labelId: request.label.id,
          confidence: 90,
        })),
      );
      assert.ok(completion.continuationStepId);
      assert.equal(await claim(context, completion.continuationStepId), null);
      const assignments = await context.database
        .select()
        .from(threadLabelAssignments)
        .where(eq(threadLabelAssignments.accountId, context.accountId));
      assert.equal(assignments.length, rows.length);
    });
  },
);

test(
  "disconnected accounts cannot admit or complete automatic label work",
  integrationOptions,
  async () => {
    await withContext(async (context) => {
      const [row] = await insertThreads(context, [
        { sentAt: context.referenceAt },
      ]);
      assert.ok(row);
      await context.database.transaction((transaction) =>
        enqueueLiveInboxThreadLabelAnalyses(
          { ...context, threadIds: [row.threadId] },
          transaction,
        ),
      );
      const [thread] = await context.database
        .select()
        .from(threads)
        .where(eq(threads.id, row.threadId));
      assert.ok(thread?.labelAnalysisDefinitionHash);
      const checkpoint = {
        threadId: row.threadId,
        analysisVersion: thread.labelAnalysisVersion,
        definitionHash: thread.labelAnalysisDefinitionHash,
      };
      await context.database
        .update(connectedAccounts)
        .set({ status: "disconnected" })
        .where(eq(connectedAccounts.id, context.accountId));
      assert.equal(
        (
          await beginThreadLabelAnalysis(
            { ...context, checkpoint },
            context.database,
          )
        ).status,
        "missing",
      );
      assert.equal(
        await context.database.transaction((transaction) =>
          enqueueLiveInboxThreadLabelAnalyses(
            { ...context, threadIds: [row.threadId] },
            transaction,
          ),
        ),
        0,
      );
      const [label] = await context.database
        .select()
        .from(labels)
        .where(
          and(
            eq(labels.accountId, context.accountId),
            eq(labels.kind, "invook"),
          ),
        );
      assert.ok(label);
      assert.equal(
        (
          await completeThreadLabelAnalysis(
            {
              ...context,
              checkpoint,
              labelId: label.id,
              modelId: "test-model",
              confidence: 90,
            },
            context.database,
          )
        ).status,
        "missing",
      );
    });
  },
);

test(
  "restoring a previous definition set creates fresh direct work instead of reusing a completed job",
  integrationOptions,
  async () => {
    await withContext(async (context) => {
      const { database, accountId, userId } = context;
      const [row] = await insertThreads(context, [
        { sentAt: context.referenceAt },
      ]);
      assert.ok(row);
      await database.transaction((transaction) =>
        enqueueLiveInboxThreadLabelAnalyses(
          { ...context, threadIds: [row.threadId] },
          transaction,
        ),
      );
      const [thread] = await database
        .select()
        .from(threads)
        .where(eq(threads.id, row.threadId));
      assert.ok(thread?.labelAnalysisDefinitionHash);
      const firstCheckpoint = {
        threadId: row.threadId,
        analysisVersion: thread.labelAnalysisVersion,
        definitionHash: thread.labelAnalysisDefinitionHash,
      };
      const [label] = await database
        .select()
        .from(labels)
        .where(
          and(eq(labels.accountId, accountId), eq(labels.systemKey, "billing")),
        );
      assert.ok(label);
      await setInvookLabelEnabled(
        { userId, labelId: label.id, isEnabled: false },
        database,
      );
      assert.equal(
        (
          await beginThreadLabelAnalysis(
            { ...context, checkpoint: firstCheckpoint },
            database,
          )
        ).status,
        "superseded",
      );
      const [disabled] = await database
        .select()
        .from(threads)
        .where(eq(threads.id, row.threadId));
      assert.ok(disabled?.labelAnalysisDefinitionHash);
      await setInvookLabelEnabled(
        { userId, labelId: label.id, isEnabled: true },
        database,
      );
      assert.equal(
        (
          await beginThreadLabelAnalysis(
            {
              ...context,
              checkpoint: {
                threadId: row.threadId,
                analysisVersion: disabled.labelAnalysisVersion,
                definitionHash: disabled.labelAnalysisDefinitionHash,
              },
            },
            database,
          )
        ).status,
        "superseded",
      );
      const [restored] = await database
        .select()
        .from(threads)
        .where(eq(threads.id, row.threadId));
      assert.ok(restored?.labelAnalysisDefinitionHash);
      assert.equal(
        restored.labelAnalysisDefinitionHash,
        firstCheckpoint.definitionHash,
      );
      assert.equal(
        restored.labelAnalysisVersion,
        firstCheckpoint.analysisVersion + 2,
      );
      assert.equal(
        (
          await beginThreadLabelAnalysis(
            {
              ...context,
              checkpoint: {
                threadId: row.threadId,
                analysisVersion: restored.labelAnalysisVersion,
                definitionHash: restored.labelAnalysisDefinitionHash,
              },
            },
            database,
          )
        ).status,
        "ready",
      );
      const jobs = await database
        .select()
        .from(workflowSteps)
        .where(eq(workflowSteps.accountId, accountId));
      assert.equal(jobs.length, 3);
      assert.ok(jobs.every((job) => job.stepType === "label.thread.assign"));
      assert.ok(jobs.every((job) => job.runId === null));
    });
  },
);

test(
  "retired automatic provider Batches only record cleanup metadata and never apply labels",
  integrationOptions,
  async () => {
    await withContext(async (context) => {
      const { database, userId, accountId } = context;
      const [row] = await insertThreads(context, [
        { sentAt: context.referenceAt },
      ]);
      assert.ok(row);
      const [label] = await database
        .select()
        .from(labels)
        .where(and(eq(labels.accountId, accountId), eq(labels.kind, "invook")));
      assert.ok(label);
      const stepId = uuidv4();
      const providerBatchId = `test-batch-${uuidv4()}`;
      await database.insert(workflowSteps).values({
        id: stepId,
        userId,
        accountId,
        stepType: "label.batch.submit",
        status: "complete",
        idempotencyKey: stepId,
      });
      const [submission] = await database
        .insert(threadLabelBatchSubmissions)
        .values({
          workflowStepId: stepId,
          userId,
          accountId,
          providerBatchId,
          inputFileId: "test-input",
          modelId: "test-model",
          definitionHash: "a".repeat(64),
          requestCount: 1,
          manifest: [
            {
              threadId: row.threadId,
              contentVersion: 1,
              assignmentVersion: null,
              fallbackLabelId: label.id,
            },
          ],
          status: "failed",
          lastError: "automatic_labeling_superseded",
        })
        .returning();
      assert.ok(submission);
      assert.ok(
        (await listSubmittedThreadLabelBatchIds(database)).includes(
          providerBatchId,
        ),
      );
      const result = await finalizeThreadLabelBatchSubmission(
        {
          submissionId: submission.id,
          providerState: "completed",
          providerErrorCode: null,
          retryableFailure: false,
          outputFileId: "test-output",
          errorFileId: null,
          modelId: "test-model",
          results: [
            { threadId: row.threadId, labelId: label.id, confidence: 95 },
          ],
          failedThreadIds: [],
        },
        database,
      );
      assert.equal(result.alreadyFinalized, true);
      assert.equal(result.appliedCount, 0);
      assert.equal(result.continuationStepId, null);
      assert.equal(
        (
          await database
            .select()
            .from(threadLabelAssignments)
            .where(eq(threadLabelAssignments.threadId, row.threadId))
        ).length,
        0,
      );
      const [completed] = await database
        .select()
        .from(threadLabelBatchSubmissions)
        .where(eq(threadLabelBatchSubmissions.id, submission.id));
      assert.equal(completed?.outputFileId, "test-output");
      assert.equal(completed?.status, "failed");
      assert.ok(
        !(await listSubmittedThreadLabelBatchIds(database)).includes(
          providerBatchId,
        ),
      );
    });
  },
);

test(
  "terminal submission failure closes only its saved settings request without creating automatic work",
  integrationOptions,
  async () => {
    await withContext(async (context) => {
      const { database, accountId } = context;
      const [row] = await insertThreads(context, [
        { sentAt: context.referenceAt },
      ]);
      assert.ok(row);
      const request = await createHistoricalRequest(context);
      const batch = await claim(context, request.stepId);
      assert.ok(batch);
      const [step] = await database
        .select()
        .from(workflowSteps)
        .where(eq(workflowSteps.id, request.stepId));
      assert.ok(step);
      assert.equal(
        await failWorkflowStep(
          {
            step: { ...step, payload: step.input },
            message: "label_analysis_model_unavailable",
            terminal: true,
          },
          database,
        ),
        true,
      );
      const [scan] = await database
        .select()
        .from(historicalThreadLabelScans)
        .where(eq(historicalThreadLabelScans.id, request.scan.id));
      const [submission] = await database
        .select()
        .from(threadLabelBatchSubmissions)
        .where(eq(threadLabelBatchSubmissions.id, batch.submissionId));
      const [thread] = await database
        .select()
        .from(threads)
        .where(eq(threads.id, row.threadId));
      assert.equal(scan?.status, "failed");
      assert.equal(submission?.status, "failed");
      assert.equal(thread?.labelAnalysisState, "not_requested");
      const steps = await database
        .select()
        .from(workflowSteps)
        .where(eq(workflowSteps.accountId, accountId));
      assert.equal(steps.length, 1);
      assert.equal(steps[0]?.status, "failed");
    });
  },
);
