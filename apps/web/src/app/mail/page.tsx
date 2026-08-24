import { redirect } from "next/navigation";
import { v4 as uuidv4, validate as validateUuid } from "uuid";

import { mailboxViews } from "@invook/contracts";

import { AgentPanel } from "@/components/mail/agent-panel";
import { ComposeSurface } from "@/components/mail/compose-surface";
import { MailList } from "@/components/mail/mail-list";
import { ThreadReader } from "@/components/mail/thread-reader";
import type {
  MailboxView,
  MailSurface,
  MailThreadSummary,
  SelectedThread,
  StaticMailboxView,
} from "@/components/mail/types";
import {
  PendingSurface,
  SearchResultsSurface,
  SearchSurface,
} from "@/components/mail/workspace-surface";
import {
  getMailboxThreadDetail,
  getMailboxThreadPage,
  searchMailbox,
} from "@/lib/api";

interface MailPageProps {
  searchParams: Promise<{
    view?: string | string[];
    surface?: string | string[];
    thread?: string | string[];
    q?: string | string[];
    cursor?: string | string[];
    account?: string | string[];
  }>;
}

const mailboxViewSet = new Set<string>(mailboxViews);

const mailSurfaces = new Set<MailSurface>([
  "mail",
  "compose",
  "search",
  "automations",
]);

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeView(value: string | undefined): MailboxView {
  if (value && mailboxViewSet.has(value)) return value as StaticMailboxView;
  if (value?.startsWith("label:")) {
    const labelId = value.slice("label:".length);
    if (validateUuid(labelId)) return `label:${labelId}`;
  }
  return "all";
}

function normalizeSurface(value: string | undefined): MailSurface {
  return value && mailSurfaces.has(value as MailSurface) ? (value as MailSurface) : "mail";
}

function normalizeAccount(value: string | undefined): string {
  return value === "all" || (value && validateUuid(value)) ? value : "all";
}

export default async function MailPage({ searchParams }: MailPageProps) {
  const params = await searchParams;

  const requestedThreadId = firstValue(params.thread);
  const requestedSurface = normalizeSurface(firstValue(params.surface));
  const currentSurface = requestedThreadId ? "mail" : requestedSurface;
  const query = firstValue(params.q)?.trim();
  const mailboxCursor = firstValue(params.cursor)?.trim() || undefined;
  const currentView = normalizeView(firstValue(params.view));
  const accountSelection = normalizeAccount(firstValue(params.account));

  const [threadDetail, threadPage, searchResults] = await Promise.all([
    requestedThreadId
      ? getMailboxThreadDetail(requestedThreadId, accountSelection)
      : null,
    currentSurface === "mail" && !requestedThreadId
      ? getMailboxThreadPage({
          account: accountSelection,
          cursor: mailboxCursor,
          view: currentView,
        })
      : null,
    currentSurface === "search" && query
      ? searchMailbox(query, accountSelection)
      : [],
  ]);
  if (requestedThreadId && !threadDetail) {
    redirect(`/mail?account=${accountSelection}&view=${currentView}`);
  }
  if (currentSurface === "mail" && !requestedThreadId && !threadPage) redirect("/");
  const selectedThread = threadDetail?.thread as SelectedThread | undefined;

  let centerPane: React.ReactNode;
  if (selectedThread) {
    centerPane = (
      <ThreadReader
        accountSelection={accountSelection}
        thread={selectedThread}
        currentView={currentView}
        mailboxCursor={mailboxCursor}
        availableLabels={threadDetail?.invookLabels ?? []}
      />
    );
  } else if (currentSurface === "compose") {
    centerPane = <ComposeSurface key={accountSelection} />;
  } else if (currentSurface === "search" && !query) {
    centerPane = <SearchSurface accountSelection={accountSelection} />;
  } else if (currentSurface === "search" && query) {
    centerPane = (
      <SearchResultsSurface
        accountSelection={accountSelection}
        query={query}
        results={searchResults}
      />
    );
  } else if (currentSurface === "automations") {
    centerPane = <PendingSurface />;
  } else {
    centerPane = (
      <MailList
        key={`${accountSelection}:${currentView}`}
        accountSelection={accountSelection}
        canonicalPageVersion={uuidv4()}
        currentView={currentView}
        initialOlderCursor={threadPage?.pagination.olderCursor ?? null}
        threads={(threadPage?.threads ?? []) as MailThreadSummary[]}
        query={currentSurface === "search" ? query : undefined}
      />
    );
  }

  return (
    <>
      <div
        data-slot="mail-workspace-content"
        className="min-h-0 min-w-0 overflow-hidden [&>*]:h-full"
      >
        {centerPane}
      </div>
      <AgentPanel
        key={`${accountSelection}:${selectedThread?.id ?? "mailbox"}`}
        accountSelection={accountSelection}
        openThreadId={selectedThread?.id}
        openThreadSubject={selectedThread?.subject || undefined}
      />
    </>
  );
}
