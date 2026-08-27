import assert from "node:assert/strict";
import test from "node:test";

import {
  parseMailboxChangeEvent,
  parseMailboxStreamReadyEvent,
} from "./mailbox-events";

const accountId = "00000000-0000-4000-8000-000000000001";
const firstThreadId = "00000000-0000-4000-8000-000000000002";
const secondThreadId = "00000000-0000-4000-8000-000000000003";

test("mailbox change parsing accepts exact browser-safe variants", () => {
  assert.deepEqual(
    parseMailboxChangeEvent(
      JSON.stringify({
        accountId,
        createdAt: "2026-08-17T00:00:00.000Z",
        changeType: "history_applied",
        reason: "history_catchup",
        changedThreadIds: [firstThreadId],
        refreshedThreadIds: [firstThreadId, secondThreadId],
      }),
    ),
    {
      accountId,
      createdAt: "2026-08-17T00:00:00.000Z",
      changeType: "history_applied",
      reason: "history_catchup",
      changedThreadIds: [firstThreadId],
      refreshedThreadIds: [firstThreadId, secondThreadId],
    },
  );
});

test("mailbox change parsing rejects incomplete and provider-shaped payloads", () => {
  assert.equal(
    parseMailboxChangeEvent(
      JSON.stringify({
        accountId,
        createdAt: "2026-08-17T00:00:00.000Z",
        changeType: "drafts_changed",
        kind: "upsert",
        providerMessageId: "provider-secret",
      }),
    ),
    null,
  );
  assert.equal(parseMailboxChangeEvent("not-json"), null);
});

test("mailbox stream readiness is a separate transport contract", () => {
  assert.deepEqual(
    parseMailboxStreamReadyEvent(
      JSON.stringify({ type: "mailbox_stream_ready", accountIds: [accountId] }),
    ),
    { type: "mailbox_stream_ready", accountIds: [accountId] },
  );
  assert.equal(
    parseMailboxStreamReadyEvent(
      JSON.stringify({ changeType: "mailbox_stream_ready", accountIds: [accountId] }),
    ),
    null,
  );
  assert.equal(
    parseMailboxStreamReadyEvent(
      JSON.stringify({ type: "mailbox_stream_ready", accountIds: [] }),
    ),
    null,
  );
});
