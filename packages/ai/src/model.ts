import { createOpenAI } from "@ai-sdk/openai";

export class AiConfigurationError extends Error {
  constructor() {
    super("OPENAI_API_KEY and OPENAI_MODEL are required for mailbox analysis.");
    this.name = "AiConfigurationError";
  }
}

export type OpenAiCredentials = {
  apiKey: string;
  baseURL?: string;
};

/**
 * One OpenAI endpoint serves both live and Batch analysis, so the shared
 * credential and its optional base URL are read only here.
 */
export function readOpenAiCredentials(): OpenAiCredentials | null {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;
  const baseURL = process.env.OPENAI_BASE_URL?.trim();
  return { apiKey, ...(baseURL ? { baseURL } : {}) };
}

export function getAiModel() {
  const credentials = readOpenAiCredentials();
  const modelId = process.env.OPENAI_MODEL?.trim();
  if (!credentials || !modelId) throw new AiConfigurationError();

  return { model: createOpenAI(credentials).chat(modelId), modelId };
}

export function isAiConfigured(): boolean {
  return Boolean(readOpenAiCredentials() && process.env.OPENAI_MODEL?.trim());
}
