import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { normalizeGmailFullMessage, parseGmailMessage } from "./message";

const attachmentBytes = Buffer.from([0x00, 0x01, 0x02, 0xfe, 0xff]);
const mime = Buffer.from(
  [
    "Received: from first.example by mx.example; Tue, 12 Aug 2026 09:30:00 +0000",
    "Received: from second.example by first.example; Tue, 12 Aug 2026 09:29:59 +0000",
    "From: Sender Name <sender@example.com>",
    "To: First Recipient <first@example.com>, second@example.com",
    "Cc: copy@example.com",
    "Subject: =?UTF-8?Q?Replica_=E2=9C=93?=",
    "Message-ID: <message-123@example.com>",
    "In-Reply-To: <parent@example.com>",
    "References: <root@example.com> <parent@example.com>",
    "Date: Tue, 12 Aug 2026 15:00:00 +0530",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="outer-boundary"',
    "",
    "--outer-boundary",
    'Content-Type: multipart/alternative; boundary="content-boundary"',
    "",
    "--content-boundary",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Complete plain text body.=0AQuoted reply remains here.",
    "--content-boundary",
    'Content-Type: text/html; charset="utf-8"',
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "<p>Complete <strong>HTML</strong> body.</p>",
    "--content-boundary--",
    "--outer-boundary",
    'Content-Type: application/octet-stream; name="bytes.bin"',
    "Content-Transfer-Encoding: base64",
    'Content-Disposition: attachment; filename="bytes.bin"',
    "Content-ID: <binary-content@example.com>",
    "",
    attachmentBytes.toString("base64"),
    "--outer-boundary--",
    "",
  ].join("\r\n"),
  "utf8",
);

test("raw MIME parsing preserves headers, bodies, bytes, and Gmail metadata", async () => {
  const parsed = await parseGmailMessage({
    id: "gmail-message-id",
    threadId: "gmail-thread-id",
    historyId: "4321",
    internalDate: "1786527000000",
    sizeEstimate: mime.byteLength,
    labelIds: ["INBOX", "IMPORTANT", "Label_7", "CATEGORY_PROMOTIONS"],
    snippet: "Complete plain text body.",
    raw: mime.toString("base64url"),
  });

  assert.equal(parsed.providerMessageId, "gmail-message-id");
  assert.equal(parsed.providerThreadId, "gmail-thread-id");
  assert.equal(parsed.historyId, "4321");
  assert.equal(parsed.internalDate, "1786527000000");
  assert.equal(parsed.sizeEstimate, mime.byteLength);
  assert.deepEqual(parsed.labelIds, ["INBOX", "IMPORTANT"]);
  assert.deepEqual(
    parsed.headers.slice(0, 2).map(({ name }) => name),
    ["received", "received"],
  );
  assert.equal(parsed.headers.filter(({ name }) => name === "received").length, 2);
  assert.equal(parsed.subject, "Replica ✓");
  assert.equal(parsed.from, '"Sender Name" <sender@example.com>');
  assert.deepEqual(parsed.to, [
    "First Recipient <first@example.com>",
    "second@example.com",
  ]);
  assert.deepEqual(parsed.cc, ["copy@example.com"]);
  assert.equal(parsed.bodyText, "Complete plain text body.\nQuoted reply remains here.");
  assert.equal(parsed.bodyHtml, "<p>Complete <strong>HTML</strong> body.</p>");
  assert.equal(parsed.sentAt, new Date(1786527000000).toISOString());

  assert.equal(parsed.attachments.length, 1);
  const [attachment] = parsed.attachments;
  assert.ok(attachment);
  assert.equal(attachment.mimePartPath, "2");
  assert.equal(attachment.filename, "bytes.bin");
  assert.equal(attachment.mimeType, "application/octet-stream");
  assert.equal(attachment.contentDisposition, "attachment");
  assert.equal(attachment.contentId, "<binary-content@example.com>");
  assert.equal(attachment.cid, "binary-content@example.com");
  assert.equal(attachment.size, attachmentBytes.byteLength);
  assert.deepEqual(attachment.content, attachmentBytes);
  assert.equal(
    attachment.checksumSha256,
    createHash("sha256").update(attachmentBytes).digest("hex"),
  );
});

test("full-format normalization reuses Gmail's parsed parts and loads external bytes", async () => {
  const attachmentRequests: Array<{ messageId: string; attachmentId: string }> = [];
  const parsed = await normalizeGmailFullMessage(
    {
      id: "full-message-id",
      threadId: "full-thread-id",
      historyId: "9876",
      internalDate: "1786527000000",
      sizeEstimate: 512,
      labelIds: ["INBOX", "Label_7"],
      snippet: "Complete body",
      payload: {
        mimeType: "multipart/mixed",
        headers: [
          { name: "From", value: "Sender Name <sender@example.com>" },
          { name: "To", value: "receiver@example.com" },
          { name: "Subject", value: "=?UTF-8?Q?Full_=E2=9C=93?=" },
          { name: "Message-ID", value: "<full@example.com>" },
        ],
        parts: [
          {
            partId: "0",
            mimeType: "text/plain",
            body: { data: Buffer.from("Complete body").toString("base64url") },
          },
          {
            partId: "1",
            mimeType: "application/pdf",
            filename: "invoice.pdf",
            headers: [
              { name: "Content-Disposition", value: "attachment; filename=invoice.pdf" },
            ],
            body: { attachmentId: "attachment-1", size: attachmentBytes.byteLength },
          },
        ],
      },
    },
    async (request) => {
      attachmentRequests.push(request);
      return { data: attachmentBytes.toString("base64url"), size: attachmentBytes.byteLength };
    },
  );

  assert.equal(parsed.providerMessageId, "full-message-id");
  assert.equal(parsed.providerThreadId, "full-thread-id");
  assert.equal(parsed.subject, "Full ✓");
  assert.equal(parsed.from, '"Sender Name" <sender@example.com>');
  assert.deepEqual(parsed.to, ["receiver@example.com"]);
  assert.equal(parsed.bodyText, "Complete body");
  assert.equal(parsed.bodyHtml, null);
  assert.equal(parsed.sentAt, new Date(1786527000000).toISOString());
  assert.deepEqual(attachmentRequests, [
    { messageId: "full-message-id", attachmentId: "attachment-1" },
  ]);
  assert.equal(parsed.attachments[0]?.providerAttachmentId, "attachment-1");
  assert.equal(parsed.attachments[0]?.mimePartPath, "1");
  assert.deepEqual(parsed.attachments[0]?.content, attachmentBytes);
});

test("raw MIME parsing reports absent body variants honestly", async () => {
  const plainOnly = Buffer.from(
    [
      "From: sender@example.com",
      "To: receiver@example.com",
      "Subject: Plain only",
      'Content-Type: text/plain; charset="utf-8"',
      "",
      "Only the actual text body is returned.",
    ].join("\r\n"),
  );

  const parsed = await parseGmailMessage({
    id: "plain-message",
    threadId: "plain-thread",
    raw: plainOnly.toString("base64url"),
  });

  assert.equal(parsed.bodyText, "Only the actual text body is returned.");
  assert.equal(parsed.bodyHtml, null);
  assert.equal(parsed.internalDate, null);
  assert.equal(parsed.sentAt, null);
  assert.deepEqual(parsed.attachments, []);
});

test("invalid Gmail dates fall back to the first plausible receipt timestamp", async () => {
  const malformedDateMime = Buffer.from(
    [
      "Received: by mx.google.com; Sat, 09 May 2026 20:22:48 -0700 (PDT)",
      "X-Received: by mx.google.com; Sat, 09 May 2026 20:22:47 -0700 (PDT)",
      "From: sender@example.com",
      "To: receiver@example.com",
      "Date: Sun, 12 Jan 2612 15:12:10 GMT",
      "Subject: Invalid provider date",
      "",
      "The receipt timestamp is authoritative when provider dates are unusable.",
    ].join("\r\n"),
  );

  const parsed = await parseGmailMessage({
    id: "invalid-date-message",
    threadId: "invalid-date-thread",
    internalDate: "-1",
    raw: malformedDateMime.toString("base64url"),
  });

  assert.equal(parsed.internalDate, "-1");
  assert.equal(parsed.sentAt, "2026-05-10T03:22:48.000Z");
});

test("centuries-future message dates remain unavailable without receipt evidence", async () => {
  const malformedDateMime = Buffer.from(
    [
      "From: sender@example.com",
      "To: receiver@example.com",
      "Date: Sun, 12 Jan 2612 15:12:10 GMT",
      "Subject: Invalid provider date",
      "",
      "No trustworthy receipt timestamp is available.",
    ].join("\r\n"),
  );

  const parsed = await parseGmailMessage({
    id: "future-date-message",
    threadId: "future-date-thread",
    internalDate: "32504713930000",
    raw: malformedDateMime.toString("base64url"),
  });

  assert.equal(parsed.sentAt, null);
});

test("raw MIME parsing rejects Gmail responses without MIME bytes", async () => {
  await assert.rejects(
    parseGmailMessage({
      id: "missing-raw",
      threadId: "thread",
      raw: "",
    }),
    /did not include raw MIME data/,
  );
});
