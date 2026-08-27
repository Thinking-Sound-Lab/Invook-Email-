"use client";

import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import {
  formatMailText,
  formatRecipientDetails,
  formatRecipientSummary,
} from "./mail-format";
export interface MessageRecipientDetailsProps {
  accountEmail: string;
  recipients: string[];
  sender: string;
}

export function MessageRecipientDetails({
  accountEmail,
  recipients,
  sender,
}: MessageRecipientDetailsProps) {
  return (
    <details className="group relative min-w-0">
      <summary className="flex cursor-pointer list-none items-center gap-1 rounded-sm text-xs leading-5 text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <span className="truncate">
          To: {formatRecipientSummary(recipients, accountEmail)}
        </span>
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          size={11}
          className="shrink-0 transition-transform group-open:rotate-180"
        />
      </summary>
      <div className="absolute left-0 top-full z-20 mt-2 w-[min(32rem,calc(100vw-3rem))] rounded-lg bg-popover p-3 text-xs shadow-xl ring-1 ring-border/55">
        <dl className="grid grid-cols-[2.75rem_minmax(0,1fr)] gap-x-2 gap-y-2 leading-5">
          <dt className="text-muted-foreground">From</dt>
          <dd className="break-words">{formatMailText(sender)}</dd>
          <dt className="text-muted-foreground">To</dt>
          <dd className="break-words">
            {formatRecipientDetails(recipients, accountEmail)}
          </dd>
        </dl>
      </div>
    </details>
  );
}
