"use client";

import { StarIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type {
  MailboxAccount,
  MailboxThreadPage,
  SignedInUser,
} from "@invook/contracts";
import axios from "axios";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  getMailboxThreadDetail,
  getMailboxThreadPage,
} from "@/lib/api/mailbox-threads";
import { createMailboxPageKey } from "@/stores/mailbox/mailbox-cache";
import { useMailboxStore } from "@/stores/mailbox/store";
import { cn } from "@/lib/utils";

import { createMailDateSections } from "./mail-date-sections";
import { MailAccountAvatar } from "./mail-account-avatar";
import { formatMailText, threadPeople } from "./mail-format";
import { mailLabelColorClassName } from "./mail-label-colors";
import { LocalMailDate } from "./local-mail-date";
import { MailboxLink } from "./mailbox-link";
import { useMailShell } from "./mail-shell-provider";
import { listMailRowLabels, type MailRowLabel } from "./mail-row-labels";
import type {
  MailboxView,
  MailThreadSummary,
  StaticMailboxView,
} from "./types";

const viewTitles: Record<StaticMailboxView, string> = {
  all: "All",
  important: "Important",
  starred: "Starred",
  drafts: "Drafts",
  sent: "Sent",
  spam: "Spam",
  trash: "Trash",
};

function mailboxHref(
  accountSelection: string,
  currentView: MailboxView,
  threadId?: string,
): string {
  const query = new URLSearchParams({ account: accountSelection, view: currentView });
  if (threadId) query.set("thread", threadId);
  return `/mail?${query.toString()}`;
}

/**
 * Reads a thread into the cache before it is opened. Pointing at a row is a
 * strong signal it is about to be read, and a thread already in the cache
 * renders without a request.
 */
function usePrefetchThreadDetail(
  accountSelection: string,
): (threadId: string) => void {
  const hydrateThreadDetail = useMailboxStore(
    (state) => state.hydrateThreadDetail,
  );
  const requestedThreadIdsRef = useRef(new Set<string>());

  return useCallback(
    (threadId: string) => {
      if (
        requestedThreadIdsRef.current.has(threadId) ||
        useMailboxStore.getState().detailsById[threadId]
      ) {
        return;
      }
      requestedThreadIdsRef.current.add(threadId);
      void getMailboxThreadDetail({ accountSelection, threadId })
        .then((detail) => hydrateThreadDetail({ threadId, detail }))
        .catch(() => {
          // A prefetch is an optimization; the reader reports its own failure.
          requestedThreadIdsRef.current.delete(threadId);
        });
    },
    [accountSelection, hydrateThreadDetail],
  );
}

interface MailRowProps {
  thread: MailThreadSummary;
  account: MailboxAccount;
  accounts: MailboxAccount[];
  accountSelection: string;
  currentView: MailboxView;
  user: SignedInUser;
}

interface MailLabelChipProps {
  label: MailRowLabel;
}

function MailLabelChip({ label }: MailLabelChipProps) {
  return (
    <span
      aria-label={`${label.name}, Invook label`}
      title={`${label.name} (Invook)`}
      className={cn(
        "min-w-0 max-w-28 truncate rounded px-1.5 py-0.5 text-[11px] font-medium",
        mailLabelColorClassName(label),
      )}
    >
      {label.name}
    </span>
  );
}

const MailRow = memo(function MailRow({
  thread,
  account,
  accounts,
  accountSelection,
  currentView,
  user,
}: MailRowProps) {
  const people = threadPeople(thread.participants, account.email);
  const { isUnread, isStarred } = thread;
  const labels = listMailRowLabels(thread);
  const prefetchThread = usePrefetchThreadDetail(accountSelection);

  return (
    <MailboxLink
      href={mailboxHref(accountSelection, currentView, thread.id)}
      onPointerEnter={() => prefetchThread(thread.id)}
      onFocus={() => prefetchThread(thread.id)}
      className={cn(
        "group relative grid min-h-12 grid-cols-[minmax(112px,0.3fr)_minmax(0,1fr)_6.5rem] items-center gap-3 border-b border-border/40 px-4 py-2 transition-colors [contain-intrinsic-size:48px] [content-visibility:auto] lg:grid-cols-[minmax(112px,0.3fr)_minmax(0,1fr)_6.5rem_1rem_7rem] lg:gap-2.5",
        "hover:bg-accent/55 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        isUnread && "bg-card/45",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            isUnread ? "bg-blue-500" : "bg-transparent",
          )}
        />
        <span className="sr-only">{isUnread ? "Unread" : "Read"}</span>
        <p
          className={cn(
            "truncate text-sm",
            isUnread
              ? "font-semibold"
              : "font-normal text-foreground/70",
          )}
        >
          {people}
          {thread.messageCount > 1 ? (
            <span className="ml-1.5 text-xs font-normal tabular-nums text-muted-foreground">
              {thread.messageCount}
            </span>
          ) : null}
        </p>
      </div>

      <div className="flex min-w-0 items-center gap-2">
        <p
          className={cn(
            "shrink-0 truncate text-sm",
            isUnread
              ? "max-w-[48%] font-semibold"
              : "max-w-[42%] font-normal text-foreground/76",
          )}
        >
          {formatMailText(thread.subject) || "(No subject)"}
        </p>
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {formatMailText(thread.snippet) || "No message preview is available."}
        </p>
        {isStarred ? (
          <HugeiconsIcon
            icon={StarIcon}
            size={13}
            className="shrink-0 text-warning lg:hidden"
            fill="currentColor"
          />
        ) : null}
      </div>

      <div
        className="hidden min-w-0 items-center justify-end gap-1 overflow-hidden lg:flex"
        aria-label={labels.length > 0 ? "Message labels" : undefined}
      >
        {labels.map((label) => (
          <MailLabelChip key={`${label.kind}:${label.id}`} label={label} />
        ))}
      </div>

      <div className="hidden size-4 items-center justify-center lg:flex">
        {isStarred ? (
          <HugeiconsIcon
            icon={StarIcon}
            size={13}
            className="shrink-0 text-warning"
            fill="currentColor"
          />
        ) : null}
      </div>

      <div className="flex min-w-0 items-center justify-end gap-2">
        <LocalMailDate
          className="min-w-0 whitespace-nowrap text-right text-xs tabular-nums text-muted-foreground"
          value={thread.latestMessageAt}
        />
        <MailAccountAvatar
          account={account}
          accounts={accounts}
          user={user}
          className="size-4.5"
        />
      </div>
    </MailboxLink>
  );
});

interface MailRowsProps {
  threads: MailThreadSummary[];
  accountsById: Map<string, MailboxAccount>;
  accounts: MailboxAccount[];
  accountSelection: string;
  currentView: MailboxView;
  user: SignedInUser;
}

function MailRows({
  threads,
  accountsById,
  accounts,
  accountSelection,
  currentView,
  user,
}: MailRowsProps) {
  const sections = createMailDateSections(threads);

  return sections.map((section, sectionIndex) => (
    <section
      key={section.id}
      aria-label={section.label ?? "Today"}
      className={cn(section.label && (sectionIndex === 0 ? "pt-4" : "pt-5"))}
    >
      {section.label ? (
        <h2 className="px-4 pb-1.5 text-xs font-medium text-muted-foreground">
          {section.label}
        </h2>
      ) : null}
      {section.threads.flatMap((thread) => {
        const account = accountsById.get(thread.accountId);
        return account
          ? [
              <MailRow
                key={thread.id}
                thread={thread}
                account={account}
                accounts={accounts}
                accountSelection={accountSelection}
                currentView={currentView}
                user={user}
              />,
            ]
          : [];
      })}
    </section>
  ));
}

export interface MailListProps {
  accountSelection: string;
  currentView: MailboxView;
  /**
   * The server render for this view, present only on the request that produced
   * it. A view reached by client navigation reads its first page itself.
   */
  initialPage: MailboxThreadPage | null;
  query?: string;
}

export function MailList({
  accountSelection,
  currentView,
  initialPage,
  query,
}: MailListProps) {
  const { accountLabels, accounts, user } = useMailShell();
  const invookLabels = accountLabels.flatMap((entry) => entry.labels);
  const title = currentView.startsWith("label:")
    ? invookLabels.find((label) => label.id === currentView.slice(6))?.name
    : undefined;
  const pageKey = createMailboxPageKey({
    accountSelection,
    view: currentView,
  });
  const hydratePage = useMailboxStore((state) => state.hydratePage);
  const appendPage = useMailboxStore((state) => state.appendPage);
  const setPageLoadState = useMailboxStore((state) => state.setPageLoadState);
  const page = useMailboxStore((state) => state.pagesByKey[pageKey]);
  const [firstPageFailure, setFirstPageFailure] = useState<{
    key: string;
  } | null>(null);
  const [firstPageAttempt, setFirstPageAttempt] = useState(0);
  const hasFirstPageFailed = firstPageFailure?.key === pageKey;
  const isCached = page !== undefined;

  useEffect(() => {
    if (initialPage) hydratePage({ key: pageKey, page: initialPage });
  }, [hydratePage, initialPage, pageKey]);

  useEffect(() => {
    if (isCached || initialPage) return;
    const requestController = new AbortController();
    void (async () => {
      try {
        const firstPage = await getMailboxThreadPage({
          accountSelection,
          view: currentView,
          signal: requestController.signal,
        });
        if (requestController.signal.aborted) return;
        hydratePage({ key: pageKey, page: firstPage });
      } catch (error: unknown) {
        if (axios.isCancel(error) || requestController.signal.aborted) return;
        setFirstPageFailure({ key: pageKey });
      }
    })();
    return () => requestController.abort();
  }, [
    accountSelection,
    currentView,
    firstPageAttempt,
    hydratePage,
    initialPage,
    isCached,
    pageKey,
  ]);

  const cachedThreadIds = page?.threadIds;
  const cachedThreads = useMailboxStore(
    useShallow((state) =>
      cachedThreadIds
        ? cachedThreadIds.flatMap((threadId) => {
            const thread = state.threadsById[threadId];
            return thread ? [thread] : [];
          })
        : null,
    ),
  );
  // The server page renders until the cache holds this view, so first paint
  // never waits on hydration.
  const loadedThreads = cachedThreads ?? initialPage?.threads ?? [];
  const isReadingFirstPage = !isCached && !initialPage && !hasFirstPageFailed;
  const olderCursor = page?.olderCursor ?? null;
  const loadState = page?.loadState ?? "idle";
  const isLoadingRef = useRef(false);
  const requestControllerRef = useRef<AbortController | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const noMail = loadedThreads.length === 0;
  const accountsById = new Map(accounts.map((account) => [account.id, account]));
  const scopedAccounts =
    accountSelection === "all"
      ? accounts
      : accounts.filter((account) => account.id === accountSelection);
  const syncing = scopedAccounts.some(
    (account) =>
      account.syncState.mailSync === "pending" ||
      account.syncState.mailSync === "running",
  );

  useEffect(
    () => () => {
      requestControllerRef.current?.abort();
    },
    [],
  );

  const loadMoreMail = useCallback(async (): Promise<void> => {
    if (!olderCursor || isLoadingRef.current) return;

    const requestController = new AbortController();
    requestControllerRef.current?.abort();
    requestControllerRef.current = requestController;
    isLoadingRef.current = true;
    setPageLoadState({ key: pageKey, loadState: "loading" });

    try {
      const nextPage = await getMailboxThreadPage({
        accountSelection,
        cursor: olderCursor,
        view: currentView,
        signal: requestController.signal,
      });
      if (requestController.signal.aborted) return;
      appendPage({ key: pageKey, page: nextPage });
    } catch (error: unknown) {
      if (axios.isCancel(error) || requestController.signal.aborted) return;
      setPageLoadState({ key: pageKey, loadState: "error" });
    } finally {
      if (requestControllerRef.current === requestController) {
        requestControllerRef.current = null;
        isLoadingRef.current = false;
      }
    }
  }, [
    accountSelection,
    appendPage,
    currentView,
    olderCursor,
    pageKey,
    setPageLoadState,
  ]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !olderCursor || loadState !== "idle") return;

    const scrollViewport = sentinel.closest(
      '[data-slot="scroll-area-viewport"]',
    );
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void loadMoreMail();
        }
      },
      { root: scrollViewport, rootMargin: "0px 0px 480px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadMoreMail, loadState, olderCursor]);

  return (
    <section
      className="mx-5 flex min-h-0 flex-col bg-background"
      aria-label="Mailbox"
    >
      <header className="flex h-14 shrink-0 items-center px-4">
        <h1 className="truncate text-base font-semibold tracking-[-0.025em]">
          {query
            ? `Search: ${query}`
            : title ??
              (currentView.startsWith("label:")
                ? "Label"
                : viewTitles[currentView as StaticMailboxView])}
        </h1>
      </header>

      <ScrollArea
        hideScrollbar
        className="min-h-0 flex-1"
        aria-busy={loadState === "loading"}
      >
        <MailRows
          threads={loadedThreads}
          accountsById={accountsById}
          accounts={accounts}
          accountSelection={accountSelection}
          currentView={currentView}
          user={user}
        />

        {noMail && isReadingFirstPage ? (
          <div className="mx-auto max-w-sm px-6 py-20 text-center" role="status">
            <p className="text-sm font-medium">Loading mail</p>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              Invook is reading this view.
            </p>
          </div>
        ) : null}

        {noMail && hasFirstPageFailed ? (
          <div className="mx-auto max-w-sm px-6 py-20 text-center" role="alert">
            <p className="text-sm font-medium">This view could not be read</p>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              Invook could not read the mail in this view.
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-3"
              onClick={() => {
                setFirstPageFailure(null);
                setFirstPageAttempt((current) => current + 1);
              }}
            >
              Try again
            </Button>
          </div>
        ) : null}

        {noMail && !isReadingFirstPage && !hasFirstPageFailed ? (
          <div className="mx-auto max-w-sm px-6 py-20 text-center">
            <p className="text-sm font-medium">
              {syncing ? "Syncing Gmail" : "No mail in this view"}
            </p>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              {syncing
                ? "Messages will appear here as Invook stores them."
                : "This view has no synchronized Gmail threads."}
            </p>
          </div>
        ) : null}

        {olderCursor ? (
          <div ref={sentinelRef} className="h-px" aria-hidden="true" />
        ) : null}
        {loadState === "loading" ? (
          <p
            className="px-4 py-4 text-center text-xs text-muted-foreground"
            role="status"
          >
            Loading more mail…
          </p>
        ) : null}
        {loadState === "error" ? (
          <div className="flex items-center justify-center gap-3 px-4 py-4" role="alert">
            <p className="text-xs text-muted-foreground">
              More mail could not be loaded.
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void loadMoreMail()}
            >
              Try again
            </Button>
          </div>
        ) : null}
      </ScrollArea>
    </section>
  );
}
