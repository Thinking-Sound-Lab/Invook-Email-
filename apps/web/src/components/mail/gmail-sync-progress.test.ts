import assert from "node:assert/strict";
import test from "node:test";

import { getGmailSyncProgressPresentation } from "./gmail-sync-progress";

test("active Gmail synchronization shows durable counts and percentage", () => {
  assert.deepEqual(
    getGmailSyncProgressPresentation({
      state: "running",
      discoveryComplete: true,
      discoveredThreadCount: 71_468,
      processedThreadCount: 14_895,
      failedThreadCount: 0,
    }),
    {
      title: "Syncing Gmail",
      detail: "14,895 of 71,468 threads synced",
      percentage: 21,
      isFailed: false,
    },
  );
});

test("thread discovery shows processed progress against the threads found so far", () => {
  assert.deepEqual(
    getGmailSyncProgressPresentation({
      state: "running",
      discoveryComplete: false,
      discoveredThreadCount: 3_400,
      processedThreadCount: 1_200,
      failedThreadCount: 0,
    }),
    {
      title: "Finding and syncing Gmail",
      detail: "1,200 of 3,400 discovered threads synced",
      percentage: 35,
      isFailed: false,
    },
  );
});

test("completed Gmail synchronization removes the progress presentation", () => {
  assert.equal(
    getGmailSyncProgressPresentation({
      state: "complete",
      discoveryComplete: true,
      discoveredThreadCount: 71_468,
      processedThreadCount: 71_468,
      failedThreadCount: 0,
    }),
    null,
  );
});
