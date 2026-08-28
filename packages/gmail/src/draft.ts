type HeaderLine = { key: string; line: string };

function safeHeaderValue(value: string): string {
  return value
    .replace(/\r?\n[\t ]+/g, " ")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim();
}

function headerValue(headers: HeaderLine[], name: string): string | null {
  const header = headers.find(
    (candidate) => candidate.key.toLowerCase() === name,
  );
  if (!header) return null;
  const separator = header.line.indexOf(":");
  const value = separator >= 0 ? header.line.slice(separator + 1) : header.line;
  return safeHeaderValue(value) || null;
}

function replySubject(subject: string): string {
  const value = safeHeaderValue(subject);
  return /^re\s*:/i.test(value) ? value : `Re: ${value}`;
}

function normalizeBody(value: string): string {
  return value.replace(/\r\n|\r|\n/g, "\r\n");
}

function subjectHeaderValue(value: string): string {
  const subject = safeHeaderValue(value);
  return /^[\u0020-\u007e]*$/.test(subject)
    ? subject
    : `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
}

function replyHeaders(headerLines: HeaderLine[]): string[] {
  const messageId = headerValue(headerLines, "message-id");
  const previousReferences = headerValue(headerLines, "references");
  const references = previousReferences
    ? messageId && !previousReferences.split(/\s+/).includes(messageId)
      ? `${previousReferences} ${messageId}`
      : previousReferences
    : messageId;
  return [
    ...(messageId ? [`In-Reply-To: ${messageId}`] : []),
    ...(references ? [`References: ${references}`] : []),
  ];
}

export function composePlainTextGmailMessage(input: {
  accountEmail: string;
  recipients: string[];
  ccRecipients?: string[];
  bccRecipients?: string[];
  subject: string;
  body: string;
  messageId: string;
  replyTarget?: { headerLines: HeaderLine[] };
}): Buffer | null {
  const sender = safeHeaderValue(input.accountEmail);
  const recipients = input.recipients
    .map((recipient) => safeHeaderValue(recipient))
    .filter(Boolean);
  const rawMessageId = safeHeaderValue(input.messageId).replace(/^<|>$/g, "");
  if (!sender || recipients.length === 0 || !rawMessageId) return null;

  const headers = [
    `From: ${sender}`,
    `To: ${recipients.join(", ")}`,
    ...(["ccRecipients", "bccRecipients"] as const).flatMap((field) => {
      const addresses = input[field]?.map(safeHeaderValue).filter(Boolean);
      return addresses?.length
        ? [
            `${field === "ccRecipients" ? "Cc" : "Bcc"}: ${addresses.join(", ")}`,
          ]
        : [];
    }),
    `Subject: ${subjectHeaderValue(input.replyTarget ? replySubject(input.subject) : input.subject)}`,
    `Message-ID: <${rawMessageId}>`,
    ...(input.replyTarget ? replyHeaders(input.replyTarget.headerLines) : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
  ];
  return Buffer.from(
    `${headers.join("\r\n")}\r\n\r\n${normalizeBody(input.body)}`,
    "utf8",
  );
}

export function composePlainTextGmailReply(input: {
  accountEmail: string;
  subject: string;
  currentText: string;
  messageId?: string;
  replyTarget: {
    sender: { raw: string; email: string };
    headerLines: HeaderLine[];
  };
}): Buffer | null {
  const replyTo = headerValue(input.replyTarget.headerLines, "reply-to");
  const recipient = safeHeaderValue(
    replyTo || input.replyTarget.sender.raw || input.replyTarget.sender.email,
  );
  const sender = safeHeaderValue(input.accountEmail);
  if (!recipient || !sender) return null;

  const headers = [
    `From: ${sender}`,
    `To: ${recipient}`,
    `Subject: ${subjectHeaderValue(replySubject(input.subject))}`,
    ...(input.messageId
      ? [
          `Message-ID: <${safeHeaderValue(input.messageId).replace(/^<|>$/g, "")}>`,
        ]
      : []),
    ...replyHeaders(input.replyTarget.headerLines),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
  ];
  return Buffer.from(
    `${headers.join("\r\n")}\r\n\r\n${normalizeBody(input.currentText)}`,
    "utf8",
  );
}
