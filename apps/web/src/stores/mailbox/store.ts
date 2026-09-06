import type { MailboxThreadSummary } from "@invook/contracts";
import { create } from "zustand";
import { devtools } from "zustand/middleware";

import {
  appendMailboxPageState,
  applyMailboxThreadUpdates,
  hydrateMailboxPageState,
} from "./mailbox-cache";
import type { MailboxState } from "./types";

const initialState: Pick<
  MailboxState,
  "threadsById" | "detailsById" | "pagesByKey" | "sidebarCounts"
> = {
  threadsById: {},
  detailsById: {},
  pagesByKey: {},
  sidebarCounts: null,
};

function withThreads(
  threadsById: Record<string, MailboxThreadSummary>,
  threads: MailboxThreadSummary[],
): Record<string, MailboxThreadSummary> {
  const next = { ...threadsById };
  for (const thread of threads) next[thread.id] = thread;
  return next;
}

export const useMailboxStore = create<MailboxState>()(
  devtools(
    (set) => ({
      ...initialState,

      hydratePage: ({ key, page }) =>
        set((state) => {
          const threadsById = withThreads(state.threadsById, page.threads);
          return {
            threadsById,
            pagesByKey: {
              ...state.pagesByKey,
              [key]: hydrateMailboxPageState({
                existing: state.pagesByKey[key],
                page,
                threadsById,
              }),
            },
          };
        }),

      appendPage: ({ key, page }) =>
        set((state) => {
          const threadsById = withThreads(state.threadsById, page.threads);
          return {
            threadsById,
            pagesByKey: {
              ...state.pagesByKey,
              [key]: appendMailboxPageState({
                existing: state.pagesByKey[key],
                page,
                threadsById,
              }),
            },
          };
        }),

      setPageLoadState: ({ key, loadState }) =>
        set((state) => {
          const page = state.pagesByKey[key];
          if (!page || page.loadState === loadState) return state;
          return {
            pagesByKey: { ...state.pagesByKey, [key]: { ...page, loadState } },
          };
        }),

      applyThreadUpdates: ({ key, threads, missingThreadIds }) =>
        set((state) =>
          applyMailboxThreadUpdates({
            key,
            missingThreadIds,
            pagesByKey: state.pagesByKey,
            threads,
            threadsById: state.threadsById,
          }),
        ),

      patchThread: ({ threadId, patch }) =>
        set((state) => {
          const thread = state.threadsById[threadId];
          if (!thread) return state;
          return {
            threadsById: {
              ...state.threadsById,
              [threadId]: { ...thread, ...patch },
            },
          };
        }),

      hydrateThreadDetail: ({ threadId, detail }) =>
        set((state) => ({
          detailsById: { ...state.detailsById, [threadId]: detail },
        })),

      removeThreadDetail: (threadId) =>
        set((state) => {
          if (!state.detailsById[threadId]) return state;
          return {
            detailsById: Object.fromEntries(
              Object.entries(state.detailsById).filter(
                ([cachedThreadId]) => cachedThreadId !== threadId,
              ),
            ),
          };
        }),

      setSidebarCounts: (sidebarCounts) => set({ sidebarCounts }),

      reset: () => set(initialState),
    }),
    { name: "mailbox-store" },
  ),
);
