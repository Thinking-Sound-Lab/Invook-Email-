import { createHash } from "node:crypto";

import { and, asc, eq, gt, inArray, lte, sql } from "drizzle-orm";

import { getDatabase, type Database, type DatabaseExecutor } from "./client";
import { insertMailboxChange } from "./mailbox-change-events";
import {
  connectedAccounts,
  historicalThreadLabelScans,
  labels,
  threadLabelAssignments,
  threadLabelBatchSubmissions,
  threads,
  workflowSteps,
} from "./schema";
import {
  listInboxThreadMessages,
  type ThreadLabelDefinition,
} from "./thread-label-analysis";
import { recentInboxThreadCondition } from "./thread-label-eligibility";
import { enqueueWorkflowStepWithExecutor } from "./workflows";

const REQUEST_LIMIT = 2_000;
const RETRY_LIMIT = 6;

export type ThreadLabelBatchManifestEntry =
  (typeof threadLabelBatchSubmissions.$inferSelect.manifest)[number];
type HistoricalScan = typeof historicalThreadLabelScans.$inferSelect;
type Submission = typeof threadLabelBatchSubmissions.$inferSelect;
export type ThreadLabelBatchContinuation = Submission["continuations"][number];

export type ThreadLabelBatchCandidate = ThreadLabelBatchManifestEntry & {
  thread: {
    subject: string;
    messages: Array<{
      subject: string;
      sender: string;
      recipients: string[];
      bodyText: string;
      sentAt: string;
    }>;
  };
  definitions: ThreadLabelDefinition[];
};

function noMatchLabelId(labelId: string): string {
  return `no-match:${labelId}`;
}

async function enqueueHistoricalBatch(
  input: {
    scan: Pick<HistoricalScan, "id" | "userId" | "accountId">;
    sourceKey: string;
    retryAttempt?: number;
    threadIds?: string[];
    continuations?: ThreadLabelBatchContinuation[];
    runAt?: Date;
  },
  database: DatabaseExecutor,
): Promise<string> {
  return enqueueWorkflowStepWithExecutor(
    {
      userId: input.scan.userId,
      accountId: input.scan.accountId,
      stepType: "label.batch.submit",
      payload: {
        historicalScanId: input.scan.id,
        retryAttempt: input.retryAttempt ?? 0,
        ...(input.threadIds ? { threadIds: input.threadIds } : {}),
        ...(input.continuations?.length
          ? { continuations: input.continuations }
          : {}),
        ...(input.runAt ? { runAt: input.runAt.toISOString() } : {}),
      },
      idempotencyKey: `label.batch.submit:${input.scan.id}:${input.sourceKey}`,
    },
    database,
  );
}

export async function createHistoricalThreadLabelScan(
  input: {
    historicalScanId: string;
    userId: string;
    accountId: string;
    labelId: string;
    definitionVersion: number;
    enablementVersion: number;
    after: Date;
    before: Date;
    previewReceiptId: string | null;
  },
  database: DatabaseExecutor,
): Promise<string> {
  const [scan] = await database
    .insert(historicalThreadLabelScans)
    .values({
      id: input.historicalScanId,
      userId: input.userId,
      accountId: input.accountId,
      labelId: input.labelId,
      definitionVersion: input.definitionVersion,
      enablementVersion: input.enablementVersion,
      after: input.after,
      before: input.before,
      previewReceiptId: input.previewReceiptId,
    })
    .returning();
  if (!scan)
    throw new Error("The historical label request could not be saved.");
  return enqueueHistoricalBatch({ scan, sourceKey: "start" }, database);
}

async function getCurrentHistoricalScan(
  input: { historicalScanId: string; userId: string; accountId: string },
  database: DatabaseExecutor,
): Promise<{ scan: HistoricalScan; definition: ThreadLabelDefinition } | null> {
  const [row] = await database
    .select({
      scan: historicalThreadLabelScans,
      definition: {
        id: labels.id,
        name: labels.name,
        description: labels.description,
        definitionVersion: labels.definitionVersion,
        enablementVersion: labels.enablementVersion,
        isEnabled: labels.isEnabled,
        systemKey: labels.systemKey,
      },
    })
    .from(historicalThreadLabelScans)
    .innerJoin(
      labels,
      and(
        eq(labels.id, historicalThreadLabelScans.labelId),
        eq(labels.userId, historicalThreadLabelScans.userId),
        eq(labels.accountId, historicalThreadLabelScans.accountId),
        eq(labels.kind, "invook"),
      ),
    )
    .innerJoin(
      connectedAccounts,
      and(
        eq(connectedAccounts.id, historicalThreadLabelScans.accountId),
        eq(connectedAccounts.userId, historicalThreadLabelScans.userId),
        eq(connectedAccounts.status, "connected"),
      ),
    )
    .where(
      and(
        eq(historicalThreadLabelScans.id, input.historicalScanId),
        eq(historicalThreadLabelScans.userId, input.userId),
        eq(historicalThreadLabelScans.accountId, input.accountId),
      ),
    )
    .for("update", { of: [historicalThreadLabelScans, labels] })
    .limit(1);
  if (!row || !["queued", "running"].includes(row.scan.status)) return null;
  if (
    !row.definition.isEnabled ||
    row.definition.systemKey === "others" ||
    row.definition.definitionVersion !== row.scan.definitionVersion ||
    row.definition.enablementVersion !== row.scan.enablementVersion
  ) {
    await database
      .update(historicalThreadLabelScans)
      .set({
        status: "superseded",
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(historicalThreadLabelScans.id, row.scan.id));
    return null;
  }
  return row;
}

async function hydrateCandidates(
  input: {
    scan: HistoricalScan;
    definition: ThreadLabelDefinition;
    manifest: ThreadLabelBatchManifestEntry[];
  },
  database: DatabaseExecutor,
): Promise<ThreadLabelBatchCandidate[]> {
  const candidates: ThreadLabelBatchCandidate[] = [];
  for (const checkpoint of input.manifest) {
    const [thread] = await database
      .select({
        id: threads.id,
        subject: threads.subject,
        contentVersion: threads.contentVersion,
        assignmentVersion: threadLabelAssignments.assignmentVersion,
      })
      .from(threads)
      .leftJoin(
        threadLabelAssignments,
        eq(threadLabelAssignments.threadId, threads.id),
      )
      .where(
        and(
          eq(threads.id, checkpoint.threadId),
          eq(threads.userId, input.scan.userId),
          eq(threads.accountId, input.scan.accountId),
          recentInboxThreadCondition(input.scan.after, input.scan.before),
        ),
      )
      .for("update", { of: threads })
      .limit(1);
    if (
      !thread ||
      thread.contentVersion !== checkpoint.contentVersion ||
      thread.assignmentVersion !== checkpoint.assignmentVersion
    )
      continue;
    const inboxMessages = await listInboxThreadMessages(thread.id, database);
    if (inboxMessages.length === 0) continue;
    candidates.push({
      ...checkpoint,
      definitions: [input.definition],
      thread: {
        subject: thread.subject,
        messages: inboxMessages.map((message) => ({
          subject: message.subject,
          sender: message.sender.raw,
          recipients: message.recipients,
          bodyText: message.bodyText,
          sentAt: message.sentAt.toISOString(),
        })),
      },
    });
  }
  return candidates;
}

export async function getThreadLabelBatchSubmissionForStep(
  workflowStepId: string,
  database: Database = getDatabase(),
): Promise<Submission | null> {
  const [submission] = await database
    .select()
    .from(threadLabelBatchSubmissions)
    .where(eq(threadLabelBatchSubmissions.workflowStepId, workflowStepId))
    .limit(1);
  return submission ?? null;
}

export async function claimThreadLabelBatchSubmission(
  input: {
    workflowStepId: string;
    historicalScanId: string;
    userId: string;
    accountId: string;
    modelId: string;
    retryAttempt: number;
    threadIds?: string[];
    continuations?: ThreadLabelBatchContinuation[];
  },
  database: Database = getDatabase(),
): Promise<{
  submissionId: string;
  candidates: ThreadLabelBatchCandidate[];
} | null> {
  return database.transaction(async (transaction) => {
    const current = await getCurrentHistoricalScan(input, transaction);
    if (!current) return null;
    const { scan, definition } = current;
    const [step] = await transaction
      .select({ id: workflowSteps.id })
      .from(workflowSteps)
      .where(
        and(
          eq(workflowSteps.id, input.workflowStepId),
          eq(workflowSteps.userId, input.userId),
          eq(workflowSteps.accountId, input.accountId),
          eq(workflowSteps.stepType, "label.batch.submit"),
          sql`${workflowSteps.input}->>'historicalScanId' = ${scan.id}`,
        ),
      )
      .limit(1);
    if (!step)
      throw new Error(
        "The Batch step does not belong to this historical request.",
      );
    const [existing] = await transaction
      .select()
      .from(threadLabelBatchSubmissions)
      .where(
        eq(threadLabelBatchSubmissions.workflowStepId, input.workflowStepId),
      )
      .limit(1);
    if (existing) {
      if (
        existing.historicalScanId !== scan.id ||
        existing.status !== "preparing"
      )
        return null;
      return {
        submissionId: existing.id,
        candidates: await hydrateCandidates(
          { ...current, manifest: existing.manifest },
          transaction,
        ),
      };
    }
    const [active] = await transaction
      .select({ id: threadLabelBatchSubmissions.id })
      .from(threadLabelBatchSubmissions)
      .where(
        and(
          eq(threadLabelBatchSubmissions.historicalScanId, scan.id),
          inArray(threadLabelBatchSubmissions.status, [
            "preparing",
            "submitted",
          ]),
        ),
      )
      .limit(1);
    if (active) return null;
    const rows = await transaction
      .select({
        threadId: threads.id,
        contentVersion: threads.contentVersion,
        assignmentVersion: threadLabelAssignments.assignmentVersion,
      })
      .from(threads)
      .leftJoin(
        threadLabelAssignments,
        eq(threadLabelAssignments.threadId, threads.id),
      )
      .where(
        and(
          eq(threads.userId, scan.userId),
          eq(threads.accountId, scan.accountId),
          lte(threads.createdAt, scan.before),
          recentInboxThreadCondition(scan.after, scan.before),
          // A user decision made after the request was admitted always wins,
          // including when it precedes a later page's candidate selection.
          sql`(${threadLabelAssignments.source} is distinct from 'user' or ${threadLabelAssignments.assignedAt} < ${scan.before.toISOString()}::timestamptz)`,
          input.threadIds
            ? inArray(threads.id, input.threadIds)
            : scan.cursorThreadId
              ? gt(threads.id, scan.cursorThreadId)
              : undefined,
        ),
      )
      .orderBy(asc(threads.id))
      .limit(REQUEST_LIMIT)
      .for("update", { of: threads });
    if (rows.length === 0) {
      if (input.threadIds) {
        const [next, ...remaining] = input.continuations ?? [];
        await enqueueHistoricalBatch(
          {
            scan,
            sourceKey: `continue:${input.workflowStepId}`,
            ...next,
            continuations: remaining,
          },
          transaction,
        );
      } else {
        await transaction
          .update(historicalThreadLabelScans)
          .set({
            status: "complete",
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(historicalThreadLabelScans.id, scan.id));
      }
      return null;
    }
    const manifest = rows.slice(0, REQUEST_LIMIT).map((row) => ({
      ...row,
      fallbackLabelId: noMatchLabelId(scan.labelId),
    }));
    const [submission] = await transaction
      .insert(threadLabelBatchSubmissions)
      .values({
        workflowStepId: input.workflowStepId,
        historicalScanId: scan.id,
        userId: scan.userId,
        accountId: scan.accountId,
        modelId: input.modelId,
        definitionHash: createHash("sha256")
          .update(JSON.stringify(definition))
          .digest("hex"),
        retryAttempt: input.retryAttempt,
        continuations: input.continuations ?? [],
        requestCount: manifest.length,
        manifest,
      })
      .returning({ id: threadLabelBatchSubmissions.id });
    if (!submission)
      throw new Error("The historical label Batch could not be claimed.");
    await transaction
      .update(historicalThreadLabelScans)
      .set({ status: "running", updatedAt: new Date() })
      .where(eq(historicalThreadLabelScans.id, scan.id));
    return {
      submissionId: submission.id,
      candidates: await hydrateCandidates(
        { ...current, manifest },
        transaction,
      ),
    };
  });
}

export async function finalizeThreadLabelBatchPreparation(
  input: {
    submissionId: string;
    manifest: ThreadLabelBatchManifestEntry[];
    excludedThreadIds: string[];
  },
  database: Database = getDatabase(),
): Promise<Submission> {
  return database.transaction(async (transaction) => {
    const [current] = await transaction
      .select()
      .from(threadLabelBatchSubmissions)
      .where(eq(threadLabelBatchSubmissions.id, input.submissionId))
      .for("update")
      .limit(1);
    if (!current) throw new Error("The historical label Batch was not found.");
    if (
      current.inputFileId ||
      current.providerBatchId ||
      current.status !== "preparing"
    )
      return current;
    const originalByThreadId = new Map(
      current.manifest.map((entry) => [entry.threadId, entry]),
    );
    const preparedThreadIds = new Set(
      input.manifest.map((entry) => entry.threadId),
    );
    const excludedThreadIds = new Set(input.excludedThreadIds);
    if (
      excludedThreadIds.size !== input.excludedThreadIds.length ||
      current.manifest.length !==
        input.manifest.length + excludedThreadIds.size ||
      input.excludedThreadIds.some(
        (threadId) =>
          !originalByThreadId.has(threadId) || preparedThreadIds.has(threadId),
      )
    ) {
      throw new Error("The prepared Batch lost part of its durable manifest.");
    }
    if (
      input.manifest.length === 0 ||
      input.manifest.some((entry, index) => {
        const original = originalByThreadId.get(entry.threadId);
        const previous = input.manifest[index - 1];
        return (
          !original ||
          original.contentVersion !== entry.contentVersion ||
          original.assignmentVersion !== entry.assignmentVersion ||
          original.fallbackLabelId !== entry.fallbackLabelId ||
          (previous !== undefined && previous.threadId >= entry.threadId)
        );
      })
    ) {
      throw new Error("The prepared Batch changed its durable checkpoints.");
    }
    const [updated] = await transaction
      .update(threadLabelBatchSubmissions)
      .set({
        manifest: input.manifest,
        requestCount: input.manifest.length,
        continuations:
          current.retryAttempt > 0 && input.excludedThreadIds.length > 0
            ? [
                {
                  retryAttempt: current.retryAttempt,
                  threadIds: input.excludedThreadIds,
                },
                ...current.continuations,
              ]
            : current.continuations,
        updatedAt: new Date(),
      })
      .where(eq(threadLabelBatchSubmissions.id, current.id))
      .returning();
    if (!updated)
      throw new Error("The historical Batch preparation could not be saved.");
    return updated;
  });
}

export async function recordThreadLabelBatchInputFile(
  input: { submissionId: string; inputFileId: string },
  database: Database = getDatabase(),
): Promise<string> {
  const [submission] = await database
    .update(threadLabelBatchSubmissions)
    .set({
      inputFileId: sql`coalesce(${threadLabelBatchSubmissions.inputFileId}, ${input.inputFileId})`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(threadLabelBatchSubmissions.id, input.submissionId),
        eq(threadLabelBatchSubmissions.status, "preparing"),
      ),
    )
    .returning({ inputFileId: threadLabelBatchSubmissions.inputFileId });
  if (!submission?.inputFileId)
    throw new Error("The historical Batch input file could not be recorded.");
  return submission.inputFileId;
}

export async function recordThreadLabelProviderBatch(
  input: { submissionId: string; providerBatchId: string; inputFileId: string },
  database: Database = getDatabase(),
): Promise<Submission> {
  const [submission] = await database
    .update(threadLabelBatchSubmissions)
    .set({
      providerBatchId: input.providerBatchId,
      inputFileId: input.inputFileId,
      status: "submitted",
      submittedAt: sql`coalesce(${threadLabelBatchSubmissions.submittedAt}, now())`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(threadLabelBatchSubmissions.id, input.submissionId),
        inArray(threadLabelBatchSubmissions.status, ["preparing", "submitted"]),
      ),
    )
    .returning();
  if (!submission)
    throw new Error("The historical provider Batch could not be recorded.");
  return submission;
}

export async function listSubmittedThreadLabelBatchIds(
  database: Database = getDatabase(),
): Promise<string[]> {
  const rows = await database
    .select({ providerBatchId: threadLabelBatchSubmissions.providerBatchId })
    .from(threadLabelBatchSubmissions)
    .where(
      and(
        sql`${threadLabelBatchSubmissions.providerBatchId} is not null`,
        sql`(${threadLabelBatchSubmissions.status} = 'submitted' or (
        ${threadLabelBatchSubmissions.lastError} = 'automatic_labeling_superseded'
        and coalesce(${threadLabelBatchSubmissions.providerState}, '') not in ('completed', 'failed', 'expired', 'cancelled')
      ))`,
      ),
    );
  return rows.flatMap((row) =>
    row.providerBatchId ? [row.providerBatchId] : [],
  );
}

export async function finalizeThreadLabelBatchSubmission(
  input: {
    submissionId: string;
    providerState: string;
    providerErrorCode: string | null;
    retryableFailure: boolean;
    outputFileId: string | null;
    errorFileId: string | null;
    modelId: string;
    results: Array<{ threadId: string; labelId: string; confidence: number }>;
    failedThreadIds: string[];
  },
  database: Database = getDatabase(),
): Promise<{
  alreadyFinalized: boolean;
  appliedCount: number;
  continuationStepId: string | null;
}> {
  return database.transaction(async (transaction) => {
    const [identity] = await transaction
      .select()
      .from(threadLabelBatchSubmissions)
      .where(eq(threadLabelBatchSubmissions.id, input.submissionId))
      .limit(1);
    if (!identity) throw new Error("The historical Batch was not found.");
    const current = identity.historicalScanId
      ? await getCurrentHistoricalScan(
          {
            historicalScanId: identity.historicalScanId,
            userId: identity.userId,
            accountId: identity.accountId,
          },
          transaction,
        )
      : null;
    const [submission] = await transaction
      .select()
      .from(threadLabelBatchSubmissions)
      .where(eq(threadLabelBatchSubmissions.id, identity.id))
      .for("update")
      .limit(1);
    if (!submission) throw new Error("The historical Batch was not found.");
    if (submission.status === "complete" || submission.status === "failed") {
      // Retired automatic Batches may finish at the provider after deployment.
      // Remember their files for cleanup without applying their old results.
      await transaction
        .update(threadLabelBatchSubmissions)
        .set({
          providerState: input.providerState,
          outputFileId: input.outputFileId,
          errorFileId: input.errorFileId,
          updatedAt: new Date(),
        })
        .where(eq(threadLabelBatchSubmissions.id, submission.id));
      return {
        alreadyFinalized: true,
        appliedCount: 0,
        continuationStepId: null,
      };
    }
    const appliedThreadIds: string[] = [];
    const retryThreadIds: string[] = [];
    // Duplicate results are invalid instead of allowing provider order to decide.
    const resultsByThreadId = new Map<string, typeof input.results>();
    const failedThreadIds = new Set(input.failedThreadIds);
    for (const result of input.results) {
      resultsByThreadId.set(result.threadId, [
        ...(resultsByThreadId.get(result.threadId) ?? []),
        result,
      ]);
    }
    if (current) {
      for (const checkpoint of submission.manifest) {
        const [thread] = await transaction
          .select({
            id: threads.id,
            contentVersion: threads.contentVersion,
            assignmentVersion: threadLabelAssignments.assignmentVersion,
          })
          .from(threads)
          .leftJoin(
            threadLabelAssignments,
            eq(threadLabelAssignments.threadId, threads.id),
          )
          .where(
            and(
              eq(threads.id, checkpoint.threadId),
              eq(threads.userId, current.scan.userId),
              eq(threads.accountId, current.scan.accountId),
              recentInboxThreadCondition(
                current.scan.after,
                current.scan.before,
              ),
            ),
          )
          .for("update", { of: threads })
          .limit(1);
        if (
          !thread ||
          thread.contentVersion !== checkpoint.contentVersion ||
          thread.assignmentVersion !== checkpoint.assignmentVersion
        )
          continue;
        const matches = resultsByThreadId.get(thread.id) ?? [];
        const result = matches.length === 1 ? matches[0] : undefined;
        if (
          input.providerState !== "completed" ||
          failedThreadIds.has(thread.id) ||
          !result ||
          !Number.isFinite(result.confidence) ||
          result.confidence < 0 ||
          result.confidence > 100 ||
          ![
            current.scan.labelId,
            noMatchLabelId(current.scan.labelId),
          ].includes(result.labelId)
        ) {
          retryThreadIds.push(thread.id);
          continue;
        }
        if (result.labelId !== current.scan.labelId) continue;
        await transaction
          .insert(threadLabelAssignments)
          .values({
            userId: current.scan.userId,
            accountId: current.scan.accountId,
            threadId: thread.id,
            labelId: current.scan.labelId,
            source: "ai",
            confidence: result.confidence.toFixed(2),
            modelId: input.modelId,
            definitionVersion: current.scan.definitionVersion,
          })
          .onConflictDoUpdate({
            target: threadLabelAssignments.threadId,
            set: {
              labelId: current.scan.labelId,
              source: "ai",
              confidence: result.confidence.toFixed(2),
              modelId: input.modelId,
              definitionVersion: current.scan.definitionVersion,
              assignmentVersion: sql`${threadLabelAssignments.assignmentVersion} + 1`,
              assignedAt: new Date(),
              updatedAt: new Date(),
            },
          });
        await transaction
          .update(threads)
          .set({
            labelAnalysisState: "complete",
            labelAnalysisVersion: sql`${threads.labelAnalysisVersion} + 1`,
            labelAnalysisAfter: null,
            labelAnalysisError: null,
            labelAnalyzedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(threads.id, thread.id));
        appliedThreadIds.push(thread.id);
      }
    }
    await transaction
      .update(threadLabelBatchSubmissions)
      .set({
        status:
          current && input.providerState === "completed"
            ? "complete"
            : "failed",
        providerState: input.providerState,
        outputFileId: input.outputFileId,
        errorFileId: input.errorFileId,
        lastError: current
          ? input.providerErrorCode
          : "historical_label_request_superseded",
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(threadLabelBatchSubmissions.id, submission.id));
    if (!current)
      return {
        alreadyFinalized: false,
        appliedCount: 0,
        continuationStepId: null,
      };
    if (appliedThreadIds.length > 0) {
      await insertMailboxChange(transaction, {
        userId: current.scan.userId,
        accountId: current.scan.accountId,
        changeType: "labels_changed",
        payload: {
          kind: "analysis_resolution",
          affectedThreadIds: appliedThreadIds,
        },
      });
    }
    // The cursor advances only over the submitted manifest, never a truncated
    // preparation tail. Retry pages preserve the original scan's cursor.
    if (submission.retryAttempt === 0) {
      const lastThreadId = submission.manifest.at(-1)?.threadId;
      if (lastThreadId)
        await transaction
          .update(historicalThreadLabelScans)
          .set({ cursorThreadId: lastThreadId, updatedAt: new Date() })
          .where(eq(historicalThreadLabelScans.id, current.scan.id));
    }
    let continuationStepId: string | null = null;
    if (retryThreadIds.length > 0) {
      if (
        submission.retryAttempt < RETRY_LIMIT &&
        (input.providerState === "completed" || input.retryableFailure)
      ) {
        continuationStepId = await enqueueHistoricalBatch(
          {
            scan: current.scan,
            sourceKey: `retry:${submission.id}`,
            retryAttempt: submission.retryAttempt + 1,
            threadIds: retryThreadIds,
            continuations: submission.continuations,
            ...(input.retryableFailure
              ? { runAt: new Date(Date.now() + 5 * 60 * 1_000) }
              : {}),
          },
          transaction,
        );
      } else {
        await transaction
          .update(historicalThreadLabelScans)
          .set({
            status: "failed",
            lastError:
              input.providerErrorCode ??
              "historical_label_batch_invalid_result",
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(historicalThreadLabelScans.id, current.scan.id));
      }
    } else {
      const [next, ...remaining] = submission.continuations;
      continuationStepId = await enqueueHistoricalBatch(
        {
          scan: current.scan,
          sourceKey: `continue:${submission.id}`,
          ...next,
          continuations: remaining,
        },
        transaction,
      );
    }
    return {
      alreadyFinalized: false,
      appliedCount: appliedThreadIds.length,
      continuationStepId,
    };
  });
}

export async function enqueueHistoricalThreadLabelBatchRecoveries(
  database: Database = getDatabase(),
): Promise<number> {
  const scans = await database
    .select()
    .from(historicalThreadLabelScans)
    .where(eq(historicalThreadLabelScans.status, "queued"));
  for (const scan of scans)
    await database.transaction((transaction) =>
      enqueueHistoricalBatch({ scan, sourceKey: "start" }, transaction),
    );
  return scans.length;
}
