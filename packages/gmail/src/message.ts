import { createHash } from "node:crypto";

import {
  simpleParser,
  type AddressObject,
  type EmailAddress,
  type HeaderLines,
  type Headers,
  type HeaderValue,
} from "mailparser";

import type {
  GmailFullMessage,
  GmailMessagePart,
  GmailMessagePartBody,
  GmailRawMessage,
} from "./client";
import {
  filterGmailSystemLabelIds,
  type GmailSystemLabelId,
} from "./system-labels";

export type ParsedGmailHeader = {
  /** Lowercase field name as interpreted by the MIME parser. */
  name: string;
  /** The complete unfolded field value, including encoded words where present. */
  value: string;
  /** The complete header line supplied by the MIME parser. */
  raw: string;
};

export type ParsedGmailAttachment = {
  index: number;
  providerAttachmentId: string | null;
  mimePartPath: string | null;
  filename: string | null;
  mimeType: string;
  contentDisposition: string | null;
  contentId: string | null;
  cid: string | null;
  related: boolean;
  size: number;
  checksumSha256: string;
  headers: ParsedGmailHeader[];
  content: Buffer;
};

export type ParsedGmailMessage = {
  providerMessageId: string;
  providerThreadId: string;
  historyId: string | null;
  internalDate: string | null;
  sizeEstimate: number | null;
  labelIds: GmailSystemLabelId[];
  snippet: string;
  headers: ParsedGmailHeader[];
  subject: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  bodyText: string | null;
  bodyHtml: string | null;
  sentAt: string | null;
  attachments: ParsedGmailAttachment[];
};

export type GmailAttachmentLoader = (input: {
  messageId: string;
  attachmentId: string;
}) => Promise<GmailMessagePartBody>;

export const GMAIL_MESSAGE_FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1_000;

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function headerValueText(value: HeaderValue): string {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(headerValueText).join(", ");
  if ("text" in value) return value.text;
  return [
    value.value,
    ...Object.entries(value.params).map(([key, parameter]) => `${key}=${parameter}`),
  ].join("; ");
}

function parseHeaders(
  lines: HeaderLines | undefined,
  fallback?: Headers,
): ParsedGmailHeader[] {
  if (!lines) {
    return [...(fallback ?? new Map())].map(([name, value]) => {
      const text = headerValueText(value);
      return { name, value: text, raw: `${name}: ${text}` };
    });
  }
  return lines.map(({ key, line }) => {
    const separator = line.indexOf(":");
    return {
      name: key.toLowerCase(),
      value: separator >= 0 ? line.slice(separator + 1).trimStart() : "",
      raw: line,
    };
  });
}

function addressText(value: EmailAddress): string[] {
  if (value.group) return value.group.flatMap(addressText);
  if (value.address && value.name) return [`${value.name} <${value.address}>`];
  if (value.address) return [value.address];
  return value.name ? [value.name] : [];
}

function addresses(value: AddressObject | AddressObject[] | undefined): string[] {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]).flatMap((entry) =>
    entry.value.flatMap(addressText),
  );
}

function firstAddress(value: AddressObject | undefined): string {
  return value?.text ?? "";
}

function validIsoDate(
  value: Date | number | undefined,
  latestAllowedAt: number,
): string | null {
  if (value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  const timestamp = date.getTime();
  return Number.isFinite(timestamp) && timestamp <= latestAllowedAt
    ? date.toISOString()
    : null;
}

function receivedHeaderDate(
  headers: ParsedGmailHeader[],
  latestAllowedAt: number,
): string | null {
  const receivedHeaders = headers.filter(
    (header) => header.name === "received" || header.name === "x-received",
  );
  for (const header of receivedHeaders) {
    const separator = header.raw.lastIndexOf(";");
    if (separator < 0) continue;
    const receivedAt = validIsoDate(
      new Date(header.raw.slice(separator + 1).trim()),
      latestAllowedAt,
    );
    if (receivedAt) return receivedAt;
  }
  return null;
}

export function resolveGmailMessageDate(input: {
  internalDate?: string | null;
  headerDate?: Date;
  headers: ParsedGmailHeader[];
  now?: Date;
}): string | null {
  const now = input.now ?? new Date();
  const nowTimestamp = now.getTime();
  if (!Number.isFinite(nowTimestamp)) {
    throw new Error("The Gmail message date reference is invalid.");
  }
  const latestAllowedAt = nowTimestamp + GMAIL_MESSAGE_FUTURE_TOLERANCE_MS;
  const internalDate = input.internalDate;
  if (internalDate && /^\d+$/.test(internalDate)) {
    const date = validIsoDate(Number(internalDate), latestAllowedAt);
    if (date) return date;
  }
  return (
    receivedHeaderDate(input.headers, latestAllowedAt) ??
    validIsoDate(input.headerDate, latestAllowedAt)
  );
}

function referenceList(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

export function extractEmailAddress(value: string): string {
  const angleAddress = value.match(/<([^>]+)>/);
  return (angleAddress?.[1] ?? value).trim().toLowerCase();
}

/**
 * Decodes Gmail's raw base64url message and parses the complete RFC 2822/MIME
 * object. No quoted reply, signature, header, HTML, or attachment data is
 * deliberately removed.
 */
export async function parseGmailMessage(
  message: GmailRawMessage,
): Promise<ParsedGmailMessage> {
  if (!message.raw) {
    throw new Error(`Gmail message ${message.id} did not include raw MIME data.`);
  }

  const raw = Buffer.from(message.raw, "base64url");
  const parsed = await simpleParser(raw, {
    keepCidLinks: true,
    skipHtmlToText: true,
    skipTextToHtml: true,
  });
  const headers = parseHeaders(parsed.headerLines);

  return {
    providerMessageId: message.id,
    providerThreadId: message.threadId,
    historyId: message.historyId ?? null,
    internalDate: message.internalDate ?? null,
    sizeEstimate:
      typeof message.sizeEstimate === "number" ? message.sizeEstimate : null,
    labelIds: filterGmailSystemLabelIds(message.labelIds),
    snippet: message.snippet ?? "",
    headers,
    subject: parsed.subject ?? "",
    from: firstAddress(parsed.from),
    to: addresses(parsed.to),
    cc: addresses(parsed.cc),
    bcc: addresses(parsed.bcc),
    replyTo: parsed.replyTo?.text ?? null,
    messageId: parsed.messageId ?? null,
    inReplyTo: parsed.inReplyTo ?? null,
    references: referenceList(parsed.references),
    bodyText: parsed.text ?? null,
    bodyHtml: typeof parsed.html === "string" ? parsed.html : null,
    sentAt: resolveGmailMessageDate({
      internalDate: message.internalDate,
      headerDate: parsed.date,
      headers,
    }),
    attachments: parsed.attachments.map((attachment, index) => {
      const mimePart = attachment as typeof attachment & { partId?: string };
      return {
        index,
        providerAttachmentId: null,
        mimePartPath: mimePart.partId ?? null,
        filename: attachment.filename ?? null,
        mimeType: attachment.contentType,
        contentDisposition: attachment.contentDisposition || null,
        contentId: attachment.contentId ?? null,
        cid: attachment.cid ?? null,
        related: attachment.related === true,
        size: attachment.size,
        checksumSha256: sha256(attachment.content),
        headers: parseHeaders(attachment.headerLines, attachment.headers),
        content: attachment.content,
      };
    }),
  };
}

function gmailPartHeaders(part: GmailMessagePart): ParsedGmailHeader[] {
  if (part.headers !== undefined && !Array.isArray(part.headers)) {
    throw new Error("Gmail full message part headers are invalid.");
  }
  const headers = part.headers ?? [];
  return headers.map((header) => {
    if (
      typeof header !== "object" ||
      header === null ||
      typeof header.name !== "string" ||
      typeof header.value !== "string"
    ) {
      throw new Error("Gmail full message part header values are invalid.");
    }
    return {
      name: header.name.toLowerCase(),
      value: header.value,
      raw: `${header.name}: ${header.value}`,
    };
  });
}

function gmailHeaderValue(
  headers: ParsedGmailHeader[],
  name: string,
): string | undefined {
  return headers.find((header) => header.name === name)?.value;
}

function gmailBodyData(body: GmailMessagePartBody | undefined): Buffer | null {
  if (body === undefined) return null;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("Gmail full message part body is invalid.");
  }
  if (
    (body.attachmentId !== undefined &&
      (typeof body.attachmentId !== "string" || !body.attachmentId.trim())) ||
    (body.size !== undefined &&
      (typeof body.size !== "number" ||
        !Number.isFinite(body.size) ||
        body.size < 0))
  ) {
    throw new Error("Gmail full message part body metadata is invalid.");
  }
  if (body.data === undefined) return null;
  if (typeof body.data !== "string") {
    throw new Error("Gmail full message part data is invalid.");
  }
  return Buffer.from(body.data, "base64url");
}

function contentDisposition(headers: ParsedGmailHeader[]): string | null {
  const value = gmailHeaderValue(headers, "content-disposition");
  return value?.split(";", 1)[0]?.trim().toLowerCase() || null;
}

function contentId(headers: ParsedGmailHeader[]): string | null {
  return gmailHeaderValue(headers, "content-id") ?? null;
}

async function loadGmailPartBody(input: {
  messageId: string;
  body: GmailMessagePartBody | undefined;
  loadAttachment: GmailAttachmentLoader;
}): Promise<Buffer> {
  const inline = gmailBodyData(input.body);
  if (inline) return inline;
  const attachmentId = input.body?.attachmentId;
  if (!attachmentId) return Buffer.alloc(0);
  const external = await input.loadAttachment({
    messageId: input.messageId,
    attachmentId,
  });
  const content = gmailBodyData(external);
  if (!content) {
    throw new Error(
      `Gmail attachment ${attachmentId} for message ${input.messageId} has no data.`,
    );
  }
  return content;
}

type NormalizedGmailParts = {
  textBodies: string[];
  htmlBodies: string[];
  attachments: ParsedGmailAttachment[];
};

async function normalizeGmailParts(input: {
  messageId: string;
  part: GmailMessagePart;
  loadAttachment: GmailAttachmentLoader;
  output: NormalizedGmailParts;
}): Promise<void> {
  if (
    typeof input.part !== "object" ||
    input.part === null ||
    Array.isArray(input.part) ||
    (input.part.mimeType !== undefined &&
      typeof input.part.mimeType !== "string") ||
    (input.part.filename !== undefined &&
      typeof input.part.filename !== "string")
  ) {
    throw new Error("Gmail full message part is invalid.");
  }
  const mimeType = input.part.mimeType?.toLowerCase() || "application/octet-stream";
  if (mimeType.startsWith("multipart/")) {
    if (input.part.parts !== undefined && !Array.isArray(input.part.parts)) {
      throw new Error("Gmail multipart children are invalid.");
    }
    for (const child of input.part.parts ?? []) {
      await normalizeGmailParts({ ...input, part: child });
    }
    return;
  }

  const headers = gmailPartHeaders(input.part);
  const disposition = contentDisposition(headers);
  const partContentId = contentId(headers);
  const filename = input.part.filename?.trim() || null;
  const isAttachment = Boolean(
    filename ||
      disposition === "attachment" ||
      partContentId ||
      (!mimeType.startsWith("text/") &&
        (input.part.body?.attachmentId || input.part.body?.data)),
  );
  const content = await loadGmailPartBody({
    messageId: input.messageId,
    body: input.part.body,
    loadAttachment: input.loadAttachment,
  });

  if (!isAttachment && mimeType === "text/plain") {
    input.output.textBodies.push(content.toString("utf8"));
    return;
  }
  if (!isAttachment && mimeType === "text/html") {
    input.output.htmlBodies.push(content.toString("utf8"));
    return;
  }
  if (content.length === 0 && !input.part.body?.attachmentId) return;

  const attachmentId = input.part.body?.attachmentId ?? null;
  input.output.attachments.push({
    index: input.output.attachments.length,
    providerAttachmentId: attachmentId,
    mimePartPath: input.part.partId ?? null,
    filename,
    mimeType,
    contentDisposition: disposition,
    contentId: partContentId,
    cid: partContentId?.replace(/^<|>$/g, "") ?? null,
    related: disposition === "inline" || Boolean(partContentId),
    size:
      typeof input.part.body?.size === "number"
        ? input.part.body.size
        : content.byteLength,
    checksumSha256: sha256(content),
    headers,
    content,
  });
}

/** Maps Gmail's already-parsed format=full JSON into Invook's message contract. */
export async function normalizeGmailFullMessage(
  message: GmailFullMessage,
  loadAttachment: GmailAttachmentLoader,
): Promise<ParsedGmailMessage> {
  if (
    typeof message !== "object" ||
    message === null ||
    typeof message.id !== "string" ||
    !message.id.trim() ||
    typeof message.threadId !== "string" ||
    !message.threadId.trim() ||
    typeof message.payload !== "object" ||
    message.payload === null ||
    Array.isArray(message.payload)
  ) {
    throw new Error("Gmail full message identity or payload is missing.");
  }
  if (
    (message.labelIds !== undefined &&
      (!Array.isArray(message.labelIds) ||
        message.labelIds.some((labelId) => typeof labelId !== "string"))) ||
    (message.historyId !== undefined && typeof message.historyId !== "string") ||
    (message.internalDate !== undefined &&
      typeof message.internalDate !== "string") ||
    (message.snippet !== undefined && typeof message.snippet !== "string") ||
    (message.sizeEstimate !== undefined &&
      (typeof message.sizeEstimate !== "number" ||
        !Number.isFinite(message.sizeEstimate) ||
        message.sizeEstimate < 0))
  ) {
    throw new Error("Gmail full message metadata is invalid.");
  }
  const headers = gmailPartHeaders(message.payload);
  const headerSource = Buffer.from(
    `${headers.map((header) => header.raw).join("\r\n")}\r\n\r\n`,
    "utf8",
  );
  const parsedHeaders = await simpleParser(headerSource, {
    skipHtmlToText: true,
    skipTextToHtml: true,
  });
  const normalizedParts: NormalizedGmailParts = {
    textBodies: [],
    htmlBodies: [],
    attachments: [],
  };
  await normalizeGmailParts({
    messageId: message.id,
    part: message.payload,
    loadAttachment,
    output: normalizedParts,
  });

  return {
    providerMessageId: message.id,
    providerThreadId: message.threadId,
    historyId: message.historyId ?? null,
    internalDate: message.internalDate ?? null,
    sizeEstimate:
      typeof message.sizeEstimate === "number" ? message.sizeEstimate : null,
    labelIds: filterGmailSystemLabelIds(message.labelIds),
    snippet: message.snippet ?? "",
    headers,
    subject: parsedHeaders.subject ?? gmailHeaderValue(headers, "subject") ?? "",
    from: firstAddress(parsedHeaders.from) || gmailHeaderValue(headers, "from") || "",
    to: addresses(parsedHeaders.to),
    cc: addresses(parsedHeaders.cc),
    bcc: addresses(parsedHeaders.bcc),
    replyTo: parsedHeaders.replyTo?.text ?? gmailHeaderValue(headers, "reply-to") ?? null,
    messageId: parsedHeaders.messageId ?? gmailHeaderValue(headers, "message-id") ?? null,
    inReplyTo: parsedHeaders.inReplyTo ?? gmailHeaderValue(headers, "in-reply-to") ?? null,
    references: referenceList(parsedHeaders.references),
    bodyText:
      normalizedParts.textBodies.length > 0
        ? normalizedParts.textBodies.join("\n")
        : null,
    bodyHtml:
      normalizedParts.htmlBodies.length > 0
        ? normalizedParts.htmlBodies.join("\n")
        : null,
    sentAt: resolveGmailMessageDate({
      internalDate: message.internalDate,
      headerDate: parsedHeaders.date,
      headers,
    }),
    attachments: normalizedParts.attachments,
  };
}

export function isMemoryEligible(message: ParsedGmailMessage): boolean {
  const normalizedSubject = message.subject.toLowerCase();
  const wordCount = (message.bodyText ?? "").split(/\s+/).filter(Boolean).length;

  return (
    message.labelIds.includes("SENT") &&
    wordCount >= 5 &&
    !normalizedSubject.startsWith("automatic reply") &&
    !normalizedSubject.startsWith("out of office")
  );
}
