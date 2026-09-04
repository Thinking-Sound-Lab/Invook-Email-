/**
 * Environment parsing shared by the Temporal configuration and the Activity
 * implementations. Every reader validates eagerly so a misconfigured container
 * fails at startup rather than mid-Workflow.
 */
export function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

export function parseNonNegativeInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return parsed;
}

export function requiredEnvironmentValue(
  value: string | undefined,
  name: string,
): string {
  const normalized = value?.trim() ?? "";
  if (!normalized) throw new Error(`${name} is required for Temporal Cloud.`);
  return normalized;
}
