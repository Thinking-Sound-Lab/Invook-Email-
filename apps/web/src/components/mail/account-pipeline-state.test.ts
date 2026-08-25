import assert from "node:assert/strict";
import test from "node:test";

import {
  getAccountPipelinePresentation,
  parseAccountSyncStatusEvent,
} from "./account-pipeline-state";

const completeMailSync = {
  state: "complete",
  discoveryComplete: true,
  discoveredMessageCount: 71_468,
  processedMessageCount: 71_468,
  failedMessageCount: 0,
} as const;

test("account progress events are validated before entering client state", () => {
  const serialized = JSON.stringify({
    mailSync: completeMailSync,
    memory: "pending",
  });

  assert.deepEqual(parseAccountSyncStatusEvent(serialized), JSON.parse(serialized));
  assert.equal(parseAccountSyncStatusEvent("{"), null);
  assert.equal(
    parseAccountSyncStatusEvent(JSON.stringify({ ...JSON.parse(serialized), memory: "unknown" })),
    null,
  );
});

test("the progress stripe presents Memory after mail synchronization", () => {
  assert.deepEqual(
    getAccountPipelinePresentation({
      mailSync: completeMailSync,
      memory: "running",
    }),
    {
      phase: "memory",
      title: "Creating Memory",
      detail: "Analyzing sent mail for reusable reply rules",
      percentage: null,
      isFailed: false,
    },
  );
});

test("a completed account pipeline removes the progress stripe", () => {
  assert.equal(
    getAccountPipelinePresentation({
      mailSync: completeMailSync,
      memory: "complete",
    }),
    null,
  );
});
