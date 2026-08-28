import type { AiReplyDraft, MailboxThreadMessage } from "@invook/contracts";

export type ThreadComposeMode = "reply" | "forward";

export type ThreadComposeMessage = Pick<
  MailboxThreadMessage,
  | "id"
  | "direction"
  | "sender"
  | "recipients"
  | "headers"
  | "subject"
  | "bodyText"
  | "sentAt"
> & { attachmentCount: number };

export interface ThreadComposeSession {
  mode: ThreadComposeMode;
  message: ThreadComposeMessage;
  recipients: string;
  ccRecipients: string;
  bccRecipients: string;
  subject: string;
  body: string;
  aiDraft: AiReplyDraft | null;
  hasEdits: boolean;
}

function header(
  message: ThreadComposeMessage,
  name: string,
): string | undefined {
  return message.headers.find(
    (candidate) => candidate.name.toLowerCase() === name,
  )?.value;
}

function addresses(value: string): string[] {
  // Commas inside quoted display names are not address separators.
  return value
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((address) => (address.match(/<([^>]+)>/)?.[1] ?? address).trim())
    .filter(Boolean);
}

export function createThreadComposeSession(input: {
  mode: ThreadComposeMode;
  message: ThreadComposeMessage;
  accountEmail: string;
  aiDraft?: AiReplyDraft | null;
}): ThreadComposeSession {
  const { mode, message } = input;
  const isReply = mode === "reply";
  const replyTo = header(message, "reply-to");
  const hiddenRecipientEmails = new Set(addresses(header(message, "bcc") ?? "").map((email) => email.toLowerCase()));
  const recipients =
    message.direction === "incoming"
      ? addresses(replyTo ?? (message.sender.email || message.sender.raw))
      : addresses(
          header(message, "to") ?? message.recipients.join(", "),
        ).filter(
          (email) => email.toLowerCase() !== input.accountEmail.toLowerCase() && !hiddenRecipientEmails.has(email.toLowerCase()),
        );
  const prefix = isReply ? "Re" : "Fwd";
  const hasPrefix = isReply
    ? /^re\s*:/i.test(message.subject)
    : /^(?:fwd?|fw)\s*:/i.test(message.subject);
  const aiDraft = isReply ? (input.aiDraft ?? null) : null;
  return {
    mode,
    message,
    recipients: isReply ? [...new Set(recipients)].join(", ") : "",
    ccRecipients: "",
    bccRecipients: "",
    subject: hasPrefix ? message.subject : `${prefix}: ${message.subject}`,
    body: isReply
      ? (aiDraft?.currentText ?? "")
      : [
          "",
          "",
          "---------- Forwarded message ----------",
          `From: ${message.sender.raw || message.sender.email}`,
          `Date: ${message.sentAt}`,
          `Subject: ${message.subject}`,
        ...(header(message, "to") ? [`To: ${header(message, "to")}`] : []),
        ...(header(message, "cc") ? [`Cc: ${header(message, "cc")}`] : []),
          "",
          message.bodyText,
        ].join("\n"),
    aiDraft,
    hasEdits: false,
  };
}

export function acceptThreadAiDraft(
  session: ThreadComposeSession,
  draft: AiReplyDraft,
): ThreadComposeSession {
  return {
    ...session,
    body: draft.currentText,
    aiDraft: draft,
    hasEdits: true,
  };
}
