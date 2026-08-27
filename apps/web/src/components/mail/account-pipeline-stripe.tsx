"use client";

import type { MailboxAccount } from "@invook/contracts";
import { useSearchParams } from "next/navigation";

import { Progress } from "@/components/ui/progress";
import { useAccountSyncEvents } from "@/hooks/use-account-sync-events";
import { cn } from "@/lib/utils";

import {
  resolveMailboxAccountSelection,
  selectedMailboxAccount,
} from "./mail-account-scope";
import { getAccountPipelinePresentation } from "./account-pipeline-state";

export interface AccountPipelineStripeProps {
  accounts: MailboxAccount[];
}

export function AccountPipelineStripe({
  accounts,
}: AccountPipelineStripeProps) {
  const searchParams = useSearchParams();
  const selection = resolveMailboxAccountSelection(
    searchParams.get("account"),
    accounts,
  );
  const account = selectedMailboxAccount(selection, accounts);
  const stream = useAccountSyncEvents(account?.id ?? null);
  if (!account) return null;
  const accountEmail = account.email;
  if (stream.status !== "available") {
    return (
      <div role={stream.status === "unavailable" ? "alert" : "status"} className="flex h-10 shrink-0 items-center justify-center bg-sidebar px-4 text-xs text-sidebar-foreground/70">
        {stream.status === "unavailable"
          ? `Synchronization status is unavailable for ${accountEmail}.`
          : `Reading synchronization status for ${accountEmail}…`}
      </div>
    );
  }
  const presentation = getAccountPipelinePresentation(stream.progress);
  if (!presentation) return null;

  return (
    <div
      role={presentation.isFailed ? "alert" : "status"}
      aria-live="polite"
      className="flex h-10 shrink-0 items-center justify-center bg-sidebar px-4 text-sidebar-foreground"
      title={`${presentation.title}: ${presentation.detail}`}
    >
      <div className="flex min-w-0 items-center justify-center gap-3">
        <span className="max-w-48 truncate text-xs font-medium sm:max-w-72">
          {accountEmail}
        </span>
        <Progress
          value={presentation.percentage}
          aria-label={`${presentation.title} for ${accountEmail}`}
          className={cn(
            "h-1.5 w-28 shrink-0 bg-sidebar-accent sm:w-40",
            presentation.isFailed &&
              "[&_[data-slot=progress-indicator]]:bg-destructive",
          )}
        />
        <span className="sr-only">{presentation.detail}</span>
      </div>
    </div>
  );
}
