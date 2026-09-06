"use client";

import type { MailboxThreadPage } from "@invook/contracts";
import { useSearchParams } from "next/navigation";

import { ComposeSurface } from "./compose-surface";
import { MailList } from "./mail-list";
import { resolveMailboxAccountSelection } from "./mail-account-scope";
import { useMailShell } from "./mail-shell-provider";
import {
  normalizeMailSurface,
  normalizeMailboxView,
} from "./mailbox-location";
import { ThreadReader } from "./thread-reader";
import { PendingSurface, SearchSurface } from "./workspace-surface";
import type { MailboxView } from "./types";

export interface MailWorkspaceProps {
  /** The address the server rendered, so its page seeds only that view. */
  initialAccountSelection: string;
  initialView: MailboxView;
  initialPage: MailboxThreadPage | null;
}

/**
 * Chooses the open mailbox surface from the address.
 *
 * Every surface reads its own data from the client cache, so moving between
 * them is a history update rather than a server navigation.
 */
export function MailWorkspace({
  initialAccountSelection,
  initialView,
  initialPage,
}: MailWorkspaceProps) {
  const searchParams = useSearchParams();
  const { accounts } = useMailShell();
  const accountSelection = resolveMailboxAccountSelection(
    searchParams.get("account"),
    accounts,
  );
  const threadId = searchParams.get("thread");
  const currentView = normalizeMailboxView(searchParams.get("view"));
  const currentSurface = threadId
    ? "mail"
    : normalizeMailSurface(searchParams.get("surface"));
  const query = searchParams.get("q")?.trim() || undefined;
  const seededPage =
    accountSelection === initialAccountSelection && currentView === initialView
      ? initialPage
      : null;

  let centerPane: React.ReactNode;
  if (threadId) {
    centerPane = (
      <ThreadReader
        accountSelection={accountSelection}
        threadId={threadId}
        currentView={currentView}
      />
    );
  } else if (currentSurface === "compose") {
    centerPane = <ComposeSurface />;
  } else if (currentSurface === "search") {
    centerPane = (
      <SearchSurface accountSelection={accountSelection} query={query} />
    );
  } else if (currentSurface === "automations") {
    centerPane = <PendingSurface />;
  } else {
    centerPane = (
      <MailList
        key={`${accountSelection}:${currentView}`}
        accountSelection={accountSelection}
        currentView={currentView}
        initialPage={seededPage}
      />
    );
  }

  return (
    <div
      data-slot="mail-workspace-content"
      className="min-h-0 min-w-0 overflow-hidden [&>*]:h-full"
    >
      {centerPane}
    </div>
  );
}
