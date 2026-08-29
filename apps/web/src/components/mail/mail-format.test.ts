import assert from "node:assert/strict";
import test from "node:test";

import {
  formatMailDate,
  formatRecipientDetails,
  formatRecipientSummary,
  splitMailBodyQuotedContent,
} from "./mail-format";

test("mail time formatting respects the viewer timezone", () => {
  const value = "2026-08-15T20:52:00.000Z";
  const now = new Date("2026-08-15T21:00:00.000Z");

  assert.equal(
    formatMailDate(value, { now, timeZone: "Asia/Kolkata" }),
    "2:22 AM",
  );
  assert.equal(
    formatMailDate(value, { now, timeZone: "UTC" }),
    "8:52 PM",
  );
});

test("message recipients identify the signed-in mailbox without losing addresses", () => {
  const recipients = [
    "Abhishek Kumar <abhishek@example.com>",
    "Teammate <teammate@example.com>",
    "third@example.com",
  ];

  assert.equal(
    formatRecipientSummary(recipients, "abhishek@example.com"),
    "me (abhishek@example.com), Teammate (teammate@example.com) +1",
  );
  assert.equal(
    formatRecipientDetails(recipients, "abhishek@example.com"),
    "me (abhishek@example.com), Teammate (teammate@example.com), third@example.com",
  );
});

test("message recipients preserve an honest unavailable state", () => {
  assert.equal(
    formatRecipientSummary([], "abhishek@example.com"),
    "Recipients unavailable",
  );
});

test("plain-text replies separate visible text from quoted history", () => {
  assert.deepEqual(
    splitMailBodyQuotedContent(`Thanks, that works for me.

On Fri, Aug 28, 2026 at 10:00 AM Sender <sender@example.com> wrote:
> Earlier message
> More history`),
    {
      visibleText: "Thanks, that works for me.",
      quotedText:
        "On Fri, Aug 28, 2026 at 10:00 AM Sender <sender@example.com> wrote:\n> Earlier message\n> More history",
    },
  );
});

test("plain-text forwards separate an original-message section", () => {
  assert.deepEqual(
    splitMailBodyQuotedContent(`Please see below.

-----Original Message-----
From: sender@example.com
Subject: Earlier message`),
    {
      visibleText: "Please see below.",
      quotedText:
        "-----Original Message-----\nFrom: sender@example.com\nSubject: Earlier message",
    },
  );
});

test("plain-text content is not collapsed without a visible current message", () => {
  assert.deepEqual(splitMailBodyQuotedContent("> Quoted line only"), {
    visibleText: "> Quoted line only",
    quotedText: null,
  });
  assert.deepEqual(
    splitMailBodyQuotedContent("On this project I wrote:\nA fresh sentence."),
    {
      visibleText: "On this project I wrote:\nA fresh sentence.",
      quotedText: null,
    },
  );
});
