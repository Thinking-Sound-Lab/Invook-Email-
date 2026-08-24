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

import { isRelevantMailboxChange } from "@/components/mail/mailbox-event-relevance";
import { resolveMailboxAccountSelection } from "@/components/mail/mail-account-scope";
import { useMailShell } from "@/components/mail/mail-shell-provider";

export type MailboxEventStreamStatus = "connecting" | "ready" | "degraded";

export function useMailboxEvents(): MailboxEventStreamStatus {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { accounts } = useMailShell();
  const surface = searchParams.get("surface") ?? "mail";
  const threadId = searchParams.get("thread");
  const view = searchParams.get("view") ?? "all";
  const accountSelection = resolveMailboxAccountSelection(
    searchParams.get("account"),
    accounts,
  );
  const [status, setStatus] = useState<MailboxEventStreamStatus>("connecting");
  const [isRefreshPending, startRefreshTransition] = useTransition();
  const locationRef = useRef({ accountSelection, surface, threadId, view });
  const isRefreshPendingRef = useRef(false);
  const hasQueuedRefreshRef = useRef(false);

  useEffect(() => {
    locationRef.current = { accountSelection, surface, threadId, view };
  }, [accountSelection, surface, threadId, view]);

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
      refreshMailbox();
    };
    const handleOpen = () => setStatus("connecting");
    const handleError = () => setStatus("degraded");
    eventSource.addEventListener("open", handleOpen);
    eventSource.addEventListener("error", handleError);
    const handleMailboxChange = (event: Event) => {
      if (!(event instanceof MessageEvent) || typeof event.data !== "string") return;
      const change = parseMailboxChangeEvent(event.data);
      if (change && isRelevantMailboxChange(change, locationRef.current)) {
        refreshMailbox();
      }
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
  }, [refreshMailbox]);

  return status;
}
