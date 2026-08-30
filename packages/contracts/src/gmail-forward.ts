import { buildEmailPlainText } from "./mail-body";

export interface GmailForwardMessage {
  sender: { raw: string; email: string };
  headers: { name: string; value: string }[];
  subject: string;
  sentAt: string;
  bodyText: string;
  bodyHtml?: string | null;
}

export function buildGmailForwardedMessageText(
  message: GmailForwardMessage,
): string {
  const visibleHeaders = ["to", "cc"].flatMap((name) => {
    const value = message.headers.find(
      (header) => header.name.toLowerCase() === name,
    )?.value;
    return value ? [`${name === "to" ? "To" : "Cc"}: ${value}`] : [];
  });
  return [
    "---------- Forwarded message ----------",
    `From: ${message.sender.raw || message.sender.email}`,
    `Date: ${message.sentAt}`,
    `Subject: ${message.subject}`,
    ...visibleHeaders,
    "",
    message.bodyText ||
      (message.bodyHtml ? buildEmailPlainText(message.bodyHtml) : ""),
  ].join("\n");
}
