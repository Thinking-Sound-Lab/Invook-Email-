import { createHash } from "node:crypto";

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { getDatabase, type Database, type DatabaseExecutor } from "./client";
import {
  connectedAccounts,
  labels,
  messages,
  threadLabelAssignments,
  threads,
} from "./schema";
import { insertMailboxChange } from "./mailbox-change-events";
import { enqueueWorkflowStepWithExecutor } from "./workflows";

import {
  automaticThreadLabelCutoff,
  inboxMessageCondition,
  recentInboxThreadCondition,
} from "./thread-label-eligibility";

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

export type InboxThreadMessage = {
  id: string;
  subject: string;
  sender: { raw: string; email: string };
  recipients: string[];
  bodyText: string;
  sentAt: Date;
};

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
      : [
          {
            id: definition.id,
            name: definition.name,
            description: definition.description,
            definitionVersion: definition.definitionVersion,
          },
        ],
  );
  return {
    definitions,
    fallback,
    definitionHash: definitionHash(definitions, fallback),
  };
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
    .where(
      and(
        eq(messages.threadId, threadId),
        inboxMessageCondition(messages.id, messages.accountId),
      ),
    )
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

function connectedThreadAccountCondition() {
  return sql<boolean>`exists (
    select 1 from ${connectedAccounts} account
    where account.id = ${threads.accountId}
      and account.user_id = ${threads.userId}
      and account.status = 'connected'
  )`;
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
    after: Date;
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
      labelAnalysisAfter: input.after,
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
        inArray(threads.labelAnalysisState, ["pending", "not_requested"]),
        recentInboxThreadCondition(input.after),
        automaticThreadLabelAssignmentAllowed(),
        connectedThreadAccountCondition(),
      ),
    )
    .returning({ id: threads.id });
  if (!reserved) return null;
  const stepId = await enqueueWorkflowStepWithExecutor(
    {
      userId: input.userId,
      accountId: input.accountId,
      stepType: "label.thread.assign",
      payload: {
        threadId: input.threadId,
        analysisVersion: input.analysisVersion,
        definitionHash: snapshot.definitionHash,
        lane: "live",
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
    after: Date;
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
        inArray(threads.labelAnalysisState, ["pending", "not_requested"]),
        automaticThreadLabelAssignmentAllowed(),
        connectedThreadAccountCondition(),
        recentInboxThreadCondition(input.after),
      ),
    )
    .orderBy(desc(threads.latestMessageAt), desc(threads.id));
  return query;
}

export async function enqueueLiveInboxThreadLabelAnalyses(
  input: {
    userId: string;
    accountId: string;
    threadIds: string[];
    referenceAt?: Date;
  },
  database: DatabaseExecutor,
): Promise<number> {
  const threadIds = Array.from(new Set(input.threadIds));
  if (threadIds.length === 0) return 0;
  const after = automaticThreadLabelCutoff(input.referenceAt ?? new Date());
  const candidates = await listLiveThreadLabelCandidates(
    { userId: input.userId, accountId: input.accountId, threadIds, after },
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
        after,
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
        labelAnalysisAfter: threads.labelAnalysisAfter,
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
          connectedThreadAccountCondition(),
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
      thread.labelAnalysisState !== "running" ||
      !thread.labelAnalysisAfter
    ) {
      return { status: "resolved" };
    }
    const analysisAfter = thread.labelAnalysisAfter;
    const snapshot = await getDefinitionSnapshot(input.accountId, transaction);
    if (snapshot.definitionHash !== input.checkpoint.definitionHash) {
      await transaction
        .update(threads)
        .set({
          labelAnalysisState: "pending",
          labelAnalysisVersion: thread.labelAnalysisVersion + 1,
          updatedAt: new Date(),
        })
        .where(eq(threads.id, thread.id));
      await enqueueThreadLabelAnalysisWithExecutor(
        {
          userId: input.userId,
          accountId: input.accountId,
          threadId: thread.id,
          analysisVersion: thread.labelAnalysisVersion + 1,
          after: thread.labelAnalysisAfter,
        },
        transaction,
      );
      return { status: "superseded" };
    }
    const inboxMessages = await listInboxThreadMessages(thread.id, transaction);
    if (!inboxMessages.some((message) => message.sentAt >= analysisAfter)) {
      await transaction
        .update(threads)
        .set({ labelAnalysisState: "not_requested", labelAnalysisAfter: null })
        .where(eq(threads.id, thread.id));
      return { status: "ineligible" };
    }
    return {
      status: "ready",
      thread: {
        id: thread.id,
        subject: thread.subject,
        messages: inboxMessages,
      },
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
        labelAnalysisAfter: threads.labelAnalysisAfter,
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
          connectedThreadAccountCondition(),
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
      thread.labelAnalysisState !== "running" ||
      !thread.labelAnalysisAfter
    ) {
      return { status: "current" };
    }
    const analysisAfter = thread.labelAnalysisAfter;
    const snapshot = await getDefinitionSnapshot(input.accountId, transaction);
    if (snapshot.definitionHash !== input.checkpoint.definitionHash) {
      await transaction
        .update(threads)
        .set({
          labelAnalysisState: "pending",
          labelAnalysisVersion: thread.labelAnalysisVersion + 1,
          updatedAt: new Date(),
        })
        .where(eq(threads.id, thread.id));
      await enqueueThreadLabelAnalysisWithExecutor(
        {
          userId: input.userId,
          accountId: input.accountId,
          threadId: thread.id,
          analysisVersion: thread.labelAnalysisVersion + 1,
          after: thread.labelAnalysisAfter,
        },
        transaction,
      );
      return { status: "superseded" };
    }
    const selectedDefinition = [
      ...snapshot.definitions,
      snapshot.fallback,
    ].find((definition) => definition.id === input.labelId);
    if (
      !selectedDefinition ||
      !Number.isFinite(input.confidence) ||
      input.confidence < 0 ||
      input.confidence > 100
    ) {
      throw new Error(
        "The thread label result does not match current definitions.",
      );
    }
    const inboxMessages = await listInboxThreadMessages(thread.id, transaction);
    if (!inboxMessages.some((message) => message.sentAt >= analysisAfter)) {
      await transaction
        .update(threads)
        .set({ labelAnalysisState: "not_requested", labelAnalysisAfter: null })
        .where(eq(threads.id, thread.id));
      return { status: "superseded" };
    }
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
        labelAnalysisState: "failed",
        labelAnalysisError: input.errorCode,
        labelAnalyzedAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(threads.id, input.checkpoint.threadId),
          connectedThreadAccountCondition(),
          eq(threads.userId, input.userId),
          eq(threads.accountId, input.accountId),
          eq(threads.labelAnalysisVersion, input.checkpoint.analysisVersion),
          eq(
            threads.labelAnalysisDefinitionHash,
            input.checkpoint.definitionHash,
          ),
          eq(threads.labelAnalysisState, "running"),
          automaticThreadLabelAssignmentAllowed(),
          connectedThreadAccountCondition(),
        ),
      )
      .returning({ id: threads.id });
    if (!updated) return false;
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
            and ${inboxMessageCondition(sql.raw("preview_message.id"), threads.accountId)}
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
      .where(
        and(eq(threads.id, input.threadId), eq(threads.userId, input.userId)),
      )
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
      .returning({
        assignmentVersion: threadLabelAssignments.assignmentVersion,
      });
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
