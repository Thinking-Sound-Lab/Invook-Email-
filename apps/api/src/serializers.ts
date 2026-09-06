import { isAiConfigured } from "@invook/ai";
import type {
  MailboxShell,
  MailboxThreadDetail,
  SignedInUser,
} from "@invook/contracts";
import { buildEmailPlainText } from "@invook/contracts/email-plain-text";
import type {
  getMailboxShellData,
  StoredMailboxThreadDetail,
} from "@invook/database";

import { buildEmailHtmlPresentation } from "./email-html-presentation";

export function serializeMailboxShell(
  shell: NonNullable<Awaited<ReturnType<typeof getMailboxShellData>>>,
  user: SignedInUser,
): MailboxShell {
  return {
    aiConfigured: isAiConfigured(),
    user,
    accounts: shell.accounts,
    accountLabels: shell.accountLabels,
  };
}

/**
 * Turns stored message bodies into what the browser is allowed to render.
 *
 * Sanitizing here keeps raw provider HTML on the server, and because a stored
 * body never changes, the result is safe for the client to cache alongside the
 * rest of the thread.
 */
export function serializeMailboxThreadDetail(
  detail: StoredMailboxThreadDetail,
): MailboxThreadDetail {
  return {
    invookLabels: detail.invookLabels,
    thread: {
      ...detail.thread,
      messages: detail.thread.messages.map(({ bodyHtml, ...message }) => ({
        ...message,
        // An HTML-only message still needs readable text for quoting, so the
        // projection happens once here instead of shipping the markup.
        bodyText:
          message.bodyText || (bodyHtml ? buildEmailPlainText(bodyHtml) : ""),
        bodyPresentation: bodyHtml ? buildEmailHtmlPresentation(bodyHtml) : null,
      })),
    },
  };
}
