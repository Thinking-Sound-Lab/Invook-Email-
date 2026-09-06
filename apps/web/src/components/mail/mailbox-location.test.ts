import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeMailSurface,
  normalizeMailboxAccount,
  normalizeMailboxView,
} from "./mailbox-location";

const labelId = "0f9d5b1a-8c2e-4f6b-9a51-2d7c3e4b5a6f";

test("an address resolves to one view on the server and in the browser", () => {
  assert.equal(normalizeMailboxView("starred"), "starred");
  assert.equal(normalizeMailboxView(`label:${labelId}`), `label:${labelId}`);
  // A view that is not a mailbox view, and a label that is not an identity,
  // both fall back rather than addressing a page key nothing renders.
  assert.equal(normalizeMailboxView("bogus"), "all");
  assert.equal(normalizeMailboxView("label:not-a-uuid"), "all");
  assert.equal(normalizeMailboxView(null), "all");
});

test("surfaces and account scope fall back to the mailbox", () => {
  assert.equal(normalizeMailSurface("compose"), "compose");
  assert.equal(normalizeMailSurface("bogus"), "mail");
  assert.equal(normalizeMailSurface(undefined), "mail");
  assert.equal(normalizeMailboxAccount(labelId), labelId);
  assert.equal(normalizeMailboxAccount("all"), "all");
  assert.equal(normalizeMailboxAccount("not-a-uuid"), "all");
});
