"use client";

import type { MailboxThreadDetail } from "@invook/contracts";
import axios from "axios";
import { useCallback, useEffect, useState } from "react";

import { getMailboxThreadDetail } from "@/lib/api/mailbox-threads";
import { useMailboxStore } from "@/stores/mailbox/store";

export type ThreadDetailLoadState =
  | "loading"
  | "available"
  | "missing"
  | "error";

export interface UseThreadDetailProps {
  accountSelection: string;
  threadId: string;
}

export interface UseThreadDetailResult {
  detail: MailboxThreadDetail | null;
  loadState: ThreadDetailLoadState;
  reload: () => void;
}

interface ThreadDetailRequestResult {
  threadId: string;
  status: Exclude<ThreadDetailLoadState, "loading">;
}

/**
 * Reads an opened thread, preferring the cache so a revisited thread renders
 * without waiting on the server. A cached thread still revalidates in the
 * background because stored state, not the cache, is authoritative.
 */
export function useThreadDetail({
  accountSelection,
  threadId,
}: UseThreadDetailProps): UseThreadDetailResult {
  const detail = useMailboxStore((state) => state.detailsById[threadId] ?? null);
  const hydrateThreadDetail = useMailboxStore(
    (state) => state.hydrateThreadDetail,
  );
  const removeThreadDetail = useMailboxStore(
    (state) => state.removeThreadDetail,
  );
  const [result, setResult] = useState<ThreadDetailRequestResult | null>(null);
  const [reloadCount, setReloadCount] = useState(0);
  const loadState: ThreadDetailLoadState =
    result?.threadId === threadId
      ? result.status
      : detail
        ? "available"
        : "loading";

  const reload = useCallback(() => {
    setReloadCount((current) => current + 1);
  }, []);

  useEffect(() => {
    const requestController = new AbortController();
    void (async () => {
      try {
        const nextDetail = await getMailboxThreadDetail({
          accountSelection,
          threadId,
          signal: requestController.signal,
        });
        if (requestController.signal.aborted) return;
        hydrateThreadDetail({ threadId, detail: nextDetail });
        setResult({ threadId, status: "available" });
      } catch (cause: unknown) {
        if (axios.isCancel(cause) || requestController.signal.aborted) return;
        const status =
          axios.isAxiosError(cause) && cause.response?.status === 404
            ? "missing"
            : "error";
        if (status === "missing") removeThreadDetail(threadId);
        setResult({ threadId, status });
      }
    })();
    return () => requestController.abort();
  }, [
    accountSelection,
    hydrateThreadDetail,
    reloadCount,
    removeThreadDetail,
    threadId,
  ]);

  return { detail, loadState, reload };
}
