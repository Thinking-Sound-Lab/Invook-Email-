import assert from "node:assert/strict";
import test from "node:test";

import { isOlderGmailHistoryId } from "./gmail-history-id";

test("a missing history ID is not treated as older", () => {
  assert.equal(isOlderGmailHistoryId(null, "150"), false);
  assert.equal(isOlderGmailHistoryId("150", null), false);
  assert.equal(isOlderGmailHistoryId(null, null), false);
  assert.equal(isOlderGmailHistoryId("", "150"), false);
});

test("equal history IDs are current snapshots, not older ones", () => {
  assert.equal(isOlderGmailHistoryId("150", "150"), false);
});

test("Gmail history IDs compare as unsigned integers", () => {
  assert.equal(isOlderGmailHistoryId("140", "150"), true);
  assert.equal(isOlderGmailHistoryId("160", "150"), false);
  assert.equal(
    isOlderGmailHistoryId("99999999999999999999", "100000000000000000000"),
    true,
  );
  assert.equal(
    isOlderGmailHistoryId("100000000000000000000", "99999999999999999999"),
    false,
  );
});
