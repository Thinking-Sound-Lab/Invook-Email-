import assert from "node:assert/strict";
import test from "node:test";

import { v4 as uuidv4 } from "uuid";

import { parseThreadLabelBatchPayload } from "./thread-label-batch";

test("Batch admission requires a saved historical settings request", () => {
  assert.throws(() => parseThreadLabelBatchPayload({ flushRemainder: true }));
  assert.throws(() =>
    parseThreadLabelBatchPayload({
      historicalScanId: "invalid",
      retryAttempt: 0,
    }),
  );
  const historicalScanId = uuidv4();
  assert.deepEqual(
    parseThreadLabelBatchPayload({ historicalScanId, retryAttempt: 0 }),
    {
      historicalScanId,
      retryAttempt: 0,
      threadIds: undefined,
      continuations: [],
    },
  );
});

test("Batch retry checkpoints preserve disjoint bounded scopes and attempts", () => {
  const historicalScanId = uuidv4();
  const threadId = uuidv4();
  const continuationThreadId = uuidv4();
  const payload = {
    historicalScanId,
    retryAttempt: 2,
    threadIds: [threadId],
    continuations: [{ retryAttempt: 1, threadIds: [continuationThreadId] }],
  };
  assert.deepEqual(parseThreadLabelBatchPayload(payload), payload);
  for (const invalid of [
    { ...payload, retryAttempt: 0 },
    { ...payload, retryAttempt: 7 },
    { ...payload, threadIds: undefined },
    { ...payload, threadIds: [] },
    { ...payload, threadIds: ["invalid"] },
    {
      ...payload,
      continuations: [{ retryAttempt: 0, threadIds: [continuationThreadId] }],
    },
    { ...payload, continuations: [{ retryAttempt: 1, threadIds: [threadId] }] },
    {
      ...payload,
      continuations: [
        {
          retryAttempt: 1,
          threadIds: Array.from({ length: 2_000 }, () => uuidv4()),
        },
      ],
    },
  ])
    assert.throws(() => parseThreadLabelBatchPayload(invalid));
});
