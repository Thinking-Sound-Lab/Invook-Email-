import { redirect } from "next/navigation";

import { MailWorkspace } from "@/components/mail/mail-workspace";
import {
  normalizeMailSurface,
  normalizeMailboxAccount,
  normalizeMailboxView,
} from "@/components/mail/mailbox-location";
import { getMailboxThreadPage } from "@/lib/api";

interface MailPageProps {
  searchParams: Promise<{
    view?: string | string[];
    surface?: string | string[];
    thread?: string | string[];
    q?: string | string[];
    account?: string | string[];
  }>;
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Seeds the mailbox for the requested address and hands the surfaces over.
 *
 * Only the opening list is read here. Threads, search, and every later address
 * are read by the browser from its own cache, so moving around the mailbox does
 * not return to the server.
 */
export default async function MailPage({ searchParams }: MailPageProps) {
  const params = await searchParams;

  const requestedThreadId = firstValue(params.thread);
  const currentSurface = requestedThreadId
    ? "mail"
    : normalizeMailSurface(firstValue(params.surface));
  const currentView = normalizeMailboxView(firstValue(params.view));
  const accountSelection = normalizeMailboxAccount(firstValue(params.account));
  const isMailboxList = currentSurface === "mail" && !requestedThreadId;

  const threadPage = isMailboxList
    ? await getMailboxThreadPage({
        account: accountSelection,
        view: currentView,
      })
    : null;
  if (isMailboxList && !threadPage) redirect("/");

  return (
    <MailWorkspace
      initialAccountSelection={accountSelection}
      initialView={currentView}
      initialPage={threadPage}
    />
  );
}
