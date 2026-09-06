import assert from "node:assert/strict";
import { test } from "node:test";

import type { MailboxChangeEvent } from "@invook/contracts";

import { planMailboxEvent, type MailboxEventLocation } from "./mailbox-event-plan";

const mailboxLocation: MailboxEventLocation = {
  accountSelection: "all",
  threadId: null,
  view: "all",
};

function historyApplied(
  changedThreadIds: string[],
  refreshedThreadIds: string[] = [],
): MailboxChangeEvent {
  return {
    accountId: "account-1",
    createdAt: "2026-09-05T10:00:00.000Z",
    changeType: "history_applied",
    reason: "history_catchup",
    changedThreadIds,
    refreshedThreadIds,
  };
}

test("a named thread change reconciles instead of refreshing the route", () => {
  const plan = planMailboxEvent(
    historyApplied(["thread-1"], ["thread-1", "thread-2"]),
    mailboxLocation,
  );
  assert.deepEqual(plan, { kind: "patch", threadIds: ["thread-1", "thread-2"] });
});

test("an event for another account is ignored while that account is scoped out", () => {
  const plan = planMailboxEvent(historyApplied(["thread-1"]), {
    ...mailboxLocation,
    accountSelection: "account-2",
  });
  assert.deepEqual(plan, { kind: "ignore" });
});

test("an event naming no thread is ignored", () => {
  assert.deepEqual(planMailboxEvent(historyApplied([]), mailboxLocation), {
    kind: "ignore",
  });
});

test("a change to the open thread reconciles it rather than refreshing", () => {
  const plan = planMailboxEvent(historyApplied(["thread-1"]), {
    ...mailboxLocation,
    threadId: "thread-1",
  });
  assert.deepEqual(plan, { kind: "patch", threadIds: ["thread-1"] });
});

test("label and draft changes reconcile by thread identity", () => {
  const labelPlan = planMailboxEvent(
    {
      accountId: "account-1",
      createdAt: "2026-09-05T10:00:00.000Z",
      changeType: "labels_changed",
      kind: "decision",
      affectedThreadIds: ["thread-3"],
    },
    mailboxLocation,
  );
  assert.deepEqual(labelPlan, { kind: "patch", threadIds: ["thread-3"] });

  const draftPlan = planMailboxEvent(
    {
      accountId: "account-1",
      createdAt: "2026-09-05T10:00:00.000Z",
      changeType: "drafts_changed",
      kind: "upsert",
      affectedThreadIds: ["thread-4"],
    },
    { ...mailboxLocation, view: "drafts" },
  );
  assert.deepEqual(draftPlan, { kind: "patch", threadIds: ["thread-4"] });
});

test("structural events still refresh the server rendered shell", () => {
  assert.deepEqual(
    planMailboxEvent(
      {
        accountId: "account-1",
        createdAt: "2026-09-05T10:00:00.000Z",
        changeType: "replica_ready",
      },
      mailboxLocation,
    ),
    { kind: "refresh" },
  );
  assert.deepEqual(
    planMailboxEvent(
      {
        accountId: "account-1",
        createdAt: "2026-09-05T10:00:00.000Z",
        changeType: "safe_invalidation",
        reason: "legacy_or_malformed",
      },
      mailboxLocation,
    ),
    { kind: "refresh" },
  );
});
