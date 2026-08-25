import type {
  AccountSyncStage,
  AccountSyncStatusEvent,
  MailSyncProgress,
} from "@invook/contracts";

import { getGmailSyncProgressPresentation } from "./gmail-sync-progress";

export interface AccountPipelinePresentation {
  phase: "mail" | "memory";
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
    !isNonnegativeInteger(value.discoveredMessageCount) ||
    !isNonnegativeInteger(value.processedMessageCount) ||
    !isNonnegativeInteger(value.failedMessageCount)
  ) {
    return null;
  }

  return {
    state: value.state,
    discoveryComplete: value.discoveryComplete,
    discoveredMessageCount: value.discoveredMessageCount,
    processedMessageCount: value.processedMessageCount,
    failedMessageCount: value.failedMessageCount,
  };
}

export function parseAccountSyncStatusEvent(
  serializedEvent: string,
): AccountSyncStatusEvent | null {
  try {
    const value: unknown = JSON.parse(serializedEvent);
    if (!isRecord(value) || !isAccountSyncStage(value.memory)) return null;
    const mailSync = parseMailSyncProgress(value.mailSync);
    return mailSync ? { mailSync, memory: value.memory } : null;
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
