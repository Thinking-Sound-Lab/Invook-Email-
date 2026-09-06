"use client";

import {
  parseGmailComposeRecipients,
  validateGmailComposeDraftFields,
  type GmailComposeDraftSource,
} from "@invook/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";

import { useMailShell } from "@/components/mail/mail-shell-provider";
import {
  createThreadComposeSession,
  type ThreadComposeMessage,
  type ThreadComposeMode,
  type ThreadComposeSession,
} from "@/components/mail/thread-composer-state";
import { getMailboxThreadDetail } from "@/lib/api/mailbox-threads";
import { useMailboxStore } from "@/stores/mailbox/store";
import {
  sendGmailComposeAttempt,
  type GmailComposeSendAttempt,
} from "@/lib/api/gmail-compose-send";
import { apiErrorMessage } from "@/lib/http-error";

export interface UseThreadComposerProps {
  threadId: string;
  accountId: string;
  accountEmail: string;
  message: ThreadComposeMessage | null;
}

export interface UseThreadComposerResult {
  session: ThreadComposeSession | null;
  pending: "send" | null;
  isLocked: boolean;
  isConnected: boolean;
  isSendUnresolved: boolean;
  error: string | null;
  notice: string | null;
  open: (mode: ThreadComposeMode) => boolean;
  edit: (
    field: "recipients" | "ccRecipients" | "bccRecipients" | "subject" | "body",
    value: string,
  ) => void;
  send: () => Promise<void>;
  discard: () => void;
}

export function useThreadComposer({
  threadId,
  accountId,
  accountEmail,
  message,
}: UseThreadComposerProps): UseThreadComposerResult {
  const { accounts } = useMailShell();
  const hydrateThreadDetail = useMailboxStore(
    (state) => state.hydrateThreadDetail,
  );
  const busyRef = useRef(false);
  const [session, setSession] = useState<ThreadComposeSession | null>(null);
  const [attempt, setAttempt] = useState<GmailComposeSendAttempt | null>(null);
  const [pending, setPending] = useState<"send" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const isConnected = accounts.some(
    (account) => account.id === accountId && account.status === "connected",
  );
  const isLocked = pending !== null || attempt !== null;

  // Composing writes to the thread the reader is showing, so the cached thread
  // is re-read directly instead of re-rendering the whole route.
  const reloadThreadDetail = useCallback(async (): Promise<void> => {
    try {
      const detail = await getMailboxThreadDetail({
        accountSelection: accountId,
        threadId,
      });
      hydrateThreadDetail({ threadId, detail });
    } catch {
      // The mailbox change event that follows this write reconciles the thread.
    }
  }, [accountId, hydrateThreadDetail, threadId]);

  useEffect(() => {
    if (!session?.hasEdits && !attempt) return;
    function handleBeforeUnload(event: BeforeUnloadEvent): void {
      event.preventDefault();
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [session?.hasEdits, attempt]);

  function handleOpen(mode: ThreadComposeMode): boolean {
    if (!message || isLocked) return false;
    if (session?.mode !== mode) {
      if (
        session?.hasEdits &&
        !window.confirm("Discard your unsent message and switch actions?")
      )
        return false;
      setSession(
        createThreadComposeSession({ mode, message, accountEmail }),
      );
    }
    setError(null);
    setNotice(null);
    return true;
  }

  function handleEdit(
    field: "recipients" | "ccRecipients" | "bccRecipients" | "subject" | "body",
    value: string,
  ): void {
    if (isLocked) return;
    setSession((current) =>
      current ? { ...current, [field]: value, hasEdits: true } : null,
    );
    setError(null);
    setNotice(null);
  }

  async function handleSend(): Promise<void> {
    if (!session || busyRef.current || !isConnected) return;
    const source: GmailComposeDraftSource =
      session.mode === "reply"
        ? { replyToMessageId: session.message.id }
        : { forwardOfMessageId: session.message.id };
    const validation = validateGmailComposeDraftFields(
      {
        recipients: parseGmailComposeRecipients(session.recipients),
        ccRecipients: parseGmailComposeRecipients(session.ccRecipients),
        bccRecipients: parseGmailComposeRecipients(session.bccRecipients),
        subject: session.subject,
        body: session.body,
      },
      source,
    );
    if (!validation.valid) {
      setError(validation.error.message);
      return;
    }
    busyRef.current = true;
    setPending("send");
    setError(null);
    setNotice(null);
    try {
      const nextAttempt: GmailComposeSendAttempt = attempt ?? {
        phase: "save",
        request: {
          ...validation.fields,
          accountId,
          idempotencyKey: uuidv4(),
          ...source,
        },
        sendIdempotencyKey: uuidv4(),
      };
      setAttempt(nextAttempt);
      await sendGmailComposeAttempt(nextAttempt, setAttempt);
      setAttempt(null);
      setSession(null);
      setNotice("Sent with Gmail.");
      await reloadThreadDetail();
    } catch (cause) {
      setError(
        apiErrorMessage(
          cause,
          "Invook could not confirm the send. Retry to safely resolve this attempt.",
        ),
      );
      await reloadThreadDetail();
    } finally {
      busyRef.current = false;
      setPending(null);
    }
  }

  function handleDiscard(): void {
    if (
      isLocked ||
      (session?.hasEdits && !window.confirm("Discard this unsent message?"))
    )
      return;
    setSession(null);
    setError(null);
    setNotice(null);
  }

  return {
    session,
    pending,
    isLocked,
    isConnected,
    isSendUnresolved: attempt !== null,
    error,
    notice,
    open: handleOpen,
    edit: handleEdit,
    send: handleSend,
    discard: handleDiscard,
  };
}
