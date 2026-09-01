import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { v4 as uuidv4 } from "uuid";

import { encryptGoogleCredential } from "./credentials";
import { GmailConnectionDeletingError } from "./gmail-identity";
import {
  getMailboxSettings,
  getMailboxThreadDetail,
  getMailboxEventRecoveryContextForUser,
} from "./mailbox-resources";
import {
  createGmailConnectionRequest,
  consumeGmailConnectionRequest,
  createInvookLabel,
  getGmailConnectionForOAuth,
  getGmailConnectionForUser,
  getMailboxAttachmentDownloadForUser,
  refreshGmailAuthentication,
  saveNewGmailConnection,
} from "./repositories";
import {
  applyGmailHistoryBatch,
  getGmailProviderWriteContextForAccount,
  listGmailObjectKeysForAccount,
  markGmailReplicaDeleting,
  recordGmailPushNotification,
} from "./replica";
import * as schema from "./schema";
import {
  accountSecrets,
  connectedAccounts,
  gmailReplicaStates,
  labels,
  mailboxChangeEvents,
  memoryEntries,
  messageAttachments,
  messages,
  profiles,
  temporalCommands,
  threads,
  workflowSteps,
} from "./schema";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test(
  "A connects Gmail A/B and B independently connects Gmail A/C",
  { skip: !testDatabaseUrl },
  async (t) => {
    assert.ok(testDatabaseUrl);
    const testSchema = `shared_connections_${uuidv4().replaceAll("-", "")}`;
    const client = postgres(testDatabaseUrl, {
      max: 4,
      prepare: false,
      onnotice: () => {},
      connection: { search_path: `${testSchema},public` },
    });
    const database = drizzle(client, { schema });
    const userA = uuidv4();
    const userB = uuidv4();
    const gmailA = uuidv4();
    const gmailB = uuidv4();
    const gmailC = uuidv4();
    const encryptionKey = Buffer.alloc(32, 4).toString("base64");
    const authentication = (userId: string, providerAccountId: string) => ({
      userId,
      providerAccountId,
      email: `${providerAccountId}@example.test`,
      image: null,
      scopes: ["https://www.googleapis.com/auth/gmail.modify"],
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
    try {
      await client.unsafe(`CREATE SCHEMA "${testSchema}"`);
      await client.unsafe(
        "CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public",
      );
      const migrationsUrl = new URL("../drizzle/", import.meta.url);
      for (const filename of (await readdir(migrationsUrl))
        .filter((name) => /^\d{4}_.+\.sql$/.test(name))
        .sort()) {
        const migration = await readFile(
          new URL(filename, migrationsUrl),
          "utf8",
        );
        for (const statement of migration
          .replaceAll('"public".', `"${testSchema}".`)
          .split("--> statement-breakpoint")) {
          if (statement.trim()) await client.unsafe(statement);
        }
      }
      await database.insert(profiles).values(
        [userA, userB].map((userId) => ({
          id: userId,
          email: `${userId}@example.test`,
          displayName: "Shared mailbox test",
        })),
      );
      const aaInput = authentication(userA, gmailA);
      const baInput = authentication(userB, gmailA);
      const aa = await saveNewGmailConnection(aaInput, database);
      // No credentials are available to B before B independently authorizes A.
      assert.equal(
        await getGmailConnectionForOAuth(
          { userId: userB, providerAccountId: gmailA },
          database,
        ),
        null,
      );
      const [ab, ba, bc] = await Promise.all([
        saveNewGmailConnection(authentication(userA, gmailB), database),
        saveNewGmailConnection(baInput, database),
        saveNewGmailConnection(authentication(userB, gmailC), database),
      ]);
      const accountIds = [aa.id, ab.id, ba.id, bc.id];
      assert.equal(new Set(accountIds).size, 4);

      await t.test(
        "OAuth requests are independent, single-use, and credentials are user scoped",
        async () => {
          for (const userId of [userA, userB]) {
            const state = uuidv4();
            await createGmailConnectionRequest(
              {
                state,
                codeVerifier: userId,
                userId,
                accountId: null,
                expiresAt: new Date(Date.now() + 60_000),
              },
              database,
            );
            assert.equal(
              (
                await consumeGmailConnectionRequest(
                  { state, consumedAt: new Date() },
                  database,
                )
              )?.userId,
              userId,
            );
            assert.equal(
              await consumeGmailConnectionRequest(
                { state, consumedAt: new Date() },
                database,
              ),
              null,
            );
          }
          assert.equal(
            (
              await getGmailConnectionForOAuth(
                { userId: userA, providerAccountId: gmailA },
                database,
              )
            )?.id,
            aa.id,
          );
          assert.equal(
            (
              await getGmailConnectionForOAuth(
                { userId: userB, providerAccountId: gmailA },
                database,
              )
            )?.id,
            ba.id,
          );
          assert.equal(
            await getGmailConnectionForUser(
              { userId: userA, accountId: ba.id },
              database,
            ),
            null,
          );
          assert.equal(
            await getGmailProviderWriteContextForAccount(
              { userId: userA, accountId: ba.id },
              database,
            ),
            null,
          );
          assert.equal(
            (
              await getGmailProviderWriteContextForAccount(
                { userId: userB, accountId: ba.id },
                database,
              )
            )?.tokenCiphertext,
            baInput.tokenCiphertext,
          );
          const updated = {
            ...aaInput,
            tokenCiphertext: "new-user-a-ciphertext",
          };
          await refreshGmailAuthentication(updated, database);
          const [bSecret] = await database
            .select()
            .from(accountSecrets)
            .where(eq(accountSecrets.accountId, ba.id));
          assert.equal(bSecret?.tokenCiphertext, baInput.tokenCiphertext);
        },
      );

      await t.test(
        "concurrent duplicate connects retain one connection per user and identity",
        async () => {
          const duplicates = await Promise.all(
            Array.from({ length: 8 }, () =>
              saveNewGmailConnection(aaInput, database),
            ),
          );
          assert.ok(
            duplicates.every(
              (result) => result.id === aa.id && !result.created,
            ),
          );
          const accounts = await database
            .select()
            .from(connectedAccounts)
            .where(inArray(connectedAccounts.userId, [userA, userB]));
          assert.equal(accounts.length, 4);
          await assert.rejects(
            database.insert(connectedAccounts).values({
              userId: userA,
              providerAccountId: gmailA,
              email: aaInput.email,
              memoryAcknowledgedAt: new Date(),
            }),
            (error: unknown) =>
              error instanceof Error &&
              error.cause instanceof postgres.PostgresError &&
              error.cause.code === "23505",
          );
        },
      );

      await t.test(
        "labels, preferences, Memory, replicas, attachment keys and event audiences stay isolated",
        async () => {
          for (const [userId, accountId] of [
            [userA, aa.id],
            [userB, ba.id],
          ]) {
            assert.ok(userId && accountId);
            await createInvookLabel(
              {
                userId,
                accountId,
                name: "Private",
                description: `Only ${userId}`,
              },
              database,
            );
            await database.insert(memoryEntries).values({
              userId,
              accountId,
              memoryType: "preference",
              statement: `Preference ${userId}`,
              source: "user",
              fingerprint: "same-fingerprint",
            });
            const threadId = uuidv4();
            const messageId = uuidv4();
            const attachmentId = uuidv4();
            const objectKey = `${accountId}/messages/shared-message/attachments/0-checksum`;
            await database.insert(threads).values({
              id: threadId,
              userId,
              accountId,
              providerThreadId: "shared-thread",
              messageCount: 1,
            });
            await database.insert(messages).values({
              id: messageId,
              userId,
              accountId,
              threadId,
              providerMessageId: "shared-message",
              direction: "incoming",
              sender: {
                raw: "sender@example.test",
                email: "sender@example.test",
              },
              internalDate: new Date(),
              sentAt: new Date(),
            });
            await database.insert(messageAttachments).values({
              id: attachmentId,
              userId,
              accountId,
              messageId,
              objectKey,
              filename: "test.txt",
            });
            const otherUserId = userId === userA ? userB : userA;
            assert.equal(
              await getMailboxSettings(otherUserId, accountId, database),
              null,
            );
            assert.equal(
              await getMailboxThreadDetail(
                otherUserId,
                threadId,
                null,
                database,
              ),
              null,
            );
            assert.equal(
              await getMailboxAttachmentDownloadForUser(
                { userId: otherUserId, attachmentId },
                database,
              ),
              null,
            );
            assert.deepEqual(
              await listGmailObjectKeysForAccount(accountId, database),
              [objectKey],
            );
            const settings = await getMailboxSettings(
              userId,
              accountId,
              database,
            );
            assert.equal(
              settings?.memories[0]?.statement,
              `Preference ${userId}`,
            );
            assert.equal(
              settings?.invookLabels.find((label) => label.name === "Private")
                ?.description,
              `Only ${userId}`,
            );
            await applyGmailHistoryBatch(
              {
                userId,
                accountId,
                expectedCursor: "100",
                nextCursor: "200",
                messages: [],
                labelChanges: [
                  {
                    providerMessageId: "shared-message",
                    providerHistoryId: "200",
                    gmailLabels: [
                      { providerLabelId: "STARRED", name: "Starred" },
                    ],
                  },
                ],
                deletedMessageIds: [],
              },
              database,
            );
          }
          assert.deepEqual(
            new Set(
              (
                await getMailboxEventRecoveryContextForUser(userA, database)
              )?.accountIds,
            ),
            new Set([aa.id, ab.id]),
          );
          assert.deepEqual(
            new Set(
              (
                await getMailboxEventRecoveryContextForUser(userB, database)
              )?.accountIds,
            ),
            new Set([ba.id, bc.id]),
          );
          const events = await database
            .select()
            .from(mailboxChangeEvents)
            .where(inArray(mailboxChangeEvents.accountId, accountIds));
          assert.ok(
            events.some(
              (event) => event.accountId === aa.id && event.userId === userA,
            ),
          );
          assert.ok(
            events.some(
              (event) => event.accountId === ba.id && event.userId === userB,
            ),
          );
          const privateLabels = await database
            .select()
            .from(labels)
            .where(
              and(
                inArray(labels.accountId, [aa.id, ba.id]),
                eq(labels.name, "Private"),
              ),
            );
          assert.equal(new Set(privateLabels.map((label) => label.id)).size, 2);
        },
      );

      await t.test(
        "fan-out commits idle connections despite busy siblings and redelivery is idempotent",
        async () => {
          await database
            .update(gmailReplicaStates)
            .set({
              historyCursor: "100",
              pendingHistoryCursor: null,
              state: "ready",
            })
            .where(eq(gmailReplicaStates.accountId, aa.id));
          await database
            .update(gmailReplicaStates)
            .set({
              historyCursor: "200",
              pendingHistoryCursor: null,
              state: "ready",
            })
            .where(eq(gmailReplicaStates.accountId, ba.id));
          for (const lockTarget of ["account", "replica"] as const) {
            await database.transaction(async (busy) => {
              if (lockTarget === "account") {
                await busy
                  .select()
                  .from(connectedAccounts)
                  .where(eq(connectedAccounts.id, ba.id))
                  .for("update");
              } else {
                await busy
                  .select()
                  .from(gmailReplicaStates)
                  .where(eq(gmailReplicaStates.accountId, ba.id))
                  .for("update");
              }
              const results = await Promise.all(
                Array.from({ length: 12 }, () =>
                  recordGmailPushNotification(
                    {
                      emailAddress: aaInput.email.toUpperCase(),
                      notificationHistoryId: "300",
                    },
                    database,
                  ),
                ),
              );
              assert.ok(results.every((result) => result.status === "retry"));
              const [idle] = await database
                .select()
                .from(gmailReplicaStates)
                .where(eq(gmailReplicaStates.accountId, aa.id));
              assert.equal(idle?.pendingHistoryCursor, "300");
              assert.equal(idle?.historyCursor, "100");
            });
          }
          const delivery = {
            emailAddress: aaInput.email,
            notificationHistoryId: "300",
          };
          assert.equal(
            (await recordGmailPushNotification(delivery, database)).status,
            "accepted",
          );
          assert.equal(
            (await recordGmailPushNotification(delivery, database)).status,
            "accepted",
          );
          await recordGmailPushNotification(
            { ...delivery, notificationHistoryId: "250" },
            database,
          );
          const catchups = await database
            .select()
            .from(workflowSteps)
            .where(
              and(
                inArray(workflowSteps.accountId, accountIds),
                eq(workflowSteps.stepType, "gmail.history.catchup"),
              ),
            );
          assert.deepEqual(
            new Set(catchups.map((step) => step.idempotencyKey)),
            new Set(
              [aa.id, ba.id].map(
                (id) => `gmail-history-notification:${id}:300`,
              ),
            ),
          );
          const commands = await database
            .select()
            .from(temporalCommands)
            .where(
              inArray(
                temporalCommands.workflowStepId,
                catchups.map((step) => step.id),
              ),
            );
          assert.equal(commands.length, 2);
          const replicas = await database
            .select()
            .from(gmailReplicaStates)
            .where(inArray(gmailReplicaStates.accountId, accountIds));
          assert.equal(
            replicas.find((replica) => replica.accountId === ba.id)
              ?.historyCursor,
            "200",
          );
          assert.ok(
            replicas
              .filter((replica) => [ab.id, bc.id].includes(replica.accountId))
              .every((replica) => replica.pendingHistoryCursor === null),
          );
        },
      );

      await t.test(
        "disconnect cannot cross ownership or resurrect an account awaiting cleanup",
        async () => {
          assert.equal(
            await markGmailReplicaDeleting(
              { userId: userB, accountId: aa.id },
              database,
            ),
            null,
          );
          assert.ok(
            await markGmailReplicaDeleting(
              { userId: userA, accountId: aa.id },
              database,
            ),
          );
          await assert.rejects(
            refreshGmailAuthentication(aaInput, database),
            GmailConnectionDeletingError,
          );
          await assert.rejects(
            saveNewGmailConnection(aaInput, database),
            GmailConnectionDeletingError,
          );
          const notification = await recordGmailPushNotification(
            { emailAddress: aaInput.email, notificationHistoryId: "400" },
            database,
          );
          assert.equal(notification.status, "accepted");
          assert.equal(notification.connections.length, 1);
          const [stillConnected] = await database
            .select()
            .from(connectedAccounts)
            .where(eq(connectedAccounts.id, ba.id));
          assert.equal(stillConnected?.status, "connected");
        },
      );
    } finally {
      await client.unsafe(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`);
      await client.end();
    }
  },
);
