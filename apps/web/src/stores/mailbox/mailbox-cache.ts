import type { MailboxThreadPage, MailboxThreadSummary } from "@invook/contracts";

import type {
  ApplyMailboxThreadUpdatesInput,
  MailboxPageState,
} from "./types";

export interface CreateMailboxPageKeyInput {
  accountSelection: string;
  view: string;
}

export function createMailboxPageKey({
  accountSelection,
  view,
}: CreateMailboxPageKeyInput): string {
  return `${accountSelection}:${view}`;
}

function sortTime(thread: MailboxThreadSummary): number {
  if (!thread.latestMessageAt) return 0;
  const timestamp = new Date(thread.latestMessageAt).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

/**
 * Mirrors the server ordering of `listMailboxThreads`, which sorts on
 * `coalesce(latest_message_at, epoch)` descending and breaks ties on the thread
 * id descending. Cached pages sort on write so a paginated list and a
 * reconciled list agree on position.
 */
export function compareMailboxThreads(
  left: MailboxThreadSummary,
  right: MailboxThreadSummary,
): number {
  const difference = sortTime(right) - sortTime(left);
  if (difference !== 0) return difference;
  if (left.id === right.id) return 0;
  return left.id < right.id ? 1 : -1;
}

export function sortMailboxThreadIds(
  threadIds: string[],
  threadsById: Record<string, MailboxThreadSummary>,
): string[] {
  return [...threadIds].sort((leftId, rightId) => {
    const left = threadsById[leftId];
    const right = threadsById[rightId];
    if (!left || !right) return 0;
    return compareMailboxThreads(left, right);
  });
}

function upsertThreads(
  threadsById: Record<string, MailboxThreadSummary>,
  threads: MailboxThreadSummary[],
): Record<string, MailboxThreadSummary> {
  if (threads.length === 0) return threadsById;
  const next = { ...threadsById };
  for (const thread of threads) next[thread.id] = thread;
  return next;
}

function pruneThreads(
  threadsById: Record<string, MailboxThreadSummary>,
  pagesByKey: Record<string, MailboxPageState>,
): Record<string, MailboxThreadSummary> {
  const referenced = new Set<string>();
  for (const page of Object.values(pagesByKey)) {
    for (const threadId of page.threadIds) referenced.add(threadId);
  }
  const next: Record<string, MailboxThreadSummary> = {};
  for (const [threadId, thread] of Object.entries(threadsById)) {
    if (referenced.has(threadId)) next[threadId] = thread;
  }
  return next;
}

export interface HydrateMailboxPageStateInput {
  existing: MailboxPageState | undefined;
  page: MailboxThreadPage;
  threadsById: Record<string, MailboxThreadSummary>;
}

/**
 * Folds a freshly server-rendered page into cached state.
 *
 * The server page is authoritative for the window it covers, so a cached thread
 * that falls inside that window but is absent from the response has left the
 * view and is dropped. Threads older than the window were loaded by pagination
 * and are kept.
 */
export function hydrateMailboxPageState({
  existing,
  page,
  threadsById,
}: HydrateMailboxPageStateInput): MailboxPageState {
  const serverThreadIds = page.threads.map((thread) => thread.id);
  if (!existing || existing.isStale) {
    return {
      threadIds: sortMailboxThreadIds(serverThreadIds, threadsById),
      olderCursor: page.pagination.olderCursor,
      loadState: "idle",
      isStale: false,
    };
  }
  const serverThreadIdSet = new Set(serverThreadIds);
  const oldestServerThread = page.threads.reduce<MailboxThreadSummary | null>(
    (oldest, thread) =>
      oldest === null || compareMailboxThreads(thread, oldest) > 0
        ? thread
        : oldest,
    null,
  );
  const retainedThreadIds = existing.threadIds.filter((threadId) => {
    if (serverThreadIdSet.has(threadId)) return true;
    if (!oldestServerThread) return true;
    const thread = threadsById[threadId];
    if (!thread) return false;
    return compareMailboxThreads(thread, oldestServerThread) > 0;
  });
  const mergedThreadIds = [...retainedThreadIds];
  const retained = new Set(retainedThreadIds);
  for (const threadId of serverThreadIds) {
    if (!retained.has(threadId)) mergedThreadIds.push(threadId);
  }
  return {
    threadIds: sortMailboxThreadIds(mergedThreadIds, threadsById),
    olderCursor: existing.olderCursor,
    loadState: existing.loadState,
    isStale: false,
  };
}

export interface AppendMailboxPageStateInput {
  existing: MailboxPageState | undefined;
  page: MailboxThreadPage;
  threadsById: Record<string, MailboxThreadSummary>;
}

export function appendMailboxPageState({
  existing,
  page,
  threadsById,
}: AppendMailboxPageStateInput): MailboxPageState {
  const existingThreadIds = existing?.threadIds ?? [];
  const present = new Set(existingThreadIds);
  const appendedThreadIds = page.threads
    .map((thread) => thread.id)
    .filter((threadId) => !present.has(threadId));
  return {
    threadIds: sortMailboxThreadIds(
      [...existingThreadIds, ...appendedThreadIds],
      threadsById,
    ),
    olderCursor: page.pagination.olderCursor,
    loadState: "idle",
    isStale: existing?.isStale ?? false,
  };
}

/**
 * A reconciled thread only enters a page whose loaded window already covers its
 * position. Inserting an older thread into a partially loaded page would render
 * it above threads that pagination has not reached yet.
 */
function coversThreadPosition(
  thread: MailboxThreadSummary,
  page: MailboxPageState,
  threadsById: Record<string, MailboxThreadSummary>,
): boolean {
  if (page.olderCursor === null) return true;
  const oldestThreadId = page.threadIds.at(-1);
  if (!oldestThreadId) return true;
  const oldestThread = threadsById[oldestThreadId];
  if (!oldestThread) return true;
  return compareMailboxThreads(thread, oldestThread) <= 0;
}

export interface ApplyMailboxThreadUpdatesStateInput
  extends ApplyMailboxThreadUpdatesInput {
  pagesByKey: Record<string, MailboxPageState>;
  threadsById: Record<string, MailboxThreadSummary>;
}

export interface MailboxThreadUpdatesResult {
  pagesByKey: Record<string, MailboxPageState>;
  threadsById: Record<string, MailboxThreadSummary>;
}

export function applyMailboxThreadUpdates({
  key,
  missingThreadIds,
  pagesByKey,
  threads,
  threadsById,
}: ApplyMailboxThreadUpdatesStateInput): MailboxThreadUpdatesResult {
  const nextThreadsById = upsertThreads(threadsById, threads);
  const updatedThreadIds = new Set(threads.map((thread) => thread.id));
  const missing = new Set(missingThreadIds);
  const nextPagesByKey: Record<string, MailboxPageState> = {};

  for (const [pageKey, page] of Object.entries(pagesByKey)) {
    if (pageKey !== key) {
      const touchesPage = page.threadIds.some(
        (threadId) => updatedThreadIds.has(threadId) || missing.has(threadId),
      );
      nextPagesByKey[pageKey] = touchesPage
        ? {
            ...page,
            threadIds: sortMailboxThreadIds(page.threadIds, nextThreadsById),
            isStale: true,
          }
        : page;
      continue;
    }

    const retainedThreadIds = page.threadIds.filter(
      (threadId) => !missing.has(threadId),
    );
    const present = new Set(retainedThreadIds);
    const insertedThreadIds = threads
      .filter(
        (thread) =>
          !present.has(thread.id) &&
          coversThreadPosition(thread, page, nextThreadsById),
      )
      .map((thread) => thread.id);
    nextPagesByKey[pageKey] = {
      ...page,
      threadIds: sortMailboxThreadIds(
        [...retainedThreadIds, ...insertedThreadIds],
        nextThreadsById,
      ),
    };
  }

  return {
    pagesByKey: nextPagesByKey,
    threadsById: pruneThreads(nextThreadsById, nextPagesByKey),
  };
}
