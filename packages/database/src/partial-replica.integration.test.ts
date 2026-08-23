import assert from "node:assert/strict";
import test from "node:test";

import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { v4 as uuidv4 } from "uuid";

import type { Database } from "./client";
import { queryInvookMailbox } from "./mailbox-query";
import {
  getMailboxShellData,
  getMailboxSidebarCounts,
  getMailboxThreadDetail,
  listMailboxThreads,
} from "./mailbox-resources";
import {
  applyGmailHistoryBatch,
  enqueueGmailHistoryCatchup,
  getAiReplyDraftForGmailSave,
  getGmailMessageMutationContext,
  getGmailProviderWriteContext,
  getGmailProviderWriteContextForAccount,
  getGmailThreadMutationContext,
} from "./replica";
import {
  getMailboxThreadForAgent,
  getReplyDraftContext,
  listMailboxThreadAttachments,
  searchMailbox,
} from "./repositories";
import {
  accountSecrets,
  connectedAccounts,
  drafts,
  gmailReplicaStates,
  labels,
  mailboxChangeEvents,
  messageAttachments,
  messageLabels,
  messages,
  profiles,
  temporalCommands,
  threadLabelAssignments,
  threads,
  workflowSteps,
} from "./schema";
import * as schema from "./schema";
import { createInitialMailSyncRun } from "./workflows";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

interface PartialReplicaFixture {
  database: Database;
  userId: string;
  otherUserId: string;
  accountId: string;
  threadId: string;
  messageId: string;
  draftId: string;
  gmailLabelId: string;
  invookLabelId: string;
  initialRunId: string;
}

async function withPartialReplicaFixture(
  run: (fixture: PartialReplicaFixture) => Promise<void>,
): Promise<void> {
  if (!testDatabaseUrl) return;
  const client = postgres(testDatabaseUrl, { max: 1, prepare: false });
  const database = drizzle(client, { schema });
  const userId = uuidv4();
  const otherUserId = uuidv4();
  const accountId = uuidv4();
  const threadId = uuidv4();
  const messageId = uuidv4();
  const draftId = uuidv4();
  const gmailLabelId = uuidv4();
  const gmailDraftLabelId = uuidv4();
  const invookLabelId = uuidv4();
  const sentAt = new Date("2026-08-15T08:00:00.000Z");
  try {
    await database
      .insert(profiles)
      .values([
        {
          id: userId,
          displayName: "Database Test User",
          email: `${userId}@example.test`,
        },
        {
          id: otherUserId,
          displayName: "Other Database Test User",
          email: `${otherUserId}@example.test`,
        },
      ]);
    await database.insert(connectedAccounts).values({
      id: accountId,
      userId,
      providerAccountId: `provider-${accountId}`,
      email: "owner@example.com",
      memoryAcknowledgedAt: new Date(),
      syncState: {
        mailSync: "running",
        memory: "pending",
      },
    });
    await database.insert(accountSecrets).values({
      accountId,
      tokenCiphertext: "stored-encrypted-credential",
    });
    await database.insert(gmailReplicaStates).values({
      accountId,
      initialHistoryId: "100",
      historyCursor: null,
      state: "snapshotting",
    });
    await database.insert(threads).values({
      id: threadId,
      userId,
      accountId,
      providerThreadId: `provider-thread-${threadId}`,
      subject: "Partial synchronization keyword",
      snippet: "A stored message is immediately usable.",
      participants: ["Distinctive Sender <partial-sender@example.com>"],
      latestMessageAt: sentAt,
      messageCount: 1,
    });
    await database.insert(messages).values({
      id: messageId,
      userId,
      accountId,
      threadId,
      providerMessageId: `provider-message-${messageId}`,
      direction: "incoming",
      sender: {
        raw: "Distinctive Sender <partial-sender@example.com>",
        email: "partial-sender@example.com",
      },
      recipients: ["owner@example.com"],
      providerHistoryId: "105",
      internalDate: sentAt,
      headerLines: [
        {
          key: "from",
          line: "From: Distinctive Sender <partial-sender@example.com>",
        },
        {
          key: "message-id",
          line: "Message-ID: <partial-message@example.com>",
        },
      ],
      subject: "Partial synchronization keyword",
      snippet: "A stored message is immediately usable.",
      bodyText: "The synchronization keyword is present in committed mail.",
      sentAt,
    });
    await database.insert(labels).values([
      {
        id: gmailLabelId,
        userId,
        accountId,
        kind: "gmail",
        providerLabelId: "INBOX",
        name: "Inbox",
        normalizedName: "inbox",
        providerType: "system",
      },
      {
        id: gmailDraftLabelId,
        userId,
        accountId,
        kind: "gmail",
        providerLabelId: "DRAFT",
        name: "Drafts",
        normalizedName: "drafts",
        providerType: "system",
      },
      {
        id: invookLabelId,
        userId,
        accountId,
        kind: "invook",
        name: "Action needed",
        normalizedName: "action needed",
        description: "Requires a reply",
      },
    ]);
    await database.insert(messageLabels).values([
      {
        userId,
        accountId,
        messageId,
        labelId: gmailLabelId,
        source: "gmail",
      },
      {
        userId,
        accountId,
        messageId,
        labelId: gmailDraftLabelId,
        source: "gmail",
      },
    ]);
    await database.insert(threadLabelAssignments).values({
      userId,
      accountId,
      threadId,
      labelId: invookLabelId,
      source: "user",
      definitionVersion: 1,
    });
    await database.insert(messageAttachments).values({
      userId,
      accountId,
      messageId,
      providerAttachmentId: "provider-attachment",
      filename: "roadmap-attachment.pdf",
      mimeType: "application/pdf",
      size: 128,
    });
    await database.insert(drafts).values({
      id: draftId,
      userId,
      accountId,
      kind: "invook",
      threadId,
      status: "editing",
      generatedText: "Stored draft",
      currentText: "Stored draft",
    });
    const initialRunId = await createInitialMailSyncRun(
      { userId, accountId, startingHistoryCursor: "100" },
      database,
    );

    await run({
      database,
      userId,
      otherUserId,
      accountId,
      threadId,
      messageId,
      draftId,
      gmailLabelId,
      invookLabelId,
      initialRunId,
    });
  } finally {
    await database
      .delete(profiles)
      .where(inArray(profiles.id, [userId, otherUserId]));
    await client.end();
  }
}

test(
  "stored mailbox rows support browsing, ordinary search, and drafts during initial sync",
  { skip: !testDatabaseUrl },
  async () => {
    await withPartialReplicaFixture(async (fixture) => {
      const {
        database,
        userId,
        otherUserId,
        threadId,
        messageId,
        draftId,
        gmailLabelId,
        invookLabelId,
      } = fixture;
      const missingThreadId = uuidv4();

      const [shell, threadPage, threadDetail, sidebarCounts] = await Promise.all([
        getMailboxShellData(userId, database),
        listMailboxThreads(userId, {}, database),
        getMailboxThreadDetail(userId, threadId, database),
        getMailboxSidebarCounts(userId, database),
      ]);
      assert.equal(shell?.account.replica.state, "snapshotting");
      assert.deepEqual(threadPage?.threads.map((thread) => thread.id), [threadId]);
      assert.deepEqual(
        threadDetail?.thread.messages.map((message) => message.id),
        [messageId],
      );
      assert.deepEqual(sidebarCounts?.views, {
        all: 1,
        important: 0,
        starred: 0,
        drafts: 1,
        sent: 0,
        spam: 0,
        trash: 0,
      });
      assert.equal(sidebarCounts?.labels[invookLabelId], 1);
      assert.deepEqual(
        (
          await listMailboxThreads(userId, { view: "drafts" }, database)
        )?.threads.map((thread) => thread.id),
        [threadId],
      );

      const [textResults, metadataResults, attachmentResults] =
        await Promise.all([
          searchMailbox({ userId, query: "synchronization keyword" }, database),
          searchMailbox({ userId, query: "Distinctive Sender" }, database),
          searchMailbox({ userId, query: "roadmap attachment" }, database),
        ]);
      assert.equal(textResults[0]?.messageId, messageId);
      assert.ok(textResults[0]?.matches.includes("full_text"));
      assert.equal(metadataResults[0]?.messageId, messageId);
      assert.ok(metadataResults[0]?.matches.includes("metadata"));
      assert.equal(attachmentResults[0]?.messageId, messageId);
      assert.ok(attachmentResults[0]?.matches.includes("attachment"));
      assert.deepEqual(
        await searchMailbox(
          { userId: otherUserId, query: "synchronization" },
          database,
        ),
        [],
      );

      const structured = await queryInvookMailbox(
        { userId, gmailLabelIds: [gmailLabelId] },
        database,
      );
      assert.equal(structured.status, "available");
      if (structured.status === "available") {
        assert.deepEqual(
          structured.messages.map((message) => message.messageId),
          [messageId],
        );
      }
      const unavailable = await queryInvookMailbox(
        { userId: otherUserId },
        database,
      );
      assert.deepEqual(unavailable, {
        status: "unavailable",
        reason: "mailbox_not_connected",
      });

      assert.equal(
        (await getMailboxThreadForAgent(userId, threadId, database))?.id,
        threadId,
      );
      assert.equal(
        await getMailboxThreadForAgent(otherUserId, threadId, database),
        null,
      );
      assert.equal(
        await getMailboxThreadForAgent(userId, missingThreadId, database),
        null,
      );
      assert.equal(
        (await listMailboxThreadAttachments(userId, threadId, database))[0]?.filename,
        "roadmap-attachment.pdf",
      );
      assert.deepEqual(
        await listMailboxThreadAttachments(otherUserId, threadId, database),
        [],
      );

      assert.equal(
        (await getReplyDraftContext(userId, threadId, database))?.id,
        threadId,
      );
      assert.equal(
        await getReplyDraftContext(otherUserId, threadId, database),
        null,
      );
      assert.equal(
        await getReplyDraftContext(userId, missingThreadId, database),
        null,
      );
      assert.equal(
        (await getAiReplyDraftForGmailSave({ userId, draftId }, database))?.id,
        draftId,
      );
      assert.equal(
        await getAiReplyDraftForGmailSave({ userId: otherUserId, draftId }, database),
        null,
      );
    });
  },
);

test(
  "partial-replica provider contexts require the owned stored resource",
  { skip: !testDatabaseUrl },
  async () => {
    await withPartialReplicaFixture(async (fixture) => {
      const {
        database,
        userId,
        otherUserId,
        accountId,
        threadId,
        messageId,
      } = fixture;

      const defaultAccess = await getGmailProviderWriteContext(userId, database);
      assert.equal(defaultAccess?.accountId, accountId);

      const access = await getGmailProviderWriteContextForAccount(
        { userId, accountId },
        database,
      );
      assert.deepEqual(access, {
        userId,
        accountId,
        email: "owner@example.com",
        tokenCiphertext: "stored-encrypted-credential",
      });
      assert.equal(
        await getGmailProviderWriteContextForAccount(
          { userId: otherUserId, accountId },
          database,
        ),
        null,
      );
      assert.equal(
        await getGmailProviderWriteContextForAccount(
          { userId, accountId: uuidv4() },
          database,
        ),
        null,
      );

      const message = await getGmailMessageMutationContext(
        { userId, messageId },
        database,
      );
      assert.equal(message?.accountId, accountId);
      assert.equal(message?.providerMessageId, `provider-message-${messageId}`);
      assert.equal(
        await getGmailMessageMutationContext(
          { userId: otherUserId, messageId },
          database,
        ),
        null,
      );
      assert.equal(
        await getGmailMessageMutationContext(
          { userId, messageId: uuidv4() },
          database,
        ),
        null,
      );

      const thread = await getGmailThreadMutationContext(
        { userId, threadId },
        database,
      );
      assert.equal(thread?.accountId, accountId);
      assert.equal(thread?.providerThreadId, `provider-thread-${threadId}`);
      assert.equal(
        await getGmailThreadMutationContext(
          { userId: otherUserId, threadId },
          database,
        ),
        null,
      );
      assert.equal(
        await getGmailThreadMutationContext(
          { userId, threadId: uuidv4() },
          database,
        ),
        null,
      );

      await database
        .delete(threadLabelAssignments)
        .where(eq(threadLabelAssignments.threadId, threadId));
      assert.deepEqual(
        await getGmailThreadMutationContext({ userId, threadId }, database),
        { accountId, providerThreadId: `provider-thread-${threadId}` },
      );
    });
  },
);

test(
  "coalesced Gmail label history refreshes an unchanged visible thread",
  { skip: !testDatabaseUrl },
  async () => {
    await withPartialReplicaFixture(async (fixture) => {
      const { database, userId, accountId, threadId, messageId } = fixture;
      const unreadLabelId = uuidv4();
      await database.insert(labels).values({
        id: unreadLabelId,
        userId,
        accountId,
        kind: "gmail",
        providerLabelId: "UNREAD",
        name: "Unread",
        normalizedName: "unread",
        providerType: "system",
      });
      await database.insert(messageLabels).values({
        userId,
        accountId,
        messageId,
        labelId: unreadLabelId,
        source: "gmail",
      });

      const result = await applyGmailHistoryBatch(
        {
          userId,
          accountId,
          expectedCursor: "100",
          nextCursor: "120",
          messages: [],
          labelChanges: [
            {
              providerMessageId: `provider-message-${messageId}`,
              providerHistoryId: "120",
              gmailLabels: [
                { providerLabelId: "INBOX", name: "Inbox" },
                { providerLabelId: "DRAFT", name: "Drafts" },
                { providerLabelId: "UNREAD", name: "Unread" },
              ],
            },
          ],
          deletedMessageIds: [],
        },
        database,
      );

      assert.deepEqual(result.changedThreadIds, []);
      assert.ok(result.eventId);
      const [event] = await database
        .select({ payload: mailboxChangeEvents.payload })
        .from(mailboxChangeEvents)
        .where(eq(mailboxChangeEvents.id, result.eventId));
      assert.deepEqual(event?.payload, {
        reason: "history_catchup",
        changedThreadIds: [],
        refreshedThreadIds: [threadId],
      });
      const threadDetail = await getMailboxThreadDetail(userId, threadId, database);
      assert.equal(
        threadDetail?.thread.messages[0]?.providerHistoryId,
        "120",
      );
      assert.equal(
        threadDetail?.thread.gmailLabels.some(
          (label) => label.providerLabelId === "UNREAD",
        ),
        true,
      );
    });
  },
);

test(
  "provider-write reconciliation stays durable and retry-safe during initial sync",
  { skip: !testDatabaseUrl },
  async () => {
    await withPartialReplicaFixture(async (fixture) => {
      const { database, userId, accountId, initialRunId } = fixture;
      const input = {
        userId,
        accountId,
        reason: "provider_write" as const,
        sourceId: "partial-sync-action",
      };

      const firstStepId = await enqueueGmailHistoryCatchup(input, database);
      const retryStepId = await enqueueGmailHistoryCatchup(input, database);
      assert.equal(retryStepId, firstStepId);

      const steps = await database
        .select({
          id: workflowSteps.id,
          runId: workflowSteps.runId,
          stepType: workflowSteps.stepType,
          status: workflowSteps.status,
        })
        .from(workflowSteps)
        .where(eq(workflowSteps.accountId, accountId));
      assert.deepEqual(
        steps.map((step) => step.stepType).sort(),
        ["gmail.history.catchup", "gmail.sync.page"],
      );
      assert.equal(
        steps.find((step) => step.stepType === "gmail.sync.page")?.runId,
        initialRunId,
      );
      assert.equal(
        steps.find((step) => step.id === firstStepId)?.status,
        "queued",
      );

      const outbox = await database
        .select({
          workflowStepId: temporalCommands.workflowStepId,
          activityTaskLane: temporalCommands.activityTaskLane,
        })
        .from(temporalCommands)
        .where(inArray(temporalCommands.workflowStepId, steps.map((step) => step.id)));
      assert.deepEqual(
        outbox
          .map((entry) => entry.activityTaskLane)
          .sort(),
        ["bulk", "control"],
      );

      const [replica] = await database
        .select({
          state: gmailReplicaStates.state,
          readyAt: gmailReplicaStates.readyAt,
        })
        .from(gmailReplicaStates)
        .where(eq(gmailReplicaStates.accountId, accountId));
      assert.deepEqual(replica, { state: "snapshotting", readyAt: null });
    });
  },
);
