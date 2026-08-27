import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { AccountPipelineStripe } from "@/components/mail/account-pipeline-stripe";
import { MailboxEventSubscriber } from "@/components/mail/mailbox-event-subscriber";
import { MailShellProvider } from "@/components/mail/mail-shell-provider";
import { MailSidebar } from "@/components/mail/mail-sidebar";
import { getMailboxShell, getMailboxSidebarCounts } from "@/lib/api";

interface MailLayoutProps {
  children: ReactNode;
}

export default async function MailLayout({ children }: MailLayoutProps) {
  const [shell, sidebarCounts] = await Promise.all([
    getMailboxShell(),
    getMailboxSidebarCounts().catch(() => null),
  ]);
  if (!shell) redirect("/");

  return (
    <MailShellProvider shell={shell}>
      <main className="flex h-dvh flex-col overflow-hidden bg-background">
        <MailboxEventSubscriber />
        <div className="grid min-h-0 flex-1 grid-cols-[64px_minmax(0,1fr)] lg:grid-cols-[240px_minmax(0,1fr)] xl:grid-cols-[240px_minmax(520px,1fr)_360px]">
          <MailSidebar sidebarCounts={sidebarCounts} />
          {children}
        </div>
        <AccountPipelineStripe accounts={shell.accounts} />
      </main>
    </MailShellProvider>
  );
}
