import type {
  MailboxSidebarCounts,
  MailboxThreadDetail,
  MailboxThreadPage,
  MailboxThreadSummary,
} from "@invook/contracts";

export type MailboxPageLoadState = "idle" | "loading" | "error";

export interface MailboxPageState {
  /**
   * Thread identities in server order, sorted on write so selectors return a
   * stable reference and rows never re-sort during render.
   */
  threadIds: string[];
  olderCursor: string | null;
  loadState: MailboxPageLoadState;
  /**
   * Set when a mailbox change event reconciled a different view, so this page's
   * membership can no longer be trusted. The next server render replaces it
   * instead of merging into it.
   */
  isStale: boolean;
}

export interface HydrateMailboxPageInput {
  key: string;
  page: MailboxThreadPage;
}

export interface AppendMailboxPageInput {
  key: string;
  page: MailboxThreadPage;
}

export interface SetMailboxPageLoadStateInput {
  key: string;
  loadState: MailboxPageLoadState;
}

export interface ApplyMailboxThreadUpdatesInput {
  key: string;
  threads: MailboxThreadSummary[];
  missingThreadIds: string[];
}

export interface PatchMailboxThreadInput {
  threadId: string;
  patch: Partial<MailboxThreadSummary>;
}

export interface HydrateMailboxThreadDetailInput {
  threadId: string;
  detail: MailboxThreadDetail;
}

export interface MailboxState {
  threadsById: Record<string, MailboxThreadSummary>;
  /**
   * Opened threads, kept so returning to one renders from the cache instead of
   * waiting on the server. A stored message body never changes, so a cached
   * detail only goes out of date when an event names its thread.
   */
  detailsById: Record<string, MailboxThreadDetail>;
  pagesByKey: Record<string, MailboxPageState>;
  sidebarCounts: MailboxSidebarCounts | null;
  hydratePage: (input: HydrateMailboxPageInput) => void;
  appendPage: (input: AppendMailboxPageInput) => void;
  setPageLoadState: (input: SetMailboxPageLoadStateInput) => void;
  applyThreadUpdates: (input: ApplyMailboxThreadUpdatesInput) => void;
  patchThread: (input: PatchMailboxThreadInput) => void;
  hydrateThreadDetail: (input: HydrateMailboxThreadDetailInput) => void;
  removeThreadDetail: (threadId: string) => void;
  setSidebarCounts: (sidebarCounts: MailboxSidebarCounts | null) => void;
  reset: () => void;
}
