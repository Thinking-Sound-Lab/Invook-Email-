import type {
  DeletedResourceResponse,
  MemoryEntry,
  MemoryEntryResponse,
  SaveMemoryRequest,
} from "@invook/contracts";
import axios from "axios";

export interface SaveMemoryInput extends SaveMemoryRequest {
  accountId: string;
  memoryId?: string;
}

export async function saveMemory({
  memoryId,
  accountId,
  type,
  contactEmail,
  statement,
}: SaveMemoryInput): Promise<MemoryEntry> {
  const request: SaveMemoryRequest & { accountId?: string } = {
    type,
    contactEmail,
    statement,
    ...(!memoryId ? { accountId } : {}),
  };
  const response = memoryId
    ? await axios.patch<MemoryEntryResponse>(`/v1/memories/${memoryId}`, request)
    : await axios.post<MemoryEntryResponse>("/v1/memories", request);
  return response.data.memory;
}

export async function deleteMemory(memoryId: string): Promise<void> {
  await axios.delete<DeletedResourceResponse>(`/v1/memories/${memoryId}`);
}
