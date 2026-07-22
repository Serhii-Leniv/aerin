/**
 * Static model metadata for context-window management and cost display.
 * Prices are USD per million tokens and are approximate — verify against
 * each provider's pricing page. Unknown models fall back to DEFAULT_MODEL_INFO.
 */

export interface ModelInfo {
  contextWindow: number;
  maxOutput: number;
  inputPerMTok?: number;
  outputPerMTok?: number;
}

export const DEFAULT_MODEL_INFO: ModelInfo = {
  contextWindow: 200_000,
  maxOutput: 8_192,
};

export const MODEL_TABLE: Record<string, ModelInfo> = {
  // Anthropic (verified 2026-07)
  "anthropic/claude-opus-4-8": { contextWindow: 1_000_000, maxOutput: 128_000, inputPerMTok: 5, outputPerMTok: 25 },
  "anthropic/claude-opus-4-7": { contextWindow: 1_000_000, maxOutput: 128_000, inputPerMTok: 5, outputPerMTok: 25 },
  "anthropic/claude-sonnet-5": { contextWindow: 1_000_000, maxOutput: 128_000, inputPerMTok: 3, outputPerMTok: 15 },
  "anthropic/claude-sonnet-4-6": { contextWindow: 1_000_000, maxOutput: 128_000, inputPerMTok: 3, outputPerMTok: 15 },
  "anthropic/claude-haiku-4-5": { contextWindow: 200_000, maxOutput: 64_000, inputPerMTok: 1, outputPerMTok: 5 },
  // OpenAI / Google / OpenRouter / Ollama entries are best-effort; extend as needed.
  "openai/gpt-4.1": { contextWindow: 1_000_000, maxOutput: 32_768 },
  "openai/gpt-4o": { contextWindow: 128_000, maxOutput: 16_384 },
  "google/gemini-flash-latest": { contextWindow: 1_000_000, maxOutput: 65_536 },
  "google/gemini-pro-latest": { contextWindow: 1_000_000, maxOutput: 65_536 },
  "google/gemini-3-flash-preview": { contextWindow: 1_000_000, maxOutput: 65_536 },
  "google/gemini-3-pro-preview": { contextWindow: 1_000_000, maxOutput: 65_536 },
  // xAI (best effort — verify against x.ai pricing)
  "xai/grok-4": { contextWindow: 256_000, maxOutput: 64_000, inputPerMTok: 3, outputPerMTok: 15 },
  "xai/grok-code-fast-1": { contextWindow: 256_000, maxOutput: 32_000, inputPerMTok: 0.2, outputPerMTok: 1.5 },
};

/** Runtime-registered metadata (e.g. from the models.dev registry). */
const DYNAMIC_TABLE: Record<string, ModelInfo> = {};

export function registerModelInfo(modelId: string, info: ModelInfo): void {
  DYNAMIC_TABLE[modelId] = info;
}

/** Metadata when we actually know the model — no default fallback. */
export function knownModelInfo(modelId: string): ModelInfo | undefined {
  return MODEL_TABLE[modelId] ?? DYNAMIC_TABLE[modelId];
}

export function modelInfo(modelId: string): ModelInfo {
  return knownModelInfo(modelId) ?? DEFAULT_MODEL_INFO;
}

export function estimateCostUsd(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): number | undefined {
  const info = knownModelInfo(modelId);
  if (!info || info.inputPerMTok === undefined || info.outputPerMTok === undefined) return undefined;
  return (inputTokens / 1e6) * info.inputPerMTok + (outputTokens / 1e6) * info.outputPerMTok;
}
