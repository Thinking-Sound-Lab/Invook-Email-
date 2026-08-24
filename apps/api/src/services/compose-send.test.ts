import assert from "node:assert/strict";
import test from "node:test";

import type { BeginGmailDraftWriteResult } from "@invook/database";
import { GmailApiError } from "@invook/gmail";

import { parseGmailComposeSendRequest } from "../routes/compose-drafts";
import {
  sendComposeDraft,
  type ComposeSendDependencies,
} from "./compose-send";

const userId = "11111111-1111-4111-8111-111111111111";
const accountId = "22222222-2222-4222-8222-222222222222";
const idempotencyKey = "33333333-3333-4333-8333-333333333333";
const providerDraftId = "provider-draft";
const access = {
  accountId,
  accessToken: "access-token",
  email: "owner@example.com",
};

function gmailDraft() {
  return {
    id: providerDraftId,
    message: {
      id: "provider-draft-message",
      threadId: "provider-thread",
      raw: "",
    },
  };
}

function gmailNotFound(): GmailApiError {
  return new GmailApiError("Gmail resource not found.", 404, "redacted");
}

function memoryDependencies(input: {
  failFirstCatchup?: boolean;
  loseFirstSendResponse?: boolean;
} = {}): {
  dependencies: ComposeSendDependencies;
  counts: { send: number; catchup: number };
} {
  let stored: BeginGmailDraftWriteResult | null = null;
  let isSent = false;
  let precedingLock = Promise.resolve();
  const counts = { send: 0, catchup: 0 };
  const dependencies: ComposeSendDependencies = {
    withSendLock: async (_lockInput, operation) => {
      const preceding = precedingLock;
      let releaseLock = (): void => {
        throw new Error("The test send lock was not initialized.");
      };
      precedingLock = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      await preceding;
      try {
        return await operation();
      } finally {
        releaseLock();
      }
    },
    beginWrite: async () => {
      if (stored) return stored;
      stored = { outcome: "claimed", operationId: "operation-1" };
      return stored;
    },
    prepareSend: async ({ operationId, result }) => {
      stored = { outcome: "pending", operationId, result };
    },
    completeWrite: async ({ operationId, result }) => {
      stored = { outcome: "complete", operationId, result };
    },
    abandonUnpreparedSend: async () => {
      stored = null;
      return true;
    },
    getDraft: async () => {
      if (isSent) throw gmailNotFound();
      return gmailDraft();
    },
    getMessageState: async () => ({
      id: "provider-draft-message",
      threadId: "provider-thread",
      labelIds: ["SENT"],
    }),
    sendDraft: async () => {
      counts.send += 1;
      isSent = true;
      if (input.loseFirstSendResponse && counts.send === 1) {
        throw new Error("connection closed after provider write");
      }
      return {
        id: "provider-sent-message",
        threadId: "provider-thread",
        labelIds: ["SENT"],
      };
    },
    enqueueCatchup: async ({ sourceId }) => {
      counts.catchup += 1;
      assert.equal(sourceId, "compose-send:operation-1");
      if (input.failFirstCatchup && counts.catchup === 1) {
        throw new Error("outbox unavailable");
      }
      return "catchup-step";
    },
  };
  return { dependencies, counts };
}

const sendInput = {
  userId,
  access,
  idempotencyKey,
  providerDraftId,
};

test("compose send admission accepts only an exact idempotency key", () => {
  assert.deepEqual(parseGmailComposeSendRequest({ accountId, idempotencyKey }), {
    accountId,
    idempotencyKey,
  });
  assert.equal(
    parseGmailComposeSendRequest({ accountId, idempotencyKey, unexpected: true }),
    null,
  );
  assert.equal(
    parseGmailComposeSendRequest({ accountId, idempotencyKey: "invalid" }),
    null,
  );
});

test("an exact send retry does not send the Gmail draft twice", async () => {
  const { dependencies, counts } = memoryDependencies();

  const first = await sendComposeDraft(sendInput, dependencies);
  const retry = await sendComposeDraft(sendInput, dependencies);

  assert.deepEqual(retry, first);
  assert.equal(first.message.providerMessageId, "provider-sent-message");
  assert.equal(counts.send, 1);
  assert.equal(counts.catchup, 2);
});

test("concurrent exact sends are serialized before the provider write", async () => {
  const { dependencies, counts } = memoryDependencies();

  const [first, duplicate] = await Promise.all([
    sendComposeDraft(sendInput, dependencies),
    sendComposeDraft(sendInput, dependencies),
  ]);

  assert.deepEqual(duplicate, first);
  assert.equal(counts.send, 1);
});

test("a catch-up retry reuses the completed provider send", async () => {
  const { dependencies, counts } = memoryDependencies({ failFirstCatchup: true });

  await assert.rejects(sendComposeDraft(sendInput, dependencies), /outbox unavailable/);
  const retry = await sendComposeDraft(sendInput, dependencies);

  assert.equal(retry.stepId, "catchup-step");
  assert.equal(counts.send, 1);
  assert.equal(counts.catchup, 2);
});

test("an ambiguous send response recovers from Gmail's SENT message", async () => {
  const { dependencies, counts } = memoryDependencies({
    loseFirstSendResponse: true,
  });

  await assert.rejects(
    sendComposeDraft(sendInput, dependencies),
    /connection closed after provider write/,
  );
  const retry = await sendComposeDraft(sendInput, dependencies);

  assert.equal(retry.message.providerMessageId, "provider-draft-message");
  assert.equal(counts.send, 1);
  assert.equal(counts.catchup, 1);
});

test("a missing draft clears only an unprepared send operation", async () => {
  let abandoned = false;
  const { dependencies } = memoryDependencies();
  dependencies.beginWrite = async () => ({
    outcome: "pending",
    operationId: "operation-1",
    result: null,
  });
  dependencies.getDraft = async () => {
    throw gmailNotFound();
  };
  dependencies.abandonUnpreparedSend = async () => {
    abandoned = true;
    return true;
  };

  await assert.rejects(sendComposeDraft(sendInput, dependencies), GmailApiError);
  assert.equal(abandoned, true);
});
