import assert from "node:assert/strict";
import { test } from "node:test";

import { gmailHistoryChanges } from "@invook/gmail";

test("Gmail history exposes additions, label changes, and deletions", () => {
  assert.deepEqual(
    gmailHistoryChanges({
      id: "105",
      messagesAdded: [{ message: { id: "added", threadId: "thread-1" } }],
      labelsAdded: [
        {
          message: {
            id: "starred",
            threadId: "thread-2",
            labelIds: ["STARRED"],
          },
          labelIds: ["STARRED"],
        },
        {
          message: {
            id: "draft-message",
            threadId: "thread-draft",
            labelIds: ["DRAFT"],
          },
          labelIds: ["DRAFT"],
        },
      ],
      labelsRemoved: [
        {
          message: { id: "archived", threadId: "thread-3" },
          labelIds: ["INBOX"],
        },
      ],
      messagesDeleted: [
        { message: { id: "deleted", threadId: "thread-4" } },
      ],
    }),
    [
      {
        messageId: "added",
        action: "upsert",
        providerLabelIds: null,
        isDraftRelated: false,
      },
      {
        messageId: "starred",
        action: "labels",
        providerLabelIds: ["STARRED"],
        isDraftRelated: false,
      },
      {
        messageId: "draft-message",
        action: "labels",
        providerLabelIds: ["DRAFT"],
        isDraftRelated: true,
      },
      {
        messageId: "archived",
        action: "labels",
        providerLabelIds: null,
        isDraftRelated: false,
      },
      {
        messageId: "deleted",
        action: "delete",
        providerLabelIds: null,
        isDraftRelated: false,
      },
    ],
  );
});
