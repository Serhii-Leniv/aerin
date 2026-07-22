/**
 * Model metadata for context-window management and cost display.
 * Prices are USD per million tokens, sourced exclusively at runtime from
 * live registries (models.dev, provider list APIs) — never hardcoded.
 */

export interface ModelInfo {
  contextWindow: number;
  maxOutput: number;
  inputPerMTok?: number;
  outputPerMTok?: number;
  /** Explicitly false = the model cannot drive tools (whisper, TTS, guards). */
  toolCall?: boolean;
}

export const DEFAULT_MODEL_INFO: ModelInfo = {
  contextWindow: 200_000,
  maxOutput: 8_192,
};

/**
 * ALL model metadata is runtime-registered from live sources — the models.dev
 * registry (daily refresh) and provider list APIs. Nothing is hardcoded, so
 * displayed pricing and context windows can never silently drift from
 * reality. Unknown models get DEFAULT_MODEL_INFO (conservative) until a live
 * source fills them in.
 */
const DYNAMIC_TABLE: Record<string, ModelInfo> = {};

export function registerModelInfo(modelId: string, info: ModelInfo): void {
  DYNAMIC_TABLE[modelId] = info;
}

/** Metadata when a live source actually knows the model — no default fallback. */
export function knownModelInfo(modelId: string): ModelInfo | undefined {
  return DYNAMIC_TABLE[modelId];
}

/** Everything the live sources have registered, keyed "provider/model-id". */
export function allKnownModels(): Record<string, ModelInfo> {
  return { ...DYNAMIC_TABLE };
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
