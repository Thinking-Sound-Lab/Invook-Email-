import assert from "node:assert/strict";
import test from "node:test";

import {
  parseMailboxAccountScope,
  parseRequiredMailboxAccountId,
} from "./mailbox-account-scope";

const accountId = "00000000-0000-4000-8000-000000000001";

test("mailbox account scope treats omitted and All as the aggregate inbox", () => {
  assert.deepEqual(parseMailboxAccountScope(undefined), {
    valid: true,
    accountId: null,
  });
  assert.deepEqual(parseMailboxAccountScope("all"), {
    valid: true,
    accountId: null,
  });
});

test("mailbox account scope accepts only a specific UUID account", () => {
  assert.deepEqual(parseMailboxAccountScope(accountId), {
    valid: true,
    accountId,
  });
  assert.deepEqual(parseMailboxAccountScope("not-an-account"), {
    valid: false,
    accountId: null,
  });
  assert.equal(parseRequiredMailboxAccountId(accountId), accountId);
  assert.equal(parseRequiredMailboxAccountId("all"), null);
});
