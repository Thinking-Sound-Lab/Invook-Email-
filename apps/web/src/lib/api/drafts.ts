import type {
  AiReplyDraft,
  AiReplyDraftResponse,
  CreateAiReplyDraftRequest,
  UpdateAiReplyDraftRequest,
} from "@invook/contracts";
import axios from "axios";

export interface GenerateReplyDraftInput {
  threadId: string;
  instruction: string;
}

export async function generateReplyDraft({
  threadId,
  instruction,
}: GenerateReplyDraftInput): Promise<AiReplyDraft> {
  const request: CreateAiReplyDraftRequest = { instruction };
  const response = await axios.post<AiReplyDraftResponse>(
    `/v1/threads/${threadId}/drafts`,
    request,
  );
  return response.data.draft;
}

export interface UpdateReplyDraftInput {
  draftId: string;
  currentText: string;
}

export async function updateReplyDraft({
  draftId,
  currentText,
}: UpdateReplyDraftInput): Promise<AiReplyDraft> {
  const request: UpdateAiReplyDraftRequest = { currentText };
  const response = await axios.patch<AiReplyDraftResponse>(`/v1/drafts/${draftId}`, request);
  return response.data.draft;
}
