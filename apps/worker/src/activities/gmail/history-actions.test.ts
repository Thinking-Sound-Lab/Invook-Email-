import assert from "node:assert/strict";
import test from "node:test";

import { mergeGmailHistoryMessageAction } from "./history-actions";

test("a later label event without a snapshot does not keep earlier labels", () => {
  const starred = mergeGmailHistoryMessageAction(
    undefined,
    {
      action: "labels",
      providerLabelIds: ["INBOX", "UNREAD", "STARRED"],
      isDraftRelated: false,
    },
    "100",
  );
  const archived = mergeGmailHistoryMessageAction(
    starred,
    {
      action: "labels",
      providerLabelIds: null,
      isDraftRelated: false,
    },
    "101",
  );

  assert.deepEqual(archived, {
    action: "labels",
    providerHistoryId: "101",
    gmailLabels: null,
    isDraftRelated: false,
  });
});

test("a later label snapshot replaces the previous system labels", () => {
  const starred = mergeGmailHistoryMessageAction(
    undefined,
    {
      action: "labels",
      providerLabelIds: ["INBOX", "STARRED"],
      isDraftRelated: false,
    },
    "100",
  );
  const archived = mergeGmailHistoryMessageAction(
    starred,
    {
      action: "labels",
      providerLabelIds: ["STARRED"],
      isDraftRelated: false,
    },
    "101",
  );

  assert.deepEqual(archived, {
    action: "labels",
    providerHistoryId: "101",
    gmailLabels: [{ providerLabelId: "STARRED", name: "Starred" }],
    isDraftRelated: false,
  });
});
