import type {
  MailboxSettings,
  MailboxShell,
  MailboxSidebarCounts,
  MailboxThreadDetail,
  MailboxThreadPage,
  MailboxView,
  MailSearchResult,
  SessionState,
} from "@invook/contracts";
import axios from "axios";
import { headers } from "next/headers";

function getApiOrigin(): string {
  return (process.env.API_INTERNAL_URL ?? "http://127.0.0.1:4000").replace(/\/$/, "");
}

async function apiRequest<T>(path: string) {
  const requestHeaders = await headers();
  const cookie = requestHeaders.get("cookie");
  const requestId = requestHeaders.get("x-request-id");

  return axios.get<T>(`${getApiOrigin()}${path}`, {
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(requestId ? { "x-request-id": requestId } : {}),
    },
    validateStatus: () => true,
  });
}

export async function getSessionState(): Promise<SessionState> {
  const response = await apiRequest<SessionState>("/v1/session");
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`The session API returned ${response.status}.`);
  }
  return response.data;
}

export async function getMailboxShell(): Promise<MailboxShell | null> {
  const response = await apiRequest<MailboxShell>("/v1/mailbox/shell");
  if (response.status === 401 || response.status === 404) return null;
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`The mailbox shell API returned ${response.status}.`);
  }
  return response.data;
}

export async function getMailboxSidebarCounts(): Promise<MailboxSidebarCounts | null> {
  const response = await apiRequest<MailboxSidebarCounts>(
    "/v1/mailbox/sidebar-counts",
  );
  if (response.status === 401 || response.status === 404) return null;
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`The mailbox sidebar API returned ${response.status}.`);
  }
  return response.data;
}

export async function getMailboxThreadPage(input: {
  account: string;
  cursor?: string;
  view: MailboxView;
}): Promise<MailboxThreadPage | null> {
  const query = new URLSearchParams();
  query.set("account", input.account);
  query.set("view", input.view);
  if (input.cursor) query.set("cursor", input.cursor);
  const response = await apiRequest<MailboxThreadPage>(
    `/v1/mailbox/threads?${query.toString()}`,
  );

  if (response.status === 401 || response.status === 404) return null;
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`The mailbox thread list API returned ${response.status}.`);
  }
  return response.data;
}

export async function getMailboxThreadDetail(
  threadId: string,
  account: string,
): Promise<MailboxThreadDetail | null> {
  const query = new URLSearchParams({ account });
  const response = await apiRequest<MailboxThreadDetail>(
    `/v1/mailbox/threads/${encodeURIComponent(threadId)}?${query.toString()}`,
  );
  if (response.status === 401 || response.status === 404) return null;
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`The mailbox thread API returned ${response.status}.`);
  }
  return response.data;
}

export async function getMailboxSettings(accountId: string): Promise<MailboxSettings | null> {
  const query = new URLSearchParams({ account: accountId });
  const response = await apiRequest<MailboxSettings>(
    `/v1/mailbox/settings?${query.toString()}`,
  );
  if (response.status === 401 || response.status === 404) return null;
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`The mailbox settings API returned ${response.status}.`);
  }
  return response.data;
}

export async function searchMailbox(
  query: string,
  account: string,
): Promise<MailSearchResult[]> {
  const search = new URLSearchParams({ q: query, account });
  const response = await apiRequest<{ results: MailSearchResult[] }>(
    `/v1/mail/search?${search.toString()}`,
  );
  if (response.status === 401) return [];
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`The mail search API returned ${response.status}.`);
  }
  return response.data.results;
}
