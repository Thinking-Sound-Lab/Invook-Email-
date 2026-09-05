/**
 * Normalizes a provider message into the stored projection: raw MIME and
 * attachments to object storage, addresses and body text to PostgreSQL.
 */
import {
  toPostgresTextProjection,
  upsertMailboxMessage,
  type IndexedMessage,
} from "@invook/database";
import {
  extractEmailAddress,
  gmailSystemLabels,
  getGmailAttachment,
  normalizeGmailFullMessage,
  type ParsedGmailMessage,
} from "@invook/gmail";

import { objectStorage } from "../configuration";

export function normalizedEmails(values: string[], ownerEmail: string): string[] {
  return Array.from(
    new Set(
      values
        .map(extractEmailAddress)
        .filter((email) => email.includes("@") && email !== ownerEmail.toLowerCase()),
    ),
  );
}

export async function prepareMessage(options: {
  userId: string;
  accountId: string;
  accountEmail: string;
  message: ParsedGmailMessage;
  ingestionMode: "initial" | "incremental";
  isLiveDelivery?: boolean;
}): Promise<IndexedMessage> {
  const { userId, accountId, accountEmail, message, ingestionMode } = options;
  const direction =
    message.labelIds.includes("SENT") ||
    extractEmailAddress(message.from) === accountEmail.toLowerCase()
      ? "outgoing"
      : "incoming";
  const sentAt = options.message.sentAt
    ? new Date(options.message.sentAt)
    : null;
  const internalDate = sentAt;
  if (
    !internalDate ||
    !sentAt ||
    !Number.isFinite(internalDate.getTime()) ||
    !Number.isFinite(sentAt.getTime())
  ) {
    throw new Error(
      `Gmail message ${message.providerMessageId} has no usable internal or sent date.`,
    );
  }

  const attachments = await Promise.all(
    message.attachments.map(async (attachment) => {
      const attachmentObject = await objectStorage.putObject({
        key: `${accountId}/messages/${message.providerMessageId}/attachments/${attachment.index}-${attachment.checksumSha256}`,
        body: attachment.content,
        contentType: attachment.mimeType,
      });
      return {
        providerAttachmentId: attachment.providerAttachmentId,
        mimePartPath: attachment.mimePartPath
          ? toPostgresTextProjection(attachment.mimePartPath)
          : null,
        filename: toPostgresTextProjection(attachment.filename ?? ""),
        mimeType: attachment.mimeType
          ? toPostgresTextProjection(attachment.mimeType)
          : null,
        contentId: attachment.contentId
          ? toPostgresTextProjection(attachment.contentId)
          : null,
        contentDisposition: attachment.contentDisposition
          ? toPostgresTextProjection(attachment.contentDisposition)
          : null,
        size: attachment.size,
        objectKey: attachmentObject.key,
        checksumSha256: attachmentObject.checksumSha256,
        contentLength: attachmentObject.contentLength,
        etag: attachmentObject.etag,
      };
    }),
  );
  return {
    userId,
    accountId,
    providerThreadId: message.providerThreadId,
    providerMessageId: message.providerMessageId,
    subject: toPostgresTextProjection(message.subject),
    snippet: toPostgresTextProjection(message.snippet),
    participants: [message.from, ...message.to, ...message.cc]
      .filter(Boolean)
      .map(toPostgresTextProjection),
    gmailLabels: gmailSystemLabels(message.labelIds),
    providerHistoryId: message.historyId,
    internalDate,
    sizeEstimate: message.sizeEstimate,
    headerLines: message.headers.map((header) => ({
      key: toPostgresTextProjection(header.name),
      line: toPostgresTextProjection(header.raw),
    })),
    sentAt,
    direction,
    sender: {
      raw: toPostgresTextProjection(message.from),
      email: toPostgresTextProjection(extractEmailAddress(message.from)),
    },
    recipients: [...message.to, ...message.cc].map(toPostgresTextProjection),
    bodyText: toPostgresTextProjection(message.bodyText ?? ""),
    bodyHtml: message.bodyHtml
      ? toPostgresTextProjection(message.bodyHtml)
      : null,
    ingestionMode,
    isLiveDelivery: options.isLiveDelivery,
    attachments,
  };
}

export async function normalizeFullMessage(
  accessToken: string,
  message: Parameters<typeof normalizeGmailFullMessage>[0],
): Promise<ParsedGmailMessage> {
  return normalizeGmailFullMessage(message, ({ messageId, attachmentId }) =>
    getGmailAttachment(accessToken, messageId, attachmentId),
  );
}

export async function storeMessage(
  options: Parameters<typeof prepareMessage>[0] & {
    activeRunId?: string;
  },
) {
  const { activeRunId, ...messageOptions } = options;
  const message = await prepareMessage(messageOptions);
  return upsertMailboxMessage(message, undefined, activeRunId);
}
