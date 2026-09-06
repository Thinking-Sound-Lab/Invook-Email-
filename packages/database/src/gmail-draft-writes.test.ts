import assert from "node:assert/strict";
import test from "node:test";

import { count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { v4 as uuidv4 } from "uuid";

import {
  abandonUnpreparedGmailDraftSend,
  beginGmailDraftWrite,
  completeGmailDraftWrite,
  GmailDraftWriteConflictError,
  prepareGmailDraftSend,
} from "./gmail-draft-writes";
import { enqueueGmailHistoryCatchup } from "./replica";
import {
  connectedAccounts,
  profiles,
  workflowSteps,
} from "./schema";
import * as schema from "./schema";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test(
  "Gmail compose writes and their stored-cursor catch-up are idempotent",
  { skip: !testDatabaseUrl },
  async () => {
    if (!testDatabaseUrl) return;
    const client = postgres(testDatabaseUrl, { max: 1, prepare: false });
    const database = drizzle(client, { schema });
    const userId = uuidv4();
    const accountId = uuidv4();
    const idempotencyKey = uuidv4();
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
        email: "owner@example.com",
      });

      const input = {
        userId,
        accountId,
        operation: "create" as const,
        idempotencyKey,
        requestFingerprint: "fingerprint-one",
      };
      const claimed = await beginGmailDraftWrite(input, database);
      assert.equal(claimed.outcome, "claimed");
      const pending = await beginGmailDraftWrite(input, database);
      assert.deepEqual(pending, {
        outcome: "pending",
        operationId: claimed.operationId,
        result: null,
      });

      const result = {
        providerDraftId: "provider-draft",
        providerMessageId: "provider-message",
        providerThreadId: "provider-thread",
      };
      await completeGmailDraftWrite(
        { operationId: claimed.operationId, userId, result },
        database,
      );
      await completeGmailDraftWrite(
        { operationId: claimed.operationId, userId, result },
        database,
      );
      const completed = await beginGmailDraftWrite(input, database);
      assert.deepEqual(completed, {
        outcome: "complete",
        operationId: claimed.operationId,
        result,
      });

      await assert.rejects(
        beginGmailDraftWrite(
          { ...input, requestFingerprint: "fingerprint-two" },
          database,
        ),
        GmailDraftWriteConflictError,
      );

      const sendInput = {
        ...input,
        operation: "send" as const,
        idempotencyKey: uuidv4(),
        requestFingerprint: "send-fingerprint",
      };
      const sendClaimed = await beginGmailDraftWrite(sendInput, database);
      assert.equal(sendClaimed.outcome, "claimed");
      await prepareGmailDraftSend(
        {
          operationId: sendClaimed.operationId,
          userId,
          result,
        },
        database,
      );
      const preparedSend = await beginGmailDraftWrite(sendInput, database);
      assert.deepEqual(preparedSend, {
        outcome: "pending",
        operationId: sendClaimed.operationId,
        result,
      });
      await completeGmailDraftWrite(
        { operationId: sendClaimed.operationId, userId, result },
        database,
      );

      const unpreparedSendInput = {
        ...sendInput,
        idempotencyKey: uuidv4(),
      };
      const unpreparedSend = await beginGmailDraftWrite(
        unpreparedSendInput,
        database,
      );
      assert.equal(
        await abandonUnpreparedGmailDraftSend(
          { operationId: unpreparedSend.operationId, userId },
          database,
        ),
        true,
      );
      const reclaimedSend = await beginGmailDraftWrite(
        unpreparedSendInput,
        database,
      );
      assert.equal(reclaimedSend.outcome, "claimed");

      const catchupInput = {
        userId,
        accountId,
        reason: "provider_write" as const,
        sourceId: `compose-draft:${claimed.operationId}`,
      };
      const firstStepId = await enqueueGmailHistoryCatchup(catchupInput, database);
      const retryStepId = await enqueueGmailHistoryCatchup(catchupInput, database);
      assert.equal(retryStepId, firstStepId);

      const [stepCount] = await database
        .select({ value: count(workflowSteps.id) })
        .from(workflowSteps)
        .where(eq(workflowSteps.id, firstStepId));
      assert.equal(stepCount?.value, 1);
    } finally {
      await database.delete(profiles).where(eq(profiles.id, userId));
      await client.end();
    }
  },
);
