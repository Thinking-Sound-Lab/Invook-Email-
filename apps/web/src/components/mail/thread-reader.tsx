import { ArrowLeft02Icon, Download01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { InvookLabel } from "@invook/contracts";
import Link from "next/link";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";

import {
  displayName,
  formatMailText,
  initials,
} from "./mail-format";
import { ThreadComposer } from "./thread-composer";
import { EmailHtmlContent } from "./email-html-content";
import { buildEmailHtmlPresentation } from "./email-html-sanitizer";
import { LocalMailDate } from "./local-mail-date";
import { MessageRecipientDetails } from "./message-recipient-details";
import { MessageStarButton } from "./message-star-button";
import { PlainTextMailContent } from "./plain-text-mail-content";
import { SmartLabelControls } from "./smart-label-controls";
import { ThreadReadTracker } from "./thread-read-tracker";
import { getThreadReadTrackerKey } from "./thread-read-state";
import type { MailboxView, SelectedThread } from "./types";

export interface ThreadReaderProps {
  accountSelection: string;
  thread: SelectedThread;
  currentView: MailboxView;
  mailboxCursor?: string;
  availableLabels: InvookLabel[];
}

export async function ThreadReader({
  accountSelection,
  thread,
  currentView,
  mailboxCursor,
  availableLabels,
}: ThreadReaderProps) {
  const mailboxQuery = new URLSearchParams({
    account: accountSelection,
    view: currentView,
  });
  if (mailboxCursor) mailboxQuery.set("cursor", mailboxCursor);
  const isUnread = thread.isUnread;
  const latestMessage = thread.messages.at(-1);
  const composeMessage = [...thread.messages]
    .reverse()
    .find((message) => !message.isDraft);
  const isLatestMessageStarred = Boolean(latestMessage?.isStarred);

  return (
    <section
      className="flex min-h-0 flex-col bg-background"
      aria-label="Open email thread"
    >
      <header className="relative z-30 flex min-h-15 shrink-0 items-center justify-between gap-3 border-b border-border/35 px-3 sm:px-4">
        <Button
          asChild
          variant="ghost"
          size="sm"
          className="text-sm text-muted-foreground"
        >
          <Link href={`/mail?${mailboxQuery.toString()}`} scroll={false}>
            <HugeiconsIcon icon={ArrowLeft02Icon} size={16} />
            Back
          </Link>
        </Button>
        <div className="flex min-w-0 items-center justify-end gap-1">
          <SmartLabelControls
            key={thread.id}
            threadId={thread.id}
            label={thread.invookLabel}
            availableLabels={availableLabels}
          />
          {latestMessage ? (
            <MessageStarButton
              messageId={latestMessage.id}
              isStarred={isLatestMessageStarred}
            />
          ) : null}
        </div>
      </header>
      <ThreadReadTracker
        key={getThreadReadTrackerKey({
          threadId: thread.id,
          isUnread,
          providerHistoryIds: thread.messages.map(
            (message) => message.providerHistoryId,
          ),
        })}
        threadId={thread.id}
        isUnread={isUnread}
      />

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-[900px] px-5 py-7 sm:px-8 sm:py-9 lg:px-10">
          <h1 className="text-balance text-xl font-semibold leading-7 tracking-[-0.025em] sm:text-[22px] sm:leading-8">
            {formatMailText(thread.subject) || "(No subject)"}
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {thread.messageCount}{" "}
            {thread.messageCount === 1 ? "message" : "messages"}
          </p>

          <div className="mt-7 space-y-14">
            {thread.messages.map((message) => {
              const senderName = displayName(
                message.sender.raw || message.sender.email,
              );
              const senderLabel =
                message.direction === "outgoing" ? "You" : senderName;
              const emailPresentation = message.bodyHtml
                ? buildEmailHtmlPresentation(message.bodyHtml)
                : null;
              return (
                <article
                  key={message.id}
                  aria-labelledby={`message-${message.id}-sender`}
                >
                  <div className="flex items-start gap-3">
                    <Avatar className="size-8">
                      <AvatarFallback className="bg-secondary text-[11px] font-semibold">
                        {initials(senderName)}
                      </AvatarFallback>
                    </Avatar>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p
                            id={`message-${message.id}-sender`}
                            className="truncate text-sm font-semibold leading-5"
                          >
                            {senderLabel}
                          </p>
                          <MessageRecipientDetails
                            accountEmail={thread.accountEmail}
                            recipients={message.recipients}
                            sender={message.sender.raw || message.sender.email}
                          />
                        </div>

                        <div className="flex shrink-0 items-center gap-1 sm:gap-2">
                          <LocalMailDate
                            className="whitespace-nowrap text-[11px] tabular-nums text-muted-foreground sm:text-xs"
                            value={message.sentAt}
                          />
                        </div>
                      </div>

                      {emailPresentation ? (
                        <div className="mt-7 flex justify-center">
                          <EmailHtmlContent
                            className="max-w-[720px]"
                            hasQuotedContent={
                              emailPresentation.hasQuotedContent
                            }
                            sanitizedHtml={emailPresentation.sanitizedHtml}
                          />
                        </div>
                      ) : (
                        <PlainTextMailContent
                          bodyText={message.bodyText}
                          className="mx-auto mt-7 max-w-[720px] text-[15px] leading-7 text-foreground/88"
                        />
                      )}

                      {message.attachments.length > 0 ? (
                        <div
                          className="mx-auto mt-5 flex max-w-[720px] flex-wrap gap-2"
                          aria-label="Attachments"
                        >
                          {message.attachments.map((attachment) => (
                            <Button
                              key={attachment.id}
                              asChild
                              variant="secondary"
                              size="sm"
                              className="max-w-full"
                            >
                              <a
                                href={`/v1/attachments/${encodeURIComponent(attachment.id)}/download`}
                                download
                              >
                                <HugeiconsIcon
                                  icon={Download01Icon}
                                  size={15}
                                />
                                <span className="truncate">
                                  {formatMailText(attachment.filename) ||
                                    "Attachment"}
                                </span>
                              </a>
                            </Button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>

          <ThreadComposer
            key={thread.id}
            threadId={thread.id}
            accountId={thread.accountId}
            accountEmail={thread.accountEmail}
            message={
              composeMessage
                ? {
                    id: composeMessage.id,
                    direction: composeMessage.direction,
                    sender: composeMessage.sender,
                    recipients: composeMessage.recipients,
                    headers: composeMessage.headers,
                    subject: composeMessage.subject,
                    bodyText: composeMessage.bodyText,
                    bodyHtml: composeMessage.bodyHtml,
                    sentAt: composeMessage.sentAt,
                    attachmentCount: composeMessage.attachments.length,
                  }
                : null
            }
            initialDraft={thread.aiReplyDraft}
          />
        </div>
      </ScrollArea>
    </section>
  );
}
