import { isAiConfigured } from "@invook/ai";
import type { MailboxShell, SignedInUser } from "@invook/contracts";
import type { getMailboxShellData } from "@invook/database";

export function serializeMailboxShell(
  shell: NonNullable<Awaited<ReturnType<typeof getMailboxShellData>>>,
  user: SignedInUser,
): MailboxShell {
  return {
    aiConfigured: isAiConfigured(),
    user,
    accounts: shell.accounts,
    accountLabels: shell.accountLabels,
  };
}
