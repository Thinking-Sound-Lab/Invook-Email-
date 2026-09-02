"use client";

import {
  Attachment01Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  MailAdd01Icon,
  MailSend02Icon,
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
  type ReactNode,
  useReducer,
  useState,
} from "react";
import { v4 as uuidv4 } from "uuid";

import {
  composeDraftReducer,
  createComposeDraftState,
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
  createGmailComposeDraft,
  sendGmailComposeDraft,
  updateGmailComposeDraft,
} from "@/lib/api/compose-drafts";
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
        className="min-w-0 flex-1 border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0 md:text-sm dark:bg-transparent"
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
  const [senderAccount, setSenderAccount] = useState(() =>
    createComposeSenderAccountState(scopedAccount?.id ?? ""),
  );
  const [state, dispatch] = useReducer(
    composeDraftReducer,
    undefined,
    () => createComposeDraftState(uuidv4()),
  );
  const [isCcOpen, setIsCcOpen] = useState(false);
  const gmailAccountId = resolveComposeSenderAccountId({
    state: senderAccount,
    scopedAccountId: scopedAccount?.id ?? null,
  });
  const account =
    accounts.find((candidate) => candidate.id === gmailAccountId) ?? null;
  const isSaving = state.status === "saving";
  const isSending = state.status === "sending";
  const isSent = state.status === "sent";
  const isReconnectRequired = state.status === "reconnect_required";
  const isLocked = isSaving || isSending || isSent || isReconnectRequired;
  const isCurrentDraftSaved = Boolean(
    state.providerDraft &&
      !["editing", "saving", "error"].includes(state.status),
  );
  const canRequestSend =
    Boolean(state.providerDraft && state.sendIdempotencyKey) &&
    ["saved", "send_error"].includes(state.status);
  const mailboxHref = `/mail?account=${encodeURIComponent(accountSelection)}`;

  function handleEdit(
    field: ComposeDraftEditableField,
    value: string,
  ): void {
    setSenderAccount((current) =>
      releaseComposeSenderAccount(current, {
        hasProviderDraft: Boolean(state.providerDraft),
      }),
    );
    dispatch({ type: "edit", field, value, idempotencyKey: uuidv4() });
  }

  function handleSenderAccountChange(accountId: string): void {
    setSenderAccount(selectComposeSenderAccount(accountId));
    dispatch({ type: "change_sender", idempotencyKey: uuidv4() });
  }

  async function handleSave(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
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

    setSenderAccount(bindComposeSenderAccount(account.id));
    dispatch({ type: "saving" });
    const request = {
      accountId: account.id,
      idempotencyKey: state.idempotencyKey,
      ...validation.fields,
    };
    try {
      const result = state.providerDraft
        ? await updateGmailComposeDraft(
            state.providerDraft.providerDraftId,
            request,
          )
        : await createGmailComposeDraft(request);
      dispatch({
        type: "saved",
        draft: result.draft,
        sendIdempotencyKey: uuidv4(),
      });
    } catch (error) {
      const message = apiErrorMessage(
        error,
        "Invook could not save this draft to Gmail.",
      );
      dispatch({
        type: "error",
        message,
        isReconnectRequired: message === "Gmail account must be reconnected",
      });
    }
  }

  async function handleSend(): Promise<void> {
    if (!state.providerDraft || !state.sendIdempotencyKey) return;
    dispatch({ type: "sending" });
    try {
      await sendGmailComposeDraft(state.providerDraft.providerDraftId, {
        accountId: gmailAccountId,
        idempotencyKey: state.sendIdempotencyKey,
      });
      dispatch({ type: "sent" });
    } catch (error) {
      const message = apiErrorMessage(
        error,
        "Invook could not send this Gmail draft.",
      );
      dispatch({
        type: "send_error",
        message,
        isReconnectRequired: message === "Gmail account must be reconnected",
      });
    }
  }

  return (
    <section className="flex min-h-0 flex-col bg-muted/20">
      <form
        aria-label="New message composer"
        className="flex min-h-0 flex-1 flex-col p-2 sm:p-4 lg:p-6"
        onSubmit={(event) => void handleSave(event)}
      >
        <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col overflow-hidden rounded-2xl bg-card shadow-[0_18px_48px_-32px_rgba(0,0,0,0.8)]">
          <div className="bg-muted/45 py-1 dark:bg-muted/55">
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
                  disabled={isLocked || Boolean(state.providerDraft)}
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
                onChange={(event) => handleEdit("subject", event.target.value)}
                maxLength={GMAIL_COMPOSE_MAX_SUBJECT_LENGTH}
                disabled={isLocked}
                placeholder="Add a subject"
                className="min-w-0 flex-1 border-0 bg-transparent px-0 text-sm font-medium shadow-none focus-visible:ring-0 md:text-sm dark:bg-transparent"
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
            className="field-sizing-fixed min-h-48 flex-1 resize-none border-0 bg-transparent px-4 py-5 text-[15px] leading-7 shadow-none focus-visible:ring-0 sm:px-5 md:text-[15px] dark:bg-transparent"
          />

          {state.message || isReconnectRequired ? (
            <div className="px-4 pb-3 sm:px-5">
              <div className="max-w-2xl text-xs leading-5 text-muted-foreground">
                {state.message ? (
                  <p
                    className={
                      ["error", "send_error", "reconnect_required"].includes(
                        state.status,
                      )
                        ? "text-destructive"
                        : "text-success"
                    }
                    role={
                      ["error", "send_error", "reconnect_required"].includes(
                        state.status,
                      )
                        ? "alert"
                        : "status"
                    }
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

          <div className="flex flex-wrap items-center justify-between gap-3 bg-muted/35 px-4 py-3 sm:px-5 dark:bg-muted/45">
            {state.status === "confirming_send" ? (
              <div
                role="alertdialog"
                aria-label="Confirm Gmail send"
                className="flex w-full flex-wrap items-center gap-2"
              >
                <p className="mr-auto text-xs text-muted-foreground">
                  Send now to {state.recipients}?
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => dispatch({ type: "cancel_send" })}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  className="bg-compose-accent text-compose-accent-foreground hover:bg-compose-accent/90"
                  onClick={() => void handleSend()}
                >
                  <HugeiconsIcon icon={MailSend02Icon} size={14} />
                  Send now
                </Button>
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  {!isSent ? (
                    <Button
                      type="submit"
                      variant="outline"
                      disabled={isLocked || isCurrentDraftSaved}
                      className="h-8 rounded-lg bg-transparent px-3.5 text-sm font-normal"
                    >
                      <HugeiconsIcon
                        icon={
                          isCurrentDraftSaved
                            ? CheckmarkCircle02Icon
                            : MailAdd01Icon
                        }
                        size={14}
                      />
                      {isSaving
                        ? "Saving to Gmail…"
                        : isCurrentDraftSaved
                          ? "Saved to Gmail drafts"
                          : state.providerDraft
                            ? "Update Gmail draft"
                            : "Save to Gmail drafts"}
                    </Button>
                  ) : null}
                  {state.providerDraft ? (
                    <Button
                      type="button"
                      disabled={!canRequestSend || isSending || isSent}
                      onClick={() => dispatch({ type: "confirm_send" })}
                      className="h-8 rounded-lg bg-compose-accent px-3.5 text-sm font-normal text-compose-accent-foreground hover:bg-compose-accent/90"
                    >
                      <HugeiconsIcon
                        icon={isSent ? CheckmarkCircle02Icon : MailSend02Icon}
                        size={14}
                      />
                      {isSending
                        ? "Sending with Gmail…"
                        : isSent
                          ? "Sent with Gmail"
                          : state.status === "send_error"
                            ? "Retry send"
                            : "Send"}
                    </Button>
                  ) : null}
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
              </>
            )}
          </div>
        </div>
      </form>
    </section>
  );
}
