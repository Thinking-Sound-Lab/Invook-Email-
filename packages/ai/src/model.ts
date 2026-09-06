import { createOpenAI } from "@ai-sdk/openai";

export class AiConfigurationError extends Error {
  constructor() {
    super("OPENAI_API_KEY is required for mailbox analysis.");
    this.name = "AiConfigurationError";
  }
}

/**
 * Live per-thread classification and the historical label Batch classify
 * against the same model, so one default serves both while each keeps its own
 * environment override.
 */
export const DEFAULT_LABEL_MODEL = "gpt-5.6-luna";

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
  if (!credentials) throw new AiConfigurationError();

  const modelId = process.env.OPENAI_MODEL?.trim() || DEFAULT_LABEL_MODEL;
  return { model: createOpenAI(credentials).chat(modelId), modelId };
}

export function isAiConfigured(): boolean {
  return readOpenAiCredentials() !== null;
}
