"use client";

import {
  Attachment01Icon,
  ArrowTurnForwardIcon,
  Cancel01Icon,
  Delete02Icon,
  MailReply01Icon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  GMAIL_COMPOSE_MAX_BODY_LENGTH,
  GMAIL_COMPOSE_MAX_SUBJECT_LENGTH,
  type AiReplyDraft,
} from "@invook/contracts";
import { useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useThreadComposer } from "@/hooks/use-thread-composer";

import { useMailShell } from "./mail-shell-provider";
import type {
  ThreadComposeMessage,
  ThreadComposeMode,
} from "./thread-composer-state";

export interface ThreadComposerProps {
  threadId: string;
  accountId: string;
  accountEmail: string;
  message: ThreadComposeMessage | null;
  initialDraft: AiReplyDraft | null;
}

export function ThreadComposer({
  threadId,
  accountId,
  accountEmail,
  message,
  initialDraft,
}: ThreadComposerProps) {
  const { aiConfigured } = useMailShell();
  const formId = useId();
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const [isAiOpen, setIsAiOpen] = useState(false);
  const [isCcOpen, setIsCcOpen] = useState(false);
  const [instruction, setInstruction] = useState("");
  const composer = useThreadComposer({
    threadId,
    accountId,
    accountEmail,
    message,
    initialDraft,
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

  function handleOpen(
    mode: ThreadComposeMode,
    options: { withAi?: boolean } = {},
  ): void {
    if (!composer.open(mode, options)) return;
    if (session?.mode !== mode) setIsCcOpen(false);
    setIsAiOpen(Boolean(options.withAi));
    bodyRef.current?.focus();
  }

  async function handleGenerateDraft(): Promise<void> {
    if (await composer.generateDraft(instruction)) setIsAiOpen(false);
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
        <Button
          type="button"
          variant="outline"
          className="h-8 gap-2 rounded-full bg-transparent px-3.5 font-normal"
          onClick={() => handleOpen("reply", { withAi: true })}
          disabled={!message || isLocked || !aiConfigured}
          title={
            aiConfigured
              ? undefined
              : "Add an AI model in Settings to draft replies"
          }
          aria-expanded={isAiOpen && session?.mode === "reply"}
          aria-controls={formId}
        >
          <HugeiconsIcon icon={SparklesIcon} size={14} /> Draft with AI
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
          <div className="flex min-h-11 items-center gap-3 border-b border-border/50 px-4 sm:px-5">
            <label
              htmlFor={`${formId}-to`}
              className="text-xs text-muted-foreground"
            >
              To
            </label>
            <Input
              id={`${formId}-to`}
              value={session.recipients}
              onChange={(event) =>
                composer.edit("recipients", event.target.value)
              }
              placeholder="Recipients"
              disabled={isLocked}
              autoFocus={session.mode === "forward"}
              autoComplete="off"
              className="min-w-0 flex-1 border-0 px-0 text-sm shadow-none focus-visible:ring-0 md:text-sm dark:bg-transparent"
            />
            {session.recipients && !isLocked ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="rounded-md text-muted-foreground"
                aria-label="Clear recipients"
                onClick={() => composer.edit("recipients", "")}
              >
                <HugeiconsIcon icon={Cancel01Icon} size={12} />
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="rounded-md font-normal text-muted-foreground"
              onClick={() => setIsCcOpen(!isCcOpen)}
              aria-expanded={isCcOpen}
              disabled={isLocked}
            >
              Cc/Bcc
            </Button>
          </div>
          {isCcOpen ? (
            <div className="space-y-1 px-4 pt-2 sm:px-5">
              {(["ccRecipients", "bccRecipients"] as const).map((field) => (
                <div key={field} className="flex items-center gap-3">
                  <label
                    htmlFor={`${formId}-${field}`}
                    className="w-6 text-xs text-muted-foreground"
                  >
                    {field === "ccRecipients" ? "Cc" : "Bcc"}
                  </label>
                  <Input
                    id={`${formId}-${field}`}
                    value={session[field]}
                    onChange={(event) =>
                      composer.edit(field, event.target.value)
                    }
                    disabled={isLocked}
                    autoComplete="off"
                    className="border-0 px-0 text-sm shadow-none focus-visible:ring-0 md:text-sm dark:bg-transparent"
                  />
                </div>
              ))}
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-3 text-[11px] text-muted-foreground sm:px-5">
            <span>From {accountEmail}</span>
            {session.mode === "reply" ? (
              <span className="truncate">{session.subject}</span>
            ) : null}
          </div>
          {session.mode === "forward" ? (
            <div className="flex items-center gap-3 px-4 pt-2 sm:px-5">
              <label
                htmlFor={`${formId}-subject`}
                className="text-xs text-muted-foreground"
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
                className="border-0 px-0 text-sm shadow-none focus-visible:ring-0 md:text-sm dark:bg-transparent"
              />
            </div>
          ) : null}
          {isAiOpen && session.mode === "reply" ? (
            <div className="m-4 flex flex-wrap items-center gap-2 rounded-lg bg-background/60 p-2 sm:mx-5">
              <Input
                value={instruction}
                onChange={(event) => setInstruction(event.target.value)}
                aria-label="Instruction for this reply"
                placeholder="Optional instruction for this reply"
                maxLength={1000}
                disabled={isLocked}
                className="min-w-40 flex-1 border-0 shadow-none dark:bg-transparent"
              />
              <Button
                type="button"
                className="rounded-md"
                onClick={() => void handleGenerateDraft()}
                disabled={isLocked || !aiConfigured}
              >
                {pending === "generate" ? "Drafting…" : "Generate draft"}
              </Button>
            </div>
          ) : null}
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
                className="h-8 rounded-lg bg-[#8184f5] px-3.5 text-sm font-normal text-[#171724] hover:bg-[#9496fa]"
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
              {session.aiDraft &&
              session.body !== session.aiDraft.currentText ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="rounded-md"
                  onClick={() => void composer.saveAiEdits()}
                  disabled={isLocked || !session.body.trim()}
                >
                  Save changes
                </Button>
              ) : null}
              {session.mode === "reply" ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="rounded-md"
                  aria-label="Draft with AI"
                  onClick={() => setIsAiOpen(!isAiOpen)}
                  disabled={isLocked || !aiConfigured}
                >
                  <HugeiconsIcon icon={SparklesIcon} size={16} />
                </Button>
              ) : null}
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
