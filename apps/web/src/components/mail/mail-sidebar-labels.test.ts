import assert from "node:assert/strict";
import test from "node:test";

import type { InvookLabel } from "@invook/contracts";

import { listSidebarLabels } from "./mail-sidebar-labels";

function label(overrides: Partial<InvookLabel> & Pick<InvookLabel, "id" | "name">): InvookLabel {
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
    label({ id: "custom-label", name: "Action needed" }),
    label({
      id: "newsletter-label",
      name: "Newsletter",
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

test("sidebar labels merge account labels that share one name", () => {
  const labels = listSidebarLabels([
    label({ id: "first-billing", name: "Billing", systemKey: "billing" }),
    label({ id: "first-important", name: "Important", systemKey: "important" }),
    label({ id: "second-billing", name: "billing", systemKey: "billing" }),
    label({ id: "second-receipts", name: "Receipts" }),
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
