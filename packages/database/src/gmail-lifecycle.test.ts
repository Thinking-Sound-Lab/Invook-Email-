import assert from "node:assert/strict";
import test from "node:test";

import { and, asc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { v4 as uuidv4 } from "uuid";

import {
  connectedAccounts,
  gmailReplicaStates,
  gmailSyncItems,
  mailSyncRuns,
  messages,
  profiles,
  temporalCommands,
  threads,
  workflowSteps,
} from "./schema";
import * as schema from "./schema";
import {
  enqueueFailedInitialGmailRepairRecoveries,
  enqueueImplausibleGmailMessageDateRepairs,
  failWorkflowStep,
  markGmailAccountReconnectRequired,
  markWorkflowStepRunning,
} from "./workflows";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test(
  "implausible stored dates enqueue one durable provider refresh",
  { skip: !testDatabaseUrl },
  async () => {
    if (!testDatabaseUrl) return;
    const client = postgres(testDatabaseUrl, { max: 1, prepare: false });
    const database = drizzle(client, { schema });
    const userId = uuidv4();
    const accountId = uuidv4();
    const threadId = uuidv4();
    const messageId = uuidv4();
    const providerMessageId = `provider-${messageId}`;
    const invalidSentAt = new Date("2612-01-12T15:12:10.000Z");
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
        providerThreadId: `provider-${threadId}`,
        subject: "Invalid date",
        snippet: "Invalid date",
        participants: ["sender@example.com"],
        latestMessageAt: invalidSentAt,
      });
      await database.insert(messages).values({
        id: messageId,
        userId,
        accountId,
        threadId,
        providerMessageId,
        direction: "incoming",
        sender: { raw: "sender@example.com", email: "sender@example.com" },
        recipients: [`${accountId}@example.com`],
        internalDate: new Date("1969-12-31T23:59:59.999Z"),
        subject: "Invalid date",
        snippet: "Invalid date",
        bodyText: "Stored provider content",
        embeddingContentHash: "a".repeat(64),
        sentAt: invalidSentAt,
      });

      const input = {
        latestAllowedAt: new Date("2026-08-16T00:00:00.000Z"),
      };
      assert.equal(
        await enqueueImplausibleGmailMessageDateRepairs(input, database),
        1,
      );
      assert.equal(
        await enqueueImplausibleGmailMessageDateRepairs(input, database),
        1,
      );

      const steps = await database
        .select({
          id: workflowSteps.id,
          stepType: workflowSteps.stepType,
          input: workflowSteps.input,
          idempotencyKey: workflowSteps.idempotencyKey,
        })
        .from(workflowSteps)
        .where(eq(workflowSteps.accountId, accountId));
      assert.deepEqual(steps, [
        {
          id: steps[0]?.id,
          stepType: "gmail.message.refresh",
          input: { providerMessageId, reason: "implausible_date" },
          idempotencyKey: `gmail-message-date-repair:${accountId}:${providerMessageId}:${invalidSentAt.toISOString()}`,
        },
      ]);
      const outbox = await database
        .select({ activityTaskLane: temporalCommands.activityTaskLane })
        .from(temporalCommands)
        .where(eq(temporalCommands.workflowStepId, steps[0]?.id ?? ""));
      assert.deepEqual(outbox, [{ activityTaskLane: "control" }]);
    } finally {
      await database.delete(profiles).where(eq(profiles.id, userId));
      await client.end();
    }
  },
);

test(
  "terminal stalled sync fails the run, remaining items, and published workflow steps",
  { skip: !testDatabaseUrl },
  async () => {
    if (!testDatabaseUrl) return;
    const client = postgres(testDatabaseUrl, { max: 1, prepare: false });
    const database = drizzle(client, { schema });
    const userId = uuidv4();
    const accountId = uuidv4();
    const runId = uuidv4();
    const stalledStepId = uuidv4();
    const remainingStepId = uuidv4();
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
        syncState: { mailSync: "running", indexing: "running", memory: "complete" },
      });
      await database.insert(gmailReplicaStates).values({
        accountId,
        initialHistoryId: "100",
        pendingHistoryCursor: "250",
        state: "snapshotting",
      });
      await database.insert(mailSyncRuns).values({
        id: runId,
        userId,
        accountId,
        status: "running",
        startingHistoryCursor: "100",
        discoveredThreadCount: 2,
        idempotencyKey: `test-run-${runId}`,
      });
      await database.insert(gmailSyncItems).values([
        { runId, providerThreadId: "thread-1", status: "running" },
        { runId, providerThreadId: "thread-2", status: "queued" },
      ]);
      await database.insert(workflowSteps).values([
        {
          id: stalledStepId,
          runId,
          userId,
          accountId,
          stepType: "gmail.sync.thread.batch",
          status: "running",
          input: { runId, providerThreadIds: ["thread-1"] },
          idempotencyKey: `test-step-${stalledStepId}`,
        },
        {
          id: remainingStepId,
          runId,
          userId,
          accountId,
          stepType: "gmail.sync.thread.batch",
          input: { runId, providerThreadIds: ["thread-2"] },
          idempotencyKey: `test-step-${remainingStepId}`,
        },
      ]);

      assert.equal(
        await failWorkflowStep(
          {
            step: {
              id: stalledStepId,
              runId,
              userId,
              accountId,
              stepType: "gmail.sync.thread.batch",
              payload: { runId, providerThreadIds: ["thread-1"] },
              attempts: 1,
              maxAttempts: 5,
            },
            message: "gmail_workflow_stalled",
            terminal: true,
          },
          database,
        ),
        true,
      );
      assert.equal(
        await failWorkflowStep(
          {
            step: {
              id: stalledStepId,
              runId,
              userId,
              accountId,
              stepType: "gmail.sync.thread.batch",
              payload: { runId, providerThreadIds: ["thread-1"] },
              attempts: 1,
              maxAttempts: 5,
            },
            message: "gmail_workflow_stalled",
            terminal: true,
          },
          database,
        ),
        false,
      );

      const [run] = await database
        .select()
        .from(mailSyncRuns)
        .where(eq(mailSyncRuns.id, runId));
      const items = await database
        .select()
        .from(gmailSyncItems)
        .where(eq(gmailSyncItems.runId, runId))
        .orderBy(asc(gmailSyncItems.providerThreadId));
      const steps = await database
        .select()
        .from(workflowSteps)
        .where(eq(workflowSteps.runId, runId));
      const [account] = await database
        .select()
        .from(connectedAccounts)
        .where(eq(connectedAccounts.id, accountId));
      const [replica] = await database
        .select()
        .from(gmailReplicaStates)
        .where(eq(gmailReplicaStates.accountId, accountId));
      const [repairRecovery] = await database
        .select({
          status: workflowSteps.status,
          input: workflowSteps.input,
          idempotencyKey: workflowSteps.idempotencyKey,
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
            eq(workflowSteps.stepType, "gmail.watch.renew"),
          ),
        );

      assert.equal(run?.status, "failed");
      assert.equal(run?.processedThreadCount, 0);
      assert.equal(run?.failedThreadCount, 2);
      assert.deepEqual(items.map((item) => item.status), ["failed", "failed"]);
      assert.deepEqual(steps.map((step) => step.status), ["failed", "failed"]);
      assert.equal(account?.status, "connected");
      assert.equal(account?.syncState.mailSync, "failed");
      assert.equal(account?.syncState.indexing, "running");
      assert.equal(account?.syncState.memory, "complete");
      assert.equal(replica?.state, "failed");
      assert.equal(replica?.pendingHistoryCursor, "250");
      assert.equal(repairRecovery?.status, "queued");
      assert.equal(repairRecovery?.input.reason, "terminal_sync_failure_recovery");
      assert.equal(repairRecovery?.input.failedRunId, runId);
      assert.equal(
        repairRecovery?.idempotencyKey,
        `gmail-repair-recovery:${accountId}:${runId}`,
      );
      assert.equal(repairRecovery?.activityTaskLane, "control");
      assert.deepEqual(
        await markWorkflowStepRunning(remainingStepId, 1, database),
        { shouldExecute: false, result: { status: "inactive" } },
      );
    } finally {
      await database.delete(profiles).where(eq(profiles.id, userId));
      await client.end();
    }
  },
);

test(
  "failed initial replicas reconcile one durable repair trigger across restarts",
  { skip: !testDatabaseUrl },
  async () => {
    if (!testDatabaseUrl) return;
    const client = postgres(testDatabaseUrl, { max: 1, prepare: false });
    const database = drizzle(client, { schema });
    const userId = uuidv4();
    const accountId = uuidv4();
    const runId = uuidv4();
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
        syncState: { mailSync: "failed", indexing: "pending", memory: "pending" },
      });
      await database.insert(gmailReplicaStates).values({
        accountId,
        initialHistoryId: "100",
        pendingHistoryCursor: "250",
        state: "failed",
      });
      await database.insert(mailSyncRuns).values({
        id: runId,
        userId,
        accountId,
        runType: "initial",
        status: "failed",
        startingHistoryCursor: "100",
        lastError: "gmail_workflow_activity_failed",
        idempotencyKey: `test-run-${runId}`,
      });

      assert.equal(
        await enqueueFailedInitialGmailRepairRecoveries(database),
        1,
      );
      const [firstRecovery] = await database
        .select({ id: workflowSteps.id })
        .from(workflowSteps)
        .where(
          eq(
            workflowSteps.idempotencyKey,
            `gmail-repair-recovery:${accountId}:${runId}`,
          ),
        );
      assert.ok(firstRecovery);
      await database
        .update(workflowSteps)
        .set({ status: "complete", completedAt: new Date() })
        .where(eq(workflowSteps.id, firstRecovery.id));

      assert.equal(
        await enqueueFailedInitialGmailRepairRecoveries(database),
        1,
      );
      const recoveries = await database
        .select({ id: workflowSteps.id, status: workflowSteps.status })
        .from(workflowSteps)
        .where(
          eq(
            workflowSteps.idempotencyKey,
            `gmail-repair-recovery:${accountId}:${runId}`,
          ),
        );
      assert.deepEqual(recoveries, [
        { id: firstRecovery.id, status: "complete" },
      ]);
    } finally {
      await database.delete(profiles).where(eq(profiles.id, userId));
      await client.end();
    }
  },
);

test(
  "permanent authentication failure requires reconnect and cancels remaining Gmail work",
  { skip: !testDatabaseUrl },
  async () => {
    if (!testDatabaseUrl) return;
    const client = postgres(testDatabaseUrl, { max: 1, prepare: false });
    const database = drizzle(client, { schema });
    const userId = uuidv4();
    const accountId = uuidv4();
    const catchupStepId = uuidv4();
    const renewalStepId = uuidv4();
    const workflowStepIds = [catchupStepId, renewalStepId];
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
        syncState: { mailSync: "complete", indexing: "running", memory: "pending" },
      });
      await database.insert(gmailReplicaStates).values({
        accountId,
        initialHistoryId: "100",
        historyCursor: "200",
        state: "ready",
        readyAt: new Date(),
      });
      await database.insert(workflowSteps).values([
        {
          id: catchupStepId,
          userId,
          accountId,
          stepType: "gmail.history.catchup",
          status: "running",
          input: {},
          idempotencyKey: `test-step-${catchupStepId}`,
        },
        {
          id: renewalStepId,
          userId,
          accountId,
          stepType: "gmail.watch.renew",
          status: "queued",
          input: {},
          idempotencyKey: `test-step-${renewalStepId}`,
        },
      ]);

      assert.equal(
        await markGmailAccountReconnectRequired(
          { accountId, errorCode: "provider_authentication_failed" },
          database,
        ),
        true,
      );

      const [account] = await database
        .select()
        .from(connectedAccounts)
        .where(eq(connectedAccounts.id, accountId));
      const [replica] = await database
        .select()
        .from(gmailReplicaStates)
        .where(eq(gmailReplicaStates.accountId, accountId));
      const steps = await database
        .select()
        .from(workflowSteps)
        .where(inArray(workflowSteps.id, workflowStepIds));

      assert.equal(account?.status, "reconnect_required");
      assert.equal(account?.syncState.mailSync, "failed");
      assert.equal(account?.syncState.indexing, "running");
      assert.equal(replica?.state, "failed");
      assert.equal(replica?.lastError, "provider_authentication_failed");
      assert.deepEqual(steps.map((step) => step.status), ["failed", "failed"]);
      assert.deepEqual(
        await markWorkflowStepRunning(renewalStepId, 1, database),
        { shouldExecute: false, result: { status: "inactive" } },
      );
    } finally {
      await database.delete(profiles).where(eq(profiles.id, userId));
      await client.end();
    }
  },
);
