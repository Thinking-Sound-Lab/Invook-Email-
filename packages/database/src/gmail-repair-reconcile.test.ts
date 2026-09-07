import assert from "node:assert/strict";
import { test } from "node:test";

import { shouldDeleteStoredMessageDuringRepair } from "./gmail-repair-reconcile";

test("repair keeps live catch-up on a thread the walk never listed", () => {
  assert.equal(
    shouldDeleteStoredMessageDuringRepair({
      isOnDiscoveredThread: false,
      providerHistoryId: "250",
      repairStartingHistoryCursor: "200",
    }),
    false,
  );
});

test("repair deletes a thread that vanished from Gmail before the walk", () => {
  assert.equal(
    shouldDeleteStoredMessageDuringRepair({
      isOnDiscoveredThread: false,
      providerHistoryId: "150",
      repairStartingHistoryCursor: "200",
    }),
    true,
  );
  assert.equal(
    shouldDeleteStoredMessageDuringRepair({
      isOnDiscoveredThread: false,
      providerHistoryId: null,
      repairStartingHistoryCursor: "200",
    }),
    true,
  );
});

test("repair does not use this pass to delete extras on discovered threads", () => {
  assert.equal(
    shouldDeleteStoredMessageDuringRepair({
      isOnDiscoveredThread: true,
      providerHistoryId: "100",
      repairStartingHistoryCursor: "200",
    }),
    false,
  );
});
