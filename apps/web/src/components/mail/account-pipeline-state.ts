import type {
  AccountSyncStage,
  AccountSyncStatusEvent,
  IndexingProgress,
  MailSyncProgress,
} from "@invook/contracts";

import { getGmailSyncProgressPresentation } from "./gmail-sync-progress";

export interface AccountPipelinePresentation {
  phase: "mail" | "indexing" | "memory";
  title: string;
  detail: string;
  percentage: number | null;
  isFailed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAccountSyncStage(value: unknown): value is AccountSyncStage {
  return value === "pending" || value === "running" || value === "complete" || value === "failed";
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function parseMailSyncProgress(value: unknown): MailSyncProgress | null {
  if (
    !isRecord(value) ||
    !isAccountSyncStage(value.state) ||
    typeof value.discoveryComplete !== "boolean" ||
    !isNonnegativeInteger(value.discoveredThreadCount) ||
    !isNonnegativeInteger(value.processedThreadCount) ||
    !isNonnegativeInteger(value.failedThreadCount)
  ) {
    return null;
  }

  return {
    state: value.state,
    discoveryComplete: value.discoveryComplete,
    discoveredThreadCount: value.discoveredThreadCount,
    processedThreadCount: value.processedThreadCount,
    failedThreadCount: value.failedThreadCount,
  };
}

function parseIndexingProgress(value: unknown): IndexingProgress | null {
  if (
    !isRecord(value) ||
    !isAccountSyncStage(value.state) ||
    !isNonnegativeInteger(value.completedMessageCount) ||
    !isNonnegativeInteger(value.failedMessageCount) ||
    !isNonnegativeInteger(value.totalMessageCount)
  ) {
    return null;
  }

  return {
    state: value.state,
    completedMessageCount: value.completedMessageCount,
    failedMessageCount: value.failedMessageCount,
    totalMessageCount: value.totalMessageCount,
  };
}

export function parseAccountSyncStatusEvent(
  serializedEvent: string,
): AccountSyncStatusEvent | null {
  try {
    const value: unknown = JSON.parse(serializedEvent);
    if (!isRecord(value) || !isAccountSyncStage(value.memory)) return null;
    const mailSync = parseMailSyncProgress(value.mailSync);
    const indexing = parseIndexingProgress(value.indexing);
    return mailSync && indexing
      ? { mailSync, indexing, memory: value.memory }
      : null;
  } catch {
    return null;
  }
}

export function getAccountPipelinePresentation(
  progress: AccountSyncStatusEvent,
): AccountPipelinePresentation | null {
  const mailPresentation = getGmailSyncProgressPresentation(progress.mailSync);
  if (mailPresentation) {
    return { phase: "mail", ...mailPresentation };
  }

  if (progress.indexing.state !== "complete") {
    const { indexing } = progress;
    const isFailed = indexing.state === "failed";
    const percentage = indexing.totalMessageCount > 0
      ? Math.min(
          100,
          Math.round(
            (indexing.completedMessageCount / indexing.totalMessageCount) * 100,
          ),
        )
      : null;
    const failedDetail = indexing.failedMessageCount > 0
      ? `; ${indexing.failedMessageCount.toLocaleString()} failed`
      : "";
    return {
      phase: "indexing",
      title: isFailed
        ? "Indexing needs attention"
        : indexing.state === "running"
          ? "Indexing mail"
          : "Preparing mail index",
      detail: indexing.totalMessageCount > 0
        ? `${indexing.completedMessageCount.toLocaleString()} of ${indexing.totalMessageCount.toLocaleString()} messages indexed${failedDetail}`
        : "Waiting for indexed messages",
      percentage,
      isFailed,
    };
  }

  if (progress.memory !== "complete") {
    const isFailed = progress.memory === "failed";
    return {
      phase: "memory",
      title: isFailed
        ? "Memory needs attention"
        : progress.memory === "running"
          ? "Creating Memory"
          : "Preparing Memory",
      detail: isFailed
        ? "Memory analysis could not finish"
        : progress.memory === "running"
          ? "Analyzing sent mail for reusable reply rules"
          : "Waiting for Memory analysis to start",
      percentage: null,
      isFailed,
    };
  }

  return null;
}
