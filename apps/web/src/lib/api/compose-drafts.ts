import type {
  CreateGmailComposeDraftRequest,
  GmailComposeDraftResponse,
  GmailComposeSendResponse,
  SendGmailComposeDraftRequest,
} from "@invook/contracts";
import axios from "axios";

export async function createGmailComposeDraft(
  request: CreateGmailComposeDraftRequest,
): Promise<GmailComposeDraftResponse> {
  const response = await axios.post<GmailComposeDraftResponse>(
    "/v1/gmail/compose-drafts",
    request,
  );
  return response.data;
}

export async function sendGmailComposeDraft(
  providerDraftId: string,
  request: SendGmailComposeDraftRequest,
): Promise<GmailComposeSendResponse> {
  const response = await axios.post<GmailComposeSendResponse>(
    `/v1/gmail/compose-drafts/${encodeURIComponent(providerDraftId)}/send`,
    request,
  );
  return response.data;
}
