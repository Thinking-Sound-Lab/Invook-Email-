import assert from "node:assert/strict";
import test from "node:test";

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { v4 as uuidv4 } from "uuid";

import type { LabelHistoryWindowDays } from "@invook/contracts";

import type { Database } from "./client";
import {
  createLabelPreviewReceipt,
  deleteExpiredLabelPreviewReceipts,
  LABEL_PREVIEW_RECEIPT_LIFETIME_MS,
  LabelPreviewReceiptConflictError,
} from "./label-preview-receipts";
import {
  beginHistoricalThreadLabelScan,
  completeHistoricalThreadLabelScan,
  ensureBuiltInInvookLabels,
  HISTORICAL_THREAD_LABEL_SCAN_PAGE_SIZE,
  scanHistoricalThreadLabelPage,
  setUserThreadLabel,
} from "./thread-label-analysis";
import {
  createInvookLabel,
  setInvookLabelEnabled,
  updateInvookLabel,
} from "./repositories";
import {
  connectedAccounts,
  labels,
  labelPreviewReceipts,
  messageLabels,
  messages,
  profiles,
  temporalCommands,
  threadLabelAssignments,
  threads,
  workflowSteps,
} from "./schema";
import * as schema from "./schema";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

type TestContext = {
  accountId: string;
  client: ReturnType<typeof postgres>;
  database: Database;
  gmailLabelIds: Record<"INBOX" | "SPAM" | "TRASH", string>;
  userId: string;
};

async function createTestContext(): Promise<TestContext> {
  if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL is required.");
  const client = postgres(testDatabaseUrl, { max: 5, prepare: false });
  const database = drizzle(client, { schema }) as Database;
  const userId = uuidv4();
  const accountId = uuidv4();
  await database.insert(profiles).values({
    id: userId,
    email: `${userId}@example.test`,
    displayName: "Historical label integration test",
  });
  await database.insert(connectedAccounts).values({
    id: accountId,
    userId,
    providerAccountId: `provider-${accountId}`,
    email: `${accountId}@example.test`,
    memoryAcknowledgedAt: new Date(),
  });
  await ensureBuiltInInvookLabels({ userId, accountId }, database);
  const gmailLabels = await database
    .insert(labels)
    .values(
      (["INBOX", "SPAM", "TRASH"] as const).map((providerLabelId) => ({
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
  const gmailLabelIds = Object.fromEntries(
    gmailLabels.map((label) => [label.providerLabelId, label.id]),
  ) as TestContext["gmailLabelIds"];
  return { accountId, client, database, gmailLabelIds, userId };
}

async function destroyTestContext(context: TestContext): Promise<void> {
  await context.database
    .delete(profiles)
    .where(eq(profiles.id, context.userId));
  await context.client.end();
}

async function insertCustomLabel(
  context: Pick<TestContext, "accountId" | "database" | "userId">,
  name: string,
): Promise<{
  id: string;
  definitionVersion: number;
  enablementVersion: number;
}> {
  const [label] = await context.database
    .insert(labels)
    .values({
      userId: context.userId,
      accountId: context.accountId,
      kind: "invook",
      name,
      normalizedName: name.toLowerCase(),
      description: `${name} messages`,
    })
    .returning({
      id: labels.id,
      definitionVersion: labels.definitionVersion,
      enablementVersion: labels.enablementVersion,
    });
  assert.ok(label);
  return label;
}

async function insertThreadMessage(
  context: TestContext,
  input: { sentAt: Date; gmailLabelIds: string[] },
): Promise<{ threadId: string; messageId: string }> {
  const threadId = uuidv4();
  const messageId = uuidv4();
  await context.database.insert(threads).values({
    id: threadId,
    userId: context.userId,
    accountId: context.accountId,
    providerThreadId: `provider-thread-${threadId}`,
    subject: `Subject ${threadId}`,
    snippet: "Stored message",
    participants: ["sender@example.test"],
    latestMessageAt: input.sentAt,
    messageCount: 1,
  });
  await context.database.insert(messages).values({
    id: messageId,
    userId: context.userId,
    accountId: context.accountId,
    threadId,
    providerMessageId: `provider-message-${messageId}`,
    direction: "incoming",
    sender: {
      raw: "Sender <sender@example.test>",
      email: "sender@example.test",
    },
    recipients: [`${context.accountId}@example.test`],
    internalDate: input.sentAt,
    headerLines: [],
    subject: `Subject ${threadId}`,
    snippet: "Stored message",
    bodyText: "Stored message body",
    sentAt: input.sentAt,
  });
  if (input.gmailLabelIds.length > 0) {
    await context.database.insert(messageLabels).values(
      input.gmailLabelIds.map((labelId) => ({
        userId: context.userId,
        accountId: context.accountId,
        messageId,
        labelId,
        source: "gmail" as const,
      })),
    );
  }
  return { threadId, messageId };
}

function coordinatorCheckpoint(
  label: {
    id: string;
    definitionVersion: number;
    enablementVersion: number;
  },
  after: Date,
  cursorThreadId: string | null = null,
) {
  return {
    historicalScanId: uuidv4(),
    previewReceiptId: null,
    labelId: label.id,
    definitionVersion: label.definitionVersion,
    enablementVersion: label.enablementVersion,
    after,
    cursorThreadId,
  };
}

test(
  "label creation atomically admits one coordinator for every supported history window",
  { skip: !testDatabaseUrl },
  async () => {
    const context = await createTestContext();
    try {
      for (const windowDays of [7, 30, 90] as LabelHistoryWindowDays[]) {
        const before = Date.now();
        const created = await createInvookLabel(
          {
            userId: context.userId,
            accountId: context.accountId,
            name: `Window ${windowDays}`,
            description: `Messages from the last ${windowDays} days`,
            applyToPastDays: windowDays,
          },
          context.database,
        );
        const after = Date.now();
        assert.ok(created);
        assert.deepEqual(created.historicalAnalysis, {
          windowDays,
          status: "queued",
        });
        const coordinatorSteps = await context.database
          .select({
            input: workflowSteps.input,
            lane: temporalCommands.activityTaskLane,
          })
          .from(workflowSteps)
          .innerJoin(
            temporalCommands,
            eq(temporalCommands.workflowStepId, workflowSteps.id),
          )
          .where(
            and(
              eq(workflowSteps.accountId, context.accountId),
              eq(workflowSteps.stepType, "label.historical.scan"),
            ),
          );
        const step = coordinatorSteps.find(
          (candidate) => candidate.input.labelId === created.id,
        );
        assert.ok(step);
        assert.equal(step.lane, "bulk");
        assert.equal(step.input.cursorThreadId, null);
        const cutoff = Date.parse(String(step.input.after));
        const windowMilliseconds = windowDays * 24 * 60 * 60 * 1_000;
        assert.ok(cutoff >= before - windowMilliseconds);
        assert.ok(cutoff <= after - windowMilliseconds);
      }
      assert.equal(
        await context.database
          .select({ id: workflowSteps.id })
          .from(workflowSteps)
          .where(
            and(
              eq(workflowSteps.accountId, context.accountId),
              eq(workflowSteps.stepType, "label.thread.scan"),
            ),
          )
          .then((rows) => rows.length),
        0,
      );

      const rollbackName = "Rollback label";
      await assert.rejects(
        context.database.transaction(async (transaction) => {
          await createInvookLabel(
            {
              userId: context.userId,
              accountId: context.accountId,
              name: rollbackName,
              description: "This transaction must roll back",
              applyToPastDays: 7,
            },
            transaction,
          );
          throw new Error("rollback-only");
        }),
        /rollback-only/,
      );
      assert.equal(
        await context.database
          .select({ id: labels.id })
          .from(labels)
          .where(
            and(
              eq(labels.accountId, context.accountId),
              eq(labels.normalizedName, rollbackName.toLowerCase()),
            ),
          )
          .then((rows) => rows.length),
        0,
      );
      assert.equal(
        await context.database
          .select({ id: workflowSteps.id })
          .from(workflowSteps)
          .where(
            and(
              eq(workflowSteps.accountId, context.accountId),
              eq(workflowSteps.stepType, "label.historical.scan"),
            ),
          )
          .then((rows) => rows.length),
        3,
      );
    } finally {
      await destroyTestContext(context);
    }
  },
);

test(
  "label creation atomically consumes a preview receipt and historical work reads it",
  { skip: !testDatabaseUrl },
  async () => {
    const context = await createTestContext();
    try {
      const thread = await insertThreadMessage(context, {
        sentAt: new Date(),
        gmailLabelIds: [context.gmailLabelIds.INBOX],
      });
      const previewResult = {
        threadId: thread.threadId,
        classifierInputHash: "a".repeat(64),
        matched: true,
        confidence: 96,
        modelId: "preview-model",
      };
      const receipt = await createLabelPreviewReceipt(
        {
          userId: context.userId,
          accountId: context.accountId,
          name: "Preview receipts",
          description: "Invoices and purchase receipts",
          results: [previewResult],
        },
        context.database,
      );
      const created = await createInvookLabel(
        {
          userId: context.userId,
          accountId: context.accountId,
          name: "Preview receipts",
          description: "Invoices and purchase receipts",
          applyToPastDays: 7,
          previewReceiptId: receipt.id,
        },
        context.database,
      );
      assert.ok(created);

      const [storedReceipt] = await context.database
        .select({ consumedScanId: labelPreviewReceipts.consumedScanId })
        .from(labelPreviewReceipts)
        .where(eq(labelPreviewReceipts.id, receipt.id));
      assert.ok(storedReceipt?.consumedScanId);
      const [coordinator] = await context.database
        .select({ input: workflowSteps.input })
        .from(workflowSteps)
        .where(
          and(
            eq(workflowSteps.stepType, "label.historical.scan"),
            eq(workflowSteps.accountId, context.accountId),
          ),
        );
      assert.ok(coordinator);
      assert.equal(
        coordinator.input.historicalScanId,
        storedReceipt.consumedScanId,
      );
      assert.equal(coordinator.input.previewReceiptId, receipt.id);

      await scanHistoricalThreadLabelPage(
        {
          userId: context.userId,
          accountId: context.accountId,
          checkpoint: {
            historicalScanId: storedReceipt.consumedScanId,
            previewReceiptId: receipt.id,
            labelId: created.id,
            definitionVersion: created.definitionVersion,
            enablementVersion: 1,
            after: new Date(String(coordinator.input.after)),
            cursorThreadId: null,
          },
        },
        context.database,
      );
      const [threadStep] = await context.database
        .select({ input: workflowSteps.input })
        .from(workflowSteps)
        .where(
          and(
            eq(workflowSteps.stepType, "label.thread.scan"),
            eq(workflowSteps.accountId, context.accountId),
          ),
        );
      assert.ok(threadStep);
      const analysis = await beginHistoricalThreadLabelScan(
        {
          userId: context.userId,
          accountId: context.accountId,
          checkpoint: {
            historicalScanId: storedReceipt.consumedScanId,
            previewReceiptId: receipt.id,
            threadId: String(threadStep.input.threadId),
            labelId: created.id,
            definitionVersion: created.definitionVersion,
            enablementVersion: 1,
            assignmentVersion: null,
          },
        },
        context.database,
      );
      assert.equal(analysis.status, "ready");
      if (analysis.status === "ready") {
        assert.deepEqual(analysis.previewResult, {
          classifierInputHash: previewResult.classifierInputHash,
          matched: previewResult.matched,
          confidence: previewResult.confidence,
          modelId: previewResult.modelId,
        });
      }
      assert.equal(
        await deleteExpiredLabelPreviewReceipts(context.database),
        0,
      );
      await context.database
        .update(workflowSteps)
        .set({ status: "complete", completedAt: new Date() })
        .where(eq(workflowSteps.accountId, context.accountId));
      assert.equal(
        await deleteExpiredLabelPreviewReceipts(context.database),
        1,
      );
    } finally {
      await destroyTestContext(context);
    }
  },
);

test(
  "a stale preview receipt rolls back label and coordinator admission",
  { skip: !testDatabaseUrl },
  async () => {
    const context = await createTestContext();
    try {
      const receipt = await createLabelPreviewReceipt(
        {
          userId: context.userId,
          accountId: context.accountId,
          name: "Expired preview",
          description: "Must be previewed again",
          results: [],
          createdAt: new Date(
            Date.now() - LABEL_PREVIEW_RECEIPT_LIFETIME_MS - 1,
          ),
        },
        context.database,
      );
      await assert.rejects(
        createInvookLabel(
          {
            userId: context.userId,
            accountId: context.accountId,
            name: "Expired preview",
            description: "Must be previewed again",
            applyToPastDays: 90,
            previewReceiptId: receipt.id,
          },
          context.database,
        ),
        LabelPreviewReceiptConflictError,
      );
      assert.equal(
        await context.database
          .select({ id: labels.id })
          .from(labels)
          .where(
            and(
              eq(labels.accountId, context.accountId),
              eq(labels.normalizedName, "expired preview"),
            ),
          )
          .then((rows) => rows.length),
        0,
      );
      assert.equal(
        await context.database
          .select({ id: workflowSteps.id })
          .from(workflowSteps)
          .where(
            and(
              eq(workflowSteps.accountId, context.accountId),
              eq(workflowSteps.stepType, "label.historical.scan"),
            ),
          )
          .then((rows) => rows.length),
        0,
      );
    } finally {
      await destroyTestContext(context);
    }
  },
);

test(
  "typed Date cutoffs admit only recent Inbox messages and exclude Spam and Trash",
  { skip: !testDatabaseUrl },
  async () => {
    const context = await createTestContext();
    try {
      const label = await insertCustomLabel(context, "Security");
      const cutoff = new Date("2026-08-01T00:00:00.000Z");
      const recentInbox = await insertThreadMessage(context, {
        sentAt: new Date(cutoff.getTime() + 1),
        gmailLabelIds: [context.gmailLabelIds.INBOX],
      });
      await insertThreadMessage(context, {
        sentAt: new Date(cutoff.getTime() - 1),
        gmailLabelIds: [context.gmailLabelIds.INBOX],
      });
      for (const gmailLabelIds of [
        [context.gmailLabelIds.SPAM],
        [context.gmailLabelIds.TRASH],
        [context.gmailLabelIds.INBOX, context.gmailLabelIds.SPAM],
        [context.gmailLabelIds.INBOX, context.gmailLabelIds.TRASH],
      ]) {
        await insertThreadMessage(context, {
          sentAt: new Date(cutoff.getTime() + 1),
          gmailLabelIds,
        });
      }

      const result = await scanHistoricalThreadLabelPage(
        {
          userId: context.userId,
          accountId: context.accountId,
          checkpoint: coordinatorCheckpoint(label, cutoff),
        },
        context.database,
      );
      assert.deepEqual(result, {
        status: "complete",
        queuedThreadCount: 1,
        continuationStepId: null,
        cursorThreadId: recentInbox.threadId,
      });
      const threadScanSteps = await context.database
        .select({ input: workflowSteps.input })
        .from(workflowSteps)
        .where(
          and(
            eq(workflowSteps.accountId, context.accountId),
            eq(workflowSteps.stepType, "label.thread.scan"),
          ),
        );
      assert.deepEqual(
        threadScanSteps.map((step) => step.input.threadId),
        [recentInbox.threadId],
      );

      assert.deepEqual(
        await scanHistoricalThreadLabelPage(
          {
            userId: context.userId,
            accountId: context.accountId,
            checkpoint: coordinatorCheckpoint(
              label,
              new Date("2026-09-01T00:00:00.000Z"),
            ),
          },
          context.database,
        ),
        {
          status: "complete",
          queuedThreadCount: 0,
          continuationStepId: null,
          cursorThreadId: null,
        },
      );
    } finally {
      await destroyTestContext(context);
    }
  },
);

test(
  "pagination, duplicate delivery, and worker restart preserve durable cursor progress",
  { skip: !testDatabaseUrl },
  async () => {
    const context = await createTestContext();
    const label = await insertCustomLabel(context, "Receipts");
    const cutoff = new Date("2026-07-01T00:00:00.000Z");
    try {
      for (
        let index = 0;
        index < HISTORICAL_THREAD_LABEL_SCAN_PAGE_SIZE + 1;
        index += 1
      ) {
        await insertThreadMessage(context, {
          sentAt: new Date(cutoff.getTime() + index + 1),
          gmailLabelIds: [context.gmailLabelIds.INBOX],
        });
      }
      const checkpoint = coordinatorCheckpoint(label, cutoff);
      const firstPage = await scanHistoricalThreadLabelPage(
        { userId: context.userId, accountId: context.accountId, checkpoint },
        context.database,
      );
      assert.equal(firstPage.status, "continued");
      assert.equal(
        firstPage.queuedThreadCount,
        HISTORICAL_THREAD_LABEL_SCAN_PAGE_SIZE,
      );
      assert.ok(firstPage.continuationStepId);
      assert.ok(firstPage.cursorThreadId);

      assert.deepEqual(
        await scanHistoricalThreadLabelPage(
          { userId: context.userId, accountId: context.accountId, checkpoint },
          context.database,
        ),
        { ...firstPage, queuedThreadCount: 0 },
      );
      assert.equal(
        await context.database
          .select({ id: workflowSteps.id })
          .from(workflowSteps)
          .where(
            and(
              eq(workflowSteps.accountId, context.accountId),
              eq(workflowSteps.stepType, "label.thread.scan"),
            ),
          )
          .then((rows) => rows.length),
        HISTORICAL_THREAD_LABEL_SCAN_PAGE_SIZE,
      );

      const [continuation] = await context.database
        .select({ input: workflowSteps.input })
        .from(workflowSteps)
        .where(eq(workflowSteps.id, firstPage.continuationStepId!));
      assert.ok(continuation);
      await context.client.end();

      const restartedClient = postgres(testDatabaseUrl!, {
        max: 5,
        prepare: false,
      });
      const restartedDatabase = drizzle(restartedClient, {
        schema,
      }) as Database;
      context.client = restartedClient;
      context.database = restartedDatabase;
      const resumedCheckpoint = {
        historicalScanId: String(continuation.input.historicalScanId),
        previewReceiptId:
          continuation.input.previewReceiptId === null
            ? null
            : String(continuation.input.previewReceiptId),
        labelId: String(continuation.input.labelId),
        definitionVersion: Number(continuation.input.definitionVersion),
        enablementVersion: Number(continuation.input.enablementVersion),
        after: new Date(String(continuation.input.after)),
        cursorThreadId: String(continuation.input.cursorThreadId),
      };
      const resumed = await scanHistoricalThreadLabelPage(
        {
          userId: context.userId,
          accountId: context.accountId,
          checkpoint: resumedCheckpoint,
        },
        restartedDatabase,
      );
      assert.equal(resumed.status, "complete");
      assert.equal(resumed.queuedThreadCount, 1);
      assert.equal(
        (
          await scanHistoricalThreadLabelPage(
            {
              userId: context.userId,
              accountId: context.accountId,
              checkpoint: resumedCheckpoint,
            },
            restartedDatabase,
          )
        ).queuedThreadCount,
        0,
      );
      assert.equal(
        await restartedDatabase
          .select({ id: workflowSteps.id })
          .from(workflowSteps)
          .where(
            and(
              eq(workflowSteps.accountId, context.accountId),
              eq(workflowSteps.stepType, "label.thread.scan"),
            ),
          )
          .then((rows) => rows.length),
        HISTORICAL_THREAD_LABEL_SCAN_PAGE_SIZE + 1,
      );
      assert.equal(
        await restartedDatabase
          .select({ id: temporalCommands.id })
          .from(temporalCommands)
          .innerJoin(
            workflowSteps,
            eq(workflowSteps.id, temporalCommands.workflowStepId),
          )
          .where(
            and(
              eq(workflowSteps.accountId, context.accountId),
              eq(workflowSteps.stepType, "label.historical.scan"),
            ),
          )
          .then((rows) => rows.length),
        1,
      );
    } finally {
      await destroyTestContext(context);
    }
  },
);

test(
  "definition, enablement, assignment, and duplicate completion versions supersede stale work",
  { skip: !testDatabaseUrl },
  async () => {
    const context = await createTestContext();
    try {
      const label = await insertCustomLabel(context, "Projects");
      const important = await context.database
        .select({ id: labels.id })
        .from(labels)
        .where(
          and(
            eq(labels.accountId, context.accountId),
            eq(labels.systemKey, "important"),
          ),
        )
        .then((rows) => rows[0]);
      assert.ok(important);
      const thread = await insertThreadMessage(context, {
        sentAt: new Date("2026-08-10T00:00:00.000Z"),
        gmailLabelIds: [context.gmailLabelIds.INBOX],
      });
      const checkpoint = coordinatorCheckpoint(
        label,
        new Date("2026-08-01T00:00:00.000Z"),
      );
      await scanHistoricalThreadLabelPage(
        { userId: context.userId, accountId: context.accountId, checkpoint },
        context.database,
      );
      const [threadStep] = await context.database
        .select({ input: workflowSteps.input })
        .from(workflowSteps)
        .where(
          and(
            eq(workflowSteps.accountId, context.accountId),
            eq(workflowSteps.stepType, "label.thread.scan"),
          ),
        );
      assert.ok(threadStep);
      const threadCheckpoint = {
        historicalScanId: String(threadStep.input.historicalScanId),
        previewReceiptId:
          threadStep.input.previewReceiptId === null
            ? null
            : String(threadStep.input.previewReceiptId),
        threadId: String(threadStep.input.threadId),
        labelId: String(threadStep.input.labelId),
        definitionVersion: Number(threadStep.input.definitionVersion),
        enablementVersion: Number(threadStep.input.enablementVersion),
        assignmentVersion: null,
      };
      assert.equal(
        (
          await beginHistoricalThreadLabelScan(
            {
              userId: context.userId,
              accountId: context.accountId,
              checkpoint: threadCheckpoint,
            },
            context.database,
          )
        ).status,
        "ready",
      );
      assert.deepEqual(
        await completeHistoricalThreadLabelScan(
          {
            userId: context.userId,
            accountId: context.accountId,
            checkpoint: threadCheckpoint,
            modelId: "integration-test",
            matched: true,
            confidence: 95,
          },
          context.database,
        ),
        { status: "complete" },
      );
      assert.deepEqual(
        await completeHistoricalThreadLabelScan(
          {
            userId: context.userId,
            accountId: context.accountId,
            checkpoint: threadCheckpoint,
            modelId: "integration-test",
            matched: true,
            confidence: 95,
          },
          context.database,
        ),
        { status: "superseded" },
      );

      await setUserThreadLabel(
        {
          userId: context.userId,
          threadId: thread.threadId,
          labelId: important.id,
        },
        context.database,
      );
      assert.equal(
        (
          await beginHistoricalThreadLabelScan(
            {
              userId: context.userId,
              accountId: context.accountId,
              checkpoint: threadCheckpoint,
            },
            context.database,
          )
        ).status,
        "superseded",
      );
      await updateInvookLabel(
        {
          userId: context.userId,
          labelId: label.id,
          name: "Projects",
          description: "Edited projects definition",
        },
        context.database,
      );
      assert.equal(
        (
          await scanHistoricalThreadLabelPage(
            {
              userId: context.userId,
              accountId: context.accountId,
              checkpoint,
            },
            context.database,
          )
        ).status,
        "superseded",
      );
      await setInvookLabelEnabled(
        { userId: context.userId, labelId: label.id, isEnabled: false },
        context.database,
      );
      assert.equal(
        (
          await scanHistoricalThreadLabelPage(
            {
              userId: context.userId,
              accountId: context.accountId,
              checkpoint: { ...checkpoint, definitionVersion: 2 },
            },
            context.database,
          )
        ).status,
        "superseded",
      );
      assert.equal(
        await context.database
          .select({
            assignmentVersion: threadLabelAssignments.assignmentVersion,
          })
          .from(threadLabelAssignments)
          .where(eq(threadLabelAssignments.threadId, thread.threadId))
          .then((rows) => rows[0]?.assignmentVersion),
        2,
      );
    } finally {
      await destroyTestContext(context);
    }
  },
);
