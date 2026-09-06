import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const mailWorkspaceSource = readFileSync(
  new URL("./mail-workspace.tsx", import.meta.url),
  "utf8",
);
const mailLayoutSource = readFileSync(
  new URL("../../app/mail/layout.tsx", import.meta.url),
  "utf8",
);

test("mailbox account navigation preserves the active compose session", () => {
  assert.match(mailWorkspaceSource, /centerPane = <ComposeSurface \/>;/);
  assert.doesNotMatch(mailWorkspaceSource, /<ComposeSurface[^>]*\bkey=/);
});

test("mail workspace bounds its row for internal compose scrolling", () => {
  assert.match(mailLayoutSource, /grid-rows-\[minmax\(0,1fr\)\]/);
});
