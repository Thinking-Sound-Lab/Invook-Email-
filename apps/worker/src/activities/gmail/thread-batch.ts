import { GMAIL_SYNC_THREAD_BATCH_SIZE } from "@invook/database";

export interface GmailThreadBatchPayload {
  runId: string;
  providerThreadIds: string[];
}

export interface GmailThreadBatchFailure {
  providerThreadId: string;
  error: unknown;
}

export function parseGmailThreadBatchPayload(
  payload: Record<string, unknown>,
): GmailThreadBatchPayload {
  const runId = payload.runId;
  const providerThreadIds = payload.providerThreadIds;
  if (typeof runId !== "string" || !runId.trim()) {
    throw new Error("Gmail thread batch run ID is missing.");
  }
  if (
    !Array.isArray(providerThreadIds) ||
    providerThreadIds.length === 0 ||
    providerThreadIds.length > GMAIL_SYNC_THREAD_BATCH_SIZE ||
    providerThreadIds.some(
      (providerThreadId) =>
        typeof providerThreadId !== "string" || !providerThreadId.trim(),
    ) ||
    new Set(providerThreadIds).size !== providerThreadIds.length
  ) {
    throw new Error("Gmail thread batch IDs are invalid.");
  }
  return { runId, providerThreadIds };
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
