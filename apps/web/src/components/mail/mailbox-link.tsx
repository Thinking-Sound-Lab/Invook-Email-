"use client";

import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from "react";

export interface MailboxLinkProps
  extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  href: string;
  children: ReactNode;
}

function isPlainLeftClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

/**
 * Moves to a mailbox address without a server navigation. `pushState` is
 * integrated with the router, so `useSearchParams` re-renders the surfaces
 * while the address stays shareable and the history stack stays intact.
 */
export function navigateMailbox(href: string): void {
  if (href === `${window.location.pathname}${window.location.search}`) return;
  window.history.pushState(null, "", href);
}

/**
 * Moves between mailbox surfaces without a server navigation.
 *
 * Every surface reads its data from the client cache, so the route only needs
 * the address to change. Modified clicks keep the anchor's native behavior so
 * opening a thread in a new tab still works.
 */
export function MailboxLink({
  href,
  children,
  onClick,
  ...anchorProps
}: MailboxLinkProps) {
  return (
    <a
      href={href}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || !isPlainLeftClick(event)) return;
        event.preventDefault();
        navigateMailbox(href);
      }}
      {...anchorProps}
    >
      {children}
    </a>
  );
}
