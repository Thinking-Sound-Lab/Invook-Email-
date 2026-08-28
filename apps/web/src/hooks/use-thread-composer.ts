"use client";

import {
  parseGmailComposeRecipients,
  validateGmailComposeDraftFields,
  type AiReplyDraft,
} from "@invook/contracts";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";

import { useMailShell } from "@/components/mail/mail-shell-provider";
import {
  acceptThreadAiDraft,
  createThreadComposeSession,
  type ThreadComposeMessage,
  type ThreadComposeMode,
  type ThreadComposeSession,
} from "@/components/mail/thread-composer-state";
import { generateReplyDraft, updateReplyDraft } from "@/lib/api/drafts";
import {
  sendThreadComposeAttempt,
  type ThreadComposeSendAttempt,
} from "@/lib/api/thread-compose-send";
import { apiErrorMessage } from "@/lib/http-error";

export interface UseThreadComposerProps {
  threadId: string;
  accountId: string;
  accountEmail: string;
  message: ThreadComposeMessage | null;
  initialDraft: AiReplyDraft | null;
}

export interface UseThreadComposerResult {
  session: ThreadComposeSession | null;
  pending: "generate" | "feedback" | "send" | null;
  isLocked: boolean;
  isConnected: boolean;
  isSendUnresolved: boolean;
  error: string | null;
  notice: string | null;
  open: (mode: ThreadComposeMode, options?: { withAi?: boolean }) => boolean;
  edit: (
    field: "recipients" | "ccRecipients" | "bccRecipients" | "subject" | "body",
    value: string,
  ) => void;
  generateDraft: (instruction: string) => Promise<boolean>;
  saveAiEdits: () => Promise<void>;
  send: () => Promise<void>;
  discard: () => void;
}

export function useThreadComposer({
  threadId,
  accountId,
  accountEmail,
  message,
  initialDraft,
}: UseThreadComposerProps): UseThreadComposerResult {
  const { accounts } = useMailShell();
  const router = useRouter();
  const busyRef = useRef(false);
  const [session, setSession] = useState<ThreadComposeSession | null>(null);
  const [attempt, setAttempt] = useState<ThreadComposeSendAttempt | null>(null);
  const [pending, setPending] = useState<
    "generate" | "feedback" | "send" | null
  >(null);
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

  function handleOpen(
    mode: ThreadComposeMode,
    options: { withAi?: boolean } = {},
  ): boolean {
    if (!message || isLocked) return false;
    if (session?.mode !== mode) {
      if (
        session?.hasEdits &&
        !window.confirm("Discard your unsent message and switch actions?")
      )
        return false;
      setSession(
        createThreadComposeSession({
          mode,
          message,
          accountEmail,
          aiDraft: options.withAi ? initialDraft : null,
        }),
      );
    } else if (options.withAi && !session.body.trim() && initialDraft) {
      setSession(acceptThreadAiDraft(session, initialDraft));
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

  async function handleGenerateDraft(instruction: string): Promise<boolean> {
    if (!session || session.mode !== "reply" || busyRef.current || isLocked)
      return false;
    if (
      session.body.trim() &&
      !window.confirm("Replace this reply with an AI draft?")
    )
      return false;
    busyRef.current = true;
    setPending("generate");
    setError(null);
    setNotice(null);
    try {
      const draft = await generateReplyDraft({ threadId, instruction });
      setSession((current) =>
        current ? acceptThreadAiDraft(current, draft) : null,
      );
      setNotice(
        draft.usedMemoryIds.length
          ? `Drafted with ${draft.usedMemoryIds.length} relevant ${draft.usedMemoryIds.length === 1 ? "memory" : "memories"}.`
          : "Drafted from this conversation.",
      );
      router.refresh();
      return true;
    } catch (cause) {
      setError(apiErrorMessage(cause, "Invook could not draft this reply."));
      return false;
    } finally {
      busyRef.current = false;
      setPending(null);
    }
  }

  async function saveAiEdits(): Promise<void> {
    if (!session?.aiDraft || session.body === session.aiDraft.currentText)
      return;
    const draft = await updateReplyDraft({
      draftId: session.aiDraft.id,
      currentText: session.body,
    });
    setSession((current) =>
      current ? acceptThreadAiDraft(current, draft) : null,
    );
  }

  async function handleSaveAiEdits(): Promise<void> {
    if (busyRef.current || isLocked) return;
    busyRef.current = true;
    setPending("feedback");
    setError(null);
    try {
      await saveAiEdits();
      setNotice("Changes saved as draft feedback.");
      router.refresh();
    } catch (cause) {
      setError(
        apiErrorMessage(cause, "Invook could not save your draft changes."),
      );
    } finally {
      busyRef.current = false;
      setPending(null);
    }
  }

  async function handleSend(): Promise<void> {
    if (!session || busyRef.current || !isConnected) return;
    const validation = validateGmailComposeDraftFields({
      recipients: parseGmailComposeRecipients(session.recipients),
      ccRecipients: parseGmailComposeRecipients(session.ccRecipients),
      bccRecipients: parseGmailComposeRecipients(session.bccRecipients),
      subject: session.subject,
      body: session.body,
    });
    if (!validation.valid) {
      setError(validation.error.message);
      return;
    }
    busyRef.current = true;
    setPending("send");
    setError(null);
    setNotice(null);
    try {
      if (!attempt) await saveAiEdits();
      const nextAttempt: ThreadComposeSendAttempt = attempt ?? {
        phase: "save",
        request: {
          ...validation.fields,
          accountId,
          idempotencyKey: uuidv4(),
          ...(session.mode === "reply"
            ? { replyToMessageId: session.message.id }
            : {}),
        },
        sendIdempotencyKey: uuidv4(),
      };
      setAttempt(nextAttempt);
      await sendThreadComposeAttempt(nextAttempt, setAttempt);
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
    generateDraft: handleGenerateDraft,
    saveAiEdits: handleSaveAiEdits,
    send: handleSend,
    discard: handleDiscard,
  };
}
