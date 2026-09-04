import assert from "node:assert/strict";
import test from "node:test";

import { gmailSyncThreadBatchSize } from "@invook/workflows";

import {
  assertGmailThreadBatch,
  processGmailThreadBatch,
} from "./thread-batch";

test("Gmail thread batches are bounded and unique", () => {
  const providerThreadIds = Array.from(
    { length: gmailSyncThreadBatchSize },
    (_, index) => `thread-${index + 1}`,
  );
  assertGmailThreadBatch(providerThreadIds);
  assert.throws(() => assertGmailThreadBatch([]), /IDs are invalid/i);
  assert.throws(
    () => assertGmailThreadBatch([...providerThreadIds, "thread-overflow"]),
    /IDs are invalid/i,
  );
  assert.throws(
    () => assertGmailThreadBatch(["thread-1", "thread-1"]),
    /IDs are invalid/i,
  );
  assert.throws(
    () => assertGmailThreadBatch(["thread-1", "   "]),
    /IDs are invalid/i,
  );
});

test("a Gmail thread batch bounds concurrency and finishes independent threads", async () => {
  const providerThreadIds = Array.from(
    { length: gmailSyncThreadBatchSize },
    (_, index) => `thread-${index + 1}`,
  );
  let activeCount = 0;
  let maximumActiveCount = 0;
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const startedThreadIds: string[] = [];
  const processing = processGmailThreadBatch({
    providerThreadIds,
    concurrency: 5,
    processThread: async (providerThreadId) => {
      activeCount += 1;
      maximumActiveCount = Math.max(maximumActiveCount, activeCount);
      startedThreadIds.push(providerThreadId);
      if (startedThreadIds.length === 5) release?.();
      await gate;
      activeCount -= 1;
      if (providerThreadId === "thread-7") throw new Error("retryable");
    },
  });
  await gate;
  const result = await processing;

  assert.equal(maximumActiveCount, 5);
  assert.deepEqual(result.succeededThreadIds, [
    "thread-1",
    "thread-2",
    "thread-3",
    "thread-4",
    "thread-5",
    "thread-6",
    "thread-8",
    "thread-9",
    "thread-10",
  ]);
  assert.deepEqual(
    result.failures.map((failure) => failure.providerThreadId),
    ["thread-7"],
  );
});
