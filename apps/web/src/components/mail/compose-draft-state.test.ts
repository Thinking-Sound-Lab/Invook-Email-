import assert from "node:assert/strict";
import test from "node:test";

import type { GmailComposeSendAttempt } from "../../lib/api/gmail-compose-send";

import {
  composeDraftReducer,
  createComposeDraftState,
  isComposeDraftLocked,
  type ComposeDraftState,
} from "./compose-draft-state";

const request = {
  accountId: "account-1",
  idempotencyKey: "save-key-1",
  recipients: ["recipient@example.com"],
  subject: "Project update",
  body: "The work is ready for review.",
};
const savePhaseAttempt: GmailComposeSendAttempt = {
  phase: "save",
  request,
  sendIdempotencyKey: "send-key-1",
};
const sendPhaseAttempt: Extract<GmailComposeSendAttempt, { phase: "send" }> = {
  phase: "send",
  request,
  sendIdempotencyKey: "send-key-1",
  draft: {
    providerDraftId: "provider-draft",
    providerMessageId: "provider-message",
    providerThreadId: "provider-thread",
  },
};

function sendingState(): ComposeDraftState {
  return composeDraftReducer(createComposeDraftState(), {
    type: "sending",
    attempt: savePhaseAttempt,
  });
}

test("copy recipients are first-class editable draft fields", () => {
  const withCc = composeDraftReducer(createComposeDraftState(), {
    type: "edit",
    field: "ccRecipients",
    value: "copy@example.com",
  });
  const withBcc = composeDraftReducer(withCc, {
    type: "edit",
    field: "bccRecipients",
    value: "private@example.com",
  });

  assert.equal(withBcc.ccRecipients, "copy@example.com");
  assert.equal(withBcc.bccRecipients, "private@example.com");
  assert.equal(withBcc.status, "editing");
});

test("a send that never created a Gmail draft stays editable and retries its keys", () => {
  const failed = composeDraftReducer(sendingState(), {
    type: "send_error",
    message: "Gmail is unavailable.",
    isReconnectRequired: false,
  });

  assert.equal(failed.status, "send_error");
  assert.equal(isComposeDraftLocked(failed), false);
  assert.deepEqual(failed.attempt, savePhaseAttempt);
});

test("editing after a failed save discards the unusable attempt", () => {
  const failed = composeDraftReducer(sendingState(), {
    type: "send_error",
    message: "Gmail is unavailable.",
    isReconnectRequired: false,
  });
  const edited = composeDraftReducer(failed, {
    type: "edit",
    field: "body",
    value: "Revised body",
  });

  assert.equal(edited.attempt, null);
  assert.equal(edited.status, "editing");
  assert.equal(edited.body, "Revised body");
});

test("an unresolved send freezes the message so only an identical retry resolves it", () => {
  const saved = composeDraftReducer(sendingState(), {
    type: "attempt_saved",
    attempt: sendPhaseAttempt,
  });
  const failed = composeDraftReducer(saved, {
    type: "send_error",
    message: "Gmail is unavailable.",
    isReconnectRequired: false,
  });
  const edited = composeDraftReducer(failed, {
    type: "edit",
    field: "body",
    value: "Revised body",
  });

  assert.equal(isComposeDraftLocked(failed), true);
  assert.equal(edited, failed);
  assert.deepEqual(failed.attempt, sendPhaseAttempt);
});

test("changing the sender discards an attempt bound to the previous account", () => {
  const failed = composeDraftReducer(sendingState(), {
    type: "send_error",
    message: "Gmail is unavailable.",
    isReconnectRequired: false,
  });
  const changed = composeDraftReducer(failed, { type: "change_sender" });

  assert.equal(changed.attempt, null);
  assert.equal(changed.status, "editing");
});

test("a successful send is terminal and states its convergence honestly", () => {
  const sent = composeDraftReducer(sendingState(), { type: "sent" });

  assert.equal(sent.status, "sent");
  assert.equal(sent.attempt, null);
  assert.equal(isComposeDraftLocked(sent), true);
  assert.match(sent.message ?? "", /Sent with Gmail/);
  assert.match(sent.message ?? "", /Gmail history catches up/);
});

test("a permanent auth failure requests reconnect and locks the message", () => {
  const reconnect = composeDraftReducer(sendingState(), {
    type: "send_error",
    message: "Gmail account must be reconnected",
    isReconnectRequired: true,
  });

  assert.equal(reconnect.status, "reconnect_required");
  assert.equal(isComposeDraftLocked(reconnect), true);
});

test("a validation failure reports the field error without starting an attempt", () => {
  const invalid = composeDraftReducer(createComposeDraftState(), {
    type: "error",
    message: "Enter at least one recipient email address.",
  });

  assert.equal(invalid.status, "error");
  assert.equal(invalid.attempt, null);
  assert.equal(isComposeDraftLocked(invalid), false);
});
