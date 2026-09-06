"use client";

import {
  Attachment01Icon,
  ArrowTurnForwardIcon,
  Cancel01Icon,
  Delete02Icon,
  MailReply01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  GMAIL_COMPOSE_MAX_BODY_LENGTH,
  GMAIL_COMPOSE_MAX_SUBJECT_LENGTH,
} from "@invook/contracts";
import { type ReactNode, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useThreadComposer } from "@/hooks/use-thread-composer";

import { QuotedTextToggle } from "./quoted-text-toggle";
import type {
  ThreadComposeMessage,
  ThreadComposeMode,
} from "./thread-composer-state";

export interface ThreadComposerProps {
  threadId: string;
  accountId: string;
  accountEmail: string;
  message: ThreadComposeMessage | null;
}

interface RecipientRowProps {
  id: string;
  label: "To" | "Cc" | "Bcc";
  value: string;
  placeholder: string;
  isDisabled: boolean;
  autoFocus?: boolean;
  trailing?: ReactNode;
  onChange: (value: string) => void;
}

function RecipientRow({
  id,
  label,
  value,
  placeholder,
  isDisabled,
  autoFocus,
  trailing,
  onChange,
}: RecipientRowProps) {
  return (
    <div className="flex min-h-10 items-center gap-3 px-4 sm:px-5">
      <label
        htmlFor={id}
        className="w-8 shrink-0 text-xs text-muted-foreground"
      >
        {label}
      </label>
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        disabled={isDisabled}
        autoFocus={autoFocus}
        autoComplete="off"
        className="min-w-0 flex-1 border-0 px-0 text-sm shadow-none focus-visible:ring-0 md:text-sm dark:bg-transparent"
      />
      {value && !isDisabled ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="rounded-md text-muted-foreground"
          aria-label={`Clear ${label} recipients`}
          onClick={() => onChange("")}
        >
          <HugeiconsIcon icon={Cancel01Icon} size={12} />
        </Button>
      ) : null}
      {trailing}
    </div>
  );
}

export function ThreadComposer({
  threadId,
  accountId,
  accountEmail,
  message,
}: ThreadComposerProps) {
  const formId = useId();
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const [isCcOpen, setIsCcOpen] = useState(false);
  const [isForwardQuoteExpanded, setIsForwardQuoteExpanded] = useState(false);
  const composer = useThreadComposer({
    threadId,
    accountId,
    accountEmail,
    message,
  });
  const {
    session,
    pending,
    isLocked,
    isConnected,
    isSendUnresolved,
    error,
    notice,
  } = composer;

  function handleOpen(mode: ThreadComposeMode): void {
    if (!composer.open(mode)) return;
    if (session?.mode !== mode) {
      setIsCcOpen(false);
      setIsForwardQuoteExpanded(false);
    }
    bodyRef.current?.focus();
  }

  return (
    <section className="mt-10" aria-label="Thread actions">
      <div className="flex flex-wrap gap-2.5">
        <Button
          type="button"
          variant="outline"
          className="h-8 gap-2 rounded-full bg-transparent px-3.5 font-normal"
          onClick={() => handleOpen("reply")}
          disabled={!message || isLocked}
          aria-expanded={session?.mode === "reply"}
          aria-controls={formId}
        >
          <HugeiconsIcon icon={MailReply01Icon} size={14} /> Reply
        </Button>
        <Button
          type="button"
          variant="outline"
          className="h-8 gap-2 rounded-full bg-transparent px-3.5 font-normal"
          onClick={() => handleOpen("forward")}
          disabled={!message || isLocked}
          aria-expanded={session?.mode === "forward"}
          aria-controls={formId}
        >
          <HugeiconsIcon icon={ArrowTurnForwardIcon} size={14} /> Forward
        </Button>
      </div>

      {session ? (
        <form
          id={formId}
          className="mt-5 overflow-hidden rounded-2xl bg-muted/65 dark:bg-muted"
          aria-label={
            session.mode === "reply" ? "Reply composer" : "Forward composer"
          }
          onSubmit={(event) => {
            event.preventDefault();
            void composer.send();
          }}
        >
          <div className="border-b border-border/50 py-0.5">
            <RecipientRow
              id={`${formId}-to`}
              label="To"
              value={session.recipients}
              onChange={(value) => composer.edit("recipients", value)}
              placeholder="Add recipient"
              isDisabled={isLocked}
              autoFocus={session.mode === "forward"}
              trailing={
                !isCcOpen ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="rounded-md font-normal text-muted-foreground"
                    onClick={() => setIsCcOpen(true)}
                    aria-expanded={false}
                    disabled={isLocked}
                  >
                    Cc/Bcc
                  </Button>
                ) : null
              }
            />
            {isCcOpen ? (
              <>
                <RecipientRow
                  id={`${formId}-ccRecipients`}
                  label="Cc"
                  value={session.ccRecipients}
                  onChange={(value) => composer.edit("ccRecipients", value)}
                  placeholder="Add recipient"
                  isDisabled={isLocked}
                />
                <RecipientRow
                  id={`${formId}-bccRecipients`}
                  label="Bcc"
                  value={session.bccRecipients}
                  onChange={(value) => composer.edit("bccRecipients", value)}
                  placeholder="Add recipient"
                  isDisabled={isLocked}
                />
              </>
            ) : null}
            {session.mode === "forward" ? (
              <div className="flex min-h-10 items-center px-4 sm:px-5">
                <label
                  htmlFor={`${formId}-subject`}
                  className="sr-only"
                >
                  Subject
                </label>
                <Input
                  id={`${formId}-subject`}
                  value={session.subject}
                  onChange={(event) =>
                    composer.edit("subject", event.target.value)
                  }
                  disabled={isLocked}
                  maxLength={GMAIL_COMPOSE_MAX_SUBJECT_LENGTH}
                  className="min-w-0 flex-1 border-0 px-0 text-sm shadow-none focus-visible:ring-0 md:text-sm dark:bg-transparent"
                />
              </div>
            ) : null}
          </div>
          <Textarea
            ref={bodyRef}
            aria-label={
              session.mode === "reply" ? "Reply message" : "Forward message"
            }
            value={session.body}
            onChange={(event) => composer.edit("body", event.target.value)}
            placeholder="Write your message…"
            maxLength={GMAIL_COMPOSE_MAX_BODY_LENGTH}
            disabled={isLocked}
            autoFocus={session.mode === "reply"}
            className="min-h-48 resize-y border-0 bg-transparent px-4 py-4 text-sm leading-6 shadow-none focus-visible:ring-0 md:text-sm sm:px-5 dark:bg-transparent"
          />
          {session.forwardedMessageText ? (
            <div className="px-4 pb-4 sm:px-5">
              <QuotedTextToggle
                controls={`${formId}-forwarded-message`}
                isExpanded={isForwardQuoteExpanded}
                onToggle={() =>
                  setIsForwardQuoteExpanded((value) => !value)
                }
              />
              {isForwardQuoteExpanded ? (
                <div
                  id={`${formId}-forwarded-message`}
                  role="region"
                  aria-label="Forwarded message"
                  className="mt-4 whitespace-pre-wrap break-words border-l border-border/60 pl-4 text-sm leading-6 text-foreground/68"
                >
                  {session.forwardedMessageText}
                </div>
              ) : null}
            </div>
          ) : null}
          {session.mode === "forward" && session.message.attachmentCount > 0 ? (
            <p className="px-5 pb-3 text-xs text-muted-foreground">
              Original attachments are not included in this forward.
            </p>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 pb-3 sm:px-5">
            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                disabled={pending !== null || !isConnected}
                className="h-8 rounded-lg bg-compose-accent px-3.5 text-sm font-normal text-compose-accent-foreground hover:bg-compose-accent-hover"
              >
                {pending === "send"
                  ? "Sending…"
                  : isSendUnresolved
                    ? "Retry send"
                    : "Send"}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled
                title="Send later is not available yet"
                className="h-8 rounded-lg bg-transparent text-sm font-normal"
              >
                Send later
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled
                title="Reminders are not available yet"
                className="h-8 rounded-lg bg-transparent text-sm font-normal"
              >
                Remind me
              </Button>
            </div>
            <div className="flex items-center gap-2 text-muted-foreground">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="rounded-md"
                aria-label="Attachments unavailable"
                title="Adding attachments is not available yet"
                disabled
              >
                <HugeiconsIcon icon={Attachment01Icon} size={16} />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="rounded-md"
                aria-label="Discard message"
                onClick={composer.discard}
                disabled={isLocked}
              >
                <HugeiconsIcon icon={Delete02Icon} size={16} />
              </Button>
            </div>
          </div>
        </form>
      ) : null}
      {!isConnected && session ? (
        <p className="mt-3 text-xs text-destructive">
          Reconnect this Gmail account to send.{" "}
          <a
            className="underline"
            href={`/v1/connections/gmail/start?accountId=${encodeURIComponent(accountId)}`}
          >
            Reconnect Gmail
          </a>
        </p>
      ) : null}
      {isSendUnresolved && error ? (
        <p className="mt-3 text-xs text-muted-foreground">
          This message is locked while its send is unresolved. Retry send safely
          checks the same attempt.
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="mt-3 text-xs text-success">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
