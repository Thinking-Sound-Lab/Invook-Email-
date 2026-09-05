import type { MailRowLabel } from "./mail-row-labels";

const MAIL_LABEL_COLOR_CLASSES = [
  "bg-pill-brown text-pill-brown-foreground",
  "bg-pill-purple text-pill-purple-foreground",
  "bg-pill-blue text-pill-blue-foreground",
  "bg-pill-red text-pill-red-foreground",
  "bg-pill-pink text-pill-pink-foreground",
  "bg-pill-yellow text-pill-yellow-foreground",
  "bg-pill-green text-pill-green-foreground",
  "bg-pill-orange text-pill-orange-foreground",
] as const;

export function mailLabelColorClassName(
  label: Pick<MailRowLabel, "id" | "kind">,
): string {
  const identity = `${label.kind}:${label.id}`;
  let hash = 2_166_136_261;

  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }

  return MAIL_LABEL_COLOR_CLASSES[(hash >>> 0) % MAIL_LABEL_COLOR_CLASSES.length];
}
