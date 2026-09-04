import { parsePositiveInteger } from "../../temporal/environment";

/**
 * Bounds how many Gmail message bodies one Activity fetches in parallel. This
 * is a provider quota control, independent of how many Activities Temporal
 * runs concurrently.
 */
export const gmailContentConcurrency = parsePositiveInteger(
  process.env.GMAIL_CONTENT_CONCURRENCY,
  5,
  "GMAIL_CONTENT_CONCURRENCY",
);
