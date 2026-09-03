/**
 * Resolves a connected Gmail account into a usable credential, renewing the
 * access token when it is close to expiry.
 */
import {
  decryptGoogleCredential,
  encryptGoogleCredential,
  getWorkerAccount,
  updateStoredCredential,
  type GoogleCredential,
  type DatabaseExecutor,
} from "@invook/database";
import { refreshGoogleAccessToken } from "@invook/gmail";

import {
  credentialRenewalWindowMs,
  encryptionKey,
  googleClientId,
  googleClientSecret,
} from "../configuration";

async function refreshCredentialIfRequired(
  accountId: string,
  credential: GoogleCredential,
  database?: DatabaseExecutor,
): Promise<GoogleCredential> {
  const expiresSoon =
    Date.parse(credential.expiresAt) <= Date.now() + credentialRenewalWindowMs;
  if (!expiresSoon) return credential;

  if (!googleClientId || !googleClientSecret) {
    throw new Error(
      "The worker needs GMAIL_GOOGLE_CLIENT_ID and GMAIL_GOOGLE_CLIENT_SECRET to refresh Gmail access.",
    );
  }

  const refreshed = await refreshGoogleAccessToken({
    refreshToken: credential.refreshToken,
    clientId: googleClientId,
    clientSecret: googleClientSecret,
  });
  const nextCredential: GoogleCredential = {
    ...credential,
    accessToken: refreshed.accessToken,
    expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000).toISOString(),
    scopes: refreshed.scope?.split(" ").filter(Boolean) ?? credential.scopes,
  };

  await updateStoredCredential(
    accountId,
    encryptGoogleCredential(nextCredential, encryptionKey),
    database,
  );

  return nextCredential;
}

export async function getMailSyncContext(accountId: string, database?: DatabaseExecutor) {
  const account = await getWorkerAccount(accountId, database);
  if (!account) {
    throw new Error("The connected Gmail account or credential was not found.");
  }
  const storedCredential = decryptGoogleCredential(account.tokenCiphertext, encryptionKey);
  const credential = await refreshCredentialIfRequired(
    accountId,
    storedCredential,
    database,
  );
  return { account, credential };
}
