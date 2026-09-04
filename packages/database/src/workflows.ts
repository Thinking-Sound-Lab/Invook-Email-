import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  not,
  or,
  sql,
} from "drizzle-orm";
import { validate as validateUuid } from "uuid";

import type { TenantTaskQueueLane } from "@invook/workflows";

import {
  getDatabase,
  type Database,
  type DatabaseExecutor,
} from "./client";
import {
  connectedAccounts,
  threadLabelBatchSubmissions,
  historicalThreadLabelScans,
  gmailAccountCleanups,
  gmailReplicaStates,
  gmailWatchStates,
  gmailSyncItems,
  gmailSyncPages,
  mailSyncRuns,
  messages,
  temporalCommands,
  threads,
  workflowSteps,
} from "./schema";
import {
  createGmailWatchRecoveryStep,
  createImmediateGmailRepairRecoveryStep,
} from "./gmail-watch-schedule";
import { hasMailSyncProgressAdvanced } from "./mail-sync-progress";
import { toPostgresTextProjection } from "./text";
import type { WorkflowStepInput, WorkflowStepJob } from "./types";
import { MEMORY_SCHEMA_VERSION } from "./versions";

export type TemporalCommandJob = WorkflowStepJob & {
  userId: string;
  activityTaskLane: TenantTaskQueueLane;
};

export const TEMPORAL_COMMAND_DISPATCH_BATCH_SIZE = 10;

const gmailConnectedAccountStepTypes = [
  "gmail.sync.run",
  "gmail.message.refresh",
  "gmail.history.catchup",
  "gmail.watch.renew",
] as const;

const gmailReplicaStepTypes = [
  "gmail.history.catchup",
  "gmail.watch.renew",
] as const;
const gmailReplicaStepTypeSet = new Set<string>(gmailReplicaStepTypes);

async function lockMailSyncRun(
  input: { runId: string; accountId?: string; allowCompleted?: boolean },
  database: DatabaseExecutor,
) {
  const allowedStatuses = input.allowCompleted
    ? (["queued", "running", "complete"] as const)
    : (["queued", "running"] as const);
  const conditions = [
    eq(mailSyncRuns.id, input.runId),
    inArray(mailSyncRuns.status, allowedStatuses),
  ];
  if (input.accountId) {
    conditions.push(eq(mailSyncRuns.accountId, input.accountId));
  }
  const [run] = await database
    .select({
      id: mailSyncRuns.id,
      userId: mailSyncRuns.userId,
      accountId: mailSyncRuns.accountId,
      runType: mailSyncRuns.runType,
      discoveryComplete: mailSyncRuns.discoveryComplete,
    })
    .from(mailSyncRuns)
    .where(and(...conditions))
    .for("update")
    .limit(1);
  return run ?? null;
}

async function terminalizeMailSyncRun(
  input: {
    runId: string;
    message: string;
    failedAt: Date;
  },
  database: Database,
): Promise<{ accountId: string; runType: "initial" | "repair" } | null> {
  const run = await lockMailSyncRun({ runId: input.runId }, database);
  if (!run) return null;

  await database
    .update(gmailSyncItems)
    .set({
      status: "failed",
      lastError: input.message,
      completedAt: input.failedAt,
      updatedAt: input.failedAt,
    })
    .where(
      and(
        eq(gmailSyncItems.runId, input.runId),
        inArray(gmailSyncItems.status, ["queued", "running"]),
      ),
    );
  await database
    .update(workflowSteps)
    .set({
      status: "failed",
      lastError: input.message,
      completedAt: input.failedAt,
      updatedAt: input.failedAt,
    })
    .where(
      and(
        eq(workflowSteps.runId, input.runId),
        inArray(workflowSteps.status, ["queued", "running"]),
      ),
    );

  const counts = await getItemCounts(input.runId, database);
  await database
    .update(mailSyncRuns)
    .set({
      status: "failed",
      discoveredThreadCount: counts.total,
      processedThreadCount: counts.complete,
      failedThreadCount: counts.failed,
      lastError: input.message,
      completedAt: input.failedAt,
      updatedAt: input.failedAt,
    })
    .where(eq(mailSyncRuns.id, input.runId));
  const [account] = await database
    .update(connectedAccounts)
    .set({
      syncState: sql`jsonb_set(${connectedAccounts.syncState}, '{mailSync}', to_jsonb(${"failed"}::text), true)`,
      updatedAt: input.failedAt,
    })
    .where(eq(connectedAccounts.id, run.accountId))
    .returning({ id: connectedAccounts.id });
  await database
    .update(gmailReplicaStates)
    .set({ state: "failed", lastError: input.message, updatedAt: input.failedAt })
    .where(eq(gmailReplicaStates.accountId, run.accountId));
  if (account) {
    await database.execute(
      sql`select pg_notify('invook_account_sync', ${JSON.stringify({ accountId: run.accountId })})`,
    );
  }
  return { accountId: run.accountId, runType: run.runType };
}

async function enqueueImmediateGmailRepairRecovery(
  input: { accountId: string; failedRunId: string; failedAt: Date },
  database: Database,
): Promise<void> {
  const [account] = await database
    .select({ userId: connectedAccounts.userId })
    .from(connectedAccounts)
    .where(
      and(
        eq(connectedAccounts.id, input.accountId),
        eq(connectedAccounts.status, "connected"),
      ),
    )
    .limit(1);
  if (!account) return;
  await enqueueWorkflowStepsWithExecutor(
    [
      createImmediateGmailRepairRecoveryStep({
        userId: account.userId,
        accountId: input.accountId,
        failedRunId: input.failedRunId,
        now: input.failedAt,
      }),
    ],
    database,
  );
}

async function terminalizeGmailAccountForReconnect(
  input: { accountId: string; message: string; failedAt: Date },
  database: Database,
): Promise<boolean> {
  const activeRuns = await database
    .select({ id: mailSyncRuns.id })
    .from(mailSyncRuns)
    .where(
      and(
        eq(mailSyncRuns.accountId, input.accountId),
        inArray(mailSyncRuns.status, ["queued", "running"]),
      ),
    );
  for (const run of activeRuns) {
    await terminalizeMailSyncRun(
      {
        runId: run.id,
        message: input.message,
        failedAt: input.failedAt,
      },
      database,
    );
  }

  await database
    .update(workflowSteps)
    .set({
      status: "failed",
      lastError: input.message,
      completedAt: input.failedAt,
      updatedAt: input.failedAt,
    })
    .where(
      and(
        eq(workflowSteps.accountId, input.accountId),
        inArray(workflowSteps.stepType, [...gmailConnectedAccountStepTypes]),
        inArray(workflowSteps.status, ["queued", "running"]),
      ),
    );
  const [account] = await database
    .update(connectedAccounts)
    .set({
      status: "reconnect_required",
      syncState: sql`jsonb_set(${connectedAccounts.syncState}, '{mailSync}', to_jsonb(${"failed"}::text), true)`,
      updatedAt: input.failedAt,
    })
    .where(
      and(
        eq(connectedAccounts.id, input.accountId),
        not(eq(connectedAccounts.status, "disconnected")),
      ),
    )
    .returning({
      id: connectedAccounts.id,
    });
  if (!account) return false;
  await database
    .update(gmailReplicaStates)
    .set({ state: "failed", lastError: input.message, updatedAt: input.failedAt })
    .where(eq(gmailReplicaStates.accountId, input.accountId));
  if (activeRuns.length === 0) {
    await database.execute(
      sql`select pg_notify('invook_account_sync', ${JSON.stringify({ accountId: input.accountId })})`,
    );
  }
  return true;
}

export async function markGmailAccountReconnectRequired(
  input: { accountId: string; errorCode: string },
  database: Database = getDatabase(),
): Promise<boolean> {
  const message = toPostgresTextProjection(input.errorCode);
  return database.transaction((transaction) =>
    terminalizeGmailAccountForReconnect(
      { accountId: input.accountId, message, failedAt: new Date() },
      transaction as unknown as Database,
    ),
  );
}

export function tenantTaskQueueLaneForStepType(
  stepType: string,
): TenantTaskQueueLane {
  switch (stepType) {
    case "gmail.sync.run":
    case "gmail.account.cleanup":
    case "gmail.objects.delete":
    case "memory.extract":
    case "memory.batch.retry":
    case "label.recent.scan":
    case "label.batch.submit":
    case "label.batch.event":
      return "bulk";
    case "gmail.history.catchup":
    case "gmail.message.refresh":
    case "gmail.watch.renew":
      return "control";
    case "memory.incremental":
    case "memory.batch.event":
    case "memory.feedback":
    case "label.thread.assign":
      return "live";
    default:
      throw new Error(`Unsupported workflow step type: ${stepType}`);
  }
}

export function tenantTaskQueueLaneForStep(
  input: Pick<WorkflowStepInput, "stepType">,
): TenantTaskQueueLane {
  return tenantTaskQueueLaneForStepType(input.stepType);
}

export function temporalCommandPriority(
  stepType: string,
): number {
  if (
    stepType === "gmail.history.catchup" ||
    stepType === "label.thread.assign" ||
    stepType === "label.batch.event"
  ) {
    return 0;
  }
  return 1;
}

/**
 * `superseded` means another run has taken ownership of the account, so the
 * caller must stop rather than compete with it.
 */
export type MailSyncPageRecord =
  | { status: "recorded"; pendingThreadIds: string[] }
  | { status: "superseded" };

/**
 * The admission record that hands a synchronization run to Temporal.
 *
 * The step exists only so the transaction that creates the run and the command
 * that starts `gmailSyncWorkflow` commit together. Temporal owns pagination,
 * ingestion, and retries once it acknowledges the command, so the step carries
 * no cursor and is completed as soon as dispatch succeeds.
 */
export function createGmailSyncRunStep(input: {
  runId: string;
  userId: string;
  accountId: string;
}): WorkflowStepInput {
  return {
    runId: input.runId,
    userId: input.userId,
    accountId: input.accountId,
    stepType: "gmail.sync.run",
    payload: { runId: input.runId },
    idempotencyKey: `gmail-sync-run:${input.runId}`,
  };
}

export async function enqueueWorkflowStepsWithExecutor(
  inputs: WorkflowStepInput[],
  database: DatabaseExecutor,
): Promise<Array<{ id: string; idempotencyKey: string }>> {
  if (inputs.length === 0) return [];
  const inserted = await database
    .insert(workflowSteps)
    .values(
      inputs.map((input) => ({
        runId: input.runId ?? null,
        userId: input.userId ?? null,
        accountId: input.accountId ?? null,
        stepType: input.stepType,
        status: "queued" as const,
        input: input.payload ?? {},
        attempts: 0,
        maxAttempts: input.maxAttempts ?? 5,
        idempotencyKey: input.idempotencyKey,
      })),
    )
    .onConflictDoNothing({ target: workflowSteps.idempotencyKey })
    .returning({
      id: workflowSteps.id,
      idempotencyKey: workflowSteps.idempotencyKey,
    });

  if (inserted.length > 0) {
    const byIdempotencyKey = new Map(
      inputs.map((input) => [input.idempotencyKey, input] as const),
    );
    await database.insert(temporalCommands).values(
      inserted.map((step) => ({
        workflowStepId: step.id,
        activityTaskLane: tenantTaskQueueLaneForStep(
          byIdempotencyKey.get(step.idempotencyKey)!,
        ),
      })),
    );
  }
  return inserted;
}

export async function enqueueWorkflowStepWithExecutor(
  input: WorkflowStepInput,
  database: DatabaseExecutor,
): Promise<string> {
  const [inserted] = await enqueueWorkflowStepsWithExecutor([input], database);
  if (inserted) return inserted.id;

  const [existing] = await database
    .select({ id: workflowSteps.id, status: workflowSteps.status })
    .from(workflowSteps)
    .where(eq(workflowSteps.idempotencyKey, input.idempotencyKey))
    .limit(1);
  if (!existing) throw new Error("The workflow step could not be created.");
  if (existing.status === "queued" || existing.status === "running") {
    await database
      .insert(temporalCommands)
      .values({
        workflowStepId: existing.id,
        activityTaskLane: tenantTaskQueueLaneForStep(input),
      })
      .onConflictDoNothing({ target: temporalCommands.workflowStepId });
  }
  return existing.id;
}

export function createPostSyncDerivationSteps(input: {
  userId: string;
  accountId: string;
  historyCursor: string;
}): WorkflowStepInput[] {
  return [
    {
      userId: input.userId,
      accountId: input.accountId,
      stepType: "memory.extract",
      payload: { schemaVersion: MEMORY_SCHEMA_VERSION },
      idempotencyKey: `memory.extract:${input.accountId}:${MEMORY_SCHEMA_VERSION}:${input.historyCursor}`,
    },
  ];
}

export async function enqueueWorkflowStep(
  input: WorkflowStepInput,
  database: Database = getDatabase(),
): Promise<string> {
  return database.transaction((transaction) =>
    enqueueWorkflowStepWithExecutor(input, transaction),
  );
}

async function createMailSyncRun(
  input: {
    userId: string;
    accountId: string;
    startingHistoryCursor: string;
    runType: "initial" | "repair";
  },
  database: Database = getDatabase(),
): Promise<string> {
  return database.transaction(async (transaction) => {
    const executor = transaction as unknown as Database;
    const [account] = await transaction
      .select({ id: connectedAccounts.id, userId: connectedAccounts.userId })
      .from(connectedAccounts)
      .where(eq(connectedAccounts.id, input.accountId))
      .for("update")
      .limit(1);
    if (!account || account.userId !== input.userId) {
      throw new Error("The Gmail account is unavailable for synchronization.");
    }

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
    const idempotencyKey =
      input.runType === "initial"
        ? `gmail.initial-sync:${input.accountId}`
        : `gmail.repair-sync:${input.accountId}:${input.startingHistoryCursor}`;
    const [inserted] = activeRun
      ? []
      : await transaction
          .insert(mailSyncRuns)
          .values({
            userId: input.userId,
            accountId: input.accountId,
            runType: input.runType,
            startingHistoryCursor: input.startingHistoryCursor,
            idempotencyKey,
          })
          .onConflictDoNothing()
          .returning({ id: mailSyncRuns.id });

    let runId = activeRun?.id ?? inserted?.id;
    let active = Boolean(activeRun ?? inserted);
    if (!runId) {
      const [existing] = await transaction
        .select({ id: mailSyncRuns.id, status: mailSyncRuns.status })
        .from(mailSyncRuns)
        .where(eq(mailSyncRuns.idempotencyKey, idempotencyKey))
        .limit(1);
      runId = existing?.id;
      active = existing?.status === "queued" || existing?.status === "running";
    }
    if (!runId) {
      throw new Error("The Gmail synchronization run could not be created.");
    }

    if (active) {
      await enqueueWorkflowStep(
        createGmailSyncRunStep({
          runId,
          userId: input.userId,
          accountId: input.accountId,
        }),
        executor,
      );
      if (input.runType === "repair") {
        await transaction
          .update(gmailReplicaStates)
          .set({ state: "repairing", lastError: null, updatedAt: new Date() })
          .where(eq(gmailReplicaStates.accountId, input.accountId));
      }
    }
    return runId;
  });
}

export function createInitialMailSyncRun(
  input: {
    userId: string;
    accountId: string;
    startingHistoryCursor: string;
  },
  database: Database = getDatabase(),
): Promise<string> {
  return createMailSyncRun({ ...input, runType: "initial" }, database);
}

export async function createRepairMailSyncRun(
  input: {
    userId: string;
    accountId: string;
    startingHistoryCursor: string;
  },
  database: Database = getDatabase(),
): Promise<string> {
  return createMailSyncRun(
    { ...input, runType: "repair" },
    database,
  );
}

export async function getMailSyncRunContext(
  input: { runId: string; accountId: string },
  database: Database = getDatabase(),
) {
  const [run] = await database
    .select({
      id: mailSyncRuns.id,
      runType: mailSyncRuns.runType,
      startingHistoryCursor: mailSyncRuns.startingHistoryCursor,
      status: mailSyncRuns.status,
    })
    .from(mailSyncRuns)
    .where(
      and(
        eq(mailSyncRuns.id, input.runId),
        eq(mailSyncRuns.accountId, input.accountId),
      ),
    )
    .limit(1);
  return run ?? null;
}

export async function getActiveRepairMailSyncRunContext(
  accountId: string,
  database: Database = getDatabase(),
) {
  const [run] = await database
    .select({
      id: mailSyncRuns.id,
      startingHistoryCursor: mailSyncRuns.startingHistoryCursor,
      status: mailSyncRuns.status,
    })
    .from(mailSyncRuns)
    .where(
      and(
        eq(mailSyncRuns.accountId, accountId),
        eq(mailSyncRuns.runType, "repair"),
        inArray(mailSyncRuns.status, ["queued", "running"]),
      ),
    )
    .orderBy(desc(mailSyncRuns.createdAt))
    .limit(1);
  return run ?? null;
}

export async function enqueueFailedInitialGmailRepairRecoveries(
  database: Database = getDatabase(),
): Promise<number> {
  const failedInitialRuns = await database
    .select({
      runId: mailSyncRuns.id,
      userId: connectedAccounts.userId,
      accountId: connectedAccounts.id,
    })
    .from(mailSyncRuns)
    .innerJoin(
      connectedAccounts,
      eq(connectedAccounts.id, mailSyncRuns.accountId),
    )
    .innerJoin(
      gmailReplicaStates,
      eq(gmailReplicaStates.accountId, connectedAccounts.id),
    )
    .where(
      and(
        eq(mailSyncRuns.runType, "initial"),
        eq(mailSyncRuns.status, "failed"),
        eq(connectedAccounts.status, "connected"),
        eq(gmailReplicaStates.state, "failed"),
      ),
    );

  for (const run of failedInitialRuns) {
    await enqueueWorkflowStep(
      createImmediateGmailRepairRecoveryStep({
        userId: run.userId,
        accountId: run.accountId,
        failedRunId: run.runId,
        now: new Date(),
      }),
      database,
    );
  }
  return failedInitialRuns.length;
}

export async function enqueuePendingGmailHistoryCatchups(
  database: Database = getDatabase(),
): Promise<number> {
  const accounts = await database
    .select({
      id: connectedAccounts.id,
      userId: connectedAccounts.userId,
      pendingHistoryCursor: gmailReplicaStates.pendingHistoryCursor,
      replicaState: gmailReplicaStates.state,
    })
    .from(connectedAccounts)
    .innerJoin(
      gmailReplicaStates,
      eq(gmailReplicaStates.accountId, connectedAccounts.id),
    )
    .where(
      and(
        eq(connectedAccounts.status, "connected"),
        inArray(gmailReplicaStates.state, ["snapshotting", "ready", "repairing"]),
        not(isNull(gmailReplicaStates.pendingHistoryCursor)),
      ),
    );

  let enqueued = 0;
  for (const account of accounts) {
    if (!account.pendingHistoryCursor) continue;
    const repairRun =
      account.replicaState === "repairing"
        ? await getActiveRepairMailSyncRunContext(account.id, database)
        : null;
    if (account.replicaState === "repairing" && !repairRun) continue;
    const activation = repairRun?.id ?? account.replicaState;
    await enqueueWorkflowStep(
      {
        userId: account.userId,
        accountId: account.id,
        stepType: "gmail.history.catchup",
        payload: {
          reason: "pending_reconciliation",
          pendingHistoryCursor: account.pendingHistoryCursor,
        },
        idempotencyKey: `gmail-history-pending-reconciliation:${account.id}:${activation}:${account.pendingHistoryCursor}`,
      },
      database,
    );
    enqueued += 1;
  }
  return enqueued;
}

export async function getMailSyncRunProviderMessageIds(
  input: { runId: string; accountId: string },
  database: Database = getDatabase(),
): Promise<string[]> {
  const rows = await database
    .select({ providerMessageId: messages.providerMessageId })
    .from(gmailSyncItems)
    .innerJoin(mailSyncRuns, eq(mailSyncRuns.id, gmailSyncItems.runId))
    .innerJoin(
      threads,
      and(
        eq(threads.accountId, mailSyncRuns.accountId),
        eq(threads.providerThreadId, gmailSyncItems.providerThreadId),
      ),
    )
    .innerJoin(messages, eq(messages.threadId, threads.id))
    .where(
      and(
        eq(gmailSyncItems.runId, input.runId),
        eq(mailSyncRuns.accountId, input.accountId),
      ),
    );
  return rows.map((row) => row.providerMessageId);
}

/**
 * Re-offers an already admitted run to Temporal.
 *
 * A Workflow that failed outright leaves its run active with nothing driving
 * it, and PostgreSQL cannot tell a live Execution from a dead one. Clearing the
 * dispatch marker makes the command eligible again; the start is rejected while
 * the Execution is still running and only takes effect once it is not.
 */
export async function readmitMailSyncRun(
  input: { runId: string; userId: string; accountId: string },
  database: Database = getDatabase(),
): Promise<void> {
  const step = createGmailSyncRunStep(input);
  const stepId = await database.transaction((transaction) =>
    enqueueWorkflowStepWithExecutor(step, transaction),
  );
  await database
    .update(temporalCommands)
    .set({
      dispatchedAt: null,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(temporalCommands.workflowStepId, stepId));
}

export async function enqueueMissingMailSyncRuns(
  database: Database = getDatabase(),
): Promise<number> {
  const accounts = await database
    .select({
      id: connectedAccounts.id,
      userId: connectedAccounts.userId,
      initialHistoryId: gmailReplicaStates.initialHistoryId,
      replicaState: gmailReplicaStates.state,
    })
    .from(connectedAccounts)
    .innerJoin(
      gmailReplicaStates,
      eq(gmailReplicaStates.accountId, connectedAccounts.id),
    )
    .where(eq(connectedAccounts.status, "connected"));

  let created = 0;
  for (const account of accounts) {
    if (account.replicaState === "ready" || account.replicaState === "failed") {
      continue;
    }
    const [existingRun] = await database
      .select({ id: mailSyncRuns.id })
      .from(mailSyncRuns)
      .where(
        and(
          eq(mailSyncRuns.accountId, account.id),
          eq(mailSyncRuns.startingHistoryCursor, account.initialHistoryId),
          inArray(mailSyncRuns.status, ["queued", "running"]),
        ),
      )
      .limit(1);
    if (existingRun) {
      await readmitMailSyncRun(
        {
          runId: existingRun.id,
          userId: account.userId,
          accountId: account.id,
        },
        database,
      );
      continue;
    }
    await createInitialMailSyncRun({
      userId: account.userId,
      accountId: account.id,
      startingHistoryCursor: account.initialHistoryId,
    }, database);
    created += 1;
  }
  return created;
}

export function createGmailMessageDateRepairStep(input: {
  userId: string;
  accountId: string;
  providerMessageId: string;
  invalidSentAt: Date;
}): WorkflowStepInput {
  return {
    userId: input.userId,
    accountId: input.accountId,
    stepType: "gmail.message.refresh",
    payload: {
      providerMessageId: input.providerMessageId,
      reason: "implausible_date",
    },
    idempotencyKey: `gmail-message-date-repair:${input.accountId}:${input.providerMessageId}:${input.invalidSentAt.toISOString()}`,
  };
}

export async function enqueueImplausibleGmailMessageDateRepairs(
  input: { latestAllowedAt: Date },
  database: Database = getDatabase(),
): Promise<number> {
  if (!Number.isFinite(input.latestAllowedAt.getTime())) {
    throw new Error("The latest allowed Gmail message date is invalid.");
  }
  return database.transaction(async (transaction) => {
    const candidates = await transaction
      .select({
        userId: messages.userId,
        accountId: messages.accountId,
        providerMessageId: messages.providerMessageId,
        sentAt: messages.sentAt,
      })
      .from(messages)
      .innerJoin(
        connectedAccounts,
        eq(connectedAccounts.id, messages.accountId),
      )
      .where(
        and(
          eq(connectedAccounts.status, "connected"),
          gt(messages.sentAt, input.latestAllowedAt),
        ),
      )
      .orderBy(desc(messages.sentAt))
      .limit(1_000);

    for (const candidate of candidates) {
      await enqueueWorkflowStepWithExecutor(
        createGmailMessageDateRepairStep({
          ...candidate,
          invalidSentAt: candidate.sentAt,
        }),
        transaction,
      );
    }
    return candidates.length;
  });
}

/**
 * Step types whose Temporal Workflow owns the work outright, rather than
 * executing a single Activity through `workflowStepWorkflow`.
 */
const temporalAdmissionStepTypes = new Set<string>(["gmail.sync.run"]);

export function isTemporalAdmissionStepType(stepType: string): boolean {
  return temporalAdmissionStepTypes.has(stepType);
}

export async function dispatchTemporalCommandBatch(
  dispatch: (jobs: TemporalCommandJob[]) => Promise<void>,
  database: Database = getDatabase(),
): Promise<{ dispatched: number; failed: boolean }> {
  return database.transaction(async (transaction) => {
    const priority = sql<number>`case
      when ${workflowSteps.stepType} in ('gmail.history.catchup', 'label.thread.assign', 'label.batch.event')
      then ${temporalCommandPriority("gmail.history.catchup")}
      else ${temporalCommandPriority("default")}
    end`;
    const rankedCommands = transaction.$with("ranked_temporal_commands").as(
      transaction
        .select({
          commandId: temporalCommands.id,
          tenantRank:
            sql<number>`row_number() over (partition by ${workflowSteps.userId} order by ${priority}, ${temporalCommands.createdAt})`.as(
              "tenant_rank",
            ),
        })
        .from(temporalCommands)
        .innerJoin(
          workflowSteps,
          eq(workflowSteps.id, temporalCommands.workflowStepId),
        )
        .where(isNull(temporalCommands.dispatchedAt)),
    );
    const rows = await transaction
      .with(rankedCommands)
      .select({
        commandId: temporalCommands.id,
        activityTaskLane: temporalCommands.activityTaskLane,
        id: workflowSteps.id,
        runId: workflowSteps.runId,
        userId: workflowSteps.userId,
        accountId: workflowSteps.accountId,
        stepType: workflowSteps.stepType,
        payload: workflowSteps.input,
        attempts: workflowSteps.attempts,
        maxAttempts: workflowSteps.maxAttempts,
      })
      .from(temporalCommands)
      .innerJoin(
        workflowSteps,
        eq(workflowSteps.id, temporalCommands.workflowStepId),
      )
      .innerJoin(
        rankedCommands,
        eq(rankedCommands.commandId, temporalCommands.id),
      )
      .where(isNull(temporalCommands.dispatchedAt))
      .orderBy(
        asc(rankedCommands.tenantRank),
        priority,
        asc(temporalCommands.createdAt),
      )
      .limit(TEMPORAL_COMMAND_DISPATCH_BATCH_SIZE)
      .for("update", { of: temporalCommands, skipLocked: true });

    if (rows.length === 0) return { dispatched: 0, failed: false };
    const jobs = rows.map(({ commandId: _commandId, ...row }) =>
      temporalCommandJobFromRow(row),
    );
    try {
      await dispatch(jobs);
    } catch (error) {
      const message =
        error instanceof Error ? error.name : "TemporalDispatchError";
      await transaction
        .update(temporalCommands)
        .set({
          dispatchAttempts: sql`${temporalCommands.dispatchAttempts} + 1`,
          lastError: message,
          updatedAt: new Date(),
        })
        .where(inArray(temporalCommands.id, rows.map((row) => row.commandId)));
      return { dispatched: 0, failed: true };
    }

    await transaction
      .update(temporalCommands)
      .set({
        dispatchAttempts: sql`${temporalCommands.dispatchAttempts} + 1`,
        lastError: null,
        dispatchedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(inArray(temporalCommands.id, rows.map((row) => row.commandId)));

    // An admission step only bridges the transaction into Temporal. Once the
    // Workflow has started, Temporal owns execution and retries, so the step
    // must not stay queued and be re-dispatched.
    const admittedStepIds = rows
      .filter((row) => isTemporalAdmissionStepType(row.stepType))
      .map((row) => row.id);
    if (admittedStepIds.length > 0) {
      await transaction
        .update(workflowSteps)
        .set({
          status: "complete",
          completedAt: new Date(),
          lastError: null,
          updatedAt: new Date(),
        })
        .where(inArray(workflowSteps.id, admittedStepIds));
    }
    return { dispatched: rows.length, failed: false };
  });
}

export function temporalCommandJobFromRow(
  input: WorkflowStepJob & {
    activityTaskLane: TenantTaskQueueLane;
  },
): TemporalCommandJob {
  if (input.userId) return { ...input, userId: input.userId };
  throw new Error(
    "The Temporal command has an invalid durable routing contract.",
  );
}

export async function listActiveTemporalTenantIds(
  database: Database = getDatabase(),
): Promise<string[]> {
  const accountTenants = await database
    .selectDistinct({ userId: connectedAccounts.userId })
    .from(connectedAccounts)
    .where(
      inArray(connectedAccounts.status, ["connected", "reconnect_required"]),
    );
  const workflowTenants = await database
    .selectDistinct({ userId: workflowSteps.userId })
    .from(workflowSteps)
    .where(
      and(
        isNotNull(workflowSteps.userId),
        inArray(workflowSteps.status, ["queued", "running"]),
      ),
    );
  return [
    ...new Set(
      [...accountTenants, ...workflowTenants].flatMap((row) =>
        row.userId ? [row.userId] : [],
      ),
    ),
  ].sort();
}

export async function markWorkflowStepRunning(
  stepId: string,
  attempt: number,
  database: Database = getDatabase(),
) {
  const [step] = await database
    .update(workflowSteps)
    .set({
      status: "running",
      attempts: attempt,
      startedAt: new Date(),
      completedAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(workflowSteps.id, stepId),
        inArray(workflowSteps.status, ["queued", "running"]),
        or(
          not(
            inArray(workflowSteps.stepType, [
              ...gmailConnectedAccountStepTypes,
            ]),
          ),
          sql`exists (
            select 1
            from ${connectedAccounts}
            where ${connectedAccounts.id} = ${workflowSteps.accountId}
              and ${connectedAccounts.status} = 'connected'
          )`,
        ),
        or(
          isNull(workflowSteps.runId),
          sql`exists (
            select 1
            from ${mailSyncRuns}
            where ${mailSyncRuns.id} = ${workflowSteps.runId}
              and ${mailSyncRuns.status} in ('queued', 'running')
          )`,
        ),
      ),
    )
    .returning({ id: workflowSteps.id });
  if (step) return { shouldExecute: true as const, result: null };

  const [terminal] = await database
    .select({ status: workflowSteps.status, result: workflowSteps.result })
    .from(workflowSteps)
    .where(eq(workflowSteps.id, stepId))
    .limit(1);
  if (!terminal) throw new Error("The workflow step no longer exists.");
  return {
    shouldExecute: false as const,
    result:
      terminal.status === "complete"
        ? terminal.result ?? {}
        : { status: "inactive" },
  };
}

export async function completeWorkflowStep(
  stepId: string,
  result: Record<string, unknown> = {},
  database: DatabaseExecutor = getDatabase(),
) {
  return database.transaction(async (transaction) => {
    const [step] = await transaction
      .select({
        status: workflowSteps.status,
        runId: workflowSteps.runId,
        stepType: workflowSteps.stepType,
        accountId: workflowSteps.accountId,
        input: workflowSteps.input,
      })
      .from(workflowSteps)
      .where(eq(workflowSteps.id, stepId))
      .for("update")
      .limit(1);
    if (!step) throw new Error("The workflow step no longer exists.");
    if (step.status !== "queued" && step.status !== "running") return false;
    if (
      step.runId &&
      !(await lockMailSyncRun(
        {
          runId: step.runId,
          accountId: step.accountId ?? undefined,
          allowCompleted: true,
        },
        transaction as unknown as Database,
      ))
    ) {
      return false;
    }

    await transaction
      .update(workflowSteps)
      .set({
        status: "complete",
        result: { ...result, completedAt: new Date().toISOString() },
        lastError: null,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(workflowSteps.id, stepId));

    if (step.stepType !== "gmail.account.cleanup" || !step.accountId || result.status === "inactive") return true;
    const cleanupId =
      typeof step.input.cleanupId === "string" ? step.input.cleanupId : null;
    if (!cleanupId) {
      throw new Error("The Gmail account cleanup step is missing its cleanup ID.");
    }
    await transaction
      .update(gmailAccountCleanups)
      .set({
        status: "complete",
        objectCount:
          typeof result.objectCount === "number" ? result.objectCount : null,
        lastError: null,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(gmailAccountCleanups.id, cleanupId),
        eq(gmailAccountCleanups.accountId, step.accountId),
      ));
    await transaction
      .delete(connectedAccounts)
      .where(and(
        eq(connectedAccounts.id, step.accountId),
        eq(connectedAccounts.status, "disconnected"),
      ));
    return true;
  });
}

export async function failWorkflowStep(
  input: {
    step: WorkflowStepJob;
    message: string;
    terminal: boolean;
    reconnectRequired?: boolean;
  },
  database: Database = getDatabase(),
) {
  const message = toPostgresTextProjection(input.message);
  const failedAt = new Date();
  return database.transaction(async (transaction) => {
    const executor = transaction as unknown as Database;
    const [updatedStep] = await transaction
      .update(workflowSteps)
      .set({
        status: input.terminal ? "failed" : "queued",
        attempts: input.step.attempts,
        lastError: message,
        completedAt: input.terminal ? failedAt : null,
        updatedAt: failedAt,
      })
      .where(
        and(
          eq(workflowSteps.id, input.step.id),
          inArray(workflowSteps.status, ["queued", "running"]),
        ),
      )
      .returning({ id: workflowSteps.id });

    if (!updatedStep) return false;
    let failedRun: {
      accountId: string;
      runType: "initial" | "repair";
    } | null = null;
    if (input.terminal && input.step.accountId && input.reconnectRequired) {
      await terminalizeGmailAccountForReconnect(
        {
          accountId: input.step.accountId,
          message,
          failedAt,
        },
        executor,
      );
    } else if (input.terminal && input.step.runId) {
      failedRun = await terminalizeMailSyncRun(
        {
          runId: input.step.runId,
          message,
          failedAt,
        },
        executor,
      );
    }
    if (failedRun?.runType === "initial" && input.step.runId) {
      await enqueueImmediateGmailRepairRecovery(
        {
          accountId: failedRun.accountId,
          failedRunId: input.step.runId,
          failedAt,
        },
        executor,
      );
    }
    if (input.step.stepType === "gmail.account.cleanup") {
      const cleanupId =
        typeof input.step.payload.cleanupId === "string"
          ? input.step.payload.cleanupId
          : null;
      if (cleanupId) {
        await transaction
          .update(gmailAccountCleanups)
          .set({
            status: input.terminal ? "failed" : "queued",
            lastError: message,
            completedAt: input.terminal ? failedAt : null,
            updatedAt: failedAt,
          })
          .where(eq(gmailAccountCleanups.id, cleanupId));
      }
    }
    if (
      input.terminal &&
      !input.reconnectRequired &&
      input.step.accountId &&
      gmailReplicaStepTypeSet.has(input.step.stepType)
    ) {
      await transaction
        .update(gmailReplicaStates)
        .set({
          state: "failed",
          lastError: message,
          updatedAt: failedAt,
        })
        .where(eq(gmailReplicaStates.accountId, input.step.accountId));
      await transaction
        .update(connectedAccounts)
        .set({
          syncState: sql`jsonb_set(${connectedAccounts.syncState}, '{mailSync}', to_jsonb(${"failed"}::text), true)`,
          updatedAt: failedAt,
        })
        .where(eq(connectedAccounts.id, input.step.accountId));
    }
    if (
      input.terminal &&
      !input.reconnectRequired &&
      input.step.stepType === "gmail.watch.renew" &&
      input.step.accountId
    ) {
      const [watch] = await transaction
        .select({
          userId: connectedAccounts.userId,
          expirationAt: gmailWatchStates.expirationAt,
        })
        .from(connectedAccounts)
        .innerJoin(
          gmailWatchStates,
          eq(gmailWatchStates.accountId, connectedAccounts.id),
        )
        .where(
          and(
            eq(connectedAccounts.id, input.step.accountId),
            eq(connectedAccounts.status, "connected"),
            eq(gmailWatchStates.status, "active"),
          ),
        )
        .for("update")
        .limit(1);
      if (watch) {
        await enqueueWorkflowStepsWithExecutor(
          [
            createGmailWatchRecoveryStep({
              userId: watch.userId,
              accountId: input.step.accountId,
              expectedExpirationAt: watch.expirationAt,
              recoveryKey: `failed:${input.step.id}`,
              now: failedAt,
            }),
          ],
          executor,
        );
      }
    }
    if (input.terminal && input.step.stepType === "label.batch.submit") {
      const historicalScanId = input.step.payload.historicalScanId;
      if (
        typeof historicalScanId === "string" && validateUuid(historicalScanId) &&
        input.step.accountId && input.step.userId
      ) {
        await transaction
          .update(historicalThreadLabelScans)
          .set({ status: "failed", lastError: message, completedAt: new Date(), updatedAt: new Date() })
          .where(and(
            eq(historicalThreadLabelScans.id, historicalScanId),
            eq(historicalThreadLabelScans.accountId, input.step.accountId),
            eq(historicalThreadLabelScans.userId, input.step.userId),
            inArray(historicalThreadLabelScans.status, ["queued", "running"]),
          ));
      }
      await transaction
        .update(threadLabelBatchSubmissions)
        .set({ status: "failed", lastError: message, completedAt: new Date(), updatedAt: new Date() })
        .where(and(
          eq(threadLabelBatchSubmissions.workflowStepId, input.step.id),
          eq(threadLabelBatchSubmissions.status, "preparing"),
        ));
    }
    if (!input.terminal || !input.step.accountId) return true;
    if (
      ["memory.extract", "memory.batch.retry", "memory.batch.event"].includes(
        input.step.stepType,
      )
    ) {
      await transaction
        .update(connectedAccounts)
        .set({
          syncState: sql`jsonb_set(${connectedAccounts.syncState}, '{memory}', to_jsonb(${"failed"}::text), true)`,
          updatedAt: new Date(),
        })
        .where(eq(connectedAccounts.id, input.step.accountId));
    }
    return true;
  });
}

export async function startMailSyncRun(
  runId: string,
  accountId: string,
  database: Database = getDatabase(),
): Promise<boolean> {
  return database.transaction(async (transaction) => {
    const [run] = await transaction
      .update(mailSyncRuns)
      .set({
        status: "running",
        startedAt: sql`coalesce(${mailSyncRuns.startedAt}, now())`,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(mailSyncRuns.id, runId),
          eq(mailSyncRuns.accountId, accountId),
          inArray(mailSyncRuns.status, ["queued", "running"]),
          sql`exists (
            select 1
            from ${connectedAccounts}
            where ${connectedAccounts.id} = ${accountId}
              and ${connectedAccounts.status} = 'connected'
          )`,
        ),
      )
      .returning({ accountId: mailSyncRuns.accountId });
    if (!run) return false;
    await transaction
      .update(connectedAccounts)
      .set({
        syncState: { mailSync: "running", memory: "pending" },
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(connectedAccounts.id, run.accountId),
          eq(connectedAccounts.status, "connected"),
        ),
      );
    return true;
  });
}

export async function isActiveMailSyncRun(
  input: { runId: string; accountId: string },
  database: Database = getDatabase(),
): Promise<boolean> {
  const [run] = await database
    .select({ id: mailSyncRuns.id })
    .from(mailSyncRuns)
    .where(
      and(
        eq(mailSyncRuns.id, input.runId),
        eq(mailSyncRuns.accountId, input.accountId),
        inArray(mailSyncRuns.status, ["queued", "running"]),
      ),
    )
    .limit(1);
  return Boolean(run);
}

/**
 * Persists one page of discovery and reports the threads the caller still owes
 * ingestion for.
 *
 * The insert is idempotent on `(runId, pageNumber)`, so a replayed Activity
 * attempt re-reports the same pending set rather than duplicating work. Threads
 * an earlier page already claimed are excluded: Gmail can repeat a thread
 * across pages when the mailbox changes mid-walk.
 */
export async function recordMailSyncPage(
  input: {
    runId: string;
    userId: string;
    accountId: string;
    pageNumber: number;
    pageToken: string | null;
    nextPageToken: string | null;
    providerThreadIds: string[];
  },
  database: Database = getDatabase(),
): Promise<MailSyncPageRecord> {
  return database.transaction(async (transaction) => {
    const run = await lockMailSyncRun(
      { runId: input.runId, accountId: input.accountId },
      transaction,
    );
    if (!run || run.userId !== input.userId) return { status: "superseded" };
    if (
      input.providerThreadIds.some(
        (providerThreadId) => !providerThreadId.trim(),
      )
    ) {
      throw new Error("A Gmail synchronization page contains an invalid thread ID.");
    }
    const uniqueThreadIds = Array.from(new Set(input.providerThreadIds));
    await transaction
      .insert(gmailSyncPages)
      .values({
        runId: input.runId,
        pageNumber: input.pageNumber,
        pageToken: input.pageToken,
        nextPageToken: input.nextPageToken,
        discoveredThreadCount: uniqueThreadIds.length,
      })
      .onConflictDoNothing({ target: [gmailSyncPages.runId, gmailSyncPages.pageNumber] });

    if (uniqueThreadIds.length) {
      await transaction
        .insert(gmailSyncItems)
        .values(
          uniqueThreadIds.map((providerThreadId) => ({
            runId: input.runId,
            providerThreadId,
          })),
        )
        .onConflictDoNothing({
          target: [gmailSyncItems.runId, gmailSyncItems.providerThreadId],
        });
    }
    // Read back rather than trusting the insert's returning clause: a replayed
    // Activity attempt inserts nothing yet still owes ingestion for every thread
    // on the page that has not completed.
    const pendingItems = uniqueThreadIds.length
      ? await transaction
          .select({ providerThreadId: gmailSyncItems.providerThreadId })
          .from(gmailSyncItems)
          .where(
            and(
              eq(gmailSyncItems.runId, input.runId),
              inArray(gmailSyncItems.providerThreadId, uniqueThreadIds),
              inArray(gmailSyncItems.status, ["queued", "running"]),
            ),
          )
      : [];
    const pendingThreadIds = new Set(
      pendingItems.map((item) => item.providerThreadId),
    );

    const [[pageStats], [itemStats]] = await Promise.all([
      transaction
        .select({ pageCount: count(gmailSyncPages.id) })
        .from(gmailSyncPages)
        .where(eq(gmailSyncPages.runId, input.runId)),
      transaction
        .select({ discoveredThreadCount: count(gmailSyncItems.id) })
        .from(gmailSyncItems)
        .where(eq(gmailSyncItems.runId, input.runId)),
    ]);
    await transaction
      .update(mailSyncRuns)
      .set({
        pageCount: pageStats?.pageCount ?? 0,
        discoveredThreadCount: itemStats?.discoveredThreadCount ?? 0,
        discoveryComplete: input.nextPageToken === null ? true : undefined,
        updatedAt: new Date(),
      })
      .where(eq(mailSyncRuns.id, input.runId));

    if (input.nextPageToken === null) {
      await transaction.execute(
        sql`select pg_notify('invook_account_sync', ${JSON.stringify({ accountId: input.accountId })})`,
      );
    }

    return {
      status: "recorded",
      pendingThreadIds: uniqueThreadIds.filter((providerThreadId) =>
        pendingThreadIds.has(providerThreadId),
      ),
    };
  });
}

export async function markMailSyncThreadRunning(
  runId: string,
  accountId: string,
  providerThreadId: string,
  attempt: number,
  database: Database = getDatabase(),
) {
  const [item] = await database
    .update(gmailSyncItems)
    .set({
      status: "running",
      attempts: attempt,
      lastError: null,
      startedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(gmailSyncItems.runId, runId),
        eq(gmailSyncItems.providerThreadId, providerThreadId),
        inArray(gmailSyncItems.status, ["queued", "running"]),
        sql`exists (
          select 1
          from ${mailSyncRuns}
          where ${mailSyncRuns.id} = ${runId}
            and ${mailSyncRuns.accountId} = ${accountId}
            and ${mailSyncRuns.status} in ('queued', 'running')
        )`,
      ),
    )
    .returning({ id: gmailSyncItems.id });
  return Boolean(item);
}

export async function isMailSyncThreadComplete(
  input: {
    runId: string;
    accountId: string;
    providerThreadId: string;
  },
  database: Database = getDatabase(),
): Promise<boolean> {
  const [item] = await database
    .select({ id: gmailSyncItems.id })
    .from(gmailSyncItems)
    .innerJoin(mailSyncRuns, eq(mailSyncRuns.id, gmailSyncItems.runId))
    .where(
      and(
        eq(gmailSyncItems.runId, input.runId),
        eq(mailSyncRuns.accountId, input.accountId),
        eq(gmailSyncItems.providerThreadId, input.providerThreadId),
        eq(gmailSyncItems.status, "complete"),
      ),
    )
    .limit(1);
  return Boolean(item);
}

async function getItemCounts(runId: string, database: DatabaseExecutor) {
  const [counts] = await database
    .select({
      total: count(gmailSyncItems.id),
      complete: sql<number>`count(*) filter (where ${gmailSyncItems.status} = 'complete')`.mapWith(Number),
      failed: sql<number>`count(*) filter (where ${gmailSyncItems.status} = 'failed')`.mapWith(Number),
    })
    .from(gmailSyncItems)
    .where(eq(gmailSyncItems.runId, runId));
  return {
    total: counts?.total ?? 0,
    complete: counts?.complete ?? 0,
    failed: counts?.failed ?? 0,
  };
}

/**
 * Republishes a run's progress counters and notifies subscribed clients.
 *
 * Completion no longer gates a queued finalization step: `gmailSyncWorkflow`
 * ingests every page before it finalizes, so the run's readiness is already
 * known to the Workflow. This keeps the counters the UI reads truthful.
 */
async function recordMailSyncProgress(
  runId: string,
  database: DatabaseExecutor,
): Promise<void> {
  const [run] = await database
    .select({
      id: mailSyncRuns.id,
      accountId: mailSyncRuns.accountId,
      status: mailSyncRuns.status,
      discoveryComplete: mailSyncRuns.discoveryComplete,
      processedThreadCount: mailSyncRuns.processedThreadCount,
    })
    .from(mailSyncRuns)
    .where(eq(mailSyncRuns.id, runId))
    .limit(1)
    .for("update");
  if (!run || (run.status !== "queued" && run.status !== "running")) return;

  const counts = await getItemCounts(runId, database);
  await database
    .update(mailSyncRuns)
    .set({
      discoveredThreadCount: counts.total,
      processedThreadCount: counts.complete,
      failedThreadCount: counts.failed,
      updatedAt: new Date(),
    })
    .where(eq(mailSyncRuns.id, runId));
  if (
    hasMailSyncProgressAdvanced({
      discoveryComplete: run.discoveryComplete,
      discoveredThreadCount: counts.total,
      previousProcessedThreadCount: run.processedThreadCount,
      processedThreadCount: counts.complete,
    })
  ) {
    await database.execute(
      sql`select pg_notify('invook_account_sync', ${JSON.stringify({ accountId: run.accountId })})`,
    );
  }
}

export async function completeMailSyncThreadWithExecutor(
  input: {
    runId: string;
    providerThreadId: string;
  },
  database: DatabaseExecutor,
): Promise<boolean> {
    if (!(await lockMailSyncRun({ runId: input.runId }, database))) return false;
    const [item] = await database
      .update(gmailSyncItems)
      .set({
        status: "complete",
        lastError: null,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(gmailSyncItems.runId, input.runId),
          eq(gmailSyncItems.providerThreadId, input.providerThreadId),
          inArray(gmailSyncItems.status, ["queued", "running"]),
        ),
      )
      .returning({ id: gmailSyncItems.id });
    if (!item) return false;
    await recordMailSyncProgress(input.runId, database);
    return true;
}

export async function completeMailSyncThread(
  input: {
    runId: string;
    providerThreadId: string;
  },
  database: Database = getDatabase(),
): Promise<boolean> {
  return database.transaction((transaction) =>
    completeMailSyncThreadWithExecutor(input, transaction),
  );
}

export async function failMailSyncThread(
  input: {
    runId: string;
    providerThreadId: string;
    attempt: number;
    message: string;
    terminal: boolean;
    reconnectRequired: boolean;
  },
  database: Database = getDatabase(),
) {
  const message = toPostgresTextProjection(input.message);
  return database.transaction(async (transaction) => {
    const executor = transaction as unknown as Database;
    if (!(await lockMailSyncRun({ runId: input.runId }, executor))) return false;
    const [item] = await transaction
      .update(gmailSyncItems)
      .set({
        status: input.terminal ? "failed" : "queued",
        attempts: input.attempt,
        lastError: message,
        completedAt: input.terminal ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(gmailSyncItems.runId, input.runId),
          eq(gmailSyncItems.providerThreadId, input.providerThreadId),
          inArray(gmailSyncItems.status, ["queued", "running"]),
        ),
      )
      .returning({ id: gmailSyncItems.id });
    if (!item) return false;
    if (input.terminal) {
      const run = await terminalizeMailSyncRun(
        {
          runId: input.runId,
          message,
          failedAt: new Date(),
        },
        executor,
      );
      if (run && input.reconnectRequired) {
        await terminalizeGmailAccountForReconnect(
          { accountId: run.accountId, message, failedAt: new Date() },
          executor,
        );
      }
    }
    return true;
  });
}

export async function completeMailSyncRun(
  input: { runId: string; finalHistoryCursor: string },
  database: Database = getDatabase(),
) {
  return database.transaction(async (transaction) => {
    const executor = transaction as unknown as Database;
    const [run] = await transaction
      .select({
        userId: mailSyncRuns.userId,
        accountId: mailSyncRuns.accountId,
        discoveryComplete: mailSyncRuns.discoveryComplete,
        status: mailSyncRuns.status,
        replicaState: gmailReplicaStates.state,
        replicaCursor: gmailReplicaStates.historyCursor,
        accountStatus: connectedAccounts.status,
      })
      .from(mailSyncRuns)
      .innerJoin(
        connectedAccounts,
        eq(connectedAccounts.id, mailSyncRuns.accountId),
      )
      .innerJoin(
        gmailReplicaStates,
        eq(gmailReplicaStates.accountId, mailSyncRuns.accountId),
      )
      .where(eq(mailSyncRuns.id, input.runId))
      .for("update")
      .limit(1);
    if (
      !run ||
      (run.status !== "queued" && run.status !== "running") ||
      run.accountStatus !== "connected"
    ) {
      return false;
    }
    if (
      run.replicaState !== "ready" ||
      run.replicaCursor !== input.finalHistoryCursor
    ) {
      throw new Error(
        "The Gmail synchronization run cannot complete before replica readiness.",
      );
    }
    const counts = await getItemCounts(input.runId, executor);
    if (!run.discoveryComplete || counts.failed > 0 || counts.complete !== counts.total) {
      throw new Error("The Gmail synchronization run still has unfinished threads.");
    }

    await transaction
      .update(mailSyncRuns)
      .set({
        status: "complete",
        finalHistoryCursor: input.finalHistoryCursor,
        discoveredThreadCount: counts.total,
        processedThreadCount: counts.complete,
        failedThreadCount: counts.failed,
        completedAt: new Date(),
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(mailSyncRuns.id, input.runId));
    await transaction
      .update(connectedAccounts)
      .set({
        lastSyncedAt: new Date(),
        syncState: { mailSync: "complete", memory: "pending" },
        updatedAt: new Date(),
      })
      .where(eq(connectedAccounts.id, run.accountId));
    await transaction.execute(
      sql`select pg_notify('invook_account_sync', ${JSON.stringify({ accountId: run.accountId })})`,
    );

    await enqueueWorkflowStepsWithExecutor(
      createPostSyncDerivationSteps({
        userId: run.userId,
        accountId: run.accountId,
        historyCursor: input.finalHistoryCursor,
      }),
      executor,
    );
    return true;
  });
}

export async function completeGmailSynchronizationRecovery(
  input: { accountId: string; historyCursor: string },
  database: Database = getDatabase(),
): Promise<boolean> {
  return database.transaction(async (transaction) => {
    const [account] = await transaction
      .select({
        status: connectedAccounts.status,
        replicaState: gmailReplicaStates.state,
        historyCursor: gmailReplicaStates.historyCursor,
      })
      .from(connectedAccounts)
      .innerJoin(
        gmailReplicaStates,
        eq(gmailReplicaStates.accountId, connectedAccounts.id),
      )
      .where(eq(connectedAccounts.id, input.accountId))
      .for("update")
      .limit(1);
    if (
      !account ||
      account.status !== "connected" ||
      account.replicaState !== "ready" ||
      account.historyCursor !== input.historyCursor
    ) {
      return false;
    }

    await transaction
      .update(connectedAccounts)
      .set({
        syncState: sql`jsonb_set(${connectedAccounts.syncState}, '{mailSync}', to_jsonb(${"complete"}::text), true)`,
        lastSyncedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(connectedAccounts.id, input.accountId),
          eq(connectedAccounts.status, "connected"),
        ),
      );
    await transaction.execute(
      sql`select pg_notify('invook_account_sync', ${JSON.stringify({ accountId: input.accountId })})`,
    );
    return true;
  });
}

export async function enqueuePostSyncWorkflowSteps(
  database: Database = getDatabase(),
): Promise<number> {
  const accounts = await database
    .select({
      id: connectedAccounts.id,
      userId: connectedAccounts.userId,
      historyCursor: gmailReplicaStates.historyCursor,
      replicaState: gmailReplicaStates.state,
      syncState: connectedAccounts.syncState,
    })
    .from(connectedAccounts)
    .innerJoin(
      gmailReplicaStates,
      eq(gmailReplicaStates.accountId, connectedAccounts.id),
    )
    .where(eq(connectedAccounts.status, "connected"));
  let inserted = 0;
  for (const account of accounts) {
    if (
      account.syncState.mailSync !== "complete" ||
      account.replicaState !== "ready" ||
      !account.historyCursor
    ) continue;
    const steps = await enqueueWorkflowStepsWithExecutor(
      createPostSyncDerivationSteps({
        userId: account.userId,
        accountId: account.id,
        historyCursor: account.historyCursor,
      }),
      database,
    );
    inserted += steps.length;
  }
  return inserted;
}

export async function getWorkflowStepSubmission(
  stepId: string,
  database: Database = getDatabase(),
) {
  const [step] = await database
    .select({
      id: workflowSteps.id,
      userId: workflowSteps.userId,
      accountId: workflowSteps.accountId,
      jobType: workflowSteps.stepType,
      result: workflowSteps.result,
      maxAttempts: workflowSteps.maxAttempts,
    })
    .from(workflowSteps)
    .where(
      and(
        eq(workflowSteps.id, stepId),
        eq(workflowSteps.status, "complete"),
        inArray(workflowSteps.stepType, [
          "memory.extract",
          "memory.incremental",
          "memory.batch.retry",
        ]),
      ),
    )
    .limit(1);
  return step ?? null;
}
