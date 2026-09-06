import assert from "node:assert/strict";
import test from "node:test";

import {
  getAccountPipelinePresentation,
  parseAccountSyncStatusEvent,
} from "./account-pipeline-state";

const completeMailSync = {
  state: "complete",
  discoveryComplete: true,
  discoveredThreadCount: 71_468,
  processedThreadCount: 71_468,
  failedThreadCount: 0,
} as const;

test("account progress events are validated before entering client state", () => {
  const serialized = JSON.stringify({ mailSync: completeMailSync });

  assert.deepEqual(parseAccountSyncStatusEvent(serialized), JSON.parse(serialized));
  assert.equal(parseAccountSyncStatusEvent("{"), null);
  assert.equal(
    parseAccountSyncStatusEvent(JSON.stringify({ mailSync: { state: "unknown" } })),
    null,
  );
});

test("a completed mail synchronization removes the progress stripe", () => {
  assert.equal(
    getAccountPipelinePresentation({ mailSync: completeMailSync }),
    null,
  );
});
