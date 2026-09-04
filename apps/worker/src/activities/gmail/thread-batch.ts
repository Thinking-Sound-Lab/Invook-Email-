import { gmailSyncThreadBatchSize } from "@invook/workflows";

export interface GmailThreadBatchFailure {
  providerThreadId: string;
  error: unknown;
}

/**
 * Guards the batch an Activity was handed. The Workflow builds these batches,
 * so a malformed one is a contract violation rather than a provider fault and
 * must not be retried against Gmail.
 */
export function assertGmailThreadBatch(providerThreadIds: string[]): void {
  if (
    providerThreadIds.length === 0 ||
    providerThreadIds.length > gmailSyncThreadBatchSize ||
    providerThreadIds.some(
      (providerThreadId) =>
        typeof providerThreadId !== "string" || !providerThreadId.trim(),
    ) ||
    new Set(providerThreadIds).size !== providerThreadIds.length
  ) {
    throw new Error("Gmail thread batch IDs are invalid.");
  }
}

export async function processGmailThreadBatch(input: {
  providerThreadIds: string[];
  concurrency: number;
  processThread: (providerThreadId: string) => Promise<void>;
}): Promise<{
  succeededThreadIds: string[];
  failures: GmailThreadBatchFailure[];
}> {
  if (!Number.isInteger(input.concurrency) || input.concurrency < 1) {
    throw new Error("Gmail thread batch concurrency must be a positive integer.");
  }
  let nextIndex = 0;
  const succeededThreadIds: string[] = [];
  const failures: GmailThreadBatchFailure[] = [];
  const processNext = async (): Promise<void> => {
    while (nextIndex < input.providerThreadIds.length) {
      const providerThreadId = input.providerThreadIds[nextIndex];
      nextIndex += 1;
      if (!providerThreadId) return;
      try {
        await input.processThread(providerThreadId);
        succeededThreadIds.push(providerThreadId);
      } catch (error) {
        failures.push({ providerThreadId, error });
      }
    }
  };
  const workerCount = Math.min(input.concurrency, input.providerThreadIds.length);
  await Promise.all(Array.from({ length: workerCount }, () => processNext()));
  const inputOrder = new Map(
    input.providerThreadIds.map((providerThreadId, index) => [
      providerThreadId,
      index,
    ]),
  );
  const orderFor = (providerThreadId: string): number =>
    inputOrder.get(providerThreadId) ?? Number.MAX_SAFE_INTEGER;
  succeededThreadIds.sort((left, right) => orderFor(left) - orderFor(right));
  failures.sort(
    (left, right) =>
      orderFor(left.providerThreadId) - orderFor(right.providerThreadId),
  );
  return { succeededThreadIds, failures };
}
