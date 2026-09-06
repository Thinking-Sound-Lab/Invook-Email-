import sanitizeHtml from "sanitize-html";

import { formatMailBody } from "./mail-body";

/**
 * Projects stored email HTML to readable text.
 *
 * This is the only mail-body helper that needs an HTML parser, so it lives
 * apart from the browser-safe text helpers and keeps the sanitizer out of the
 * client bundle.
 */
export function buildEmailPlainText(bodyHtml: string): string {
  const separatedHtml = bodyHtml.replace(
    /<\/?(?:br|p|div|li|tr|h[1-6]|blockquote)\b[^>]*>/gi,
    "\n$&",
  );
  return formatMailBody(
    sanitizeHtml(separatedHtml, {
      allowedTags: [],
      allowedAttributes: {},
      nonTextTags: ["script", "style", "textarea", "option", "title", "head"],
    }),
  );
}
