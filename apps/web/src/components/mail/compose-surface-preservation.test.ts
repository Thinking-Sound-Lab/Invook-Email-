import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const mailPageSource = readFileSync(
  new URL("../../app/mail/page.tsx", import.meta.url),
  "utf8",
);

test("mailbox account navigation preserves the active compose session", () => {
  assert.match(mailPageSource, /centerPane = <ComposeSurface \/>;/);
  assert.doesNotMatch(mailPageSource, /<ComposeSurface[^>]*\bkey=/);
});
