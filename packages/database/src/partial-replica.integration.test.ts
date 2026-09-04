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
  getGmailForwardContext,
  getGmailReplyContext,
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
        accountId,
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
        getMailboxThreadDetail(userId, threadId, accountId, database),
        getMailboxSidebarCounts(userId, database),
      ]);
      assert.equal(shell?.accounts[0]?.replica.state, "snapshotting");
      assert.deepEqual(threadPage?.threads.map((thread) => thread.id), [threadId]);
      assert.deepEqual(
        threadDetail?.thread.messages.map((message) => message.id),
        [messageId],
      );
      assert.deepEqual(sidebarCounts?.all.views, {
        all: 1,
        important: 0,
        starred: 0,
        drafts: 1,
        sent: 0,
        spam: 0,
        trash: 0,
      });
      assert.equal(sidebarCounts?.all.labels[invookLabelId], 1);
      assert.deepEqual(sidebarCounts?.accounts[accountId], sidebarCounts?.all);
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
        { userId, inboxState: "inbox" },
        database,
      );
      assert.equal(structured.status, "available");
      if (structured.status === "available") {
        assert.deepEqual(
          structured.messages.map((message) => message.messageId),
          [messageId],
        );
        assert.equal(structured.messages[0]?.accountId, accountId);
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
  "All and Invook label views count every stored thread in the selected account",
  { skip: !testDatabaseUrl },
  async () => {
    await withPartialReplicaFixture(async (fixture) => {
      const { database, userId, accountId, threadId, invookLabelId } = fixture;
      const archivedThreadId = uuidv4();
      const archivedMessageId = uuidv4();
      const sentAt = new Date("2026-08-14T08:00:00.000Z");

      await database.insert(threads).values({
        id: archivedThreadId,
        userId,
        accountId,
        providerThreadId: `provider-thread-${archivedThreadId}`,
        subject: "Stored outside Gmail Inbox",
        snippet: "This thread remains available in the Invook replica.",
        participants: ["Archived Sender <archived@example.com>"],
        latestMessageAt: sentAt,
        messageCount: 1,
      });
      await database.insert(messages).values({
        id: archivedMessageId,
        userId,
        accountId,
        threadId: archivedThreadId,
        providerMessageId: `provider-message-${archivedMessageId}`,
        direction: "incoming",
        sender: {
          raw: "Archived Sender <archived@example.com>",
          email: "archived@example.com",
        },
        recipients: ["owner@example.com"],
        providerHistoryId: "104",
        internalDate: sentAt,
        headerLines: [],
        subject: "Stored outside Gmail Inbox",
        snippet: "This thread remains available in the Invook replica.",
        bodyText: "Stored locally without a Gmail Inbox membership.",
        sentAt,
      });
      await database.insert(threadLabelAssignments).values({
        userId,
        accountId,
        threadId: archivedThreadId,
        labelId: invookLabelId,
        source: "user",
        definitionVersion: 1,
      });

      const [allThreads, labelThreads, sidebarCounts] = await Promise.all([
        listMailboxThreads(userId, { accountId, view: "all" }, database),
        listMailboxThreads(
          userId,
          { accountId, view: `label:${invookLabelId}` },
          database,
        ),
        getMailboxSidebarCounts(userId, database),
      ]);

      assert.deepEqual(
        allThreads?.threads.map((thread) => thread.id).sort(),
        [threadId, archivedThreadId].sort(),
      );
      assert.deepEqual(
        labelThreads?.threads.map((thread) => thread.id).sort(),
        [threadId, archivedThreadId].sort(),
      );
      assert.equal(sidebarCounts?.accounts[accountId]?.views.all, 2);
      assert.equal(sidebarCounts?.accounts[accountId]?.labels[invookLabelId], 2);
    });
  },
);

test(
  "mailbox account scopes preserve every account and aggregate All",
  { skip: !testDatabaseUrl },
  async () => {
    await withPartialReplicaFixture(async (fixture) => {
      const { accountId, database, messageId, threadId, userId } = fixture;
      const secondAccountId = uuidv4();
      const secondThreadId = uuidv4();
      const secondMessageId = uuidv4();
      const firstStarredLabelId = uuidv4();
      const secondInboxLabelId = uuidv4();
      const secondStarredLabelId = uuidv4();
      const sentAt = new Date("2026-08-16T09:00:00.000Z");

      await database.insert(connectedAccounts).values({
        id: secondAccountId,
        userId,
        providerAccountId: `provider-${secondAccountId}`,
        email: "second@example.com",
        memoryAcknowledgedAt: new Date(),
        syncState: {
          mailSync: "complete",
          memory: "complete",
        },
      });
      await database.insert(gmailReplicaStates).values({
        accountId: secondAccountId,
        initialHistoryId: "200",
        historyCursor: "200",
        state: "ready",
        readyAt: new Date(),
      });
      await database.insert(threads).values({
        id: secondThreadId,
        userId,
        accountId: secondAccountId,
        providerThreadId: `provider-thread-${secondThreadId}`,
        subject: "Second account searchable mail",
        snippet: "Only the second account owns this thread.",
        participants: ["Second Sender <second-sender@example.com>"],
        latestMessageAt: sentAt,
        messageCount: 1,
      });
      const secondSender = {
        raw: "Second Sender <second-sender@example.com>",
        email: "second-sender@example.com",
      };
      await database.insert(messages).values({
        id: secondMessageId,
        userId,
        accountId: secondAccountId,
        threadId: secondThreadId,
        providerMessageId: `provider-message-${secondMessageId}`,
        direction: "incoming",
        sender: secondSender,
        recipients: ["second@example.com"],
        providerHistoryId: "200",
        internalDate: sentAt,
        headerLines: [
          {
            key: "from",
            line: "From: Second Sender <second-sender@example.com>",
          },
          {
            key: "message-id",
            line: `<second-${secondMessageId}@example.com>`,
          },
        ],
        subject: "Second account searchable mail",
        snippet: "Only the second account owns this thread.",
        bodyText: "A second account searchable phrase is stored here.",
        sentAt,
      });
      await database.insert(labels).values([
        {
          id: firstStarredLabelId,
          userId,
          accountId,
          kind: "gmail",
          providerLabelId: "STARRED",
          name: "Starred",
          normalizedName: "starred",
          providerType: "system",
        },
        {
          id: secondInboxLabelId,
          userId,
          accountId: secondAccountId,
          kind: "gmail",
          providerLabelId: "INBOX",
          name: "Inbox",
          normalizedName: "inbox",
          providerType: "system",
        },
        {
          id: secondStarredLabelId,
          userId,
          accountId: secondAccountId,
          kind: "gmail",
          providerLabelId: "STARRED",
          name: "Starred",
          normalizedName: "starred",
          providerType: "system",
        },
      ]);
      await database.insert(messageLabels).values([
        {
          userId,
          accountId: secondAccountId,
          messageId: secondMessageId,
          labelId: secondInboxLabelId,
          source: "gmail",
        },
        {
          userId,
          accountId,
          messageId,
          labelId: firstStarredLabelId,
          source: "gmail",
        },
        {
          userId,
          accountId: secondAccountId,
          messageId: secondMessageId,
          labelId: secondStarredLabelId,
          source: "gmail",
        },
      ]);

      const [shell, allThreads, firstThreads, secondThreads, counts] =
        await Promise.all([
          getMailboxShellData(userId, database),
          listMailboxThreads(userId, {}, database),
          listMailboxThreads(userId, { accountId }, database),
          listMailboxThreads(userId, { accountId: secondAccountId }, database),
          getMailboxSidebarCounts(userId, database),
        ]);

      assert.deepEqual(
        shell?.accounts.map((account) => account.id).sort(),
        [accountId, secondAccountId].sort(),
      );
      assert.deepEqual(
        allThreads?.threads.map((thread) => thread.id).sort(),
        [threadId, secondThreadId].sort(),
      );
      assert.deepEqual(firstThreads?.threads.map((thread) => thread.id), [threadId]);
      assert.deepEqual(secondThreads?.threads.map((thread) => thread.id), [
        secondThreadId,
      ]);
      assert.equal(counts?.all.views.all, 2);
      assert.equal(counts?.all.views.starred, 2);
      assert.equal(counts?.accounts[accountId]?.views.all, 1);
      assert.equal(counts?.accounts[accountId]?.views.starred, 1);
      assert.equal(counts?.accounts[secondAccountId]?.views.all, 1);
      assert.equal(counts?.accounts[secondAccountId]?.views.starred, 1);

      const [allSearch, firstSearch, secondSearch] = await Promise.all([
        searchMailbox({ userId, query: "second account searchable" }, database),
        searchMailbox(
          { userId, accountId, query: "second account searchable" },
          database,
        ),
        searchMailbox(
          {
            userId,
            accountId: secondAccountId,
            query: "second account searchable",
          },
          database,
        ),
      ]);
      assert.equal(allSearch[0]?.accountId, secondAccountId);
      assert.deepEqual(firstSearch, []);
      assert.equal(secondSearch[0]?.messageId, secondMessageId);
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
      const replyContext = await getGmailReplyContext(
        { userId, accountId, messageId },
        database,
      );
      const forwardContext = await getGmailForwardContext(
        { userId, accountId, messageId },
        database,
      );
      assert.equal(forwardContext?.sender.email, "partial-sender@example.com");
      assert.equal(
        forwardContext?.bodyText,
        "The synchronization keyword is present in committed mail.",
      );
      assert.equal(forwardContext?.sentAt, "2026-08-15T08:00:00.000Z");
      assert.equal(
        replyContext?.providerThreadId,
        `provider-thread-${threadId}`,
      );
      for (const inaccessible of [
        { userId: otherUserId, accountId, messageId },
        { userId, accountId: uuidv4(), messageId },
        { userId, accountId, messageId: uuidv4() },
      ]) {
        assert.equal(await getGmailReplyContext(inaccessible, database), null);
        assert.equal(await getGmailForwardContext(inaccessible, database), null);
      }
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

      await database
        .update(connectedAccounts)
        .set({ status: "reconnect_required" })
        .where(eq(connectedAccounts.id, accountId));
      assert.equal(
        await getGmailForwardContext(
          { userId, accountId, messageId },
          database,
        ),
        null,
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
      const threadDetail = await getMailboxThreadDetail(
        userId,
        threadId,
        fixture.accountId,
        database,
      );
      assert.equal(
        threadDetail?.thread.messages[0]?.providerHistoryId,
        "120",
      );
      assert.equal(
        threadDetail?.thread.isUnread,
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
        ["gmail.history.catchup", "gmail.sync.run"],
      );
      assert.equal(
        steps.find((step) => step.stepType === "gmail.sync.run")?.runId,
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
