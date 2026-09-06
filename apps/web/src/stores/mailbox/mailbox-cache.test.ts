import assert from "node:assert/strict";
import { test } from "node:test";

import type { MailboxThreadPage, MailboxThreadSummary } from "@invook/contracts";

import {
  appendMailboxPageState,
  applyMailboxThreadUpdates,
  compareMailboxThreads,
  createMailboxPageKey,
  hydrateMailboxPageState,
  sortMailboxThreadIds,
} from "./mailbox-cache";
import type { MailboxPageState } from "./types";

function createThread(
  id: string,
  latestMessageAt: string | null,
  overrides: Partial<MailboxThreadSummary> = {},
): MailboxThreadSummary {
  return {
    accountId: "account-1",
    accountEmail: "person@example.com",
    id,
    subject: `Subject ${id}`,
    snippet: "",
    participants: [],
    latestMessageAt,
    messageCount: 1,
    isUnread: false,
    isStarred: false,
    isDraft: false,
    invookLabel: null,
    ...overrides,
  };
}

function createIndex(
  threads: MailboxThreadSummary[],
): Record<string, MailboxThreadSummary> {
  return Object.fromEntries(threads.map((thread) => [thread.id, thread]));
}

function createPage(
  threads: MailboxThreadSummary[],
  olderCursor: string | null = null,
): MailboxThreadPage {
  return { pagination: { newerCursor: null, olderCursor }, threads };
}

test("page keys separate account scope from view", () => {
  assert.equal(
    createMailboxPageKey({ accountSelection: "all", view: "starred" }),
    "all:starred",
  );
  assert.notEqual(
    createMailboxPageKey({ accountSelection: "all", view: "all" }),
    createMailboxPageKey({ accountSelection: "account-1", view: "all" }),
  );
});

test("threads sort newest first with a stable identity tiebreak", () => {
  const newer = createThread("a", "2026-09-05T10:00:00.000Z");
  const older = createThread("b", "2026-09-04T10:00:00.000Z");
  const undated = createThread("c", null);
  assert.ok(compareMailboxThreads(newer, older) < 0);
  assert.ok(compareMailboxThreads(older, undated) < 0);

  const tieHigh = createThread("f", "2026-09-05T10:00:00.000Z");
  const tieLow = createThread("a", "2026-09-05T10:00:00.000Z");
  assert.ok(compareMailboxThreads(tieHigh, tieLow) < 0);

  const threadsById = createIndex([newer, older, undated]);
  assert.deepEqual(
    sortMailboxThreadIds(["c", "b", "a"], threadsById),
    ["a", "b", "c"],
  );
});

test("hydrating an unseen view adopts the server page", () => {
  const first = createThread("a", "2026-09-05T10:00:00.000Z");
  const second = createThread("b", "2026-09-04T10:00:00.000Z");
  const page = hydrateMailboxPageState({
    existing: undefined,
    page: createPage([second, first], "cursor-1"),
    threadsById: createIndex([first, second]),
  });
  assert.deepEqual(page.threadIds, ["a", "b"]);
  assert.equal(page.olderCursor, "cursor-1");
  assert.equal(page.isStale, false);
});

test("hydrating keeps paginated threads and the deeper cursor", () => {
  const newest = createThread("a", "2026-09-05T10:00:00.000Z");
  const paginated = createThread("z", "2026-01-01T10:00:00.000Z");
  const threadsById = createIndex([newest, paginated]);
  const existing: MailboxPageState = {
    threadIds: ["a", "z"],
    olderCursor: "cursor-page-3",
    loadState: "idle",
    isStale: false,
  };
  const page = hydrateMailboxPageState({
    existing,
    page: createPage([newest], "cursor-page-1"),
    threadsById,
  });
  assert.deepEqual(page.threadIds, ["a", "z"]);
  assert.equal(page.olderCursor, "cursor-page-3");
});

test("hydrating drops a cached thread the server page no longer contains", () => {
  const kept = createThread("a", "2026-09-05T10:00:00.000Z");
  const archived = createThread("b", "2026-09-04T10:00:00.000Z");
  const paginated = createThread("z", "2026-01-01T10:00:00.000Z");
  const existing: MailboxPageState = {
    threadIds: ["a", "b", "z"],
    olderCursor: "cursor-page-3",
    loadState: "idle",
    isStale: false,
  };
  const page = hydrateMailboxPageState({
    existing,
    // The server window reaches back to "c", so an omitted "b" has left the view
    // while the older paginated "z" sits outside the window and stays.
    page: createPage([kept, createThread("c", "2026-09-03T10:00:00.000Z")], "x"),
    threadsById: createIndex([
      kept,
      archived,
      paginated,
      createThread("c", "2026-09-03T10:00:00.000Z"),
    ]),
  });
  assert.deepEqual(page.threadIds, ["a", "c", "z"]);
});

test("hydrating a stale view replaces its membership", () => {
  const server = createThread("a", "2026-09-05T10:00:00.000Z");
  const existing: MailboxPageState = {
    threadIds: ["stale-1", "stale-2"],
    olderCursor: "cursor-page-3",
    loadState: "idle",
    isStale: true,
  };
  const page = hydrateMailboxPageState({
    existing,
    page: createPage([server], "cursor-page-1"),
    threadsById: createIndex([server]),
  });
  assert.deepEqual(page.threadIds, ["a"]);
  assert.equal(page.olderCursor, "cursor-page-1");
  assert.equal(page.isStale, false);
});

test("appending a page keeps loaded threads and advances the cursor", () => {
  const loaded = createThread("a", "2026-09-05T10:00:00.000Z");
  const appended = createThread("b", "2026-09-04T10:00:00.000Z");
  const existing: MailboxPageState = {
    threadIds: ["a"],
    olderCursor: "cursor-1",
    loadState: "loading",
    isStale: false,
  };
  const page = appendMailboxPageState({
    existing,
    page: createPage([appended], "cursor-2"),
    threadsById: createIndex([loaded, appended]),
  });
  assert.deepEqual(page.threadIds, ["a", "b"]);
  assert.equal(page.olderCursor, "cursor-2");
  assert.equal(page.loadState, "idle");
});

test("thread updates replace rows and reorder the page", () => {
  const first = createThread("a", "2026-09-05T10:00:00.000Z");
  const second = createThread("b", "2026-09-04T10:00:00.000Z");
  const repliedSecond = createThread("b", "2026-09-06T10:00:00.000Z", {
    isUnread: true,
  });
  const result = applyMailboxThreadUpdates({
    key: "all:all",
    missingThreadIds: [],
    pagesByKey: {
      "all:all": {
        threadIds: ["a", "b"],
        olderCursor: null,
        loadState: "idle",
        isStale: false,
      },
    },
    threads: [repliedSecond],
    threadsById: createIndex([first, second]),
  });
  assert.deepEqual(result.pagesByKey["all:all"]?.threadIds, ["b", "a"]);
  assert.equal(result.threadsById.b?.isUnread, true);
});

test("thread updates remove threads that left the view", () => {
  const kept = createThread("a", "2026-09-05T10:00:00.000Z");
  const archived = createThread("b", "2026-09-04T10:00:00.000Z");
  const result = applyMailboxThreadUpdates({
    key: "all:all",
    missingThreadIds: ["b"],
    pagesByKey: {
      "all:all": {
        threadIds: ["a", "b"],
        olderCursor: null,
        loadState: "idle",
        isStale: false,
      },
    },
    threads: [],
    threadsById: createIndex([kept, archived]),
  });
  assert.deepEqual(result.pagesByKey["all:all"]?.threadIds, ["a"]);
  assert.equal(result.threadsById.b, undefined);
});

test("a new thread enters a partially loaded page only inside its window", () => {
  const loaded = createThread("a", "2026-09-05T10:00:00.000Z");
  const arriving = createThread("new", "2026-09-06T10:00:00.000Z");
  const beyondWindow = createThread("old", "2020-01-01T10:00:00.000Z");
  const pagesByKey = {
    "all:all": {
      threadIds: ["a"],
      olderCursor: "cursor-1",
      loadState: "idle" as const,
      isStale: false,
    },
  };
  const threadsById = createIndex([loaded]);

  const inside = applyMailboxThreadUpdates({
    key: "all:all",
    missingThreadIds: [],
    pagesByKey,
    threads: [arriving],
    threadsById,
  });
  assert.deepEqual(inside.pagesByKey["all:all"]?.threadIds, ["new", "a"]);

  const outside = applyMailboxThreadUpdates({
    key: "all:all",
    missingThreadIds: [],
    pagesByKey,
    threads: [beyondWindow],
    threadsById,
  });
  assert.deepEqual(outside.pagesByKey["all:all"]?.threadIds, ["a"]);
});

test("reconciling one view marks the other cached views stale", () => {
  const shared = createThread("a", "2026-09-05T10:00:00.000Z");
  const updated = createThread("a", "2026-09-06T10:00:00.000Z");
  const result = applyMailboxThreadUpdates({
    key: "all:all",
    missingThreadIds: [],
    pagesByKey: {
      "all:all": {
        threadIds: ["a"],
        olderCursor: null,
        loadState: "idle",
        isStale: false,
      },
      "all:starred": {
        threadIds: ["a"],
        olderCursor: null,
        loadState: "idle",
        isStale: false,
      },
      "all:sent": {
        threadIds: [],
        olderCursor: null,
        loadState: "idle",
        isStale: false,
      },
    },
    threads: [updated],
    threadsById: createIndex([shared]),
  });
  assert.equal(result.pagesByKey["all:all"]?.isStale, false);
  assert.equal(result.pagesByKey["all:starred"]?.isStale, true);
  assert.equal(result.pagesByKey["all:sent"]?.isStale, false);
});
