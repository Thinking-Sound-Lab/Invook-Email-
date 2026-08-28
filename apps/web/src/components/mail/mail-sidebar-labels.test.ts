import assert from "node:assert/strict";
import test from "node:test";

import type { MailboxAccountLabel } from "@invook/contracts";

import { listSidebarLabels } from "./mail-sidebar-labels";

function label(
  overrides: Partial<MailboxAccountLabel> &
    Pick<MailboxAccountLabel, "id" | "name" | "normalizedName">,
): MailboxAccountLabel {
  return {
    description: "Requires a reply",
    systemKey: null,
    definitionVersion: 1,
    isEnabled: true,
    ...overrides,
  };
}

test("sidebar labels contain only sorted Invook label definitions", () => {
  const labels = listSidebarLabels([
    label({
      id: "custom-label",
      name: "Action needed",
      normalizedName: "action needed",
    }),
    label({
      id: "newsletter-label",
      name: "Newsletter",
      normalizedName: "newsletter",
      description: "Recurring editorial mail",
      systemKey: "newsletter",
    }),
  ]);

  assert.deepEqual(labels, [
    { id: "custom-label", name: "Action needed", labelIds: ["custom-label"] },
    {
      id: "newsletter-label",
      name: "Newsletter",
      labelIds: ["newsletter-label"],
    },
  ]);
});

test("sidebar labels merge account labels that share a stored identity", () => {
  const labels = listSidebarLabels([
    label({
      id: "first-billing",
      name: "Billing",
      normalizedName: "billing",
      systemKey: "billing",
    }),
    label({
      id: "first-important",
      name: "Important",
      normalizedName: "important",
      systemKey: "important",
    }),
    label({
      id: "second-billing",
      name: "billing",
      normalizedName: "billing",
      systemKey: "billing",
    }),
    label({
      id: "second-receipts",
      name: "Receipts",
      normalizedName: "receipts",
    }),
  ]);

  assert.deepEqual(labels, [
    {
      id: "first-billing",
      name: "Billing",
      labelIds: ["first-billing", "second-billing"],
    },
    { id: "second-receipts", name: "Receipts", labelIds: ["second-receipts"] },
  ]);
});

test("a label stored under a different identity stays a separate entry", () => {
  const labels = listSidebarLabels([
    label({ id: "stored-invariant", name: "Irmak", normalizedName: "irmak" }),
    label({ id: "stored-locale", name: "Irmak", normalizedName: "ırmak" }),
  ]);

  assert.deepEqual(
    labels.map((entry) => entry.labelIds),
    [["stored-invariant"], ["stored-locale"]],
  );
});
