import type {
  AccountSyncStage,
  AccountSyncStatusEvent,
  MailSyncProgress,
} from "@invook/contracts";

import { getGmailSyncProgressPresentation } from "./gmail-sync-progress";

export interface AccountPipelinePresentation {
  phase: "mail";
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

export function parseAccountSyncStatusEvent(
  serializedEvent: string,
): AccountSyncStatusEvent | null {
  try {
    const value: unknown = JSON.parse(serializedEvent);
    if (!isRecord(value)) return null;
    const mailSync = parseMailSyncProgress(value.mailSync);
    return mailSync ? { mailSync } : null;
  } catch {
    return null;
  }
}

export function getAccountPipelinePresentation(
  progress: AccountSyncStatusEvent,
): AccountPipelinePresentation | null {
  const mailPresentation = getGmailSyncProgressPresentation(progress.mailSync);
  return mailPresentation ? { phase: "mail", ...mailPresentation } : null;
}
