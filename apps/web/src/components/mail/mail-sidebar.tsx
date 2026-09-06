"use client";

import {
  Delete02Icon,
  FileEditIcon,
  InboxIcon,
  Mail01Icon,
  PencilEdit01Icon,
  PlusSignIcon,
  Search02Icon,
  SentIcon,
  SpamIcon,
  StarIcon,
  Tick02Icon,
  WorkflowSquare01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { MailboxSidebarCounts } from "@invook/contracts";
import { useSearchParams } from "next/navigation";
import { useEffect } from "react";

import { SignOutButton } from "@/components/auth/sign-out-button";
import { SettingsDialog } from "@/components/settings/settings-dialog";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import { useMailboxStore } from "@/stores/mailbox/store";
import { cn } from "@/lib/utils";

import { MailAccountAvatar } from "./mail-account-avatar";
import { MailboxLink } from "./mailbox-link";
import {
  accountLabels,
  createMailboxHref,
  resolveMailboxAccountSelection,
  selectedSidebarCounts,
} from "./mail-account-scope";
import { initials } from "./mail-format";
import { useMailShell } from "./mail-shell-provider";
import { listSidebarLabels } from "./mail-sidebar-labels";
import type { MailboxView, MailSurface } from "./types";

const workspaceItems = [
  { label: "Compose", icon: PencilEdit01Icon, surface: "compose" },
  { label: "Search", icon: Search02Icon, surface: "search" },
] as const;

const automationsItem = {
  label: "Automations",
  icon: WorkflowSquare01Icon,
  surface: "automations",
} as const;

const sidebarCountFormatter = new Intl.NumberFormat("en-US");

const mailItems = [
  { label: "Starred", icon: StarIcon, view: "starred" },
  { label: "Drafts", icon: FileEditIcon, view: "drafts" },
  { label: "Sent", icon: SentIcon, view: "sent" },
  { label: "Spam", icon: SpamIcon, view: "spam" },
  { label: "Trash", icon: Delete02Icon, view: "trash" },
] as const;

interface NavLinkProps {
  label: string;
  icon?: typeof Mail01Icon;
  active: boolean;
  href: string;
  count?: number;
}

function navItemClassName(active: boolean): string {
  return cn(
    "group flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-[13px] font-medium text-sidebar-foreground/58 transition-colors",
    "hover:bg-sidebar-accent/70 hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
    active && "bg-sidebar-accent text-sidebar-foreground",
  );
}

function NavLink({
  label,
  icon,
  active,
  href,
  count,
}: NavLinkProps) {
  return (
    <MailboxLink
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(navItemClassName(active), !icon && "hidden lg:flex")}
    >
      {icon ? (
        <HugeiconsIcon
          icon={icon}
          size={15}
          strokeWidth={1.65}
          className="shrink-0"
        />
      ) : null}
      <span className="hidden min-w-0 flex-1 truncate lg:block">{label}</span>
      {count === undefined ? null : (
        <span className="hidden shrink-0 text-[11px] font-normal tabular-nums text-sidebar-foreground/38 lg:block">
          {sidebarCountFormatter.format(count)}
        </span>
      )}
    </MailboxLink>
  );
}

export interface MailSidebarProps {
  sidebarCounts: MailboxSidebarCounts | null;
}

export function MailSidebar({
  sidebarCounts,
}: MailSidebarProps) {
  const shell = useMailShell();
  const { accounts, aiConfigured, user } = shell;
  const searchParams = useSearchParams();
  const setSidebarCounts = useMailboxStore((state) => state.setSidebarCounts);
  const cachedSidebarCounts = useMailboxStore((state) => state.sidebarCounts);
  const accountSelection = resolveMailboxAccountSelection(
    searchParams.get("account"),
    accounts,
  );

  useEffect(() => {
    setSidebarCounts(sidebarCounts);
  }, [setSidebarCounts, sidebarCounts]);

  // Counts are recomputed by mailbox change events, so the cache leads and the
  // server render seeds it.
  const currentSidebarCounts = cachedSidebarCounts ?? sidebarCounts;
  const currentCounts = selectedSidebarCounts(
    currentSidebarCounts,
    accountSelection,
  );
  const requestedSurface = searchParams.get("surface");
  const currentSurface: MailSurface = searchParams.has("thread")
    ? "mail"
    : requestedSurface === "compose" ||
        requestedSurface === "search" ||
        requestedSurface === "automations"
      ? requestedSurface
      : "mail";
  const requestedView = searchParams.get("view");
  const currentView: MailboxView = requestedView?.startsWith("label:")
    ? (requestedView as `label:${string}`)
    : requestedView === "important" ||
        requestedView === "starred" ||
        requestedView === "drafts" ||
        requestedView === "sent" ||
        requestedView === "spam" ||
        requestedView === "trash"
      ? requestedView
      : "all";
  const currentSearchParams = new URLSearchParams(searchParams.toString());
  const currentLabelId = currentView.startsWith("label:")
    ? currentView.slice("label:".length)
    : null;
  const sidebarLabels = listSidebarLabels(
    accounts.flatMap((account) =>
      accountSelection !== "all" && account.id !== accountSelection
        ? []
        : accountLabels(shell, account.id),
    ),
  );
  const hrefFor = (updates: Parameters<typeof createMailboxHref>[1]): string =>
    createMailboxHref(currentSearchParams, updates);
  const handleAccountHref = (account: "all" | string): string =>
    hrefFor({
      account,
      thread: null,
      view: currentView.startsWith("label:") ? "all" : currentView,
    });

  return (
    <aside className="flex min-h-0 flex-col bg-sidebar px-2 py-3 lg:px-3" aria-label="Mailbox navigation">
      <div className="flex h-11 items-center gap-2.5 px-1.5 lg:px-2">
        <Avatar className="size-8 border-0 after:border-0">
          {user.image ? <AvatarImage src={user.image} alt="" /> : null}
          <AvatarFallback className="bg-sidebar-accent text-xs font-semibold text-sidebar-foreground">
            {initials(user.name)}
          </AvatarFallback>
        </Avatar>
        <div className="hidden min-w-0 flex-1 lg:block">
          <p className="truncate text-sm font-semibold text-sidebar-foreground">
            {user.name}
          </p>
          <p className="truncate text-xs text-sidebar-foreground/45">{user.email}</p>
        </div>
        <div className="hidden lg:block">
          <SignOutButton isIconOnly />
        </div>
      </div>

      <nav className="mt-3 space-y-0.5" aria-label="Workspace">
        {workspaceItems.map((item) => (
          <NavLink
            key={item.label}
            label={item.label}
            icon={item.icon}
            active={currentSurface === item.surface}
            href={hrefFor({ surface: item.surface, thread: null })}
          />
        ))}
        <SettingsDialog
          key={accountSelection}
          accounts={accounts}
          selectedAccountId={
            accountSelection === "all" ? null : accountSelection
          }
          aiConfigured={aiConfigured}
          triggerClassName={navItemClassName(false)}
        />
        <NavLink
          label={automationsItem.label}
          icon={automationsItem.icon}
          active={currentSurface === automationsItem.surface}
          href={hrefFor({ surface: automationsItem.surface, thread: null })}
        />
      </nav>

      <div className="scrollbar-hidden mt-5 min-h-0 flex-1 overflow-y-auto">
        <p className="mb-1.5 hidden px-2.5 text-xs font-medium text-sidebar-foreground/35 lg:block">
          Labels
        </p>
        <nav className="space-y-0.5" aria-label="Labels">
          <NavLink
            label="Important"
            active={currentSurface === "mail" && currentView === "important"}
            href={hrefFor({ surface: null, thread: null, view: "important" })}
            count={currentCounts?.views.important}
          />
          {sidebarLabels.map((label) => (
            <NavLink
              key={label.id}
              label={label.name}
              active={
                currentSurface === "mail" &&
                currentLabelId !== null &&
                label.labelIds.includes(currentLabelId)
              }
              href={hrefFor({
                surface: null,
                thread: null,
                view: `label:${label.id}`,
              })}
              count={currentCounts?.labels[label.id]}
            />
          ))}
        </nav>

        <p className="mb-1.5 mt-5 hidden px-2.5 text-xs font-medium text-sidebar-foreground/35 lg:block">
          Mail
        </p>
        <nav className="space-y-0.5" aria-label="Mail">
          <NavLink
            label="All"
            icon={InboxIcon}
            active={currentSurface === "mail" && currentView === "all"}
            href={hrefFor({ surface: null, thread: null, view: "all" })}
            count={currentCounts?.views.all}
          />
          {mailItems.map((item) => (
            <NavLink
              key={item.label}
              label={item.label}
              icon={item.icon}
              active={currentSurface === "mail" && currentView === item.view}
              href={hrefFor({ surface: null, thread: null, view: item.view })}
              count={currentCounts?.views[item.view]}
            />
          ))}
        </nav>

        {!currentSidebarCounts ? (
          <p className="mt-3 hidden px-2.5 text-[11px] text-sidebar-foreground/45 lg:block" role="status">
            Mailbox counts are unavailable.
          </p>
        ) : null}

        <p className="mb-1.5 mt-5 hidden px-2.5 text-xs font-medium text-sidebar-foreground/35 lg:block">
          Inboxes
        </p>
        <nav className="space-y-0.5" aria-label="Connected inboxes">
          <MailboxLink
            href={handleAccountHref("all")}
            aria-current={accountSelection === "all" ? "true" : undefined}
            className={cn(navItemClassName(accountSelection === "all"), "h-8 gap-2 px-2")}
          >
            <span className="grid size-5 shrink-0 place-items-center rounded-full bg-sidebar-accent">
              <HugeiconsIcon icon={Mail01Icon} size={12} strokeWidth={1.7} />
            </span>
            <span className="hidden min-w-0 flex-1 truncate lg:block">All</span>
            {accountSelection === "all" ? (
              <HugeiconsIcon
                icon={Tick02Icon}
                size={14}
                strokeWidth={1.8}
                className="hidden shrink-0 text-sidebar-foreground/65 lg:block"
              />
            ) : null}
          </MailboxLink>
          {accounts.map((account) => {
            const isActive = accountSelection === account.id;
            return (
              <MailboxLink
                key={account.id}
                href={handleAccountHref(account.id)}
                aria-current={isActive ? "true" : undefined}
                className={cn(navItemClassName(isActive), "h-8 gap-2 px-2")}
              >
                <MailAccountAvatar
                  account={account}
                  accounts={accounts}
                  user={user}
                  ringOffsetClassName="ring-offset-sidebar"
                />
                <span className="hidden min-w-0 flex-1 truncate lg:block">
                  {account.email}
                </span>
                {isActive ? (
                  <HugeiconsIcon
                    icon={Tick02Icon}
                    size={14}
                    strokeWidth={1.8}
                    className="hidden shrink-0 text-sidebar-foreground/65 lg:block"
                  />
                ) : null}
              </MailboxLink>
            );
          })}
          <form action="/v1/connections/gmail/start" method="get">
            <button
              type="submit"
              aria-label="Add Gmail account"
              className={cn(
                navItemClassName(false),
                "h-8 gap-2 px-2 text-[13px] font-normal",
              )}
            >
              <HugeiconsIcon
                icon={PlusSignIcon}
                size={15}
                strokeWidth={1.65}
                className="shrink-0"
              />
              <span className="hidden truncate lg:block">Add account</span>
            </button>
          </form>
        </nav>
      </div>
    </aside>
  );
}
