import assert from "node:assert/strict";
import test from "node:test";

import {
  filterGmailSystemLabelIds,
  GMAIL_SYSTEM_LABEL_IDS,
  gmailSystemLabels,
} from "./system-labels";

test("only the product-owned Gmail system label allowlist crosses ingestion", () => {
  assert.deepEqual(GMAIL_SYSTEM_LABEL_IDS, [
    "INBOX",
    "SENT",
    "DRAFT",
    "TRASH",
    "SPAM",
    "STARRED",
    "UNREAD",
  ]);
  assert.deepEqual(
    filterGmailSystemLabelIds([
      "IMPORTANT",
      "INBOX",
      "SENT",
      "DRAFT",
      "TRASH",
      "SPAM",
      "STARRED",
      "UNREAD",
      "Label_7",
      "CATEGORY_PROMOTIONS",
      "IMPORTANT",
    ]),
    [...GMAIL_SYSTEM_LABEL_IDS],
  );
  assert.deepEqual(
    gmailSystemLabels([
      "IMPORTANT",
      "INBOX",
      "SENT",
      "DRAFT",
      "TRASH",
      "SPAM",
      "STARRED",
      "UNREAD",
      "Label_7",
      "CATEGORY_PROMOTIONS",
      "IMPORTANT",
    ]),
    [
      { providerLabelId: "INBOX", name: "Inbox" },
      { providerLabelId: "SENT", name: "Sent" },
      { providerLabelId: "DRAFT", name: "Drafts" },
      { providerLabelId: "TRASH", name: "Trash" },
      { providerLabelId: "SPAM", name: "Spam" },
      { providerLabelId: "STARRED", name: "Starred" },
      { providerLabelId: "UNREAD", name: "Unread" },
    ],
  );
});
