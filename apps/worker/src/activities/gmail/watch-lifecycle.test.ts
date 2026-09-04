import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";

import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { v4 as uuidv4 } from "uuid";

import * as schema from "@invook/database";
import {
  accountSecrets,
  connectedAccounts,
  encryptGoogleCredential,
  gmailWatchStates,
  markGmailReplicaDeleting,
  messageAttachments,
  messages,
  profiles,
  saveNewGmailConnection,
  threads,
  withGmailIdentityLock,
  workflowSteps,
} from "@invook/database";

import {
  GmailConnectionInactiveError,
  renewGmailConnectionWatch,
  runGmailConnectionCleanup,
} from "./watch-lifecycle";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const encryptionKey = Buffer.alloc(32, 5).toString("base64");

function createBarrier(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function setup(t: TestContext) {
  assert.ok(testDatabaseUrl);
  const testSchema = `watch_lifecycle_${uuidv4().replaceAll("-", "")}`;
  const client = postgres(testDatabaseUrl, {
    max: 4,
    prepare: false,
    onnotice: () => {},
    connection: { search_path: `${testSchema},public` },
  });
  const database = drizzle(client, { schema });
  t.after(async () => {
    await client.unsafe(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`);
    await client.end();
  });
  await client.unsafe(`CREATE SCHEMA "${testSchema}"`);
  await client.unsafe(
    "CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public",
  );
  const migrationsUrl = new URL(
    "../../../packages/database/drizzle/",
    import.meta.url,
  );
  for (const filename of (await readdir(migrationsUrl))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort()) {
    const migration = await readFile(new URL(filename, migrationsUrl), "utf8");
    for (const statement of migration
      .replaceAll('"public".', `"${testSchema}".`)
      .split("--> statement-breakpoint")) {
      if (statement.trim()) await client.unsafe(statement);
    }
  }
  const userIds = [uuidv4(), uuidv4()];
  const [userA, userB] = userIds;
  assert.ok(userA && userB);
  const providerAccountId = uuidv4();
  await database.insert(profiles).values(
    userIds.map((id) => ({
      id,
      email: `${id}@example.test`,
      displayName: "Lifecycle test",
    })),
  );
  const authentication = (userId: string) => ({
    userId,
    providerAccountId,
    email: `${providerAccountId}@example.test`,
    image: null,
    scopes: [],
    currentHistoryId: "100",
    initialHistoryId: "100",
    authenticatedAt: new Date(),
    tokenCiphertext: encryptGoogleCredential(
      {
        accessToken: `access-${userId}`,
        refreshToken: `refresh-${userId}`,
        expiresAt: "2030-01-01T00:00:00Z",
        scopes: [],
      },
      encryptionKey,
    ),
    watch: {
      topicName: "projects/test/topics/gmail",
      historyId: "100",
      expirationAt: new Date("2030-01-08T00:00:00Z"),
      renewedAt: new Date("2030-01-01T00:00:00Z"),
    },
  });
  const first = await saveNewGmailConnection(authentication(userA), database);
  const disconnect = async (accountId: string, userId: string) => {
    const cleanupId = await markGmailReplicaDeleting(
      { accountId, userId },
      database,
    );
    assert.ok(cleanupId);
    const [step] = await database
      .select()
      .from(workflowSteps)
      .where(
        and(
          eq(workflowSteps.accountId, accountId),
          eq(workflowSteps.stepType, "gmail.account.cleanup"),
        ),
      );
    assert.ok(step);
    return { accountId, userId, cleanupId, stepId: step.id };
  };
  return {
    database,
    client,
    userA,
    userB,
    first,
    providerAccountId,
    authentication,
    disconnect,
  };
}

test(
  "cleanup of one connection preserves the other user's watch, credentials and stored objects",
  { skip: !testDatabaseUrl },
  async (t) => {
    const { database, userA, userB, first, authentication, disconnect } =
      await setup(t);
    const second = await saveNewGmailConnection(
      authentication(userB),
      database,
    );
    const keys = new Map<string, string>();
    for (const { id: accountId, userId } of [
      { ...first, userId: userA },
      { ...second, userId: userB },
    ]) {
      const threadId = uuidv4();
      const messageId = uuidv4();
      const objectKey = `${accountId}/messages/shared/attachments/0-checksum`;
      keys.set(accountId, objectKey);
      await database.insert(threads).values({
        id: threadId,
        userId,
        accountId,
        providerThreadId: "shared",
      });
      await database.insert(messages).values({
        id: messageId,
        threadId,
        userId,
        accountId,
        providerMessageId: "shared",
        direction: "incoming",
        sender: { raw: "sender@example.test", email: "sender@example.test" },
        internalDate: new Date(),
        sentAt: new Date(),
      });
      await database.insert(messageAttachments).values({
        messageId,
        userId,
        accountId,
        filename: "test.txt",
        objectKey,
      });
    }
    const deletedKeys: string[] = [];
    const stoppedTokens: string[] = [];
    const dependencies = {
      database,
      encryptionKey,
      deleteObjects: async (objectKeys: string[]) => {
        deletedKeys.push(...objectKeys);
      },
      stopWatch: async (accessToken: string) => {
        stoppedTokens.push(accessToken);
      },
      getStopAccessToken: async (accountId: string) => `fresh-${accountId}`,
    };
    const firstCleanup = await disconnect(first.id, userA);
    await runGmailConnectionCleanup(firstCleanup, dependencies);
    assert.deepEqual(stoppedTokens, []);
    assert.deepEqual(deletedKeys, [keys.get(first.id)]);
    assert.equal(
      (
        await database
          .select()
          .from(connectedAccounts)
          .where(eq(connectedAccounts.id, first.id))
      ).length,
      0,
    );
    assert.equal(
      (
        await database
          .select()
          .from(messages)
          .where(eq(messages.accountId, second.id))
      ).length,
      1,
    );
    assert.equal(
      (
        await database
          .select()
          .from(accountSecrets)
          .where(eq(accountSecrets.accountId, second.id))
      ).length,
      1,
    );
    assert.equal(
      (
        await database
          .select()
          .from(gmailWatchStates)
          .where(eq(gmailWatchStates.accountId, second.id))
      )[0]?.status,
      "active",
    );
    assert.deepEqual(
      await runGmailConnectionCleanup(firstCleanup, dependencies),
      { status: "inactive" },
    );
    await runGmailConnectionCleanup(
      await disconnect(second.id, userB),
      dependencies,
    );
    assert.deepEqual(stoppedTokens, [`fresh-${second.id}`]);
    assert.deepEqual(deletedKeys, [keys.get(first.id), keys.get(second.id)]);
  },
);

test(
  "a sibling needing reauthorization still prevents watch stop",
  { skip: !testDatabaseUrl },
  async (t) => {
    const { database, userA, userB, first, authentication, disconnect } =
      await setup(t);
    const second = await saveNewGmailConnection(
      authentication(userB),
      database,
    );
    await database
      .update(connectedAccounts)
      .set({ status: "reconnect_required" })
      .where(eq(connectedAccounts.id, second.id));
    await runGmailConnectionCleanup(await disconnect(first.id, userA), {
      database,
      encryptionKey,
      deleteObjects: async () => {},
      stopWatch: async () => {
        assert.fail("a remaining connection still needs this watch");
      },
    });
  },
);

test(
  "watch renewal and disconnect serialize, and stale renewal never starts a disconnected watch",
  { skip: !testDatabaseUrl },
  async (t) => {
    const { database, userA, first, providerAccountId, disconnect } =
      await setup(t);
    const entered = createBarrier();
    const release = createBarrier();
    const calls: string[] = [];
    const renewal = renewGmailConnectionWatch(
      {
        accountId: first.id,
        accessToken: `access-${userA}`,
        topicName: "projects/test/topics/gmail",
      },
      {
        database,
        startWatch: async (token) => {
          assert.equal(token, `access-${userA}`);
          calls.push("watch");
          entered.resolve();
          await release.promise;
          return {
            historyId: "200",
            expiration: String(new Date("2030-01-09").getTime()),
          };
        },
      },
    );
    await entered.promise;
    try {
      const lock = await database.execute<{ locked: boolean }>(
        sql`select pg_try_advisory_xact_lock(hashtextextended(${`invook:gmail-identity:${providerAccountId}`}, 0)) as locked`,
      );
      assert.equal(lock[0]?.locked, false);
      const disconnection = disconnect(first.id, userA);
      release.resolve();
      await renewal;
      await disconnection;
    } finally {
      release.resolve();
      await renewal;
    }
    await assert.rejects(
      renewGmailConnectionWatch(
        {
          accountId: first.id,
          accessToken: "stale",
          topicName: "projects/test/topics/gmail",
        },
        {
          database,
          startWatch: async () => {
            assert.fail("must not restart after disconnect");
          },
        },
      ),
      GmailConnectionInactiveError,
    );
    assert.deepEqual(calls, ["watch"]);
  },
);

test(
  "last cleanup holds the identity lock through stop, object deletion, and account removal before reconnect",
  { skip: !testDatabaseUrl },
  async (t) => {
    const {
      database,
      userA,
      first,
      providerAccountId,
      authentication,
      disconnect,
    } = await setup(t);
    const cleanupInput = await disconnect(first.id, userA);
    const entered = createBarrier();
    const release = createBarrier();
    const order: string[] = [];
    const cleanup = runGmailConnectionCleanup(cleanupInput, {
      database,
      encryptionKey,
      stopWatch: async () => {
        order.push("stop");
        entered.resolve();
        await release.promise;
      },
      deleteObjects: async () => {
        order.push("delete-objects");
      },
    });
    await entered.promise;
    try {
      const lock = await database.execute<{ locked: boolean }>(
        sql`select pg_try_advisory_xact_lock(hashtextextended(${`invook:gmail-identity:${providerAccountId}`}, 0)) as locked`,
      );
      assert.equal(lock[0]?.locked, false);
      // Models the callback's watch + save transaction while the previous grant
      // is being cleaned. It must see deletion, not revive the old connection ID.
      const reconnect = withGmailIdentityLock(
        providerAccountId,
        async (transaction) => {
          order.push("new-watch");
          return saveNewGmailConnection(authentication(userA), transaction);
        },
        database,
      );
      release.resolve();
      await cleanup;
      const replacement = await reconnect;
      assert.equal(replacement.created, true);
      assert.notEqual(replacement.id, first.id);
      assert.deepEqual(order, ["stop", "delete-objects", "new-watch"]);
      await runGmailConnectionCleanup(cleanupInput, {
        database,
        encryptionKey,
        deleteObjects: async () => {
          assert.fail("stale cleanup");
        },
        stopWatch: async () => {
          assert.fail("stale cleanup");
        },
      });
      assert.equal(
        (
          await database
            .select()
            .from(connectedAccounts)
            .where(eq(connectedAccounts.id, replacement.id))
        )[0]?.status,
        "connected",
      );
    } finally {
      release.resolve();
      await cleanup;
    }
  },
);

test(
  "provider stop failure leaves durable cleanup retryable and never deletes local data prematurely",
  { skip: !testDatabaseUrl },
  async (t) => {
    const { database, userA, first, disconnect } = await setup(t);
    const cleanupInput = await disconnect(first.id, userA);
    await assert.rejects(
      runGmailConnectionCleanup(cleanupInput, {
        database,
        encryptionKey,
        stopWatch: async () => {
          throw new Error("retryable transport failure");
        },
        deleteObjects: async () => {
          assert.fail("stop has not succeeded");
        },
      }),
      /retryable transport failure/,
    );
    assert.equal(
      (
        await database
          .select()
          .from(connectedAccounts)
          .where(eq(connectedAccounts.id, first.id))
      )[0]?.status,
      "disconnected",
    );
    await runGmailConnectionCleanup(cleanupInput, {
      database,
      encryptionKey,
      stopWatch: async () => {},
      deleteObjects: async () => {},
    });
    assert.equal(
      (
        await database
          .select()
          .from(connectedAccounts)
          .where(eq(connectedAccounts.id, first.id))
      ).length,
      0,
    );
  },
);
