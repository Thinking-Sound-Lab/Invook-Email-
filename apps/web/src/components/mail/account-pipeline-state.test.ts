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
  const serialized = JSON.stringify({
    mailSync: completeMailSync,
    indexing: {
      state: "running",
      completedMessageCount: 4_000,
      failedMessageCount: 0,
      totalMessageCount: 71_468,
    },
    memory: "pending",
  });

  assert.deepEqual(parseAccountSyncStatusEvent(serialized), JSON.parse(serialized));
  assert.equal(parseAccountSyncStatusEvent("{"), null);
  assert.equal(
    parseAccountSyncStatusEvent(JSON.stringify({ ...JSON.parse(serialized), memory: "unknown" })),
    null,
  );
});

test("the progress stripe presents only the earliest incomplete pipeline phase", () => {
  const indexing = {
    state: "running",
    completedMessageCount: 4_000,
    failedMessageCount: 0,
    totalMessageCount: 20_000,
  } as const;
  assert.deepEqual(
    getAccountPipelinePresentation({
      mailSync: completeMailSync,
      indexing,
      memory: "running",
    }),
    {
      phase: "indexing",
      title: "Indexing mail",
      detail: "4,000 of 20,000 messages indexed",
      percentage: 20,
      isFailed: false,
    },
  );
  assert.deepEqual(
    getAccountPipelinePresentation({
      mailSync: completeMailSync,
      indexing: { ...indexing, state: "complete", completedMessageCount: 20_000 },
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
      indexing: {
        state: "complete",
        completedMessageCount: 71_468,
        failedMessageCount: 0,
        totalMessageCount: 71_468,
      },
      memory: "complete",
    }),
    null,
  );
});
