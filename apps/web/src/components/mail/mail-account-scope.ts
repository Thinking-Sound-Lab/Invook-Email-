import type {
  InvookLabel,
  MailboxAccount,
  MailboxScopeSidebarCounts,
  MailboxShell,
  MailboxSidebarCounts,
} from "@invook/contracts";

export const ALL_MAILBOX_ACCOUNTS = "all" as const;

export type MailboxAccountSelection = typeof ALL_MAILBOX_ACCOUNTS | string;

export function resolveMailboxAccountSelection(
  requestedAccount: string | null | undefined,
  accounts: MailboxAccount[],
): MailboxAccountSelection {
  if (!requestedAccount || requestedAccount === ALL_MAILBOX_ACCOUNTS) {
    return ALL_MAILBOX_ACCOUNTS;
  }
  return accounts.some((account) => account.id === requestedAccount)
    ? requestedAccount
    : ALL_MAILBOX_ACCOUNTS;
}

export function selectedMailboxAccount(
  selection: MailboxAccountSelection,
  accounts: MailboxAccount[],
): MailboxAccount | null {
  return selection === ALL_MAILBOX_ACCOUNTS
    ? null
    : accounts.find((account) => account.id === selection) ?? null;
}

export function accountLabels(
  shell: Pick<MailboxShell, "accountLabels">,
  accountId: string,
): InvookLabel[] {
  return (
    shell.accountLabels.find((entry) => entry.accountId === accountId)?.labels ?? []
  );
}

export function selectedSidebarCounts(
  counts: MailboxSidebarCounts | null,
  selection: MailboxAccountSelection,
): MailboxScopeSidebarCounts | null {
  if (!counts) return null;
  return selection === ALL_MAILBOX_ACCOUNTS
    ? counts.all
    : counts.accounts[selection] ?? null;
}

export function mailboxAccountQueryValue(
  selection: MailboxAccountSelection,
): string {
  return selection === ALL_MAILBOX_ACCOUNTS ? ALL_MAILBOX_ACCOUNTS : selection;
}

export function createMailboxHref(
  currentSearchParams: URLSearchParams,
  updates: {
    account?: MailboxAccountSelection;
    surface?: string | null;
    thread?: string | null;
    view?: string | null;
  },
): string {
  const query = new URLSearchParams(currentSearchParams);
  const setOrDelete = (key: string, value: string | null | undefined) => {
    if (value === undefined) return;
    if (value === null || value === "") query.delete(key);
    else query.set(key, value);
  };
  setOrDelete(
    "account",
    updates.account === undefined
      ? undefined
      : mailboxAccountQueryValue(updates.account),
  );
  setOrDelete("surface", updates.surface);
  setOrDelete("thread", updates.thread);
  setOrDelete("view", updates.view);
  query.delete("cursor");
  return `/mail?${query.toString()}`;
}
