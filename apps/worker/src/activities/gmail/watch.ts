/**
 * Gmail push notification registration. `users.watch` is per mailbox, so a
 * second call refreshes the existing registration rather than adding one.
 */
import { getGmailWatchContext } from "@invook/database";

import { renewGmailConnectionWatch } from "./watch-lifecycle";

function gmailPubSubTopic(): string {
  const topicName = process.env.GMAIL_PUBSUB_TOPIC?.trim();
  if (!topicName) {
    throw new Error("GMAIL_PUBSUB_TOPIC is required for Gmail watch state.");
  }
  return topicName;
}

export async function renewGmailWatch(accountId: string, accessToken: string) {
  return renewGmailConnectionWatch({
    accountId, accessToken, topicName: gmailPubSubTopic(),
  });
}

export async function ensureGmailWatch(accountId: string, accessToken: string) {
  const watch = await getGmailWatchContext(accountId);
  if (watch?.status === "active" && watch.expirationAt.getTime() > Date.now()) {
    return;
  }
  await renewGmailWatch(accountId, accessToken);
}
