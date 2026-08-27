import type { MailboxAccount, SignedInUser } from "@invook/contracts";

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

import { initials } from "./mail-format";

const accountRingClassNames = [
  "ring-blue-500",
  "ring-emerald-500",
  "ring-violet-500",
  "ring-amber-500",
  "ring-rose-500",
  "ring-cyan-500",
  "ring-fuchsia-500",
  "ring-lime-500",
] as const;

export function accountRingClassName(
  accountId: string,
  accounts: MailboxAccount[],
): string {
  const accountIndex = accounts.findIndex((account) => account.id === accountId);
  return accountRingClassNames[
    Math.max(0, accountIndex) % accountRingClassNames.length
  ];
}

export interface MailAccountAvatarProps {
  account: MailboxAccount;
  accounts: MailboxAccount[];
  user: SignedInUser;
  className?: string;
  ringOffsetClassName?: string;
}

export function MailAccountAvatar({
  account,
  accounts,
  user,
  className,
  ringOffsetClassName = "ring-offset-background",
}: MailAccountAvatarProps) {
  const image =
    account.image ??
    (account.email.toLowerCase() === user.email.toLowerCase()
      ? user.image
      : null);
  return (
    <Avatar
      size="sm"
      title={account.email}
      aria-label={account.email}
      className={cn(
        "size-5 border-0 ring-2 ring-offset-1 after:border-0",
        accountRingClassName(account.id, accounts),
        ringOffsetClassName,
        className,
      )}
    >
      {image ? <AvatarImage src={image} alt="" /> : null}
      <AvatarFallback className="bg-secondary text-[9px] font-semibold text-foreground">
        {initials(account.email)}
      </AvatarFallback>
    </Avatar>
  );
}
