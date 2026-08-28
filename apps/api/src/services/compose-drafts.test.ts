import assert from "node:assert/strict";
import test from "node:test";

import type { BeginGmailDraftWriteResult } from "@invook/database";

import { parseGmailComposeDraftRequest } from "../routes/compose-drafts";
import {
  GmailReplyContextUnavailableError,
  saveComposeDraft,
  type ComposeDraftDependencies,
} from "./compose-drafts";

const userId = "11111111-1111-4111-8111-111111111111";
const accountId = "22222222-2222-4222-8222-222222222222";
const idempotencyKey = "33333333-3333-4333-8333-333333333333";
const access = {
  accountId,
  accessToken: "access-token",
  email: "owner@example.com",
};
const fields = {
  recipients: ["recipient@example.com"],
  subject: "Subject",
  body: "Draft body",
};

function gmailDraft(
  providerDraftId = "provider-draft",
  providerMessageId = "provider-message",
  providerThreadId = "provider-thread",
) {
  return {
    id: providerDraftId,
    message: {
      id: providerMessageId,
      threadId: providerThreadId,
      raw: "",
    },
  };
}

function memoryDependencies(
  input: {
    failFirstCatchup?: boolean;
  } = {},
): {
  dependencies: ComposeDraftDependencies;
  counts: { create: number; update: number; catchup: number };
} {
  let stored: BeginGmailDraftWriteResult | null = null;
  const counts = { create: 0, update: 0, catchup: 0 };
  const dependencies: ComposeDraftDependencies = {
    getReplyContext: async () => null,
    beginWrite: async () => {
      if (stored) return stored;
      stored = { outcome: "claimed", operationId: "operation-1" };
      return stored;
    },
    completeWrite: async ({ operationId, result }) => {
      stored = { outcome: "complete", operationId, result };
    },
    abandonWrite: async () => {
      stored = null;
    },
    createDraft: async () => {
      counts.create += 1;
      return gmailDraft();
    },
    getDraft: async () => gmailDraft(),
    listDrafts: async () => ({ drafts: [] }),
    updateDraft: async () => {
      counts.update += 1;
      return gmailDraft();
    },
    enqueueCatchup: async ({ sourceId }) => {
      counts.catchup += 1;
      assert.equal(sourceId, "compose-draft:operation-1");
      if (input.failFirstCatchup && counts.catchup === 1) {
        throw new Error("outbox unavailable");
      }
      return "catchup-step";
    },
  };
  return { dependencies, counts };
}

test("compose draft admission accepts only the exact validated wire contract", () => {
  assert.deepEqual(
    parseGmailComposeDraftRequest({ accountId, idempotencyKey, ...fields }),
    { accountId, idempotencyKey, ...fields },
  );
  assert.equal(
    parseGmailComposeDraftRequest({
      idempotencyKey,
      accountId,
      ...fields,
      unexpected: "field",
    }),
    null,
  );
  assert.equal(
    parseGmailComposeDraftRequest({
      idempotencyKey: "not-a-uuid",
      accountId,
      ...fields,
    }),
    null,
  );
  assert.equal(
    parseGmailComposeDraftRequest({
      idempotencyKey,
      accountId,
      ...fields,
      subject: "Subject\r\nBcc: hidden@example.com",
    }),
    null,
  );
});

test("a completed create retry reuses the provider result without creating a duplicate", async () => {
  const { dependencies, counts } = memoryDependencies();
  const input = {
    userId,
    access,
    operation: "create" as const,
    idempotencyKey,
    fields,
  };

  const first = await saveComposeDraft(input, dependencies);
  const retry = await saveComposeDraft(input, dependencies);

  assert.deepEqual(retry, first);
  assert.equal(counts.create, 1);
  assert.equal(counts.catchup, 2);
});

test("a retry after catch-up failure does not repeat the completed provider write", async () => {
  const { dependencies, counts } = memoryDependencies({
    failFirstCatchup: true,
  });
  const input = {
    userId,
    access,
    operation: "create" as const,
    idempotencyKey,
    fields,
  };

  await assert.rejects(
    saveComposeDraft(input, dependencies),
    /outbox unavailable/,
  );
  const retry = await saveComposeDraft(input, dependencies);

  assert.equal(retry.stepId, "catchup-step");
  assert.equal(counts.create, 1);
  assert.equal(counts.catchup, 2);
});

test("an ambiguous pending write recovers by its stable RFC 822 message ID", async () => {
  let completed = false;
  const dependencies: ComposeDraftDependencies = {
    getReplyContext: async () => null,
    beginWrite: async () => ({
      outcome: "pending",
      operationId: "operation-1",
      result: null,
    }),
    completeWrite: async () => {
      completed = true;
    },
    abandonWrite: async () => undefined,
    createDraft: async () => {
      throw new Error("create must not repeat");
    },
    getDraft: async () => gmailDraft(),
    listDrafts: async (_accessToken, options) => {
      assert.equal(
        options.query,
        "rfc822msgid:invook-compose-operation-1@invook.invalid",
      );
      return {
        drafts: [
          {
            id: "provider-draft",
            message: { id: "provider-message", threadId: "provider-thread" },
          },
        ],
      };
    },
    updateDraft: async () => {
      throw new Error("update must not repeat");
    },
    enqueueCatchup: async () => "catchup-step",
  };

  const result = await saveComposeDraft(
    {
      userId,
      access,
      operation: "create",
      idempotencyKey,
      fields,
    },
    dependencies,
  );

  assert.equal(completed, true);
  assert.equal(result.draft.providerDraftId, "provider-draft");
});

test("updating reads the provider thread and replaces the existing Gmail draft", async () => {
  const { dependencies, counts } = memoryDependencies();
  let updateThreadId: string | undefined;
  dependencies.updateDraft = async (_accessToken, providerDraftId, write) => {
    counts.update += 1;
    assert.equal(providerDraftId, "provider-draft");
    updateThreadId = write.threadId;
    assert.match(write.raw.toString("utf8"), /\r\n\r\nDraft body$/);
    return gmailDraft();
  };

  await saveComposeDraft(
    {
      userId,
      access,
      operation: "update",
      idempotencyKey,
      fields,
      providerDraftId: "provider-draft",
    },
    dependencies,
  );

  assert.equal(counts.create, 0);
  assert.equal(counts.update, 1);
  assert.equal(updateThreadId, "provider-thread");
});

test("reply admission validates message identifiers and copied recipients", () => {
  const request = {
    accountId,
    idempotencyKey,
    ...fields,
    replyToMessageId: userId,
    ccRecipients: ["copy@example.com"],
    bccRecipients: ["private@example.com"],
  };
  assert.deepEqual(parseGmailComposeDraftRequest(request), request);
  for (const override of [
    { replyToMessageId: "provider-thread-id" },
    { replyToMessageId: null },
    { ccRecipients: "copy@example.com" },
    { bccRecipients: [12] },
    { bccRecipients: ["person@example.com\r\nCc: hidden@example.com"] },
  ]) {
    assert.equal(
      parseGmailComposeDraftRequest({ ...request, ...override }),
      null,
    );
  }
});

test("reply creation resolves owned message context before admitting a provider write", async () => {
  const { dependencies, counts } = memoryDependencies();
  let hasResolvedContext = false;
  const beginWrite = dependencies.beginWrite;
  dependencies.beginWrite = async (input) => {
    assert.equal(hasResolvedContext, true);
    return beginWrite(input);
  };
  dependencies.getReplyContext = async (input) => {
    assert.deepEqual(input, { userId, accountId, messageId: "message-1" });
    hasResolvedContext = true;
    return {
      subject: "Original subject",
      providerThreadId: "original-thread",
      headerLines: [
        { key: "message-id", line: "Message-ID: <original@example.com>" },
        { key: "references", line: "References: <earlier@example.com>" },
      ],
    };
  };
  dependencies.createDraft = async (_token, write) => {
    counts.create += 1;
    assert.equal(write.threadId, "original-thread");
    const raw = write.raw.toString("utf8");
    assert.match(raw, /Subject: Re: Original subject\r\n/);
    assert.match(raw, /In-Reply-To: <original@example.com>\r\n/);
    assert.match(
      raw,
      /References: <earlier@example.com> <original@example.com>\r\n/,
    );
    assert.match(raw, /To: recipient@example.com\r\n/);
    return gmailDraft("reply-draft", "reply-message", "original-thread");
  };
  const input = {
    userId,
    access,
    operation: "create" as const,
    idempotencyKey,
    fields,
    replyToMessageId: "message-1",
  };
  const result = await saveComposeDraft(input, dependencies);
  assert.equal(result.draft.providerThreadId, "original-thread");
  assert.deepEqual(await saveComposeDraft(input, dependencies), result);
  assert.equal(counts.create, 1);
});

test("a missing or cross-account reply target cannot admit draft work", async () => {
  const { dependencies, counts } = memoryDependencies();
  dependencies.beginWrite = async () => {
    assert.fail("an unauthorized reply must not admit work");
  };
  await assert.rejects(
    saveComposeDraft(
      {
        userId,
        access,
        operation: "create",
        idempotencyKey,
        fields,
        replyToMessageId: "inaccessible-message",
      },
      dependencies,
    ),
    GmailReplyContextUnavailableError,
  );
  assert.equal(counts.create, 0);
});

test("reply fingerprints distinguish the target and Cc/Bcc recipients", async () => {
  const fingerprints: string[] = [];
  for (const override of [
    {},
    { replyToMessageId: "another-message" },
    { fields: { ...fields, ccRecipients: ["copy@example.com"] } },
    { fields: { ...fields, bccRecipients: ["private@example.com"] } },
  ]) {
    const { dependencies } = memoryDependencies();
    dependencies.getReplyContext = async () => ({
      subject: "Subject",
      providerThreadId: "provider-thread",
      headerLines: [],
    });
    dependencies.beginWrite = async (input) => {
      fingerprints.push(input.requestFingerprint);
      return { outcome: "claimed", operationId: "operation-1" };
    };
    await saveComposeDraft(
      {
        userId,
        access,
        operation: "create",
        idempotencyKey,
        fields,
        replyToMessageId: "message-1",
        ...override,
      },
      dependencies,
    );
  }
  assert.equal(new Set(fingerprints).size, 4);
});

test("updating a reply cannot move a different provider draft into the thread", async () => {
  const { dependencies, counts } = memoryDependencies();
  dependencies.getReplyContext = async () => ({
    subject: "Subject",
    providerThreadId: "other-thread",
    headerLines: [],
  });
  await assert.rejects(
    saveComposeDraft(
      {
        userId,
        access,
        operation: "update",
        idempotencyKey,
        fields,
        replyToMessageId: "message-1",
        providerDraftId: "provider-draft",
      },
      dependencies,
    ),
    GmailReplyContextUnavailableError,
  );
  assert.equal(counts.update, 0);
});
