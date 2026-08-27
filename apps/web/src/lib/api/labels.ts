import type {
  CreateInvookLabelRequest,
  CreateInvookLabelResponse,
  InvookLabelPreviewResponse,
  InvookThreadLabel,
  PreviewInvookLabelRequest,
  SetInvookLabelEnabledRequest,
  SetInvookLabelEnabledResponse,
  SetThreadLabelRequest,
  ThreadLabelResponse,
} from "@invook/contracts";
import axios from "axios";

export async function createInvookLabel(
  input: CreateInvookLabelRequest,
  accountId: string,
): Promise<CreateInvookLabelResponse> {
  const response = await axios.post<CreateInvookLabelResponse>(
    "/v1/labels",
    { ...input, accountId },
  );
  return response.data;
}

export async function previewInvookLabel(
  input: PreviewInvookLabelRequest,
  accountId: string,
): Promise<InvookLabelPreviewResponse> {
  const response = await axios.post<InvookLabelPreviewResponse>(
    "/v1/labels/preview",
    { ...input, accountId },
  );
  return response.data;
}

export async function setInvookLabelEnabled(
  labelId: string,
  input: SetInvookLabelEnabledRequest,
): Promise<SetInvookLabelEnabledResponse> {
  const response = await axios.patch<SetInvookLabelEnabledResponse>(
    `/v1/labels/${labelId}/enabled`,
    input,
  );
  return response.data;
}

export interface SetThreadLabelInput extends SetThreadLabelRequest {
  threadId: string;
}

export async function setThreadLabel({
  threadId,
  labelId,
}: SetThreadLabelInput): Promise<InvookThreadLabel> {
  const request: SetThreadLabelRequest = { labelId };
  const response = await axios.patch<ThreadLabelResponse>(
    `/v1/threads/${threadId}/labels`,
    request,
  );
  return response.data.label;
}
