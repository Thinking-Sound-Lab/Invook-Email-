function decodeCharacterReference(reference: string, value: string): string {
  if (reference === "amp") return "&";
  if (reference === "lt") return "<";
  if (reference === "gt") return ">";
  if (reference === "quot") return '"';
  if (reference === "apos" || reference === "#39") return "'";
  if (reference === "nbsp") return " ";

  const numeric = reference.startsWith("#x")
    ? Number.parseInt(reference.slice(2), 16)
    : reference.startsWith("#")
      ? Number.parseInt(reference.slice(1), 10)
      : Number.NaN;

  return Number.isInteger(numeric) && numeric >= 0 && numeric <= 0x10ffff
    ? String.fromCodePoint(numeric)
    : value;
}

export function decodeMailEntities(value: string): string {
  let decoded = value;
  for (let pass = 0; pass < 3; pass += 1) {
    const next = decoded.replace(
      /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
      (match, reference: string) =>
        decodeCharacterReference(reference.toLowerCase(), match),
    );
    if (next === decoded) break;
    decoded = next;
  }

  return decoded.replace(
    /[\u034f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g,
    "",
  );
}

export function formatMailBody(value: string): string {
  return decodeMailEntities(value)
    .replace(/\r/g, "")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
