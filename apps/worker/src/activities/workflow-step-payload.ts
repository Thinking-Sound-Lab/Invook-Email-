/**
 * Workflow step payloads round-trip through JSONB, so every field a durable
 * handler reads is narrowed here before use.
 */
export function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is missing.`);
  }
  return value;
}
