import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGmailForwardedMessageText,
  type GmailForwardMessage,
} from "./gmail-forward";

const message: GmailForwardMessage = {
  sender: { raw: "Sender <sender@example.com>", email: "sender@example.com" },
  headers: [
    { name: "To", value: "owner@example.com" },
    { name: "Cc", value: "copy@example.com" },
    { name: "Bcc", value: "private@example.com" },
  ],
  subject: "Original subject",
  sentAt: "2026-08-28T12:00:00.000Z",
  bodyText: "Original message",
};

test("forward quotes preserve the complete original text and only visible headers", () => {
  const bodyText = "Long original line\n".repeat(6_000);
  const quoted = buildGmailForwardedMessageText({ ...message, bodyText });
  assert.equal(
    quoted,
    [
      "---------- Forwarded message ----------",
      "From: Sender <sender@example.com>",
      `Date: ${message.sentAt}`,
      "Subject: Original subject",
      "To: owner@example.com",
      "Cc: copy@example.com",
      "",
      bodyText,
    ].join("\n"),
  );
});

test("HTML-only forwards use the same readable quote in the browser and server", () => {
  const quoted = buildGmailForwardedMessageText({
    ...message,
    bodyText: "",
    bodyHtml:
      '<head><title>Hidden title</title><style>body {color:red}</style></head><p>Hello &amp; welcome</p><div>First<br>Second</div><script>unsafe()</script><img src="https://example.com/tracker">',
  });
  assert.match(quoted, /Hello & welcome\n\nFirst\nSecond$/);
  assert.doesNotMatch(quoted, /Hidden title|color:red|unsafe|tracker|<p>/);
  assert.ok(
    buildGmailForwardedMessageText({
      ...message,
      bodyHtml: "<p>Other text</p>",
    }).endsWith(message.bodyText),
  );
});
