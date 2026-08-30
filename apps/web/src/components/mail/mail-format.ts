import { decodeMailEntities, formatMailBody } from "@invook/contracts/mail-body";

function extractEmail(value: string): string {
  const angleAddress = value.match(/<([^>]+)>/);
  return (angleAddress?.[1] ?? value).trim().toLowerCase();
}

export function displayName(value: string): string {
  const namedAddress = value.match(/^\s*"?([^"<]+?)"?\s*</);
  if (namedAddress?.[1]) return namedAddress[1].trim();

  const email = extractEmail(value);
  return email.split("@")[0] || email;
}

export function threadPeople(participants: string[], accountEmail: string): string {
  const ownerEmail = accountEmail.toLowerCase();
  const people = participants
    .filter((participant) => extractEmail(participant) !== ownerEmail)
    .map(displayName)
    .filter((name, index, values) => values.indexOf(name) === index);

  if (people.length === 0) return "You";
  if (people.length <= 2) return people.join(", ");
  return `${people.slice(0, 2).join(", ")} +${people.length - 2}`;
}

function formatRecipient(value: string, accountEmail: string): string {
  const email = extractEmail(value);
  if (!email) return formatMailText(value);
  if (email === accountEmail.toLowerCase()) return `me (${email})`;

  const name = displayName(value);
  const hasNamedAddress = value.includes("<") && value.includes(">");
  return hasNamedAddress && name && name.toLowerCase() !== email
    ? `${name} (${email})`
    : email;
}

export function formatRecipientSummary(
  recipients: string[],
  accountEmail: string,
): string {
  const formattedRecipients = recipients
    .map((recipient) => formatRecipient(recipient, accountEmail))
    .filter(Boolean);
  if (formattedRecipients.length === 0) return "Recipients unavailable";
  if (formattedRecipients.length <= 2) return formattedRecipients.join(", ");
  return `${formattedRecipients.slice(0, 2).join(", ")} +${formattedRecipients.length - 2}`;
}

export function formatRecipientDetails(
  recipients: string[],
  accountEmail: string,
): string {
  const formattedRecipients = recipients
    .map((recipient) => formatRecipient(recipient, accountEmail))
    .filter(Boolean);
  return formattedRecipients.join(", ") || "Recipients unavailable";
}

export function initials(value: string): string {
  return value
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

export function formatMailText(value: string): string {
  return decodeMailEntities(value).replace(/\s+/g, " ").trim();
}

export interface MailBodyParts {
  visibleText: string;
  quotedText: string | null;
}

const QUOTED_TEXT_BOUNDARIES = [
  /(^|\n)-{2,}\s*Original Message\s*-{2,}\s*(?=\n|$)/i,
  /(^|\n)-{2,}\s*Forwarded message\s*-{2,}\s*(?=\n|$)/i,
  /(^|\n)Begin forwarded message:\s*(?=\n|$)/i,
] as const;

function findQuotedTextBoundary(value: string): number | null {
  const boundaryIndexes = QUOTED_TEXT_BOUNDARIES.flatMap((pattern) => {
    const match = pattern.exec(value);
    if (match?.index === undefined) return [];
    return [match.index + (match[1]?.length ?? 0)];
  });
  const replyHeader = /(^|\n)On [^\n]*(?:\n[^\n]*){0,2}\bwrote:\s*(?=\n|$)/i.exec(
    value,
  );
  if (replyHeader?.index !== undefined) {
    const replyHeaderIndex = replyHeader.index + (replyHeader[1]?.length ?? 0);
    const replyHeaderText = replyHeader[0];
    const replyBody = value.slice(replyHeaderIndex + replyHeaderText.length);
    if (
      /<[^>\n]+>|@/.test(replyHeaderText) ||
      /(^|\n)\s*>/.test(replyBody)
    ) {
      boundaryIndexes.push(replyHeaderIndex);
    }
  }

  const quotedLine = /(^|\n)\s*>/.exec(value);
  if (quotedLine?.index !== undefined) {
    boundaryIndexes.push(quotedLine.index + (quotedLine[1]?.length ?? 0));
  }

  return boundaryIndexes.length > 0 ? Math.min(...boundaryIndexes) : null;
}

export function splitMailBodyQuotedContent(value: string): MailBodyParts {
  const formattedBody = formatMailBody(value);
  const boundaryIndex = findQuotedTextBoundary(formattedBody);
  if (boundaryIndex === null) {
    return { visibleText: formattedBody, quotedText: null };
  }

  const visibleText = formattedBody.slice(0, boundaryIndex).trim();
  const quotedText = formattedBody.slice(boundaryIndex).trim();
  if (!visibleText || !quotedText) {
    return { visibleText: formattedBody, quotedText: null };
  }

  return { visibleText, quotedText };
}

interface FormatMailDateOptions {
  now?: Date;
  timeZone?: string;
}

export function formatMailDate(
  value: string | null,
  options: FormatMailDateOptions = {},
): string {
  if (!value) return "";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = options.now ?? new Date();
  const timeZoneOptions = options.timeZone
    ? { timeZone: options.timeZone }
    : {};
  const calendarDateFormatter = new Intl.DateTimeFormat("en", {
    ...timeZoneOptions,
    day: "numeric",
    month: "numeric",
    year: "numeric",
  });
  const yearFormatter = new Intl.DateTimeFormat("en", {
    ...timeZoneOptions,
    year: "numeric",
  });
  const sameDay =
    calendarDateFormatter.format(date) === calendarDateFormatter.format(now);

  if (sameDay) {
    return new Intl.DateTimeFormat("en", {
      ...timeZoneOptions,
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }

  if (yearFormatter.format(date) === yearFormatter.format(now)) {
    return new Intl.DateTimeFormat("en", {
      ...timeZoneOptions,
      month: "short",
      day: "numeric",
    }).format(date);
  }

  return new Intl.DateTimeFormat("en", {
    ...timeZoneOptions,
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}
