/**
 * Keeps stored draft resources aligned with the provider after a sync page or a
 * history change touches them.
 */
import {
  saveGmailDraftResource,
  deleteGmailDraftResourceByMessageId,
  replaceGmailDraftResources,
} from "@invook/database";
import {
  getGmailDraft,
  listGmailDrafts,
  parseGmailMessage,
} from "@invook/gmail";

import { storeMessage } from "./messages";

export async function syncGmailDraftResources(options: {
  accessToken: string;
  userId: string;
  accountId: string;
  accountEmail: string;
  ingestionMode: "initial" | "incremental";
  notify?: boolean;
}) {
  let pageToken: string | undefined;
  const drafts: Array<{
    providerDraftId: string;
    providerMessageId: string;
    providerThreadId: string;
    providerHistoryId: string | null;
    providerMetadata: Record<string, unknown>;
  }> = [];
  do {
    const page = await listGmailDrafts(options.accessToken, {
      maxResults: 100,
      pageToken,
    });
    for (const reference of page.drafts ?? []) {
      const draft = await getGmailDraft(options.accessToken, reference.id);
      const parsed = await parseGmailMessage(draft.message);
      await storeMessage({
        userId: options.userId,
        accountId: options.accountId,
        accountEmail: options.accountEmail,
        message: parsed,
        ingestionMode: options.ingestionMode,
      });
      drafts.push({
        providerDraftId: draft.id,
        providerMessageId: draft.message.id,
        providerThreadId: draft.message.threadId,
        providerHistoryId: draft.message.historyId ?? null,
        providerMetadata: {
          labelIds: parsed.labelIds,
          snippet: draft.message.snippet ?? null,
          internalDate: draft.message.internalDate ?? null,
          sizeEstimate: draft.message.sizeEstimate ?? null,
        },
      });
    }
    pageToken = page.nextPageToken;
  } while (pageToken);

  await replaceGmailDraftResources({
    userId: options.userId,
    accountId: options.accountId,
    drafts,
    notify: options.notify,
  });
  return drafts;
}

export async function refreshAffectedGmailDraftResources(options: {
  accessToken: string;
  userId: string;
  accountId: string;
  accountEmail: string;
  providerMessageIds: string[];
  ingestionMode: "initial" | "incremental";
}) {
  const affectedProviderMessageIds = new Set(options.providerMessageIds);
  if (affectedProviderMessageIds.size === 0) return;

  let pageToken: string | undefined;
  const draftsByMessageId = new Map<
    string,
    { providerDraftId: string; providerMessageId: string }
  >();
  do {
    const page = await listGmailDrafts(options.accessToken, {
      maxResults: 100,
      pageToken,
    });
    for (const reference of page.drafts ?? []) {
      if (affectedProviderMessageIds.has(reference.message.id)) {
        draftsByMessageId.set(reference.message.id, {
          providerDraftId: reference.id,
          providerMessageId: reference.message.id,
        });
      }
    }
    pageToken = page.nextPageToken;
  } while (pageToken);

  for (const providerMessageId of affectedProviderMessageIds) {
    const reference = draftsByMessageId.get(providerMessageId);
    if (!reference) {
      await deleteGmailDraftResourceByMessageId({
        userId: options.userId,
        accountId: options.accountId,
        providerMessageId,
      });
      continue;
    }
    const draft = await getGmailDraft(options.accessToken, reference.providerDraftId);
    const parsed = await parseGmailMessage(draft.message);
    await storeMessage({
      userId: options.userId,
      accountId: options.accountId,
      accountEmail: options.accountEmail,
      message: parsed,
      ingestionMode: options.ingestionMode,
    });
    await saveGmailDraftResource({
      userId: options.userId,
      accountId: options.accountId,
      notify: true,
      draft: {
        providerDraftId: draft.id,
        providerMessageId: draft.message.id,
        providerThreadId: draft.message.threadId,
        providerHistoryId: draft.message.historyId ?? null,
        providerMetadata: {
          labelIds: parsed.labelIds,
          snippet: draft.message.snippet ?? null,
          internalDate: draft.message.internalDate ?? null,
          sizeEstimate: draft.message.sizeEstimate ?? null,
        },
      },
    });
  }
}
