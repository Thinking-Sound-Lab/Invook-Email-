import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const mailPageSource = readFileSync(
  new URL("../../app/mail/page.tsx", import.meta.url),
  "utf8",
);
const mailLayoutSource = readFileSync(
  new URL("../../app/mail/layout.tsx", import.meta.url),
  "utf8",
);

test("mailbox account navigation preserves the active compose session", () => {
  assert.match(mailPageSource, /centerPane = <ComposeSurface \/>;/);
  assert.doesNotMatch(mailPageSource, /<ComposeSurface[^>]*\bkey=/);
});

test("mail workspace bounds its row for internal compose scrolling", () => {
  assert.match(mailLayoutSource, /grid-rows-\[minmax\(0,1fr\)\]/);
});
