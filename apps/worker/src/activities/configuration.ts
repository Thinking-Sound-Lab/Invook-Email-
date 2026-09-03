/**
 * Process-wide Activity configuration. Read once at startup so a misconfigured
 * container fails before it polls a Task Queue.
 */
import { createObjectStorage } from "@invook/object-storage";

export const encryptionKey = process.env.TOKEN_ENCRYPTION_KEY ?? "";
export const googleClientId = process.env.GMAIL_GOOGLE_CLIENT_ID ?? "";
export const googleClientSecret = process.env.GMAIL_GOOGLE_CLIENT_SECRET ?? "";
export const feedbackBatchSize = 24;
export const credentialRenewalWindowMs = 5 * 60 * 1_000;
export const objectStorage = createObjectStorage();
export const terminalProviderBatchStates = new Set([
  "completed",
  "failed",
  "expired",
  "cancelled",
]);
