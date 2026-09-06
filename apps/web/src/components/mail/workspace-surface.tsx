"use client";

import {
  Attachment01Icon,
  Search02Icon,
  WorkflowSquare01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { MailSearchResult } from "@invook/contracts";
import axios from "axios";
import { useEffect, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SurfaceHeader } from "@/components/mail/surface-header";
import { searchMailbox } from "@/lib/api/mailbox-threads";

import { LocalMailDate } from "./local-mail-date";
import { MailAccountAvatar } from "./mail-account-avatar";
import { MailboxLink, navigateMailbox } from "./mailbox-link";
import { useMailShell } from "./mail-shell-provider";

type SearchLoadState = "idle" | "loading" | "available" | "error";

interface SearchResultsState {
  query: string;
  results: MailSearchResult[];
}

export interface SearchSurfaceProps {
  accountSelection: string;
  query: string | undefined;
}

function searchHref(accountSelection: string, query: string): string {
  const params = new URLSearchParams({
    surface: "search",
    account: accountSelection,
  });
  if (query) params.set("q", query);
  return `/mail?${params.toString()}`;
}

export function SearchSurface({ accountSelection, query }: SearchSurfaceProps) {
  const { accounts, user } = useMailShell();
  const [draftQuery, setDraftQuery] = useState(query ?? "");
  const [state, setState] = useState<SearchResultsState | null>(null);
  const [failedQuery, setFailedQuery] = useState<string | null>(null);
  const isResolved = state?.query === query;
  const loadState: SearchLoadState = !query
    ? "idle"
    : failedQuery === query
      ? "error"
      : isResolved
        ? "available"
        : "loading";

  useEffect(() => {
    if (!query) return;
    const requestController = new AbortController();
    void (async () => {
      try {
        const results = await searchMailbox({
          accountSelection,
          query,
          signal: requestController.signal,
        });
        if (requestController.signal.aborted) return;
        setState({ query, results });
      } catch (cause: unknown) {
        if (axios.isCancel(cause) || requestController.signal.aborted) return;
        setFailedQuery(query);
      }
    })();
    return () => requestController.abort();
  }, [accountSelection, query]);

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const nextQuery = draftQuery.trim();
    if (!nextQuery) return;
    setFailedQuery(null);
    navigateMailbox(searchHref(accountSelection, nextQuery));
  }

  const results = state && isResolved ? state.results : [];

  return (
    <section className="flex min-h-0 flex-col bg-background">
      <SurfaceHeader title="Search" />
      {query ? (
        <form onSubmit={handleSubmit} className="flex gap-2 px-5 py-4">
          <Input
            name="q"
            aria-label="Search Gmail"
            value={draftQuery}
            onChange={(event) => setDraftQuery(event.target.value)}
            className="h-9"
          />
          <Button type="submit" className="h-9 px-4">
            Search
          </Button>
        </form>
      ) : (
        <div className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center px-6 py-12">
          <span className="grid size-10 place-items-center rounded-xl bg-secondary/55">
            <HugeiconsIcon
              icon={Search02Icon}
              size={18}
              className="text-muted-foreground"
            />
          </span>
          <h2 className="mt-4 text-xl font-semibold tracking-[-0.03em]">
            Search Gmail
          </h2>
          <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
            Search uses the real subjects, participants, and message previews
            already stored by the Gmail worker.
          </p>
          <form onSubmit={handleSubmit} className="mt-5 flex gap-2">
            <Input
              name="q"
              aria-label="Search Gmail"
              autoFocus
              value={draftQuery}
              onChange={(event) => setDraftQuery(event.target.value)}
              className="h-9"
            />
            <Button type="submit" className="h-9 px-4">
              Search
            </Button>
          </form>
        </div>
      )}

      {query ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
          {loadState === "loading" ? (
            <div className="mx-auto max-w-md px-4 py-16 text-center" role="status">
              <p className="text-sm font-medium">Searching Gmail</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Invook is reading stored mail for this search.
              </p>
            </div>
          ) : null}
          {loadState === "error" ? (
            <div className="mx-auto max-w-md px-4 py-16 text-center" role="alert">
              <p className="text-sm font-medium">Search is unavailable</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Invook could not run this search.
              </p>
            </div>
          ) : null}
          {loadState === "available" && results.length === 0 ? (
            <div className="mx-auto max-w-md px-4 py-16 text-center">
              <p className="text-sm font-medium">No matching mail found</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Search checks message text, mail metadata, and attachment
                filenames.
              </p>
            </div>
          ) : null}
          {results.length > 0 ? (
            <div className="space-y-1">
              {results.flatMap((result) => {
                const account = accounts.find(
                  (candidate) => candidate.id === result.accountId,
                );
                return account
                  ? [
                      <MailboxLink
                        key={result.messageId}
                        href={`/mail?account=${encodeURIComponent(accountSelection)}&thread=${encodeURIComponent(result.threadId)}&surface=search&q=${encodeURIComponent(query)}`}
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
                          <div className="flex shrink-0 items-center gap-2">
                            <MailAccountAvatar
                              account={account}
                              accounts={accounts}
                              user={user}
                              className="size-4.5"
                            />
                            <LocalMailDate
                              className="text-[11px] text-muted-foreground"
                              value={result.sentAt}
                            />
                          </div>
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
                                <HugeiconsIcon
                                  icon={Attachment01Icon}
                                  size={12}
                                />
                                {attachment.filename}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </MailboxLink>,
                    ]
                  : [];
              })}
            </div>
          ) : null}
        </div>
      ) : null}
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
