import type { AccountSyncStage, MailSyncProgress } from "@invook/contracts";

export interface StoredMailSyncProgress {
  discoveryComplete: boolean;
  discoveredThreadCount: number;
  processedThreadCount: number;
  failedThreadCount: number;
}

export function deriveMailSyncProgress(input: {
  state: AccountSyncStage;
  run: StoredMailSyncProgress | null;
}): MailSyncProgress {
  return {
    state: input.state,
    discoveryComplete:
      input.state === "complete" || (input.run?.discoveryComplete ?? false),
    discoveredThreadCount: input.run?.discoveredThreadCount ?? 0,
    processedThreadCount: input.run?.processedThreadCount ?? 0,
    failedThreadCount: input.run?.failedThreadCount ?? 0,
  };
}

const MAIL_SYNC_NOTIFICATION_INTERVAL = 100;

export function hasMailSyncProgressAdvanced(input: {
  discoveryComplete: boolean;
  discoveredThreadCount: number;
  previousProcessedThreadCount: number;
  processedThreadCount: number;
}): boolean {
  if (input.discoveredThreadCount <= 0) return false;

  const previousInterval = Math.floor(
    input.previousProcessedThreadCount / MAIL_SYNC_NOTIFICATION_INTERVAL,
  );
  const interval = Math.floor(
    input.processedThreadCount / MAIL_SYNC_NOTIFICATION_INTERVAL,
  );
  if (interval > previousInterval) return true;
  if (!input.discoveryComplete) return false;

  const previousPercentage = Math.floor(
    (input.previousProcessedThreadCount / input.discoveredThreadCount) * 100,
  );
  const percentage = Math.floor(
    (input.processedThreadCount / input.discoveredThreadCount) * 100,
  );
  return percentage > previousPercentage;
}
