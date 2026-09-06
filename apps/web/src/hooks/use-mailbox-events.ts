"use client";

import {
  parseMailboxChangeEvent,
  parseMailboxStreamReadyEvent,
} from "@invook/contracts";
import { useRouter, useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";

import { resolveMailboxAccountSelection } from "@/components/mail/mail-account-scope";
import { useMailShell } from "@/components/mail/mail-shell-provider";
import { planMailboxEvent } from "@/components/mail/mailbox-event-plan";
import {
  getMailboxSidebarCounts,
  getMailboxThreadDetail,
  getMailboxThreadUpdates,
} from "@/lib/api/mailbox-threads";
import { createMailboxPageKey } from "@/stores/mailbox/mailbox-cache";
import { useMailboxStore } from "@/stores/mailbox/store";

export type MailboxEventStreamStatus = "connecting" | "ready" | "degraded";

export function useMailboxEvents(): MailboxEventStreamStatus {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { accounts } = useMailShell();
  const threadId = searchParams.get("thread");
  const view = searchParams.get("view") ?? "all";
  const accountSelection = resolveMailboxAccountSelection(
    searchParams.get("account"),
    accounts,
  );
  const [status, setStatus] = useState<MailboxEventStreamStatus>("connecting");
  const [isRefreshPending, startRefreshTransition] = useTransition();
  const locationRef = useRef({ accountSelection, threadId, view });
  const isRefreshPendingRef = useRef(false);
  const hasQueuedRefreshRef = useRef(false);
  const applyThreadUpdates = useMailboxStore((state) => state.applyThreadUpdates);
  const setSidebarCounts = useMailboxStore((state) => state.setSidebarCounts);
  const hydrateThreadDetail = useMailboxStore(
    (state) => state.hydrateThreadDetail,
  );
  const removeThreadDetail = useMailboxStore(
    (state) => state.removeThreadDetail,
  );

  useEffect(() => {
    locationRef.current = { accountSelection, threadId, view };
  }, [accountSelection, threadId, view]);

  const refreshMailbox = useCallback(() => {
    if (isRefreshPendingRef.current) {
      hasQueuedRefreshRef.current = true;
      return;
    }
    isRefreshPendingRef.current = true;
    startRefreshTransition(() => router.refresh());
  }, [router]);

  useEffect(() => {
    isRefreshPendingRef.current = isRefreshPending;
    if (!isRefreshPending && hasQueuedRefreshRef.current) {
      hasQueuedRefreshRef.current = false;
      refreshMailbox();
    }
  }, [isRefreshPending, refreshMailbox]);

  /**
   * Cached threads other than the open one are dropped rather than re-read, so
   * one event never fans out into a request per thread the reader has visited.
   */
  const reconcileThreadDetails = useCallback(
    async (threadIds: string[]): Promise<void> => {
      const openThreadId = locationRef.current.threadId;
      const cachedDetails = useMailboxStore.getState().detailsById;
      for (const threadId of threadIds) {
        if (threadId !== openThreadId && cachedDetails[threadId]) {
          removeThreadDetail(threadId);
        }
      }
      if (!openThreadId || !threadIds.includes(openThreadId)) return;
      const detail = await getMailboxThreadDetail({
        accountSelection: locationRef.current.accountSelection,
        threadId: openThreadId,
      });
      hydrateThreadDetail({ threadId: openThreadId, detail });
    },
    [hydrateThreadDetail, removeThreadDetail],
  );

  const patchMailbox = useCallback(
    async (threadIds: string[]): Promise<void> => {
      const location = locationRef.current;
      try {
        const [updates, sidebarCounts] = await Promise.all([
          getMailboxThreadUpdates({
            accountSelection: location.accountSelection,
            threadIds,
            view: location.view,
          }),
          getMailboxSidebarCounts(),
          reconcileThreadDetails(threadIds),
        ]);
        applyThreadUpdates({
          key: createMailboxPageKey({
            accountSelection: location.accountSelection,
            view: location.view,
          }),
          threads: updates.threads,
          missingThreadIds: updates.missingThreadIds,
        });
        setSidebarCounts(sidebarCounts);
      } catch {
        // A failed reconciliation leaves the cache untouched, so fall back to
        // the server render rather than showing a partially applied mailbox.
        refreshMailbox();
      }
    },
    [applyThreadUpdates, reconcileThreadDetails, refreshMailbox, setSidebarCounts],
  );

  useEffect(() => {
    const eventSource = new EventSource("/v1/mailbox/events");
    const handleReady = (event: Event) => {
      if (!(event instanceof MessageEvent) || typeof event.data !== "string") {
        return;
      }
      const ready = parseMailboxStreamReadyEvent(event.data);
      if (
        !ready ||
        (locationRef.current.accountSelection !== "all" &&
          !ready.accountIds.includes(locationRef.current.accountSelection))
      ) {
        return;
      }
      setStatus("ready");
      // The stream carries no replay, so a fresh connection cannot know what
      // changed while it was closed and has to re-read the route.
      refreshMailbox();
    };
    const handleOpen = () => setStatus("connecting");
    const handleError = () => setStatus("degraded");
    eventSource.addEventListener("open", handleOpen);
    eventSource.addEventListener("error", handleError);
    const handleMailboxChange = (event: Event) => {
      if (!(event instanceof MessageEvent) || typeof event.data !== "string") return;
      const change = parseMailboxChangeEvent(event.data);
      if (!change) return;
      const plan = planMailboxEvent(change, locationRef.current);
      if (plan.kind === "refresh") refreshMailbox();
      if (plan.kind === "patch") void patchMailbox(plan.threadIds);
    };
    eventSource.addEventListener("mailbox-ready", handleReady);
    eventSource.addEventListener("mailbox", handleMailboxChange);

    return () => {
      eventSource.removeEventListener("mailbox-ready", handleReady);
      eventSource.removeEventListener("mailbox", handleMailboxChange);
      eventSource.removeEventListener("open", handleOpen);
      eventSource.removeEventListener("error", handleError);
      eventSource.close();
    };
  }, [patchMailbox, refreshMailbox]);

  return status;
}
