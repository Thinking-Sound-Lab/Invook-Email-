import assert from "node:assert/strict";
import { test } from "node:test";

import {
  persistableHistoricalLabelScanContinuations,
  remainingHistoricalLabelScanScope,
} from "./historical-thread-label-batches";
import type { HistoricalLabelScanBatchScope } from "@invook/workflows";

test("a retried finalization recovers a retry page instead of ending the scan", () => {
  const nextScope: HistoricalLabelScanBatchScope = {
    retryAttempt: 1,
    threadIds: ["thread-a", "thread-b"],
    continuations: [{ retryAttempt: 0, threadIds: ["thread-c"] }],
    retryDelayMs: 5 * 60 * 1_000,
  };

  const persisted = persistableHistoricalLabelScanContinuations(nextScope);
  assert.deepEqual(persisted, [
    { retryAttempt: 1, threadIds: ["thread-a", "thread-b"] },
    { retryAttempt: 0, threadIds: ["thread-c"] },
  ]);
  assert.deepEqual(
    remainingHistoricalLabelScanScope({
      scanIsCurrent: true,
      continuations: persisted,
    }),
    {
      retryAttempt: 1,
      threadIds: ["thread-a", "thread-b"],
      continuations: [{ retryAttempt: 0, threadIds: ["thread-c"] }],
      retryDelayMs: 0,
    },
  );
});

test("a retried finalization keeps walking from the scan cursor", () => {
  const nextScope: HistoricalLabelScanBatchScope = {
    retryAttempt: 0,
    threadIds: null,
    continuations: [],
    retryDelayMs: 0,
  };

  assert.deepEqual(
    persistableHistoricalLabelScanContinuations(nextScope),
    [],
  );
  assert.deepEqual(
    remainingHistoricalLabelScanScope({
      scanIsCurrent: true,
      continuations: [],
    }),
    nextScope,
  );
});

test("a retired Batch does not invent further work for a closed scan", () => {
  assert.equal(
    remainingHistoricalLabelScanScope({
      scanIsCurrent: false,
      continuations: [{ retryAttempt: 1, threadIds: ["thread-a"] }],
    }),
    null,
  );
  assert.deepEqual(persistableHistoricalLabelScanContinuations(null), []);
});
