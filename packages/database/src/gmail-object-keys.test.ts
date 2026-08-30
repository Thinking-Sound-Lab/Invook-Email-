import assert from "node:assert/strict";
import test from "node:test";

import { selectUnreferencedGmailObjectKeys } from "./replica";

test("object cleanup keeps keys that are live after re-ingest", () => {
  assert.deepEqual(
    selectUnreferencedGmailObjectKeys({
      objectKeys: [
        "account/messages/old/attachments/0-aaa",
        "account/messages/live/attachments/0-bbb",
      ],
      referencedObjectKeys: ["account/messages/live/attachments/0-bbb"],
    }),
    ["account/messages/old/attachments/0-aaa"],
  );
});

test("object cleanup is a no-op when every key is still referenced", () => {
  assert.deepEqual(
    selectUnreferencedGmailObjectKeys({
      objectKeys: ["account/messages/live/attachments/0-bbb"],
      referencedObjectKeys: ["account/messages/live/attachments/0-bbb"],
    }),
    [],
  );
});

test("object cleanup deletes unreferenced keys and ignores duplicates", () => {
  assert.deepEqual(
    selectUnreferencedGmailObjectKeys({
      objectKeys: [
        "account/messages/gone/attachments/0-ccc",
        "account/messages/gone/attachments/0-ccc",
        "",
      ],
      referencedObjectKeys: [],
    }),
    ["account/messages/gone/attachments/0-ccc"],
  );
});

test("object cleanup is a no-op for an empty manifest", () => {
  assert.deepEqual(
    selectUnreferencedGmailObjectKeys({
      objectKeys: [],
      referencedObjectKeys: ["account/messages/live/attachments/0-bbb"],
    }),
    [],
  );
});
