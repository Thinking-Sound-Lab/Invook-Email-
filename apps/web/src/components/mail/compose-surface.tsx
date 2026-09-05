"use client";

import {
  Attachment01Icon,
  Cancel01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  GMAIL_COMPOSE_MAX_BODY_LENGTH,
  GMAIL_COMPOSE_MAX_SUBJECT_LENGTH,
  parseGmailComposeRecipients,
  validateGmailComposeDraftFields,
} from "@invook/contracts";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useReducer,
  useRef,
  useState,
} from "react";
import { v4 as uuidv4 } from "uuid";

import {
  composeDraftReducer,
  createComposeDraftState,
  isComposeDraftLocked,
  type ComposeDraftEditableField,
} from "@/components/mail/compose-draft-state";
import {
  bindComposeSenderAccount,
  createComposeSenderAccountState,
  releaseComposeSenderAccount,
  resolveComposeSenderAccountId,
  selectComposeSenderAccount,
} from "@/components/mail/compose-sender-account";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  sendGmailComposeAttempt,
  type GmailComposeSendAttempt,
} from "@/lib/api/gmail-compose-send";
import { apiErrorMessage } from "@/lib/http-error";

import {
  resolveMailboxAccountSelection,
  selectedMailboxAccount,
} from "./mail-account-scope";
import { useMailShell } from "./mail-shell-provider";

interface ComposeRecipientRowProps {
  id: string;
  label: "To" | "Cc" | "Bcc";
  value: string;
  placeholder: string;
  isDisabled: boolean;
  isRequired?: boolean;
  autoFocus?: boolean;
  trailing?: ReactNode;
  onChange: (value: string) => void;
}

function ComposeRecipientRow({
  id,
  label,
  value,
  placeholder,
  isDisabled,
  isRequired,
  autoFocus,
  trailing,
  onChange,
}: ComposeRecipientRowProps) {
  return (
    <div className="flex min-h-11 items-center gap-3 px-4 sm:px-5">
      <label
        htmlFor={id}
        className="w-11 shrink-0 text-xs font-medium text-muted-foreground"
      >
        {label}
      </label>
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        disabled={isDisabled}
        required={isRequired}
        autoFocus={autoFocus}
        autoComplete="off"
        className="min-w-0 flex-1 border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0 disabled:bg-transparent md:text-sm dark:bg-transparent dark:disabled:bg-transparent"
      />
      {trailing}
    </div>
  );
}

export function ComposeSurface() {
  const { accounts } = useMailShell();
  const searchParams = useSearchParams();
  const accountSelection = resolveMailboxAccountSelection(
    searchParams.get("account"),
    accounts,
  );
  const scopedAccount = selectedMailboxAccount(accountSelection, accounts);
  const busyRef = useRef(false);
  const [senderAccount, setSenderAccount] = useState(() =>
    createComposeSenderAccountState(scopedAccount?.id ?? ""),
  );
  const [state, dispatch] = useReducer(
    composeDraftReducer,
    undefined,
    createComposeDraftState,
  );
  const [isCcOpen, setIsCcOpen] = useState(false);
  const gmailAccountId = resolveComposeSenderAccountId({
    state: senderAccount,
    scopedAccountId: scopedAccount?.id ?? null,
  });
  const account =
    accounts.find((candidate) => candidate.id === gmailAccountId) ?? null;
  const isSending = state.status === "sending";
  const isSent = state.status === "sent";
  const isReconnectRequired = state.status === "reconnect_required";
  const isLocked = isComposeDraftLocked(state);
  const isSendFailed = ["send_error", "reconnect_required"].includes(
    state.status,
  );
  const mailboxHref = `/mail?account=${encodeURIComponent(accountSelection)}`;

  function handleEdit(field: ComposeDraftEditableField, value: string): void {
    setSenderAccount((current) =>
      releaseComposeSenderAccount(current, {
        hasProviderDraft: state.attempt?.phase === "send",
      }),
    );
    dispatch({ type: "edit", field, value });
  }

  function handleSenderAccountChange(accountId: string): void {
    setSenderAccount(selectComposeSenderAccount(accountId));
    dispatch({ type: "change_sender" });
  }

  function handleComposeKeyDown(event: KeyboardEvent<HTMLFormElement>): void {
    if (
      event.target instanceof HTMLInputElement &&
      (event.key === "Enter" || event.key === "NumpadEnter")
    ) {
      event.preventDefault();
    }
  }

  async function handleSend(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busyRef.current || isSending || isSent) return;
    if (!account) {
      dispatch({
        type: "error",
        message: "Choose the Gmail account to send from.",
      });
      return;
    }
    const validation = validateGmailComposeDraftFields({
      recipients: parseGmailComposeRecipients(state.recipients),
      ...(state.ccRecipients.trim()
        ? {
            ccRecipients: parseGmailComposeRecipients(state.ccRecipients),
          }
        : {}),
      ...(state.bccRecipients.trim()
        ? {
            bccRecipients: parseGmailComposeRecipients(state.bccRecipients),
          }
        : {}),
      subject: state.subject,
      body: state.body,
    });
    if (!validation.valid) {
      dispatch({ type: "error", message: validation.error.message });
      return;
    }

    // Retries resolve the original attempt: same draft, same idempotency keys.
    const attempt: GmailComposeSendAttempt = state.attempt ?? {
      phase: "save",
      request: {
        ...validation.fields,
        accountId: account.id,
        idempotencyKey: uuidv4(),
      },
      sendIdempotencyKey: uuidv4(),
    };
    busyRef.current = true;
    let hasProviderDraft = attempt.phase === "send";
    setSenderAccount(bindComposeSenderAccount(attempt.request.accountId));
    dispatch({ type: "sending", attempt });
    try {
      await sendGmailComposeAttempt(attempt, (saved) => {
        hasProviderDraft = true;
        dispatch({ type: "attempt_saved", attempt: saved });
      });
      dispatch({ type: "sent" });
    } catch (error) {
      const message = apiErrorMessage(
        error,
        hasProviderDraft
          ? "Invook could not confirm the send. Retry to safely resolve this attempt."
          : "Invook could not send this message. Retry to send it.",
      );
      dispatch({
        type: "send_error",
        message,
        isReconnectRequired: message === "Gmail account must be reconnected",
      });
    } finally {
      busyRef.current = false;
    }
  }

  return (
    <section className="flex min-h-0 flex-col bg-muted/20">
      <form
        aria-label="New message composer"
        className="flex min-h-0 flex-1 flex-col p-2 sm:p-4 lg:p-6"
        onKeyDown={handleComposeKeyDown}
        onSubmit={(event) => void handleSend(event)}
      >
        <div className="mx-auto flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-card shadow-[0_18px_48px_-32px] shadow-overlay/80">
          <div
            role="region"
            aria-label="Message fields and body"
            className="flex min-h-0 flex-col overflow-y-auto overscroll-contain"
          >
            <div className="shrink-0 bg-muted/45 py-1 dark:bg-muted/55">
              <div className="flex min-h-11 items-center gap-3 px-4 sm:px-5">
                <label
                  htmlFor="compose-account"
                  className="w-11 shrink-0 text-xs font-medium text-muted-foreground"
                >
                  From
                </label>
                {accountSelection === "all" ? (
                  <select
                    id="compose-account"
                    value={gmailAccountId}
                    onChange={(event) =>
                      handleSenderAccountChange(event.target.value)
                    }
                    disabled={isLocked}
                    required
                    className="h-8 min-w-0 flex-1 rounded-md bg-transparent text-sm font-medium outline-none focus-visible:ring-1 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <option value="">Choose an account</option>
                    {accounts.map((candidate) => (
                      <option
                        key={candidate.id}
                        value={candidate.id}
                        disabled={candidate.status !== "connected"}
                      >
                        {candidate.email}
                      </option>
                    ))}
                  </select>
                ) : (
                  <p
                    id="compose-account"
                    className="min-w-0 flex-1 truncate text-sm font-medium"
                  >
                    {account?.email}
                  </p>
                )}
                <Button
                  asChild
                  variant="ghost"
                  size="icon-sm"
                  className="rounded-md text-muted-foreground"
                >
                  <Link href={mailboxHref} aria-label="Close composer">
                    <HugeiconsIcon icon={Cancel01Icon} size={15} />
                  </Link>
                </Button>
              </div>

              <ComposeRecipientRow
                id="compose-recipients"
                label="To"
                value={state.recipients}
                onChange={(value) => handleEdit("recipients", value)}
                placeholder="Add recipients"
                isDisabled={isLocked}
                isRequired
                autoFocus
                trailing={
                  !isCcOpen ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="rounded-md font-normal text-muted-foreground"
                      onClick={() => setIsCcOpen(true)}
                      disabled={isLocked}
                      aria-expanded={false}
                      aria-controls="compose-copy-recipients"
                    >
                      Cc/Bcc
                    </Button>
                  ) : null
                }
              />
              {isCcOpen ? (
                <div id="compose-copy-recipients">
                  <ComposeRecipientRow
                    id="compose-cc-recipients"
                    label="Cc"
                    value={state.ccRecipients}
                    onChange={(value) => handleEdit("ccRecipients", value)}
                    placeholder="Add recipients"
                    isDisabled={isLocked}
                  />
                  <ComposeRecipientRow
                    id="compose-bcc-recipients"
                    label="Bcc"
                    value={state.bccRecipients}
                    onChange={(value) => handleEdit("bccRecipients", value)}
                    placeholder="Add recipients"
                    isDisabled={isLocked}
                  />
                </div>
              ) : null}
              <div className="flex min-h-11 items-center gap-3 px-4 sm:px-5">
                <label
                  htmlFor="compose-subject"
                  className="w-11 shrink-0 text-xs font-medium text-muted-foreground"
                >
                  Subject
                </label>
                <Input
                  id="compose-subject"
                  value={state.subject}
                  onChange={(event) =>
                    handleEdit("subject", event.target.value)
                  }
                  maxLength={GMAIL_COMPOSE_MAX_SUBJECT_LENGTH}
                  disabled={isLocked}
                  placeholder="Add a subject"
                  className="min-w-0 flex-1 border-0 bg-transparent px-0 text-sm font-medium shadow-none focus-visible:ring-0 disabled:bg-transparent md:text-sm dark:bg-transparent dark:disabled:bg-transparent"
                />
              </div>
            </div>

            <label htmlFor="compose-body" className="sr-only">
              Message body
            </label>
            <Textarea
              id="compose-body"
              value={state.body}
              onChange={(event) => handleEdit("body", event.target.value)}
              placeholder="Write your message…"
              maxLength={GMAIL_COMPOSE_MAX_BODY_LENGTH}
              disabled={isLocked}
              required
              className="min-h-48 resize-none border-0 bg-transparent px-4 py-5 text-[15px] leading-7 shadow-none focus-visible:ring-0 disabled:bg-transparent sm:px-5 md:text-[15px] dark:bg-transparent dark:disabled:bg-transparent"
            />

            {state.message || isReconnectRequired ? (
              <div className="shrink-0 px-4 pb-3 sm:px-5">
                <div className="max-w-2xl text-xs leading-5 text-muted-foreground">
                  {state.message ? (
                    <p
                      className="text-destructive"
                      role="alert"
                      aria-live="polite"
                    >
                      {state.message}
                    </p>
                  ) : null}
                  {isReconnectRequired ? (
                    <div className="mt-2">
                      <Button asChild variant="outline" size="sm">
                        <a
                          href={`/v1/connections/gmail/start?accountId=${encodeURIComponent(gmailAccountId)}`}
                        >
                          Reconnect Gmail
                        </a>
                      </Button>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>

          <footer
            aria-label="Compose actions"
            className="flex shrink-0 flex-wrap items-center justify-between gap-3 bg-muted/35 px-4 py-3 sm:px-5 dark:bg-muted/45"
          >
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="submit"
                disabled={isSending || isSent || isReconnectRequired}
                className="h-8 rounded-lg bg-compose-accent px-3.5 text-sm font-normal text-compose-accent-foreground hover:bg-compose-accent-hover"
              >
                {isSending
                  ? "Sending with Gmail…"
                  : isSent
                    ? "Sent with Gmail"
                    : isSendFailed
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
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled
              aria-label="Attachments unavailable"
              title="Adding attachments is not available yet"
              className="rounded-md text-muted-foreground"
            >
              <HugeiconsIcon icon={Attachment01Icon} size={16} />
            </Button>
          </footer>
        </div>
      </form>
    </section>
  );
}
