"use client";

import {
  parseGmailComposeRecipients,
  validateGmailComposeDraftFields,
  type GmailComposeDraftSource,
} from "@invook/contracts";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";

import { useMailShell } from "@/components/mail/mail-shell-provider";
import {
  createThreadComposeSession,
  type ThreadComposeMessage,
  type ThreadComposeMode,
  type ThreadComposeSession,
} from "@/components/mail/thread-composer-state";
import {
  sendGmailComposeAttempt,
  type GmailComposeSendAttempt,
} from "@/lib/api/gmail-compose-send";
import { apiErrorMessage } from "@/lib/http-error";

export interface UseThreadComposerProps {
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
  accountId,
  accountEmail,
  message,
}: UseThreadComposerProps): UseThreadComposerResult {
  const { accounts } = useMailShell();
  const router = useRouter();
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
      router.refresh();
    } catch (cause) {
      setError(
        apiErrorMessage(
          cause,
          "Invook could not confirm the send. Retry to safely resolve this attempt.",
        ),
      );
      router.refresh();
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
