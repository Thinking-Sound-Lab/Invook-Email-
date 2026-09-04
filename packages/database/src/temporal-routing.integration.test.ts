import assert from "node:assert/strict";
import test from "node:test";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { v4 as uuidv4 } from "uuid";

import * as schema from "./schema";
import { connectedAccounts, profiles } from "./schema";
import {
  dispatchTemporalCommandBatch,
  enqueueWorkflowStep,
  TEMPORAL_COMMAND_DISPATCH_BATCH_SIZE,
  type TemporalCommandJob,
} from "./workflows";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test(
  "tenant routing admits another user's work despite a large existing backlog",
  { skip: !testDatabaseUrl },
  async () => {
    if (!testDatabaseUrl) return;
    const client = postgres(testDatabaseUrl, { max: 1, prepare: false });
    const database = drizzle(client, { schema });
    const firstUserId = uuidv4();
    const secondUserId = uuidv4();
    const firstAccountId = uuidv4();
    const secondAccountId = uuidv4();
    try {
      await database.insert(profiles).values([
        {
          id: firstUserId,
          displayName: "First Routing Test User",
          email: `${firstUserId}@example.test`,
        },
        {
          id: secondUserId,
          displayName: "Second Routing Test User",
          email: `${secondUserId}@example.test`,
        },
      ]);
      await database.insert(connectedAccounts).values([
        {
          id: firstAccountId,
          userId: firstUserId,
          providerAccountId: `provider-${firstAccountId}`,
          email: `${firstAccountId}@example.test`,
          memoryAcknowledgedAt: new Date(),
        },
        {
          id: secondAccountId,
          userId: secondUserId,
          providerAccountId: `provider-${secondAccountId}`,
          email: `${secondAccountId}@example.test`,
          memoryAcknowledgedAt: new Date(),
        },
      ]);
      for (
        let index = 0;
        index < TEMPORAL_COMMAND_DISPATCH_BATCH_SIZE;
        index += 1
      ) {
        await enqueueWorkflowStep(
          {
            userId: firstUserId,
            accountId: firstAccountId,
            stepType: "label.recent.scan",
            idempotencyKey: `tenant-fairness:${firstUserId}:${index}`,
          },
          database,
        );
      }
      await enqueueWorkflowStep(
        {
          userId: secondUserId,
          accountId: secondAccountId,
          stepType: "label.recent.scan",
          idempotencyKey: `tenant-fairness:${secondUserId}`,
        },
        database,
      );

      let dispatchedJobs: TemporalCommandJob[] = [];
      await dispatchTemporalCommandBatch(
        async (jobs) => {
          dispatchedJobs = jobs;
        },
        database,
      );

      assert.equal(dispatchedJobs.length, TEMPORAL_COMMAND_DISPATCH_BATCH_SIZE);
      assert.ok(dispatchedJobs.some((job) => job.userId === secondUserId));
      const ownedJobs = dispatchedJobs.filter(
        (job) => job.userId === firstUserId || job.userId === secondUserId,
      );
      assert.ok(
        ownedJobs.every((job) => job.activityTaskLane === "bulk"),
      );
    } finally {
      await database.delete(profiles).where(eq(profiles.id, firstUserId));
      await database.delete(profiles).where(eq(profiles.id, secondUserId));
      await client.end();
    }
  },
);
