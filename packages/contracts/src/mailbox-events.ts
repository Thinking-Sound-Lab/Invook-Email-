import type {
  MailboxChangeEvent,
  MailboxStreamReadyEvent,
} from "./index";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string" && isUuid(entry))
  );
}

function hasEventBase(
  value: Record<string, unknown>,
): value is Record<string, unknown> & {
  accountId: string;
  createdAt: string;
  changeType: string;
} {
  return (
    typeof value.accountId === "string" &&
    isUuid(value.accountId) &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    typeof value.changeType === "string"
  );
}

export function parseMailboxChangeEvent(
  serializedEvent: string,
): MailboxChangeEvent | null {
  try {
    const value: unknown = JSON.parse(serializedEvent);
    if (!isRecord(value) || !hasEventBase(value)) return null;
    const base = {
      accountId: value.accountId,
      createdAt: value.createdAt,
    };
    switch (value.changeType) {
      case "replica_ready":
        return { ...base, changeType: value.changeType };
      case "history_applied":
        if (
          (value.reason !== "history_catchup" &&
            value.reason !== "message_refresh") ||
          !isStringArray(value.changedThreadIds) ||
          !isStringArray(value.refreshedThreadIds)
        ) {
          return null;
        }
        return {
          ...base,
          changeType: value.changeType,
          reason: value.reason,
          changedThreadIds: value.changedThreadIds,
          refreshedThreadIds: value.refreshedThreadIds,
        };
      case "drafts_changed":
        if (
          (value.kind !== "snapshot" &&
            value.kind !== "upsert" &&
            value.kind !== "delete") ||
          !isStringArray(value.affectedThreadIds)
        ) {
          return null;
        }
        return {
          ...base,
          changeType: value.changeType,
          kind: value.kind,
          affectedThreadIds: value.affectedThreadIds,
        };
      case "labels_changed":
        if (
          (value.kind !== "analysis_resolution" &&
            value.kind !== "decision") ||
          !isStringArray(value.affectedThreadIds)
        ) {
          return null;
        }
        return {
          ...base,
          changeType: value.changeType,
          kind: value.kind,
          affectedThreadIds: value.affectedThreadIds,
        };
      case "safe_invalidation":
        return value.reason === "legacy_or_malformed"
          ? {
              ...base,
              changeType: value.changeType,
              reason: value.reason,
            }
          : null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export function parseMailboxStreamReadyEvent(
  serializedEvent: string,
): MailboxStreamReadyEvent | null {
  try {
    const value: unknown = JSON.parse(serializedEvent);
    return isRecord(value) &&
      value.type === "mailbox_stream_ready" &&
      isStringArray(value.accountIds) &&
      value.accountIds.length > 0
      ? { type: value.type, accountIds: value.accountIds }
      : null;
  } catch {
    return null;
  }
}
