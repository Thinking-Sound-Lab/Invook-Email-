import {
  MAILBOX_THREAD_UPDATE_LIMIT,
  type MailboxSidebarCounts,
  type MailboxThreadDetail,
  type MailboxThreadPage,
  type MailboxThreadUpdates,
  type MailSearchResult,
} from "@invook/contracts";
import axios from "axios";

export interface GetMailboxThreadPageInput {
  accountSelection: string;
  cursor?: string;
  view: string;
  signal?: AbortSignal;
}

export async function getMailboxThreadPage({
  accountSelection,
  cursor,
  view,
  signal,
}: GetMailboxThreadPageInput): Promise<MailboxThreadPage> {
  const response = await axios.get<MailboxThreadPage>("/v1/mailbox/threads", {
    params: { account: accountSelection, view, ...(cursor ? { cursor } : {}) },
    signal,
  });
  return response.data;
}

export interface SearchMailboxInput {
  accountSelection: string;
  query: string;
  signal?: AbortSignal;
}

export async function searchMailbox({
  accountSelection,
  query,
  signal,
}: SearchMailboxInput): Promise<MailSearchResult[]> {
  const response = await axios.get<{ results: MailSearchResult[] }>(
    "/v1/mail/search",
    { params: { q: query, account: accountSelection }, signal },
  );
  return response.data.results;
}

export interface GetMailboxThreadDetailInput {
  accountSelection: string;
  threadId: string;
  signal?: AbortSignal;
}

export async function getMailboxThreadDetail({
  accountSelection,
  threadId,
  signal,
}: GetMailboxThreadDetailInput): Promise<MailboxThreadDetail> {
  const response = await axios.get<MailboxThreadDetail>(
    `/v1/mailbox/threads/${encodeURIComponent(threadId)}`,
    { params: { account: accountSelection }, signal },
  );
  return response.data;
}

export interface GetMailboxThreadUpdatesInput {
  accountSelection: string;
  threadIds: string[];
  view: string;
  signal?: AbortSignal;
}

function chunkThreadIds(threadIds: string[]): string[][] {
  const chunks: string[][] = [];
  for (
    let index = 0;
    index < threadIds.length;
    index += MAILBOX_THREAD_UPDATE_LIMIT
  ) {
    chunks.push(threadIds.slice(index, index + MAILBOX_THREAD_UPDATE_LIMIT));
  }
  return chunks;
}

export async function getMailboxThreadUpdates({
  accountSelection,
  threadIds,
  view,
  signal,
}: GetMailboxThreadUpdatesInput): Promise<MailboxThreadUpdates> {
  const uniqueThreadIds = Array.from(new Set(threadIds));
  if (uniqueThreadIds.length === 0) {
    return { threads: [], missingThreadIds: [] };
  }
  const responses = await Promise.all(
    chunkThreadIds(uniqueThreadIds).map((chunk) =>
      axios.get<MailboxThreadUpdates>("/v1/mailbox/thread-updates", {
        params: { account: accountSelection, view, ids: chunk.join(",") },
        signal,
      }),
    ),
  );
  return {
    threads: responses.flatMap((response) => response.data.threads),
    missingThreadIds: responses.flatMap(
      (response) => response.data.missingThreadIds,
    ),
  };
}

export async function getMailboxSidebarCounts(
  signal?: AbortSignal,
): Promise<MailboxSidebarCounts> {
  const response = await axios.get<MailboxSidebarCounts>(
    "/v1/mailbox/sidebar-counts",
    { signal },
  );
  return response.data;
}
