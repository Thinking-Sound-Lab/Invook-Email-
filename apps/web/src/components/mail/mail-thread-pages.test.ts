import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeMailboxThreads,
  resolveMailThreadPaginationState,
} from "./mail-thread-pages";
import type { MailThreadSummary } from "./types";

function thread(id: string, subject = id): MailThreadSummary {
  return {
    id,
    accountId: "00000000-0000-4000-8000-000000000001",
    accountEmail: "first@example.test",
    subject,
    snippet: "",
    participants: [],
    isUnread: false,
    isStarred: false,
    isDraft: false,
    invookLabel: null,
    latestMessageAt: "2026-08-16T00:00:00.000Z",
    messageCount: 1,
  };
}

test("mailbox pages append without duplicating cursor-boundary threads", () => {
  assert.deepEqual(
    mergeMailboxThreads(
      [thread("first"), thread("boundary")],
      [thread("boundary"), thread("older")],
    ).map((item) => item.id),
    ["first", "boundary", "older"],
  );
});

test("refreshed first-page summaries replace stale stored summaries", () => {
  const merged = mergeMailboxThreads(
    [thread("new"), thread("existing", "Updated subject")],
    [thread("existing", "Stale subject"), thread("older")],
  );

  assert.deepEqual(
    merged.map((item) => [item.id, item.subject]),
    [
      ["new", "new"],
      ["existing", "Updated subject"],
      ["older", "older"],
    ],
  );
});

test("a canonical same-view refresh discards continuation pages and their cursor", () => {
  const state = resolveMailThreadPaginationState({
    canonicalPageVersion: "refreshed-page",
    initialOlderCursor: "refreshed-cursor",
    state: {
      canonicalPageVersion: "previous-page",
      continuationThreads: [thread("stale-continuation")],
      loadState: "error",
      olderCursor: "stale-cursor",
    },
  });

  assert.deepEqual(state, {
    canonicalPageVersion: "refreshed-page",
    continuationThreads: [],
    loadState: "idle",
    olderCursor: "refreshed-cursor",
  });
});

test("pagination state remains available within one canonical page generation", () => {
  const currentState = {
    canonicalPageVersion: "current-page",
    continuationThreads: [thread("continuation")],
    loadState: "idle" as const,
    olderCursor: "next-cursor",
  };

  assert.equal(
    resolveMailThreadPaginationState({
      canonicalPageVersion: "current-page",
      initialOlderCursor: "initial-cursor",
      state: currentState,
    }),
    currentState,
  );
});
