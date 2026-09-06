import assert from "node:assert/strict";
import test from "node:test";

import type { MailboxAccount } from "@invook/contracts";

import { accountRingClassName } from "./mail-account-avatar";
import {
  createMailboxHref,
  resolveMailboxAccountSelection,
  selectedSidebarCounts,
} from "./mail-account-scope";

const accounts = ["first", "second"].map((id) => ({
  id,
  email: `${id}@example.test`,
  image: null,
  status: "connected",
  syncState: { mailSync: "complete", memory: "complete" },
  lastSyncedAt: null,
  replica: { state: "ready", readyAt: null },
})) satisfies MailboxAccount[];

test("mailbox account selection defaults invalid and omitted values to All", () => {
  assert.equal(resolveMailboxAccountSelection(null, accounts), "all");
  assert.equal(resolveMailboxAccountSelection("unknown", accounts), "all");
  assert.equal(resolveMailboxAccountSelection("second", accounts), "second");
});

test("account switching preserves a static view and closes the open thread", () => {
  const href = createMailboxHref(
    new URLSearchParams("account=first&view=starred&thread=thread"),
    { account: "second", thread: null },
  );
  assert.equal(href, "/mail?account=second&view=starred");
});

test("sidebar counts follow the selected Inbox scope", () => {
  const counts = {
    all: { views: { all: 3, important: 0, starred: 2, drafts: 0, sent: 0, spam: 0, trash: 0 }, labels: {} },
    accounts: {
      first: { views: { all: 1, important: 0, starred: 1, drafts: 0, sent: 0, spam: 0, trash: 0 }, labels: {} },
      second: { views: { all: 2, important: 0, starred: 1, drafts: 0, sent: 0, spam: 0, trash: 0 }, labels: {} },
    },
  };
  assert.equal(selectedSidebarCounts(counts, "all")?.views.all, 3);
  assert.equal(selectedSidebarCounts(counts, "second")?.views.all, 2);
});

test("connected accounts retain distinct stable avatar ring colors", () => {
  assert.equal(accountRingClassName("first", accounts), "ring-blue-500");
  assert.equal(accountRingClassName("second", accounts), "ring-emerald-500");
  assert.notEqual(
    accountRingClassName("first", accounts),
    accountRingClassName("second", accounts),
  );
});
