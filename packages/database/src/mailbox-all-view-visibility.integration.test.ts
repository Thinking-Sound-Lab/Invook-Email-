import assert from "node:assert/strict";
import test from "node:test";

import { drizzle } from "drizzle-orm/postgres-js";
import { inArray } from "drizzle-orm";
import postgres from "postgres";
import { v4 as uuidv4 } from "uuid";

import {
  getMailboxSidebarCounts,
  getMailboxThreadDetail,
  listMailboxThreads,
} from "./mailbox-resources";
import * as schema from "./schema";
import {
  accountSecrets,
  connectedAccounts,
  gmailReplicaStates,
  labels,
  messageLabels,
  messages,
  profiles,
  threads,
} from "./schema";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test(
  "All shows Gmail INBOX threads while sent and archived mail stay out",
  { skip: !testDatabaseUrl },
  async () => {
    assert.ok(testDatabaseUrl);
    const client = postgres(testDatabaseUrl, { max: 1, prepare: false });
    const database = drizzle(client, { schema });
    const userId = uuidv4();
    const accountId = uuidv4();
    const receivedThreadId = uuidv4();
    const sentThreadId = uuidv4();
    const archivedThreadId = uuidv4();
    const receivedMessageId = uuidv4();
    const sentMessageId = uuidv4();
    const archivedMessageId = uuidv4();
    const inboxLabelId = uuidv4();
    const sentLabelId = uuidv4();
    const sentAt = new Date("2026-09-03T07:35:12.000Z");
    try {
      await database.insert(profiles).values({
        id: userId,
        displayName: "Mailbox View Test User",
        email: `${userId}@example.test`,
      });
      await database.insert(connectedAccounts).values({
        id: accountId,
        userId,
        providerAccountId: `provider-${accountId}`,
        email: "owner@example.com",
        syncState: { mailSync: "complete" },
      });
      await database.insert(accountSecrets).values({
        accountId,
        tokenCiphertext: "stored-encrypted-credential",
      });
      await database.insert(gmailReplicaStates).values({
        accountId,
        initialHistoryId: "100",
        historyCursor: "201",
        state: "ready",
        readyAt: new Date("2026-09-03T07:00:00.000Z"),
      });
      await database.insert(threads).values([
        {
          id: receivedThreadId,
          userId,
          accountId,
          providerThreadId: `provider-thread-${receivedThreadId}`,
          subject: "A correspondent wrote to you",
          snippet: "Incoming mail belongs in the mailbox.",
          participants: ["Correspondent <correspondent@example.com>"],
          latestMessageAt: sentAt,
          messageCount: 1,
        },
        {
          id: sentThreadId,
          userId,
          accountId,
          providerThreadId: `provider-thread-${sentThreadId}`,
          subject: "You wrote to a correspondent",
          snippet: "Outgoing mail belongs in Sent.",
          participants: ["owner@example.com"],
          latestMessageAt: sentAt,
          messageCount: 1,
        },
        {
          id: archivedThreadId,
          userId,
          accountId,
          providerThreadId: `provider-thread-${archivedThreadId}`,
          subject: "A correspondent wrote before you archived it",
          snippet: "Archived mail leaves the inbox.",
          participants: ["Correspondent <correspondent@example.com>"],
          latestMessageAt: sentAt,
          messageCount: 1,
        },
      ]);
      await database.insert(messages).values([
        {
          id: receivedMessageId,
          userId,
          accountId,
          threadId: receivedThreadId,
          providerMessageId: `provider-message-${receivedMessageId}`,
          direction: "incoming",
          sender: {
            raw: "Correspondent <correspondent@example.com>",
            email: "correspondent@example.com",
          },
          recipients: ["owner@example.com"],
          providerHistoryId: "200",
          internalDate: sentAt,
          headerLines: [
            {
              key: "from",
              line: "From: Correspondent <correspondent@example.com>",
            },
          ],
          subject: "A correspondent wrote to you",
          snippet: "Incoming mail belongs in the mailbox.",
          bodyText: "Incoming mail belongs in the mailbox.",
          sentAt,
        },
        {
          id: sentMessageId,
          userId,
          accountId,
          threadId: sentThreadId,
          providerMessageId: `provider-message-${sentMessageId}`,
          direction: "outgoing",
          sender: { raw: "owner@example.com", email: "owner@example.com" },
          recipients: ["correspondent@example.com"],
          providerHistoryId: "201",
          internalDate: sentAt,
          headerLines: [{ key: "from", line: "From: owner@example.com" }],
          subject: "You wrote to a correspondent",
          snippet: "Outgoing mail belongs in Sent.",
          bodyText: "Outgoing mail belongs in Sent.",
          sentAt,
        },
        {
          id: archivedMessageId,
          userId,
          accountId,
          threadId: archivedThreadId,
          providerMessageId: `provider-message-${archivedMessageId}`,
          direction: "incoming",
          sender: {
            raw: "Correspondent <correspondent@example.com>",
            email: "correspondent@example.com",
          },
          recipients: ["owner@example.com"],
          providerHistoryId: "202",
          internalDate: sentAt,
          headerLines: [
            {
              key: "from",
              line: "From: Correspondent <correspondent@example.com>",
            },
          ],
          subject: "A correspondent wrote before you archived it",
          snippet: "Archived mail leaves the inbox.",
          bodyText: "Archived mail leaves the inbox.",
          sentAt,
        },
      ]);
      await database.insert(labels).values([
        {
          id: inboxLabelId,
          userId,
          accountId,
          kind: "gmail",
          providerLabelId: "INBOX",
          name: "Inbox",
          normalizedName: "inbox",
          providerType: "system",
        },
        {
          id: sentLabelId,
          userId,
          accountId,
          kind: "gmail",
          providerLabelId: "SENT",
          name: "Sent",
          normalizedName: "sent",
          providerType: "system",
        },
      ]);
      await database.insert(messageLabels).values([
        {
          userId,
          accountId,
          messageId: receivedMessageId,
          labelId: inboxLabelId,
          source: "gmail",
        },
        {
          userId,
          accountId,
          messageId: sentMessageId,
          labelId: sentLabelId,
          source: "gmail",
        },
      ]);

      const [allView, sentView, sidebarCounts] = await Promise.all([
        listMailboxThreads(userId, { view: "all" }, database),
        listMailboxThreads(userId, { view: "sent" }, database),
        getMailboxSidebarCounts(userId, database),
      ]);

      assert.deepEqual(
        allView?.threads.map((thread) => thread.id),
        [receivedThreadId],
      );
      assert.deepEqual(
        sentView?.threads.map((thread) => thread.id),
        [sentThreadId],
      );
      assert.equal(sidebarCounts?.all.views.all, 1);
      assert.equal(sidebarCounts?.all.views.sent, 1);
      // The archived thread carries no Gmail label view of its own, so it is
      // reachable through search and its thread URL rather than a list.
      assert.equal(
        await getMailboxThreadDetail(
          userId,
          archivedThreadId,
          accountId,
          database,
        ).then((detail) => detail?.thread.id),
        archivedThreadId,
      );
    } finally {
      await database.delete(profiles).where(inArray(profiles.id, [userId]));
      await client.end();
    }
  },
);
