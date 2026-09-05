import assert from "node:assert/strict";
import test from "node:test";

import {
  createThreadComposeSession,
  type ThreadComposeMessage,
} from "./thread-composer-state";
import {
  sendThreadComposeAttempt,
  type ThreadComposeSendAttempt,
} from "../../lib/api/thread-compose-send";

const message: ThreadComposeMessage = {
  id: "message-1",
  direction: "incoming",
  sender: { raw: "Sender <sender@example.com>", email: "sender@example.com" },
  recipients: ["owner@example.com"],
  headers: [
    {
      name: "Reply-To",
      value: '"Support, Team" <support@example.com>, agent@example.com',
    },
  ],
  subject: "Question",
  bodyText: "Original message text",
  sentAt: "2026-08-28T12:00:00.000Z",
  attachmentCount: 0,
};

test("manual Reply starts blank, honors Reply-To, and captures the selected message", () => {
  const session = createThreadComposeSession({
    mode: "reply",
    message,
    accountEmail: "owner@example.com",
  });
  assert.equal(session.recipients, "support@example.com, agent@example.com");
  assert.equal(session.body, "");
  assert.equal(session.subject, "Re: Question");
  assert.equal(session.message.id, message.id);
});

test("Reply uses the sender when no Reply-To exists and never addresses outgoing mail to yourself", () => {
  const incoming = createThreadComposeSession({
    mode: "reply",
    message: { ...message, headers: [] },
    accountEmail: "owner@example.com",
  });
  assert.equal(incoming.recipients, "sender@example.com");
  const outgoing = createThreadComposeSession({
    mode: "reply",
    message: {
      ...message,
      direction: "outgoing",
      headers: [
        {
          name: "To",
          value: "Owner <owner@example.com>, Recipient <recipient@example.com>",
        },
      ],
      subject: "Re: Question",
    },
    accountEmail: "owner@example.com",
  });
  assert.equal(outgoing.recipients, "recipient@example.com");
  assert.equal(outgoing.subject, "Re: Question");
});

test("Forward requires a new recipient and includes only the original message and visible headers", () => {
  const session = createThreadComposeSession({
    mode: "forward",
    message: {
      ...message,
      headers: [
        { name: "To", value: "owner@example.com" },
        { name: "Bcc", value: "private@example.com" },
      ],
    },
    accountEmail: "owner@example.com",
  });
  assert.equal(session.recipients, "");
  assert.equal(session.ccRecipients, "");
  assert.equal(session.bccRecipients, "");
  assert.equal(session.subject, "Fwd: Question");
  assert.equal(session.body, "");
  assert.match(
    session.forwardedMessageText ?? "",
    /From: Sender <sender@example.com>/,
  );
  assert.match(session.forwardedMessageText ?? "", /To: owner@example.com/);
  assert.match(
    session.forwardedMessageText ?? "",
    /Original message text$/,
  );
  assert.doesNotMatch(
    session.forwardedMessageText ?? "",
    /private@example.com/,
  );
});

const initialAttempt: ThreadComposeSendAttempt = {
  phase: "save",
  request: {
    accountId: "account-1",
    idempotencyKey: "save-key",
    recipients: ["recipient@example.com"],
    subject: "Re: Question",
    body: "Reply text",
    replyToMessageId: message.id,
  },
  sendIdempotencyKey: "send-key",
};
const providerDraft = {
  providerDraftId: "draft-1",
  providerMessageId: "message-2",
  providerThreadId: "thread-1",
};

test("Send saves first and retries a failed send with the same provider draft and key", async () => {
  let attempt: ThreadComposeSendAttempt = initialAttempt;
  let creates = 0;
  let sends = 0;
  const dependencies = {
    createDraft: async (request: typeof initialAttempt.request) => {
      creates += 1;
      assert.deepEqual(request, initialAttempt.request);
      return { draft: providerDraft, stepId: "save-step" };
    },
    sendDraft: async (
      draftId: string,
      request: { accountId: string; idempotencyKey: string },
    ) => {
      sends += 1;
      assert.equal(attempt.phase, "send");
      assert.equal(draftId, providerDraft.providerDraftId);
      assert.deepEqual(request, {
        accountId: "account-1",
        idempotencyKey: "send-key",
      });
      if (sends === 1) throw new Error("ambiguous send response");
      return {
        message: {
          providerMessageId: "sent-message",
          providerThreadId: "thread-1",
        },
        stepId: "send-step",
      };
    },
  };
  const onSaved = (nextAttempt: ThreadComposeSendAttempt): void => {
    attempt = nextAttempt;
  };
  await assert.rejects(
    sendThreadComposeAttempt(attempt, onSaved, dependencies),
    /ambiguous send response/,
  );
  const result = await sendThreadComposeAttempt(attempt, onSaved, dependencies);
  assert.equal(result.message.providerMessageId, "sent-message");
  assert.equal(creates, 1);
  assert.equal(sends, 2);
});

test("an ambiguous save keeps its original request key and never sends without a provider identity", async () => {
  let attempts = 0;
  let saves = 0;
  const dependencies = {
    createDraft: async (request: typeof initialAttempt.request) => {
      attempts += 1;
      assert.equal(request.idempotencyKey, "save-key");
      throw new Error("ambiguous save response");
    },
    sendDraft: async () => {
      assert.fail("must not send before draft save is confirmed");
    },
  };
  for (let retry = 0; retry < 2; retry += 1) {
    await assert.rejects(
      sendThreadComposeAttempt(
        initialAttempt,
        () => {
          saves += 1;
        },
        dependencies,
      ),
      /ambiguous save response/,
    );
  }
  assert.equal(attempts, 2);
  assert.equal(saves, 0);
});
