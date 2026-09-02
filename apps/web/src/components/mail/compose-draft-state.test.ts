import assert from "node:assert/strict";
import test from "node:test";

import {
  composeDraftReducer,
  createComposeDraftState,
} from "./compose-draft-state";

test("a failed save preserves the idempotency key for an exact retry", () => {
  const initial = createComposeDraftState("save-key-1");
  const saving = composeDraftReducer(initial, { type: "saving" });
  const failed = composeDraftReducer(saving, {
    type: "error",
    message: "Gmail is unavailable.",
  });

  assert.equal(failed.idempotencyKey, "save-key-1");
  assert.equal(failed.status, "error");
});

test("editing after a save rotates the key and retains the provider draft identity", () => {
  const saved = composeDraftReducer(createComposeDraftState("save-key-1"), {
    type: "saved",
    sendIdempotencyKey: "send-key-1",
    draft: {
      providerDraftId: "provider-draft",
      providerMessageId: "provider-message",
      providerThreadId: "provider-thread",
    },
  });
  const edited = composeDraftReducer(saved, {
    type: "edit",
    field: "body",
    value: "Revised body",
    idempotencyKey: "save-key-2",
  });

  assert.equal(edited.idempotencyKey, "save-key-2");
  assert.equal(edited.sendIdempotencyKey, null);
  assert.equal(edited.status, "editing");
  assert.equal(edited.providerDraft?.providerDraftId, "provider-draft");
});

test("copy recipients are first-class editable draft fields", () => {
  const initial = createComposeDraftState("save-key-1");
  const withCc = composeDraftReducer(initial, {
    type: "edit",
    field: "ccRecipients",
    value: "copy@example.com",
    idempotencyKey: "save-key-2",
  });
  const withBcc = composeDraftReducer(withCc, {
    type: "edit",
    field: "bccRecipients",
    value: "private@example.com",
    idempotencyKey: "save-key-3",
  });

  assert.equal(withBcc.ccRecipients, "copy@example.com");
  assert.equal(withBcc.bccRecipients, "private@example.com");
  assert.equal(withBcc.idempotencyKey, "save-key-3");
});

test("changing the sender rotates the save idempotency key", () => {
  const changed = composeDraftReducer(createComposeDraftState("save-key-1"), {
    type: "change_sender",
    idempotencyKey: "save-key-2",
  });

  assert.equal(changed.idempotencyKey, "save-key-2");
  assert.equal(changed.status, "editing");
});

test("a successful save exposes an explicit convergence state", () => {
  const saved = composeDraftReducer(createComposeDraftState("save-key-1"), {
    type: "saved",
    sendIdempotencyKey: "send-key-1",
    draft: {
      providerDraftId: "provider-draft",
      providerMessageId: "provider-message",
      providerThreadId: "provider-thread",
    },
  });

  assert.equal(saved.status, "saved");
  assert.match(saved.message ?? "", /Gmail history catches up/);
});

test("send confirmation is explicit and an error preserves its idempotency key", () => {
  const saved = composeDraftReducer(createComposeDraftState("save-key-1"), {
    type: "saved",
    sendIdempotencyKey: "send-key-1",
    draft: {
      providerDraftId: "provider-draft",
      providerMessageId: "provider-message",
      providerThreadId: "provider-thread",
    },
  });
  const confirming = composeDraftReducer(saved, { type: "confirm_send" });
  const sending = composeDraftReducer(confirming, { type: "sending" });
  const failed = composeDraftReducer(sending, {
    type: "send_error",
    message: "Gmail is unavailable.",
    isReconnectRequired: false,
  });

  assert.equal(confirming.status, "confirming_send");
  assert.equal(failed.status, "send_error");
  assert.equal(failed.sendIdempotencyKey, "send-key-1");
});

test("a successful send is terminal and a permanent auth failure requests reconnect", () => {
  const saved = composeDraftReducer(createComposeDraftState("save-key-1"), {
    type: "saved",
    sendIdempotencyKey: "send-key-1",
    draft: {
      providerDraftId: "provider-draft",
      providerMessageId: "provider-message",
      providerThreadId: "provider-thread",
    },
  });
  const sent = composeDraftReducer(saved, { type: "sent" });
  const reconnect = composeDraftReducer(saved, {
    type: "send_error",
    message: "Gmail account must be reconnected",
    isReconnectRequired: true,
  });

  assert.equal(sent.status, "sent");
  assert.match(sent.message ?? "", /Sent with Gmail/);
  assert.equal(reconnect.status, "reconnect_required");
});
