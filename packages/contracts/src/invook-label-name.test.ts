import assert from "node:assert/strict";
import test from "node:test";

import { normalizeInvookLabelName } from "./index";

test("label identity folds case and surrounding whitespace", () => {
  assert.equal(normalizeInvookLabelName("  Action   Needed "), "action needed");
  assert.equal(
    normalizeInvookLabelName("BILLING"),
    normalizeInvookLabelName("billing"),
  );
});

test("label identity stays the same under a Turkish default locale", () => {
  const dottedCapital = "İstanbul Invoices";
  const dotlessCapital = "Irmak Invoices";
  assert.equal(
    normalizeInvookLabelName(dottedCapital),
    dottedCapital.trim().toLowerCase(),
  );
  assert.equal(
    normalizeInvookLabelName(dotlessCapital),
    dotlessCapital.trim().toLowerCase(),
  );
  assert.notEqual(
    normalizeInvookLabelName(dotlessCapital),
    dotlessCapital.toLocaleLowerCase("tr-TR"),
  );
});
