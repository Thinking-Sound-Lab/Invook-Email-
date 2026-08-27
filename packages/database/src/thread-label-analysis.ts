import { createHash } from "node:crypto";

import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  gte,
  inArray,
  isNull,
  sql,
  type SQLWrapper,
} from "drizzle-orm";

import {
  getDatabase,
  type Database,
  type DatabaseExecutor,
} from "./client";
import {
  connectedAccounts,
  gmailSyncItems,
  labels,
  mailSyncRuns,
  messageLabels,
  messages,
  threadLabelBatchSubmissions,
  threadLabelAssignments,
  threads,
  workflowSteps,
} from "./schema";
import { insertMailboxChange } from "./mailbox-change-events";
import { getLabelPreviewReceiptResult } from "./label-preview-receipts";
import { toPostgresTextProjection } from "./text";
import {
  enqueueWorkflowStepsWithExecutor,
  enqueueWorkflowStepWithExecutor,
} from "./workflows";

export type ThreadLabelDefinition = {
  id: string;
  name: string;
  description: string;
  definitionVersion: number;
};

export type ThreadLabelAnalysisCheckpoint = {
  threadId: string;
  analysisVersion: number;
  definitionHash: string;
};

export type HistoricalThreadLabelCheckpoint = {
  historicalScanId: string;
  previewReceiptId: string | null;
  threadId: string;
  labelId: string;
  definitionVersion: number;
  enablementVersion: number;
  assignmentVersion: number | null;
};

export type HistoricalThreadLabelScanCoordinatorCheckpoint = {
  historicalScanId: string;
  previewReceiptId: string | null;
  labelId: string;
  definitionVersion: number;
  enablementVersion: number;
  after: Date;
  cursorThreadId: string | null;
};

export type InboxThreadMessage = {
  id: string;
  subject: string;
  sender: { raw: string; email: string };
  recipients: string[];
  bodyText: string;
  sentAt: Date;
};

export const HISTORICAL_THREAD_LABEL_SCAN_PAGE_SIZE = 100;

const BUILT_IN_INVOOK_LABELS = [
  {
    name: "Important",
    normalizedName: "important",
    description:
      "Direct personal or work messages that require timely attention, a decision, or an action from the mailbox owner.",
    systemKey: "important" as const,
    definitionVersion: 1,
  },
  {
    name: "Newsletter",
    normalizedName: "newsletter",
    description:
      "Recurring editorial, digest, product-update, community-update, or marketing publications sent in bulk.",
    systemKey: "newsletter" as const,
    definitionVersion: 1,
  },
  {
    name: "Billing",
    normalizedName: "billing",
    description:
      "Invoices, receipts, payment confirmations, subscription charges, account statements, refunds, or other billing records.",
    systemKey: "billing" as const,
    definitionVersion: 1,
  },
  {
    name: "Others",
    normalizedName: "others",
    description:
      "Fallback for an Inbox thread that does not match any enabled Invook label.",
    systemKey: "others" as const,
    definitionVersion: 1,
  },
] as const;

export async function ensureBuiltInInvookLabels(
  input: { userId: string; accountId: string },
  database: DatabaseExecutor,
): Promise<void> {
  await database
    .insert(labels)
    .values(
      BUILT_IN_INVOOK_LABELS.map((definition) => ({
        userId: input.userId,
        accountId: input.accountId,
        kind: "invook" as const,
        isEnabled: true,
        ...definition,
      })),
    )
    .onConflictDoNothing();
}

function definitionHash(
  definitions: ThreadLabelDefinition[],
  fallback: ThreadLabelDefinition,
): string {
  const canonical = [...definitions, fallback]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((definition) => ({
      id: definition.id,
      name: definition.name,
      description: definition.description,
      definitionVersion: definition.definitionVersion,
    }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

async function getDefinitionSnapshot(
  accountId: string,
  database: DatabaseExecutor,
): Promise<{
  definitions: ThreadLabelDefinition[];
  fallback: ThreadLabelDefinition;
  definitionHash: string;
}> {
  const definitionRows = await database
    .select({
      id: labels.id,
      name: labels.name,
      description: labels.description,
      definitionVersion: labels.definitionVersion,
      systemKey: labels.systemKey,
    })
    .from(labels)
    .where(
      and(
        eq(labels.accountId, accountId),
        eq(labels.kind, "invook"),
        eq(labels.isEnabled, true),
      ),
    )
    .orderBy(asc(labels.id));
  const fallbackRow = definitionRows.find(
    (definition) => definition.systemKey === "others",
  );
  if (!fallbackRow) {
    throw new Error("The account has no enabled Others label.");
  }
  const fallback: ThreadLabelDefinition = {
    id: fallbackRow.id,
    name: fallbackRow.name,
    description: fallbackRow.description,
    definitionVersion: fallbackRow.definitionVersion,
  };
  const definitions = definitionRows.flatMap((definition) =>
    definition.systemKey === "others"
      ? []
      : [{
          id: definition.id,
          name: definition.name,
          description: definition.description,
          definitionVersion: definition.definitionVersion,
        }],
  );
  return {
    definitions,
    fallback,
    definitionHash: definitionHash(definitions, fallback),
  };
}

function inboxMembership(messageId: SQLWrapper) {
  return sql<boolean>`exists (
    select 1
    from ${messageLabels} inbox_membership
    inner join ${labels} inbox_label on inbox_label.id = inbox_membership.label_id
    where inbox_membership.message_id = ${messageId}
      and inbox_label.kind = 'gmail'
      and inbox_label.provider_label_id = 'INBOX'
  ) and not exists (
    select 1
    from ${messageLabels} excluded_membership
    inner join ${labels} excluded_label on excluded_label.id = excluded_membership.label_id
    where excluded_membership.message_id = ${messageId}
      and excluded_label.kind = 'gmail'
      and excluded_label.provider_label_id in ('SPAM', 'TRASH')
  )`;
}

export async function listInboxThreadMessages(
  threadId: string,
  database: DatabaseExecutor,
): Promise<InboxThreadMessage[]> {
  return database
    .select({
      id: messages.id,
      subject: messages.subject,
      sender: messages.sender,
      recipients: messages.recipients,
      bodyText: messages.bodyText,
      sentAt: messages.sentAt,
    })
    .from(messages)
    .where(and(eq(messages.threadId, threadId), inboxMembership(messages.id)))
    .orderBy(asc(messages.sentAt), asc(messages.id));
}

export async function refreshThreadProjection(
  database: DatabaseExecutor,
  threadId: string,
  options: { incrementContentVersion?: boolean } = {},
): Promise<boolean> {
  const storedMessages = await database
    .select({
      sender: messages.sender,
      recipients: messages.recipients,
      subject: messages.subject,
      snippet: messages.snippet,
      sentAt: messages.sentAt,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.threadId, threadId))
    .orderBy(desc(messages.sentAt), desc(messages.createdAt));
  const latestMessage = storedMessages[0];
  if (!latestMessage) {
    await database.delete(threads).where(eq(threads.id, threadId));
    return false;
  }
  const participants = Array.from(
    new Set(
      storedMessages.flatMap((message) => [
        message.sender.raw,
        ...message.recipients,
      ]),
    ),
  ).filter(Boolean);
  await database
    .update(threads)
    .set({
      subject: latestMessage.subject,
      snippet: latestMessage.snippet,
      participants,
      latestMessageAt: latestMessage.sentAt,
      messageCount: storedMessages.length,
      ...(options.incrementContentVersion === false
        ? {}
        : { contentVersion: sql`${threads.contentVersion} + 1` }),
      updatedAt: new Date(),
    })
    .where(eq(threads.id, threadId));
  return true;
}

function checkpointMatches(
  thread: { id: string; labelAnalysisVersion: number },
  checkpoint: ThreadLabelAnalysisCheckpoint,
): boolean {
  return (
    thread.id === checkpoint.threadId &&
    thread.labelAnalysisVersion === checkpoint.analysisVersion
  );
}

function automaticThreadLabelAssignmentAllowed() {
  return sql<boolean>`not exists (
    select 1 from ${threadLabelAssignments} manual_assignment
    where manual_assignment.thread_id = ${threads.id}
      and manual_assignment.source = 'user'
  )`;
}

async function saveAiThreadLabelAssignment(
  input: {
    userId: string;
    accountId: string;
    threadId: string;
    labelId: string;
    confidence: number;
    modelId: string;
    definitionVersion: number;
  },
  database: DatabaseExecutor,
): Promise<boolean> {
  const [assignment] = await database
    .insert(threadLabelAssignments)
    .values({
      userId: input.userId,
      accountId: input.accountId,
      threadId: input.threadId,
      labelId: input.labelId,
      source: "ai",
      confidence: input.confidence.toFixed(2),
      modelId: input.modelId,
      definitionVersion: input.definitionVersion,
    })
    .onConflictDoUpdate({
      target: threadLabelAssignments.threadId,
      set: {
        labelId: input.labelId,
        source: "ai",
        confidence: input.confidence.toFixed(2),
        modelId: input.modelId,
        definitionVersion: input.definitionVersion,
        assignmentVersion: sql`${threadLabelAssignments.assignmentVersion} + 1`,
        assignedAt: new Date(),
        updatedAt: new Date(),
      },
      setWhere: eq(threadLabelAssignments.source, "ai"),
    })
    .returning({ threadId: threadLabelAssignments.threadId });
  return Boolean(assignment);
}

async function enqueueThreadLabelAnalysisWithExecutor(
  input: {
    userId: string;
    accountId: string;
    threadId: string;
    analysisVersion: number;
    lane: "live";
    runId?: string;
  },
  database: DatabaseExecutor,
): Promise<{ stepId: string; definitionHash: string } | null> {
  await ensureBuiltInInvookLabels(
    { userId: input.userId, accountId: input.accountId },
    database,
  );
  const snapshot = await getDefinitionSnapshot(input.accountId, database);
  const [reserved] = await database
    .update(threads)
    .set({
      labelAnalysisState: "running",
      labelAnalysisDefinitionHash: snapshot.definitionHash,
      labelAnalysisError: null,
      labelAnalyzedAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(threads.id, input.threadId),
        eq(threads.userId, input.userId),
        eq(threads.accountId, input.accountId),
        eq(threads.labelAnalysisVersion, input.analysisVersion),
        eq(threads.labelAnalysisState, "pending"),
        inboxThreadConditionForBatch(),
        automaticThreadLabelAssignmentAllowed(),
      ),
    )
    .returning({ id: threads.id });
  if (!reserved) return null;
  const stepId = await enqueueWorkflowStepWithExecutor(
    {
      runId: input.runId,
      userId: input.userId,
      accountId: input.accountId,
      stepType: "label.thread.assign",
      payload: {
        threadId: input.threadId,
        analysisVersion: input.analysisVersion,
        definitionHash: snapshot.definitionHash,
        lane: input.lane,
      },
      idempotencyKey: `label.thread.assign:${input.threadId}:${input.analysisVersion}:${snapshot.definitionHash}`,
    },
    database,
  );
  return { stepId, definitionHash: snapshot.definitionHash };
}

async function listLiveThreadLabelCandidates(
  input: {
    userId: string;
    accountId: string;
    threadIds: string[];
    latestMessageAtCutoff?: Date;
    limit?: number;
  },
  database: DatabaseExecutor,
): Promise<Array<{ threadId: string; analysisVersion: number }>> {
  const query = database
    .select({
      threadId: threads.id,
      analysisVersion: threads.labelAnalysisVersion,
    })
    .from(threads)
    .leftJoin(
      threadLabelAssignments,
      eq(threadLabelAssignments.threadId, threads.id),
    )
    .where(
      and(
        eq(threads.userId, input.userId),
        eq(threads.accountId, input.accountId),
        inArray(threads.id, input.threadIds),
        eq(threads.labelAnalysisState, "pending"),
        automaticThreadLabelAssignmentAllowed(),
        inboxThreadConditionForBatch(),
        input.latestMessageAtCutoff
          ? gte(threads.latestMessageAt, input.latestMessageAtCutoff)
          : undefined,
      ),
    )
    .orderBy(desc(threads.latestMessageAt), desc(threads.id));
  return input.limit === undefined ? query : query.limit(input.limit);
}

export async function enqueueLiveInboxThreadLabelAnalyses(
  input: { userId: string; accountId: string; threadIds: string[] },
  database: DatabaseExecutor,
): Promise<number> {
  const threadIds = Array.from(new Set(input.threadIds));
  if (threadIds.length === 0) return 0;
  const candidates = await listLiveThreadLabelCandidates(
    { userId: input.userId, accountId: input.accountId, threadIds },
    database,
  );
  let enqueuedCount = 0;
  for (const candidate of candidates) {
    const enqueued = await enqueueThreadLabelAnalysisWithExecutor(
      {
        userId: input.userId,
        accountId: input.accountId,
        threadId: candidate.threadId,
        analysisVersion: candidate.analysisVersion,
        lane: "live",
      },
      database,
    );
    if (enqueued) enqueuedCount += 1;
  }
  return enqueuedCount;
}

export async function beginThreadLabelAnalysis(
  input: {
    userId: string;
    accountId: string;
    checkpoint: ThreadLabelAnalysisCheckpoint;
  },
  database: Database = getDatabase(),
): Promise<
  | { status: "missing" | "superseded" | "resolved" | "ineligible" }
  | {
      status: "ready";
      thread: { id: string; subject: string; messages: InboxThreadMessage[] };
      definitions: ThreadLabelDefinition[];
      fallback: ThreadLabelDefinition;
    }
> {
  return database.transaction(async (transaction) => {
    const [thread] = await transaction
      .select({
        id: threads.id,
        subject: threads.subject,
        labelAnalysisVersion: threads.labelAnalysisVersion,
        labelAnalysisState: threads.labelAnalysisState,
        assignmentSource: threadLabelAssignments.source,
      })
      .from(threads)
      .leftJoin(
        threadLabelAssignments,
        eq(threadLabelAssignments.threadId, threads.id),
      )
      .where(
        and(
          eq(threads.id, input.checkpoint.threadId),
          eq(threads.userId, input.userId),
          eq(threads.accountId, input.accountId),
        ),
      )
      .for("update", { of: threads })
      .limit(1);
    if (!thread) return { status: "missing" };
    if (!checkpointMatches(thread, input.checkpoint)) {
      return { status: "superseded" };
    }
    if (
      thread.assignmentSource === "user" ||
      thread.labelAnalysisState !== "running"
    ) {
      return { status: "resolved" };
    }
    const snapshot = await getDefinitionSnapshot(input.accountId, transaction);
    if (snapshot.definitionHash !== input.checkpoint.definitionHash) {
      await transaction
        .update(threads)
        .set({ labelAnalysisState: "pending", updatedAt: new Date() })
        .where(eq(threads.id, thread.id));
      await enqueueThreadLabelAnalysisWithExecutor(
        {
          userId: input.userId,
          accountId: input.accountId,
          threadId: thread.id,
          analysisVersion: thread.labelAnalysisVersion,
          lane: "live",
        },
        transaction,
      );
      return { status: "superseded" };
    }
    const inboxMessages = await listInboxThreadMessages(thread.id, transaction);
    if (inboxMessages.length === 0) return { status: "ineligible" };
    return {
      status: "ready",
      thread: { id: thread.id, subject: thread.subject, messages: inboxMessages },
      definitions: snapshot.definitions,
      fallback: snapshot.fallback,
    };
  });
}

export async function completeThreadLabelAnalysis(
  input: {
    userId: string;
    accountId: string;
    checkpoint: ThreadLabelAnalysisCheckpoint;
    modelId: string;
    labelId: string;
    confidence: number;
  },
  database: Database = getDatabase(),
): Promise<
  | { status: "missing" | "superseded" | "current" }
  | { status: "complete"; eventId: string }
> {
  return database.transaction(async (transaction) => {
    const [thread] = await transaction
      .select({
        id: threads.id,
        labelAnalysisVersion: threads.labelAnalysisVersion,
        labelAnalysisState: threads.labelAnalysisState,
        assignmentSource: threadLabelAssignments.source,
      })
      .from(threads)
      .leftJoin(
        threadLabelAssignments,
        eq(threadLabelAssignments.threadId, threads.id),
      )
      .where(
        and(
          eq(threads.id, input.checkpoint.threadId),
          eq(threads.userId, input.userId),
          eq(threads.accountId, input.accountId),
        ),
      )
      .for("update", { of: threads })
      .limit(1);
    if (!thread) return { status: "missing" };
    if (!checkpointMatches(thread, input.checkpoint)) {
      return { status: "superseded" };
    }
    if (
      thread.assignmentSource === "user" ||
      thread.labelAnalysisState !== "running"
    ) {
      return { status: "current" };
    }
    const snapshot = await getDefinitionSnapshot(input.accountId, transaction);
    if (snapshot.definitionHash !== input.checkpoint.definitionHash) {
      await transaction
        .update(threads)
        .set({ labelAnalysisState: "pending", updatedAt: new Date() })
        .where(eq(threads.id, thread.id));
      await enqueueThreadLabelAnalysisWithExecutor(
        {
          userId: input.userId,
          accountId: input.accountId,
          threadId: thread.id,
          analysisVersion: thread.labelAnalysisVersion,
          lane: "live",
        },
        transaction,
      );
      return { status: "superseded" };
    }
    const selectedDefinition = [...snapshot.definitions, snapshot.fallback].find(
      (definition) => definition.id === input.labelId,
    );
    if (
      !selectedDefinition ||
      !Number.isFinite(input.confidence) ||
      input.confidence < 0 ||
      input.confidence > 100
    ) {
      throw new Error("The thread label result does not match current definitions.");
    }
    const inboxMessages = await listInboxThreadMessages(thread.id, transaction);
    if (inboxMessages.length === 0) return { status: "superseded" };
    const assignmentSaved = await saveAiThreadLabelAssignment(
      {
        userId: input.userId,
        accountId: input.accountId,
        threadId: thread.id,
        labelId: selectedDefinition.id,
        confidence: input.confidence,
        modelId: input.modelId,
        definitionVersion: selectedDefinition.definitionVersion,
      },
      transaction,
    );
    if (!assignmentSaved) return { status: "current" };
    await transaction
      .update(threads)
      .set({
        labelAnalysisState: "complete",
        labelAnalysisDefinitionHash: snapshot.definitionHash,
        labelAnalysisError: null,
        labelAnalyzedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(threads.id, thread.id));
    const eventId = await insertMailboxChange(transaction, {
      userId: input.userId,
      accountId: input.accountId,
      changeType: "labels_changed",
      payload: {
        kind: "analysis_resolution",
        affectedThreadIds: [thread.id],
      },
    });
    return { status: "complete", eventId };
  });
}

export async function failThreadLabelAnalysis(
  input: {
    userId: string;
    accountId: string;
    checkpoint: ThreadLabelAnalysisCheckpoint;
    errorCode: string;
  },
  database: Database = getDatabase(),
): Promise<boolean> {
  return database.transaction(async (transaction) => {
    const [updated] = await transaction
      .update(threads)
      .set({
        labelAnalysisState: "pending",
        labelAnalysisError: input.errorCode,
        labelAnalyzedAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(threads.id, input.checkpoint.threadId),
          eq(threads.userId, input.userId),
          eq(threads.accountId, input.accountId),
          eq(threads.labelAnalysisVersion, input.checkpoint.analysisVersion),
          eq(threads.labelAnalysisDefinitionHash, input.checkpoint.definitionHash),
          eq(threads.labelAnalysisState, "running"),
          automaticThreadLabelAssignmentAllowed(),
        ),
      )
      .returning({ id: threads.id });
    if (!updated) return false;
    await enqueueThreadLabelBatchSubmission(
      {
        userId: input.userId,
        accountId: input.accountId,
        sourceKey: `live-fallback:${input.checkpoint.threadId}:${input.checkpoint.analysisVersion}:${input.checkpoint.definitionHash}`,
        flushRemainder: true,
      },
      transaction,
    );
    return true;
  });
}

export async function getInvookLabelPreviewContext(
  input: { userId: string; accountId: string; limit?: number },
  database: Database = getDatabase(),
): Promise<{
  accountId: string;
  candidates: Array<{
    threadId: string;
    subject: string;
    sender: { raw: string; email: string };
    sentAt: Date;
    messages: InboxThreadMessage[];
  }>;
} | null> {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 100);
  const [account] = await database
    .select({ id: connectedAccounts.id })
    .from(connectedAccounts)
    .where(
      and(
        eq(connectedAccounts.userId, input.userId),
        eq(connectedAccounts.id, input.accountId),
        eq(connectedAccounts.status, "connected"),
      ),
    )
    .limit(1);
  if (!account) return null;
  const candidates = await database
    .select({ id: threads.id, subject: threads.subject })
    .from(threads)
    .where(
      and(
        eq(threads.userId, input.userId),
        eq(threads.accountId, account.id),
        sql<boolean>`exists (
          select 1 from ${messages} preview_message
          where preview_message.thread_id = ${threads.id}
            and ${inboxMembership(sql.raw("preview_message.id"))}
        )`,
      ),
    )
    .orderBy(desc(threads.latestMessageAt), desc(threads.createdAt))
    .limit(limit);
  const results = [];
  for (const candidate of candidates) {
    const inboxMessages = await listInboxThreadMessages(candidate.id, database);
    const latestMessage = inboxMessages.at(-1);
    if (!latestMessage) continue;
    results.push({
      threadId: candidate.id,
      subject: candidate.subject,
      sender: latestMessage.sender,
      sentAt: latestMessage.sentAt,
      messages: inboxMessages,
    });
  }
  return { accountId: account.id, candidates: results };
}

function historicalThreadLabelScanCoordinatorKey(input: {
  historicalScanId: string;
  cursorThreadId: string | null;
}): string {
  return [
    "label.historical.scan",
    input.historicalScanId,
    input.cursorThreadId ?? "start",
  ].join(":");
}

export async function enqueueHistoricalThreadLabelScanCoordinator(
  input: {
    historicalScanId: string;
    previewReceiptId: string | null;
    userId: string;
    accountId: string;
    labelId: string;
    definitionVersion: number;
    enablementVersion: number;
    after: Date;
  },
  database: DatabaseExecutor,
): Promise<string> {
  const cursorThreadId = null;
  return enqueueWorkflowStepWithExecutor(
    {
      userId: input.userId,
      accountId: input.accountId,
      stepType: "label.historical.scan",
      payload: {
        historicalScanId: input.historicalScanId,
        previewReceiptId: input.previewReceiptId,
        labelId: input.labelId,
        definitionVersion: input.definitionVersion,
        enablementVersion: input.enablementVersion,
        after: input.after.toISOString(),
        cursorThreadId,
      },
      idempotencyKey: historicalThreadLabelScanCoordinatorKey({
        historicalScanId: input.historicalScanId,
        cursorThreadId,
      }),
    },
    database,
  );
}

export async function scanHistoricalThreadLabelPage(
  input: {
    userId: string;
    accountId: string;
    checkpoint: HistoricalThreadLabelScanCoordinatorCheckpoint;
  },
  database: Database = getDatabase(),
): Promise<
  | { status: "missing" | "superseded"; queuedThreadCount: 0 }
  | {
      status: "complete" | "continued";
      queuedThreadCount: number;
      continuationStepId: string | null;
      cursorThreadId: string | null;
    }
> {
  return database.transaction(async (transaction) => {
    const [definition] = await transaction
      .select({
        id: labels.id,
        definitionVersion: labels.definitionVersion,
        enablementVersion: labels.enablementVersion,
        isEnabled: labels.isEnabled,
        systemKey: labels.systemKey,
      })
      .from(labels)
      .where(
        and(
          eq(labels.id, input.checkpoint.labelId),
          eq(labels.kind, "invook"),
          eq(labels.userId, input.userId),
          eq(labels.accountId, input.accountId),
        ),
      )
      .limit(1);
    if (!definition) return { status: "missing", queuedThreadCount: 0 };
    if (
      definition.definitionVersion !== input.checkpoint.definitionVersion ||
      definition.enablementVersion !== input.checkpoint.enablementVersion ||
      !definition.isEnabled ||
      definition.systemKey === "others"
    ) {
      return { status: "superseded", queuedThreadCount: 0 };
    }

    const eligibleMessage = transaction
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.threadId, threads.id),
          gte(messages.sentAt, input.checkpoint.after),
          inboxMembership(messages.id),
        ),
      )
      .limit(1);
    const candidates = await transaction
      .select({
        threadId: threads.id,
        assignmentVersion: threadLabelAssignments.assignmentVersion,
      })
      .from(threads)
      .leftJoin(
        threadLabelAssignments,
        eq(threadLabelAssignments.threadId, threads.id),
      )
      .where(
        and(
          eq(threads.userId, input.userId),
          eq(threads.accountId, input.accountId),
          input.checkpoint.cursorThreadId
            ? gt(threads.id, input.checkpoint.cursorThreadId)
            : undefined,
          exists(eligibleMessage),
        ),
      )
      .orderBy(asc(threads.id))
      .limit(HISTORICAL_THREAD_LABEL_SCAN_PAGE_SIZE + 1);
    const page = candidates.slice(0, HISTORICAL_THREAD_LABEL_SCAN_PAGE_SIZE);
    const inserted = await enqueueWorkflowStepsWithExecutor(
      page.map((candidate) => ({
        userId: input.userId,
        accountId: input.accountId,
        stepType: "label.thread.scan",
        payload: {
          historicalScanId: input.checkpoint.historicalScanId,
          previewReceiptId: input.checkpoint.previewReceiptId,
          threadId: candidate.threadId,
          labelId: input.checkpoint.labelId,
          definitionVersion: input.checkpoint.definitionVersion,
          enablementVersion: input.checkpoint.enablementVersion,
          assignmentVersion: candidate.assignmentVersion,
        },
        idempotencyKey: `label.thread.scan:${input.checkpoint.historicalScanId}:${candidate.threadId}`,
      })),
      transaction,
    );
    const cursorThreadId = page.at(-1)?.threadId ?? null;
    if (candidates.length <= HISTORICAL_THREAD_LABEL_SCAN_PAGE_SIZE) {
      return {
        status: "complete",
        queuedThreadCount: inserted.length,
        continuationStepId: null,
        cursorThreadId,
      };
    }
    if (!cursorThreadId) {
      throw new Error("The historical label scan continuation cursor is missing.");
    }
    const continuationStepId = await enqueueWorkflowStepWithExecutor(
      {
        userId: input.userId,
        accountId: input.accountId,
        stepType: "label.historical.scan",
        payload: {
          historicalScanId: input.checkpoint.historicalScanId,
          previewReceiptId: input.checkpoint.previewReceiptId,
          labelId: input.checkpoint.labelId,
          definitionVersion: input.checkpoint.definitionVersion,
          enablementVersion: input.checkpoint.enablementVersion,
          after: input.checkpoint.after.toISOString(),
          cursorThreadId,
        },
        idempotencyKey: historicalThreadLabelScanCoordinatorKey({
          historicalScanId: input.checkpoint.historicalScanId,
          cursorThreadId,
        }),
      },
      transaction,
    );
    return {
      status: "continued",
      queuedThreadCount: inserted.length,
      continuationStepId,
      cursorThreadId,
    };
  });
}

export async function beginHistoricalThreadLabelScan(
  input: {
    userId: string;
    accountId: string;
    checkpoint: HistoricalThreadLabelCheckpoint;
  },
  database: Database = getDatabase(),
): Promise<
  | { status: "missing" | "superseded" }
  | {
      status: "ready";
      thread: { id: string; subject: string; messages: InboxThreadMessage[] };
      definition: ThreadLabelDefinition;
      previewResult: {
        classifierInputHash: string;
        matched: boolean;
        confidence: number;
        modelId: string;
      } | null;
    }
> {
  const [target] = await database
    .select({
      threadId: threads.id,
      subject: threads.subject,
      assignmentVersion: threadLabelAssignments.assignmentVersion,
      labelId: labels.id,
      labelName: labels.name,
      labelDescription: labels.description,
      definitionVersion: labels.definitionVersion,
      enablementVersion: labels.enablementVersion,
      isEnabled: labels.isEnabled,
      systemKey: labels.systemKey,
    })
    .from(threads)
    .leftJoin(
      threadLabelAssignments,
      eq(threadLabelAssignments.threadId, threads.id),
    )
    .innerJoin(labels, eq(labels.id, input.checkpoint.labelId))
    .where(
      and(
        eq(threads.id, input.checkpoint.threadId),
        eq(threads.userId, input.userId),
        eq(threads.accountId, input.accountId),
        eq(labels.kind, "invook"),
        eq(labels.userId, input.userId),
        eq(labels.accountId, input.accountId),
      ),
    )
    .limit(1);
  if (!target) return { status: "missing" };
  if (
    target.assignmentVersion !== input.checkpoint.assignmentVersion ||
    target.labelId !== input.checkpoint.labelId ||
    target.definitionVersion !== input.checkpoint.definitionVersion ||
    target.enablementVersion !== input.checkpoint.enablementVersion ||
    !target.isEnabled ||
    target.systemKey === "others"
  ) {
    return { status: "superseded" };
  }
  const inboxMessages = await listInboxThreadMessages(target.threadId, database);
  if (inboxMessages.length === 0) return { status: "superseded" };
  const storedPreviewResult = input.checkpoint.previewReceiptId
    ? await getLabelPreviewReceiptResult(
        {
          receiptId: input.checkpoint.previewReceiptId,
          historicalScanId: input.checkpoint.historicalScanId,
          userId: input.userId,
          accountId: input.accountId,
          name: target.labelName,
          description: target.labelDescription,
          threadId: target.threadId,
        },
        database,
      )
    : null;
  const previewResult = storedPreviewResult
    ? {
        classifierInputHash: storedPreviewResult.classifierInputHash,
        matched: storedPreviewResult.matched,
        confidence: storedPreviewResult.confidence,
        modelId: storedPreviewResult.modelId,
      }
    : null;
  return {
    status: "ready",
    thread: { id: target.threadId, subject: target.subject, messages: inboxMessages },
    definition: {
      id: target.labelId,
      name: target.labelName,
      description: target.labelDescription,
      definitionVersion: target.definitionVersion,
    },
    previewResult,
  };
}

export async function completeHistoricalThreadLabelScan(
  input: {
    userId: string;
    accountId: string;
    checkpoint: HistoricalThreadLabelCheckpoint;
    modelId: string;
    matched: boolean;
    confidence: number;
  },
  database: Database = getDatabase(),
): Promise<{ status: "missing" | "superseded" | "not_matched" | "complete" }> {
  return database.transaction(async (transaction) => {
    const [definition] = await transaction
      .select({
        labelId: labels.id,
        definitionVersion: labels.definitionVersion,
        enablementVersion: labels.enablementVersion,
        isEnabled: labels.isEnabled,
        systemKey: labels.systemKey,
      })
      .from(labels)
      .where(
        and(
          eq(labels.id, input.checkpoint.labelId),
          eq(labels.kind, "invook"),
          eq(labels.userId, input.userId),
          eq(labels.accountId, input.accountId),
        ),
      )
      .for("update")
      .limit(1);
    if (!definition) return { status: "missing" };

    const [target] = await transaction
      .select({
        threadId: threads.id,
        assignmentId: threadLabelAssignments.id,
        assignmentVersion: threadLabelAssignments.assignmentVersion,
      })
      .from(threads)
      .leftJoin(
        threadLabelAssignments,
        eq(threadLabelAssignments.threadId, threads.id),
      )
      .where(
        and(
          eq(threads.id, input.checkpoint.threadId),
          eq(threads.userId, input.userId),
          eq(threads.accountId, input.accountId),
        ),
      )
      .for("update", { of: threads })
      .limit(1);
    if (!target) return { status: "missing" };
    if (
      target.assignmentVersion !== input.checkpoint.assignmentVersion ||
      definition.labelId !== input.checkpoint.labelId ||
      definition.definitionVersion !== input.checkpoint.definitionVersion ||
      definition.enablementVersion !== input.checkpoint.enablementVersion ||
      !definition.isEnabled ||
      definition.systemKey === "others" ||
      !Number.isFinite(input.confidence) ||
      input.confidence < 0 ||
      input.confidence > 100
    ) {
      return { status: "superseded" };
    }
    if (!input.matched) return { status: "not_matched" };
    if (target.assignmentId) {
      await transaction
        .update(threadLabelAssignments)
        .set({
          labelId: definition.labelId,
          source: "ai",
          confidence: input.confidence.toFixed(2),
          modelId: input.modelId,
          definitionVersion: definition.definitionVersion,
          assignmentVersion: sql`${threadLabelAssignments.assignmentVersion} + 1`,
          assignedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(threadLabelAssignments.id, target.assignmentId));
    } else {
      await transaction.insert(threadLabelAssignments).values({
        userId: input.userId,
        accountId: input.accountId,
        threadId: target.threadId,
        labelId: definition.labelId,
        source: "ai",
        confidence: input.confidence.toFixed(2),
        modelId: input.modelId,
        definitionVersion: definition.definitionVersion,
      });
    }
    await transaction
      .update(threads)
      .set({
        labelAnalysisState: "complete",
        labelAnalysisError: null,
        labelAnalyzedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(threads.id, target.threadId));
    await insertMailboxChange(transaction, {
      userId: input.userId,
      accountId: input.accountId,
      changeType: "labels_changed",
      payload: {
        kind: "analysis_resolution",
        affectedThreadIds: [target.threadId],
      },
    });
    return { status: "complete" };
  });
}

export async function setUserThreadLabel(
  input: { userId: string; threadId: string; labelId: string },
  database: Database = getDatabase(),
) {
  return database.transaction(async (transaction) => {
    const [target] = await transaction
      .select({
        threadId: threads.id,
        accountId: threads.accountId,
        labelId: labels.id,
        labelName: labels.name,
        definitionVersion: labels.definitionVersion,
      })
      .from(threads)
      .innerJoin(
        labels,
        and(
          eq(labels.id, input.labelId),
          eq(labels.userId, input.userId),
          eq(labels.accountId, threads.accountId),
          eq(labels.kind, "invook"),
        ),
      )
      .where(and(eq(threads.id, input.threadId), eq(threads.userId, input.userId)))
      .for("update", { of: threads })
      .limit(1);
    if (!target) return null;
    const [assignment] = await transaction
      .insert(threadLabelAssignments)
      .values({
        userId: input.userId,
        accountId: target.accountId,
        threadId: target.threadId,
        labelId: target.labelId,
        source: "user",
        confidence: null,
        modelId: null,
        definitionVersion: target.definitionVersion,
      })
      .onConflictDoUpdate({
        target: threadLabelAssignments.threadId,
        set: {
          labelId: target.labelId,
          source: "user",
          confidence: null,
          modelId: null,
          definitionVersion: target.definitionVersion,
          assignmentVersion: sql`${threadLabelAssignments.assignmentVersion} + 1`,
          assignedAt: new Date(),
          updatedAt: new Date(),
        },
      })
      .returning({ assignmentVersion: threadLabelAssignments.assignmentVersion });
    if (!assignment) throw new Error("The thread label could not be saved.");
    await transaction
      .update(threads)
      .set({
        labelAnalysisState: "complete",
        labelAnalysisError: null,
        labelAnalyzedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(threads.id, target.threadId));
    await insertMailboxChange(transaction, {
      userId: input.userId,
      accountId: target.accountId,
      changeType: "labels_changed",
      payload: { kind: "decision", affectedThreadIds: [target.threadId] },
    });
    return {
      labelId: target.labelId,
      name: target.labelName,
      source: "user" as const,
      confidence: null,
    };
  });
}

export const THREAD_LABEL_BATCH_START_THRESHOLD = 100;
const THREAD_LABEL_BATCH_REQUEST_LIMIT = 2_000;
const THREAD_LABEL_CANDIDATE_PAGE_SIZE = 500;
const THREAD_LABEL_BATCH_RETRY_LIMIT = 6;
const THREAD_LABEL_CAPACITY_RETRY_DELAY_MS = 5 * 60 * 1_000;
const THREAD_LABEL_CAPACITY_ERROR_CODE = "openai_batch_capacity_exhausted";

export type ThreadLabelBatchManifestEntry = {
  threadId: string;
  analysisVersion: number;
  definitionHash: string;
  fallbackLabelId: string;
};

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

export async function enqueueThreadLabelBatchSubmission(
  input: {
    userId: string;
    accountId: string;
    sourceKey: string;
    flushRemainder: boolean;
    retryAttempt?: number;
    threadIds?: string[];
    runAt?: Date;
  },
  database: DatabaseExecutor = getDatabase(),
): Promise<string> {
  const threadIds = input.threadIds
    ? Array.from(new Set(input.threadIds))
    : undefined;
  if (threadIds && (threadIds.length === 0 || threadIds.length > 2_000)) {
    throw new Error("A thread-label Batch retry must contain 1 to 2,000 threads.");
  }
  return enqueueWorkflowStepWithExecutor(
    {
      userId: input.userId,
      accountId: input.accountId,
      stepType: "label.batch.submit",
      payload: {
        flushRemainder: input.flushRemainder,
        ...(input.retryAttempt === undefined
          ? {}
          : { retryAttempt: input.retryAttempt }),
        ...(threadIds ? { threadIds } : {}),
        ...(input.runAt ? { runAt: input.runAt.toISOString() } : {}),
      },
      idempotencyKey: `label.batch.submit:${input.sourceKey}`,
    },
    database,
  );
}

async function lockThreadLabelBatchAccount(
  accountId: string,
  database: DatabaseExecutor,
): Promise<void> {
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${accountId}, 41))`,
  );
}

async function listThreadLabelBatchCandidateRows(
  input: {
    userId: string;
    accountId: string;
    activeRunId: string | null;
    candidateThreadIds?: string[];
    flushRemainder: boolean;
    limit: number;
  },
  database: DatabaseExecutor,
): Promise<Array<{ threadId: string; subject: string; analysisVersion: number }>> {
  const candidates: Array<{
    threadId: string;
    subject: string;
    analysisVersion: number;
  }> = [];
  let cursor: { latestMessageAt: Date; threadId: string } | null = null;
  while (candidates.length < input.limit) {
    const pageLimit = Math.min(
      THREAD_LABEL_CANDIDATE_PAGE_SIZE,
      input.limit - candidates.length,
    );
    const page = await database
      .select({
        threadId: threads.id,
        subject: threads.subject,
        analysisVersion: threads.labelAnalysisVersion,
        latestMessageAt: threads.latestMessageAt,
      })
      .from(threads)
      .leftJoin(
        threadLabelAssignments,
        eq(threadLabelAssignments.threadId, threads.id),
      )
      .where(
        and(
          eq(threads.userId, input.userId),
          eq(threads.accountId, input.accountId),
          eq(threads.labelAnalysisState, "pending"),
          automaticThreadLabelAssignmentAllowed(),
          input.candidateThreadIds
            ? inArray(threads.id, input.candidateThreadIds)
            : undefined,
          cursor
            ? sql<boolean>`(${threads.latestMessageAt}, ${threads.id}) < (${cursor.latestMessageAt.toISOString()}::timestamptz, ${cursor.threadId}::uuid)`
            : undefined,
          inboxThreadConditionForBatch(),
          input.activeRunId
            ? sql<boolean>`exists (
                select 1
                from ${mailSyncRuns} label_run
                where label_run.id = ${input.activeRunId}
                  and label_run.account_id = ${input.accountId}
                  and label_run.status in ('queued', 'running')
              ) and not exists (
                select 1
                from ${gmailSyncItems} pending_thread_item
                where pending_thread_item.run_id = ${input.activeRunId}
                  and pending_thread_item.provider_thread_id = ${threads.providerThreadId}
                  and pending_thread_item.status <> 'complete'
              )`
            : undefined,
        ),
      )
      .orderBy(sql`${threads.latestMessageAt} desc nulls last`, desc(threads.id))
      .limit(pageLimit)
      .for("update", { of: threads, skipLocked: true });
    candidates.push(
      ...page.map(({ latestMessageAt: _latestMessageAt, ...candidate }) => candidate),
    );
    if (page.length < pageLimit) break;
    const lastRow = page.at(-1);
    // Eligible threads always carry latestMessageAt; a null cursor cannot
    // order the next keyset page, so stop instead of looping unordered.
    if (!lastRow || lastRow.latestMessageAt === null) break;
    cursor = {
      latestMessageAt: lastRow.latestMessageAt,
      threadId: lastRow.threadId,
    };
  }
  return candidates;
}

export type InitialThreadLabelBatchAdmissionResult =
  | { status: "inactive" | "busy" }
  | { status: "below_threshold"; candidateCount: number }
  | { status: "enqueued"; candidateCount: number; stepId: string };

export async function enqueueInitialThreadLabelBatchIfReady(
  input: {
    runId: string;
    userId: string;
    accountId: string;
    sourceKey: string;
  },
  database: Database = getDatabase(),
): Promise<InitialThreadLabelBatchAdmissionResult> {
  return database.transaction(async (transaction) => {
    await lockThreadLabelBatchAccount(input.accountId, transaction);
    const [activeRun] = await transaction
      .select({ id: mailSyncRuns.id })
      .from(mailSyncRuns)
      .where(
        and(
          eq(mailSyncRuns.id, input.runId),
          eq(mailSyncRuns.userId, input.userId),
          eq(mailSyncRuns.accountId, input.accountId),
          inArray(mailSyncRuns.status, ["queued", "running"]),
        ),
      )
      .limit(1);
    if (!activeRun) return { status: "inactive" };

    const [[activeSubmission], [outstandingSubmissionStep]] = await Promise.all([
      transaction
        .select({ id: threadLabelBatchSubmissions.id })
        .from(threadLabelBatchSubmissions)
        .where(
          and(
            eq(threadLabelBatchSubmissions.accountId, input.accountId),
            inArray(threadLabelBatchSubmissions.status, [
              "preparing",
              "submitted",
            ]),
          ),
        )
        .limit(1),
      transaction
        .select({ id: workflowSteps.id })
        .from(workflowSteps)
        .where(
          and(
            eq(workflowSteps.userId, input.userId),
            eq(workflowSteps.accountId, input.accountId),
            eq(workflowSteps.stepType, "label.batch.submit"),
            inArray(workflowSteps.status, ["queued", "running"]),
          ),
        )
        .limit(1),
    ]);
    if (activeSubmission || outstandingSubmissionStep) return { status: "busy" };

    const candidates = await listThreadLabelBatchCandidateRows(
      {
        userId: input.userId,
        accountId: input.accountId,
        activeRunId: input.runId,
        flushRemainder: false,
        limit: THREAD_LABEL_BATCH_START_THRESHOLD,
      },
      transaction,
    );
    if (candidates.length < THREAD_LABEL_BATCH_START_THRESHOLD) {
      return {
        status: "below_threshold",
        candidateCount: candidates.length,
      };
    }

    const stepId = await enqueueThreadLabelBatchSubmission(
      {
        userId: input.userId,
        accountId: input.accountId,
        sourceKey: input.sourceKey,
        flushRemainder: false,
      },
      transaction,
    );
    return {
      status: "enqueued",
      candidateCount: candidates.length,
      stepId,
    };
  });
}

export type InitialSyncLiveThreadLabelResult =
  | { status: "inactive" }
  | { status: "enqueued"; enqueuedCount: number; remainingBudget: number };

export async function enqueueInitialSyncLiveThreadLabelAnalyses(
  input: {
    runId: string;
    userId: string;
    accountId: string;
    threadIds: string[];
    hotWindowDays: number;
    maxThreads: number;
  },
  database: Database = getDatabase(),
): Promise<InitialSyncLiveThreadLabelResult> {
  const threadIds = Array.from(new Set(input.threadIds));
  return database.transaction(async (transaction) => {
    await lockThreadLabelBatchAccount(input.accountId, transaction);
    const [activeRun] = await transaction
      .select({ id: mailSyncRuns.id, createdAt: mailSyncRuns.createdAt })
      .from(mailSyncRuns)
      .where(
        and(
          eq(mailSyncRuns.id, input.runId),
          eq(mailSyncRuns.userId, input.userId),
          eq(mailSyncRuns.accountId, input.accountId),
          inArray(mailSyncRuns.status, ["queued", "running"]),
        ),
      )
      .limit(1);
    if (!activeRun) return { status: "inactive" };

    const [usedBudget] = await transaction
      .select({ count: sql<number>`count(*)::int` })
      .from(workflowSteps)
      .where(
        and(
          eq(workflowSteps.runId, input.runId),
          eq(workflowSteps.accountId, input.accountId),
          eq(workflowSteps.stepType, "label.thread.assign"),
        ),
      );
    const budget = input.maxThreads - (usedBudget?.count ?? 0);
    if (budget <= 0 || threadIds.length === 0) {
      return {
        status: "enqueued",
        enqueuedCount: 0,
        remainingBudget: Math.max(budget, 0),
      };
    }

    // The cutoff anchors to the run's creation time, not now(), so step
    // retries reserve a deterministic hot window.
    const cutoff = new Date(
      activeRun.createdAt.getTime() -
        input.hotWindowDays * 24 * 60 * 60 * 1000,
    );
    const candidates = await listLiveThreadLabelCandidates(
      {
        userId: input.userId,
        accountId: input.accountId,
        threadIds,
        latestMessageAtCutoff: cutoff,
        limit: budget,
      },
      transaction,
    );
    let enqueuedCount = 0;
    for (const candidate of candidates) {
      const enqueued = await enqueueThreadLabelAnalysisWithExecutor(
        {
          userId: input.userId,
          accountId: input.accountId,
          threadId: candidate.threadId,
          analysisVersion: candidate.analysisVersion,
          lane: "live",
          runId: input.runId,
        },
        transaction,
      );
      if (enqueued) enqueuedCount += 1;
    }
    return {
      status: "enqueued",
      enqueuedCount,
      remainingBudget: budget - enqueuedCount,
    };
  });
}

function inboxThreadConditionForBatch() {
  return sql<boolean>`exists (
    select 1
    from ${messages} batch_inbox_message
    where batch_inbox_message.thread_id = ${threads.id}
      and ${inboxMembership(sql.raw("batch_inbox_message.id"))}
  )`;
}

async function hydrateThreadLabelBatchCandidates(
  input: {
    manifest: ThreadLabelBatchManifestEntry[];
    definitions: ThreadLabelDefinition[];
  },
  database: DatabaseExecutor,
): Promise<ThreadLabelBatchCandidate[]> {
  if (input.manifest.length === 0) return [];
  const threadIds = input.manifest.map((entry) => entry.threadId);
  const [threadRows, messageRows] = await Promise.all([
    database
      .select({ id: threads.id, subject: threads.subject })
      .from(threads)
      .where(inArray(threads.id, threadIds)),
    database
      .select({
        threadId: messages.threadId,
        subject: messages.subject,
        sender: messages.sender,
        recipients: messages.recipients,
        bodyText: messages.bodyText,
        sentAt: messages.sentAt,
      })
      .from(messages)
      .where(
        and(
          inArray(messages.threadId, threadIds),
          inboxMembership(messages.id),
          sql<boolean>`${messages.id} in (
            select bounded_batch_message.id
            from ${messages} bounded_batch_message
            where bounded_batch_message.thread_id = ${messages.threadId}
              and ${inboxMembership(sql.raw("bounded_batch_message.id"))}
            order by bounded_batch_message.sent_at desc, bounded_batch_message.id desc
            limit 20
          )`,
        ),
      )
      .orderBy(asc(messages.threadId), asc(messages.sentAt), asc(messages.id)),
  ]);
  const subjectsByThreadId = new Map(
    threadRows.map((thread) => [thread.id, thread.subject]),
  );
  const messagesByThreadId = new Map<
    string,
    ThreadLabelBatchCandidate["thread"]["messages"]
  >();
  for (const message of messageRows) {
    const current = messagesByThreadId.get(message.threadId) ?? [];
    current.push({
      subject: message.subject,
      sender: message.sender.raw,
      recipients: message.recipients,
      bodyText: message.bodyText,
      sentAt: message.sentAt.toISOString(),
    });
    messagesByThreadId.set(message.threadId, current);
  }
  return input.manifest.flatMap((entry) => {
    const subject = subjectsByThreadId.get(entry.threadId);
    const threadMessages = messagesByThreadId.get(entry.threadId);
    return subject === undefined || !threadMessages?.length
      ? []
      : [{
          ...entry,
          thread: { subject, messages: threadMessages },
          definitions: input.definitions,
        }];
  });
}

export async function getThreadLabelBatchSubmissionForStep(
  workflowStepId: string,
  database: Database = getDatabase(),
) {
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
    userId: string;
    accountId: string;
    flushRemainder: boolean;
    modelId: string;
    threadIds?: string[];
  },
  database: Database = getDatabase(),
): Promise<null | {
  submissionId: string;
  candidates: ThreadLabelBatchCandidate[];
}> {
  return database.transaction(async (transaction) => {
    await lockThreadLabelBatchAccount(input.accountId, transaction);
    const [account] = await transaction
      .select({ id: connectedAccounts.id })
      .from(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.id, input.accountId),
          eq(connectedAccounts.userId, input.userId),
          eq(connectedAccounts.status, "connected"),
        ),
      )
      .for("update")
      .limit(1);
    if (!account) {
      throw new Error("The thread-label Batch account is unavailable.");
    }
    const [existing] = await transaction
      .select()
      .from(threadLabelBatchSubmissions)
      .where(eq(threadLabelBatchSubmissions.workflowStepId, input.workflowStepId))
      .limit(1);
    if (existing) {
      const snapshot = await getDefinitionSnapshot(input.accountId, transaction);
      return {
        submissionId: existing.id,
        candidates: await hydrateThreadLabelBatchCandidates(
          { manifest: existing.manifest, definitions: snapshot.definitions },
          transaction,
        ),
      };
    }

    const [activeSubmission] = await transaction
      .select({ id: threadLabelBatchSubmissions.id })
      .from(threadLabelBatchSubmissions)
      .where(
        and(
          eq(threadLabelBatchSubmissions.accountId, input.accountId),
          inArray(threadLabelBatchSubmissions.status, [
            "preparing",
            "submitted",
          ]),
        ),
      )
      .limit(1);
    if (activeSubmission) return null;

    const [activeRun] = await transaction
      .select({ id: mailSyncRuns.id })
      .from(mailSyncRuns)
      .where(
        and(
          eq(mailSyncRuns.accountId, input.accountId),
          inArray(mailSyncRuns.status, ["queued", "running"]),
        ),
      )
      .limit(1);
    const shouldFlushRemainder = input.flushRemainder && !activeRun;

    await ensureBuiltInInvookLabels(
      { userId: input.userId, accountId: input.accountId },
      transaction,
    );
    const currentSnapshot = await getDefinitionSnapshot(
      input.accountId,
      transaction,
    );
    const rows = await listThreadLabelBatchCandidateRows(
      {
        userId: input.userId,
        accountId: input.accountId,
        activeRunId: activeRun?.id ?? null,
        candidateThreadIds: input.threadIds,
        flushRemainder: shouldFlushRemainder,
        limit: THREAD_LABEL_BATCH_REQUEST_LIMIT + 1,
      },
      transaction,
    );
    if (
      rows.length === 0 ||
      (!input.threadIds &&
        !shouldFlushRemainder &&
        rows.length < THREAD_LABEL_BATCH_START_THRESHOLD)
    ) {
      return null;
    }
    const selected = rows.slice(0, THREAD_LABEL_BATCH_REQUEST_LIMIT);
    const manifest: ThreadLabelBatchManifestEntry[] = selected.map((thread) => ({
      threadId: thread.threadId,
      analysisVersion: thread.analysisVersion,
      definitionHash: currentSnapshot.definitionHash,
      fallbackLabelId: currentSnapshot.fallback.id,
    }));
    const [submission] = await transaction
      .insert(threadLabelBatchSubmissions)
      .values({
        workflowStepId: input.workflowStepId,
        userId: input.userId,
        accountId: input.accountId,
        modelId: input.modelId,
        definitionHash: currentSnapshot.definitionHash,
        flushRemainder: shouldFlushRemainder,
        hasMore: rows.length > THREAD_LABEL_BATCH_REQUEST_LIMIT,
        requestCount: manifest.length,
        manifest,
      })
      .returning({ id: threadLabelBatchSubmissions.id });
    if (!submission) throw new Error("The thread-label Batch could not be claimed.");
    await transaction
      .update(threads)
      .set({
        labelAnalysisState: "running",
        labelAnalysisDefinitionHash: currentSnapshot.definitionHash,
        labelAnalysisError: null,
        updatedAt: new Date(),
      })
      .where(inArray(threads.id, selected.map((thread) => thread.threadId)));
    return {
      submissionId: submission.id,
      candidates: await hydrateThreadLabelBatchCandidates(
        { manifest, definitions: currentSnapshot.definitions },
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
) {
  return database.transaction(async (transaction) => {
    const [submission] = await transaction
      .update(threadLabelBatchSubmissions)
      .set({
        manifest: input.manifest,
        requestCount: input.manifest.length,
        hasMore: sql`${threadLabelBatchSubmissions.hasMore} or ${input.excludedThreadIds.length > 0}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(threadLabelBatchSubmissions.id, input.submissionId),
          eq(threadLabelBatchSubmissions.status, "preparing"),
          isNull(threadLabelBatchSubmissions.inputFileId),
          isNull(threadLabelBatchSubmissions.providerBatchId),
        ),
      )
      .returning();
    if (!submission) {
      const [current] = await transaction
        .select()
        .from(threadLabelBatchSubmissions)
        .where(eq(threadLabelBatchSubmissions.id, input.submissionId))
        .limit(1);
      if (!current) throw new Error("The thread-label Batch was not found.");
      return current;
    }
    if (input.excludedThreadIds.length > 0) {
      await transaction
        .update(threads)
        .set({ labelAnalysisState: "pending", updatedAt: new Date() })
        .where(
          and(
            inArray(threads.id, input.excludedThreadIds),
            eq(threads.labelAnalysisState, "running"),
            eq(threads.labelAnalysisDefinitionHash, submission.definitionHash),
          ),
        );
    }
    return submission;
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
  if (!submission?.inputFileId) {
    throw new Error("The thread-label Batch input file could not be recorded.");
  }
  return submission.inputFileId;
}

export async function recordThreadLabelProviderBatch(
  input: { submissionId: string; providerBatchId: string; inputFileId: string },
  database: Database = getDatabase(),
) {
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
  if (!submission) throw new Error("The OpenAI thread-label Batch could not be recorded.");
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
        eq(threadLabelBatchSubmissions.status, "submitted"),
        sql`${threadLabelBatchSubmissions.providerBatchId} is not null`,
      ),
    );
  return rows.flatMap((row) => row.providerBatchId ? [row.providerBatchId] : []);
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
    const providerErrorCode = input.providerErrorCode
      ? toPostgresTextProjection(input.providerErrorCode)
      : null;
    const [identity] = await transaction
      .select({
        accountId: threadLabelBatchSubmissions.accountId,
        workflowInput: workflowSteps.input,
      })
      .from(threadLabelBatchSubmissions)
      .innerJoin(
        workflowSteps,
        eq(workflowSteps.id, threadLabelBatchSubmissions.workflowStepId),
      )
      .where(eq(threadLabelBatchSubmissions.id, input.submissionId))
      .limit(1);
    if (!identity) throw new Error("The thread-label Batch could not be matched.");
    await lockThreadLabelBatchAccount(identity.accountId, transaction);
    const [submission] = await transaction
      .select()
      .from(threadLabelBatchSubmissions)
      .where(eq(threadLabelBatchSubmissions.id, input.submissionId))
      .for("update")
      .limit(1);
    if (!submission) throw new Error("The thread-label Batch could not be matched.");
    if (submission.status === "complete" || submission.status === "failed") {
      return { alreadyFinalized: true, appliedCount: 0, continuationStepId: null };
    }
    if (submission.status !== "submitted") {
      throw new Error(`The thread-label Batch is ${submission.status}.`);
    }
    const manifestByThreadId = new Map(
      submission.manifest.map((entry) => [entry.threadId, entry]),
    );
    const snapshot = await getDefinitionSnapshot(submission.accountId, transaction);
    const definitionsById = new Map(
      [...snapshot.definitions, snapshot.fallback].map((definition) => [
        definition.id,
        definition,
      ]),
    );
    const appliedThreadIds: string[] = [];
    const shouldReplan = snapshot.definitionHash !== submission.definitionHash;
    if (!shouldReplan) {
      for (const result of input.results) {
        const checkpoint = manifestByThreadId.get(result.threadId);
        const definition = definitionsById.get(result.labelId);
        if (
          !checkpoint ||
          !definition ||
          !Number.isFinite(result.confidence) ||
          result.confidence < 0 ||
          result.confidence > 100
        ) {
          continue;
        }
        const [thread] = await transaction
          .select({
            id: threads.id,
            analysisVersion: threads.labelAnalysisVersion,
            assignmentSource: threadLabelAssignments.source,
          })
          .from(threads)
          .leftJoin(
            threadLabelAssignments,
            eq(threadLabelAssignments.threadId, threads.id),
          )
          .where(
            and(
              eq(threads.id, checkpoint.threadId),
              eq(threads.userId, submission.userId),
              eq(threads.accountId, submission.accountId),
              eq(threads.labelAnalysisState, "running"),
              eq(
                threads.labelAnalysisDefinitionHash,
                submission.definitionHash,
              ),
              inboxThreadConditionForBatch(),
            ),
          )
          .for("update", { of: threads })
          .limit(1);
        if (
          !thread ||
          thread.assignmentSource === "user" ||
          thread.analysisVersion !== checkpoint.analysisVersion ||
          checkpoint.definitionHash !== submission.definitionHash
        ) {
          continue;
        }
        const assignmentSaved = await saveAiThreadLabelAssignment(
          {
            userId: submission.userId,
            accountId: submission.accountId,
            threadId: thread.id,
            labelId: definition.id,
            confidence: result.confidence,
            modelId: input.modelId,
            definitionVersion: definition.definitionVersion,
          },
          transaction,
        );
        if (!assignmentSaved) continue;
        await transaction
          .update(threads)
          .set({
            labelAnalysisState: "complete",
            labelAnalysisError: null,
            labelAnalyzedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(threads.id, thread.id));
        appliedThreadIds.push(thread.id);
      }
    }
    const rawRetryAttempt = identity.workflowInput.retryAttempt;
    const retryAttempt =
      typeof rawRetryAttempt === "number" &&
      Number.isInteger(rawRetryAttempt) &&
      rawRetryAttempt >= 0
        ? rawRetryAttempt
        : 0;
    const canRetry = retryAttempt < THREAD_LABEL_BATCH_RETRY_LIMIT;
    const shouldRetryFailures =
      canRetry &&
      (shouldReplan ||
        input.retryableFailure ||
        input.providerState === "completed");
    const failedIds = Array.from(
      new Set([
        ...input.failedThreadIds,
        ...submission.manifest
          .map((entry) => entry.threadId)
          .filter((threadId) => !appliedThreadIds.includes(threadId)),
      ]),
    );
    let retriedThreadIds: string[] = [];
    if (failedIds.length > 0) {
      const unresolvedThreads = await transaction
        .update(threads)
        .set({
          labelAnalysisState: shouldRetryFailures ? "pending" : "failed",
          labelAnalysisError: shouldReplan
            ? null
            : providerErrorCode ??
              (input.providerState === "completed"
                ? "openai_batch_invalid_result"
                : `openai_batch_${input.providerState}`),
          labelAnalyzedAt: shouldRetryFailures ? null : new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            inArray(threads.id, failedIds),
            eq(threads.labelAnalysisState, "running"),
            eq(threads.labelAnalysisDefinitionHash, submission.definitionHash),
            automaticThreadLabelAssignmentAllowed(),
          ),
        )
        .returning({ id: threads.id });
      if (shouldRetryFailures) {
        retriedThreadIds = unresolvedThreads.map((thread) => thread.id);
      }
    }
    await transaction
      .update(threadLabelBatchSubmissions)
      .set({
        status: input.providerState === "completed" ? "complete" : "failed",
        providerState: input.providerState,
        outputFileId: input.outputFileId,
        errorFileId: input.errorFileId,
        lastError: providerErrorCode,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(threadLabelBatchSubmissions.id, submission.id));
    if (appliedThreadIds.length > 0) {
      await insertMailboxChange(transaction, {
        userId: submission.userId,
        accountId: submission.accountId,
        changeType: "labels_changed",
        payload: {
          kind: "analysis_resolution",
          affectedThreadIds: appliedThreadIds,
        },
      });
    }
    const retryStepId =
      retriedThreadIds.length > 0
        ? await enqueueThreadLabelBatchSubmission(
            {
              userId: submission.userId,
              accountId: submission.accountId,
              sourceKey: `${input.retryableFailure ? "provider" : shouldReplan ? "definition" : "result"}-retry:${submission.id}:${retryAttempt + 1}`,
              flushRemainder: true,
              retryAttempt: retryAttempt + 1,
              threadIds: retriedThreadIds,
              ...(input.retryableFailure
                ? {
                    runAt: new Date(
                      Date.now() + THREAD_LABEL_CAPACITY_RETRY_DELAY_MS,
                    ),
                  }
                : {}),
            },
            transaction,
          )
        : null;
    const [pendingContinuation] =
      !retryStepId &&
      !submission.hasMore &&
      (input.providerState === "completed" || shouldReplan)
        ? await transaction
            .select({ id: threads.id })
            .from(threads)
            .leftJoin(
              threadLabelAssignments,
              eq(threadLabelAssignments.threadId, threads.id),
            )
            .where(
              and(
                eq(threads.userId, submission.userId),
                eq(threads.accountId, submission.accountId),
                eq(threads.labelAnalysisState, "pending"),
                automaticThreadLabelAssignmentAllowed(),
                inboxThreadConditionForBatch(),
              ),
            )
            .limit(1)
        : [];
    const shouldContinueImmediately =
      !retryStepId &&
      (input.providerState === "completed" || shouldReplan) &&
      (submission.hasMore || Boolean(pendingContinuation));
    const continuationStepId =
      retryStepId ??
      (shouldContinueImmediately
        ? await enqueueThreadLabelBatchSubmission(
            {
              userId: submission.userId,
              accountId: submission.accountId,
              sourceKey: `continue:${submission.id}`,
              // While synchronization is active the claim path still enforces the
              // start threshold. Once synchronization completes, this guarantees
              // that the final partial group is not stranded behind an earlier Batch.
              flushRemainder: true,
            },
            transaction,
          )
        : null);
    return {
      alreadyFinalized: false,
      appliedCount: appliedThreadIds.length,
      continuationStepId,
    };
  });
}

export async function requeueRetryableThreadLabelBatchFailures(
  database: Database = getDatabase(),
): Promise<number> {
  return database.transaction(async (transaction) => {
    const submissions = await transaction
      .select({
        id: threadLabelBatchSubmissions.id,
        userId: threadLabelBatchSubmissions.userId,
        accountId: threadLabelBatchSubmissions.accountId,
        manifest: threadLabelBatchSubmissions.manifest,
      })
      .from(threadLabelBatchSubmissions)
      .where(
        and(
          eq(threadLabelBatchSubmissions.providerState, "failed"),
          sql<boolean>`(
            ${threadLabelBatchSubmissions.status} = 'complete'
            or ${threadLabelBatchSubmissions.lastError} ilike 'Enqueued token limit reached%'
          )`,
        ),
      );
    let requeuedCount = 0;
    for (const submission of submissions) {
      await lockThreadLabelBatchAccount(submission.accountId, transaction);
      const requeuedThreadIds: string[] = [];
      for (let offset = 0; offset < submission.manifest.length; offset += 500) {
        const threadIds = submission.manifest
          .slice(offset, offset + 500)
          .map((entry) => entry.threadId);
        const requeued = await transaction
          .update(threads)
          .set({
            labelAnalysisState: "pending",
            labelAnalysisError: THREAD_LABEL_CAPACITY_ERROR_CODE,
            labelAnalyzedAt: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              inArray(threads.id, threadIds),
              eq(threads.labelAnalysisState, "failed"),
              automaticThreadLabelAssignmentAllowed(),
            ),
          )
          .returning({ id: threads.id });
        requeuedCount += requeued.length;
        requeuedThreadIds.push(...requeued.map((thread) => thread.id));
      }
      await transaction
        .update(threadLabelBatchSubmissions)
        .set({
          status: "failed",
          lastError: THREAD_LABEL_CAPACITY_ERROR_CODE,
          updatedAt: new Date(),
        })
        .where(eq(threadLabelBatchSubmissions.id, submission.id));
      if (requeuedThreadIds.length > 0) {
        await enqueueThreadLabelBatchSubmission(
          {
            userId: submission.userId,
            accountId: submission.accountId,
            sourceKey: `recovered-capacity:${submission.id}`,
            flushRemainder: true,
            retryAttempt: 1,
            threadIds: requeuedThreadIds,
          },
          transaction,
        );
      }
    }

    const completedSubmissions = await transaction
      .select({
        id: threadLabelBatchSubmissions.id,
        userId: threadLabelBatchSubmissions.userId,
        accountId: threadLabelBatchSubmissions.accountId,
        manifest: threadLabelBatchSubmissions.manifest,
        workflowInput: workflowSteps.input,
      })
      .from(threadLabelBatchSubmissions)
      .innerJoin(
        workflowSteps,
        eq(workflowSteps.id, threadLabelBatchSubmissions.workflowStepId),
      )
      .where(
        and(
          eq(threadLabelBatchSubmissions.status, "complete"),
          eq(threadLabelBatchSubmissions.providerState, "completed"),
        ),
      );
    for (const submission of completedSubmissions) {
      const rawRetryAttempt = submission.workflowInput.retryAttempt;
      const retryAttempt =
        typeof rawRetryAttempt === "number" &&
        Number.isInteger(rawRetryAttempt) &&
        rawRetryAttempt >= 0
          ? rawRetryAttempt
          : 0;
      if (retryAttempt >= THREAD_LABEL_BATCH_RETRY_LIMIT) continue;
      await lockThreadLabelBatchAccount(submission.accountId, transaction);
      const recoveredThreadIds: string[] = [];
      for (let offset = 0; offset < submission.manifest.length; offset += 500) {
        const threadIds = submission.manifest
          .slice(offset, offset + 500)
          .map((entry) => entry.threadId);
        const recovered = await transaction
          .update(threads)
          .set({
            labelAnalysisState: "pending",
            labelAnalysisError: "openai_batch_invalid_result",
            labelAnalyzedAt: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              inArray(threads.id, threadIds),
              eq(threads.labelAnalysisState, "failed"),
              inboxThreadConditionForBatch(),
              automaticThreadLabelAssignmentAllowed(),
            ),
          )
          .returning({ id: threads.id });
        recoveredThreadIds.push(...recovered.map((thread) => thread.id));
      }
      if (recoveredThreadIds.length === 0) continue;
      requeuedCount += recoveredThreadIds.length;
      await enqueueThreadLabelBatchSubmission(
        {
          userId: submission.userId,
          accountId: submission.accountId,
          sourceKey: `recovered-result:${submission.id}:${retryAttempt + 1}`,
          flushRemainder: true,
          retryAttempt: retryAttempt + 1,
          threadIds: recoveredThreadIds,
        },
        transaction,
      );
    }
    return requeuedCount;
  });
}

export async function enqueueStartupThreadLabelBatchSubmissions(
  database: Database = getDatabase(),
): Promise<number> {
  const accounts = await database
    .select({ userId: connectedAccounts.userId, accountId: connectedAccounts.id })
    .from(connectedAccounts)
    .where(eq(connectedAccounts.status, "connected"));
  let count = 0;
  for (const account of accounts) {
    await enqueueThreadLabelBatchSubmission(
      {
        ...account,
        sourceKey: `startup:hybrid-v1:${account.accountId}`,
        flushRemainder: true,
      },
      database,
    );
    count += 1;
  }
  return count;
}
