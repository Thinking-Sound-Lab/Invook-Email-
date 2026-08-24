import { validate as validateUuid } from "uuid";

export type MailboxAccountQuery = {
  account?: unknown;
};

export type ParsedMailboxAccountScope =
  | { valid: true; accountId: string | null }
  | { valid: false; accountId: null };

export function parseMailboxAccountScope(
  value: unknown,
): ParsedMailboxAccountScope {
  if (value === undefined || value === "" || value === "all") {
    return { valid: true, accountId: null };
  }
  return typeof value === "string" && validateUuid(value)
    ? { valid: true, accountId: value }
    : { valid: false, accountId: null };
}

export function parseRequiredMailboxAccountId(value: unknown): string | null {
  return typeof value === "string" && validateUuid(value) ? value : null;
}
