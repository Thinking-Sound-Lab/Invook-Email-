import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveMailSyncProgress,
  hasMailSyncProgressAdvanced,
} from "./mail-sync-progress";

test("mail sync progress preserves durable run counts", () => {
  assert.deepEqual(
    deriveMailSyncProgress({
      state: "running",
      run: {
        discoveryComplete: true,
        discoveredThreadCount: 71_468,
        processedThreadCount: 14_895,
        failedThreadCount: 0,
      },
    }),
    {
      state: "running",
      discoveryComplete: true,
      discoveredThreadCount: 71_468,
      processedThreadCount: 14_895,
      failedThreadCount: 0,
    },
  );
});

test("a completed account is known to have finished discovery without a run", () => {
  assert.deepEqual(deriveMailSyncProgress({ state: "complete", run: null }), {
    state: "complete",
    discoveryComplete: true,
    discoveredThreadCount: 0,
    processedThreadCount: 0,
    failedThreadCount: 0,
  });
});

test("sync notifications advance on a new percentage or durable count interval", () => {
  assert.equal(
    hasMailSyncProgressAdvanced({
      discoveryComplete: true,
      discoveredThreadCount: 10_000,
      previousProcessedThreadCount: 99,
      processedThreadCount: 100,
    }),
    true,
  );
  assert.equal(
    hasMailSyncProgressAdvanced({
      discoveryComplete: true,
      discoveredThreadCount: 10_000,
      previousProcessedThreadCount: 199,
      processedThreadCount: 200,
    }),
    true,
  );
  assert.equal(
    hasMailSyncProgressAdvanced({
      discoveryComplete: true,
      discoveredThreadCount: 10_000,
      previousProcessedThreadCount: 200,
      processedThreadCount: 201,
    }),
    false,
  );
  assert.equal(
    hasMailSyncProgressAdvanced({
      discoveryComplete: false,
      discoveredThreadCount: 10_000,
      previousProcessedThreadCount: 99,
      processedThreadCount: 100,
    }),
    true,
  );
  assert.equal(
    hasMailSyncProgressAdvanced({
      discoveryComplete: false,
      discoveredThreadCount: 10_000,
      previousProcessedThreadCount: 100,
      processedThreadCount: 101,
    }),
    false,
  );
});
