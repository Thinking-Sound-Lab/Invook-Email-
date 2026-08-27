"use client";

import type { AccountSyncStatusEvent } from "@invook/contracts";
import { useEffect } from "react";

import { parseAccountSyncStatusEvent } from "@/components/mail/account-pipeline-state";
import { useAccountSyncStore } from "@/stores/account-sync/store";

export type AccountSyncStreamState =
  | { status: "connecting" | "unavailable"; progress: null }
  | { status: "available"; progress: AccountSyncStatusEvent };

export function useAccountSyncEvents(accountId: string | null): AccountSyncStreamState {
  const connectionStatus = useAccountSyncStore((state) => state.connectionStatus);
  const storedProgress = useAccountSyncStore((state) => state.progress);
  const setConnectionStatus = useAccountSyncStore(
    (state) => state.setConnectionStatus,
  );
  const setProgress = useAccountSyncStore((state) => state.setProgress);
  const reset = useAccountSyncStore((state) => state.reset);

  useEffect(() => {
    reset();
    if (!accountId) return;
    const query = new URLSearchParams({ accountId });
    const eventSource = new EventSource(`/v1/account-sync/events?${query.toString()}`);
    const updateAccountSyncState = (event: Event) => {
      if (!(event instanceof MessageEvent) || typeof event.data !== "string") return;
      const nextProgress = parseAccountSyncStatusEvent(event.data);
      if (!nextProgress) return;
      setProgress(nextProgress);
      setConnectionStatus("available");
    };
    const markUnavailable = () => setConnectionStatus("unavailable");
    eventSource.addEventListener("account-sync", updateAccountSyncState);
    eventSource.addEventListener("error", markUnavailable);

    return () => {
      eventSource.removeEventListener("account-sync", updateAccountSyncState);
      eventSource.removeEventListener("error", markUnavailable);
      eventSource.close();
    };
  }, [accountId, reset, setConnectionStatus, setProgress]);

  useEffect(() => () => reset(), [reset]);

  if (connectionStatus === "available" && storedProgress) {
    return { status: "available", progress: storedProgress };
  }
  return {
    status: connectionStatus === "connecting" ? "connecting" : "unavailable",
    progress: null,
  };
}
