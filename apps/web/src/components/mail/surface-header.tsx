"use client";

import { ArrowLeft02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useSearchParams } from "next/navigation";

import { Button } from "@/components/ui/button";

import { MailboxLink } from "./mailbox-link";

export interface SurfaceHeaderProps {
  title: string;
}

export function SurfaceHeader({ title }: SurfaceHeaderProps) {
  const searchParams = useSearchParams();
  const account = searchParams.get("account") ?? "all";
  return (
    <header className="flex h-15 shrink-0 items-center gap-2 border-b border-border/45 px-4">
      <Button asChild variant="ghost" size="icon-sm">
        <MailboxLink
          href={`/mail?account=${encodeURIComponent(account)}`}
          aria-label="Return to mail"
        >
          <HugeiconsIcon icon={ArrowLeft02Icon} size={15} />
        </MailboxLink>
      </Button>
      <h1 className="text-[15px] font-semibold tracking-[-0.02em]">{title}</h1>
    </header>
  );
}
