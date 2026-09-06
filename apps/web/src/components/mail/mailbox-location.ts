import { mailboxViews } from "@invook/contracts";
import { validate as validateUuid } from "uuid";

import type { MailboxView, MailSurface, StaticMailboxView } from "./types";

const mailboxViewSet = new Set<string>(mailboxViews);

const mailSurfaces = new Set<MailSurface>([
  "mail",
  "compose",
  "search",
  "automations",
]);

/**
 * One reading of a mailbox address, shared by the server render and the client
 * surfaces. Both sides must agree on what a request means, otherwise a cached
 * view and a rendered view can disagree about which address they belong to.
 */
export function normalizeMailboxView(
  value: string | null | undefined,
): MailboxView {
  if (value && mailboxViewSet.has(value)) return value as StaticMailboxView;
  if (value?.startsWith("label:")) {
    const labelId = value.slice("label:".length);
    if (validateUuid(labelId)) return `label:${labelId}`;
  }
  return "all";
}

export function normalizeMailSurface(
  value: string | null | undefined,
): MailSurface {
  return value && mailSurfaces.has(value as MailSurface)
    ? (value as MailSurface)
    : "mail";
}

export function normalizeMailboxAccount(
  value: string | null | undefined,
): string {
  return value === "all" || (value && validateUuid(value)) ? value : "all";
}
