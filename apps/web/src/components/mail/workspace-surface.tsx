import {
  Attachment01Icon,
  Search02Icon,
  WorkflowSquare01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { MailSearchResult } from "@invook/contracts";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SurfaceHeader } from "@/components/mail/surface-header";

export function SearchSurface() {
  return (
    <section className="flex min-h-0 flex-col bg-background">
      <SurfaceHeader title="Search" />
      <div className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center px-6 py-12">
        <span className="grid size-10 place-items-center rounded-xl bg-secondary/55">
          <HugeiconsIcon icon={Search02Icon} size={18} className="text-muted-foreground" />
        </span>
        <h2 className="mt-4 text-xl font-semibold tracking-[-0.03em]">Search Gmail</h2>
        <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
          Search uses the real subjects, participants, and message previews already stored by the Gmail worker.
        </p>
        <form action="/mail" method="get" className="mt-5 flex gap-2">
          <input type="hidden" name="surface" value="search" />
          <Input name="q" aria-label="Search Gmail" autoFocus className="h-9" />
          <Button type="submit" className="h-9 px-4">Search</Button>
        </form>
      </div>
    </section>
  );
}

export interface SearchResultsSurfaceProps {
  query: string;
  results: MailSearchResult[];
}

export function SearchResultsSurface({
  query,
  results,
}: SearchResultsSurfaceProps) {
  return (
    <section className="flex min-h-0 flex-col bg-background">
      <SurfaceHeader title="Search" />
      <form action="/mail" method="get" className="flex gap-2 px-5 py-4">
        <input type="hidden" name="surface" value="search" />
        <Input
          name="q"
          aria-label="Search Gmail"
          defaultValue={query}
          className="h-9"
        />
        <Button type="submit" className="h-9 px-4">
          Search
        </Button>
      </form>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {results.length === 0 ? (
          <div className="mx-auto max-w-md px-4 py-16 text-center">
            <p className="text-sm font-medium">No matching mail found</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Search checks message text, mail metadata, and attachment filenames.
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            {results.map((result) => (
              <Link
                key={result.messageId}
                href={`/mail?thread=${encodeURIComponent(result.threadId)}&surface=search&q=${encodeURIComponent(query)}`}
                className="block rounded-lg bg-card/45 px-4 py-3 transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">
                      {result.subject || "(No subject)"}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {result.sender.raw || result.sender.email}
                    </p>
                  </div>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {new Date(result.sentAt).toLocaleDateString()}
                  </span>
                </div>
                <p className="mt-2 line-clamp-2 text-[13px] leading-5 text-foreground/70">
                  {result.bodyPreview || result.snippet}
                </p>
                {result.attachments.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {result.attachments.map((attachment) => (
                      <span
                        key={attachment.id}
                        className="inline-flex items-center gap-1 rounded-md bg-secondary/65 px-2 py-1 text-[11px] text-secondary-foreground"
                      >
                        <HugeiconsIcon icon={Attachment01Icon} size={12} />
                        {attachment.filename}
                      </span>
                    ))}
                  </div>
                ) : null}
              </Link>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

export function PendingSurface() {
  const content = {
    title: "Automations",
    icon: WorkflowSquare01Icon,
    description:
      "Agent automations will appear here only after their triggers, approvals, and audit trail are implemented.",
  };

  return (
    <section className="flex min-h-0 flex-col bg-background">
      <SurfaceHeader title={content.title} />
      <div className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center px-6 py-12 text-center">
        <span className="mx-auto grid size-10 place-items-center rounded-xl bg-secondary/55">
          <HugeiconsIcon icon={content.icon} size={18} className="text-muted-foreground" />
        </span>
        <h2 className="mt-4 text-lg font-semibold">{content.title} is not connected yet</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{content.description}</p>
      </div>
    </section>
  );
}
