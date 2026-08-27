import assert from "node:assert/strict";
import test from "node:test";

import {
  bindComposeSenderAccount,
  createComposeSenderAccountState,
  releaseComposeSenderAccount,
  resolveComposeSenderAccountId,
  selectComposeSenderAccount,
} from "./compose-sender-account";

test("an unsaved compose follows an explicitly selected mailbox account", () => {
  const state = createComposeSenderAccountState("account-a");

  assert.equal(
    resolveComposeSenderAccountId({ state, scopedAccountId: "account-b" }),
    "account-b",
  );
});

test("All preserves the sender chosen inside the composer", () => {
  const state = selectComposeSenderAccount("account-b");

  assert.equal(
    resolveComposeSenderAccountId({ state, scopedAccountId: null }),
    "account-b",
  );
});

test("a save attempt binds retries and a provider draft to its original account", () => {
  const state = bindComposeSenderAccount("account-a");

  assert.equal(
    resolveComposeSenderAccountId({ state, scopedAccountId: "account-b" }),
    "account-a",
  );
  assert.equal(
    releaseComposeSenderAccount(state, { hasProviderDraft: true }),
    state,
  );
});

test("editing after a failed initial save releases the account binding", () => {
  const state = releaseComposeSenderAccount(
    bindComposeSenderAccount("account-a"),
    { hasProviderDraft: false },
  );

  assert.equal(
    resolveComposeSenderAccountId({ state, scopedAccountId: "account-b" }),
    "account-b",
  );
});
