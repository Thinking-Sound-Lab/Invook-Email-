import type { MailSyncProgress } from "@invook/contracts";

export interface GmailSyncProgressPresentation {
  title: string;
  detail: string;
  percentage: number | null;
  isFailed: boolean;
}

export function getGmailSyncProgressPresentation(
  progress: MailSyncProgress,
): GmailSyncProgressPresentation | null {
  if (progress.state === "complete") return null;

  const isFailed = progress.state === "failed";
  const percentage = progress.discoveredThreadCount === 0
    ? progress.discoveryComplete
      ? 100
      : null
    : Math.min(
        100,
        Math.round(
          (progress.processedThreadCount / progress.discoveredThreadCount) * 100,
        ),
      );

  if (isFailed) {
    const failedDetail = progress.failedThreadCount
      ? `; ${progress.failedThreadCount.toLocaleString()} failed`
      : "";
    return {
      title: "Gmail sync needs attention",
      detail: `${progress.processedThreadCount.toLocaleString()} threads synced${failedDetail}`,
      percentage,
      isFailed,
    };
  }

  if (!progress.discoveryComplete) {
    const isProcessing = progress.processedThreadCount > 0;
    return {
      title:
        isProcessing
          ? "Finding and syncing Gmail"
          : progress.discoveredThreadCount > 0
          ? "Finding Gmail threads"
          : "Preparing Gmail sync",
      detail:
        isProcessing
          ? `${progress.processedThreadCount.toLocaleString()} of ${progress.discoveredThreadCount.toLocaleString()} discovered threads synced`
          : progress.discoveredThreadCount > 0
          ? `${progress.discoveredThreadCount.toLocaleString()} threads found so far`
          : "Waiting for Gmail to report thread totals",
      percentage,
      isFailed,
    };
  }

  return {
    title: "Syncing Gmail",
    detail:
      progress.discoveredThreadCount === 0
        ? "Finishing an empty mailbox sync"
        : `${progress.processedThreadCount.toLocaleString()} of ${progress.discoveredThreadCount.toLocaleString()} threads synced`,
    percentage,
    isFailed,
  };
}
