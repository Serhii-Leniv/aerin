import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import type { AerinConfig } from "../config/config.js";

export interface ProviderMeta {
  name: string;
  envVar: string | undefined;
  needsKey: boolean;
}

export const PROVIDERS: Record<string, ProviderMeta> = {
  anthropic: { name: "Anthropic", envVar: "ANTHROPIC_API_KEY", needsKey: true },
  openai: { name: "OpenAI", envVar: "OPENAI_API_KEY", needsKey: true },
  google: { name: "Google", envVar: "GOOGLE_GENERATIVE_AI_API_KEY", needsKey: true },
  openrouter: { name: "OpenRouter", envVar: "OPENROUTER_API_KEY", needsKey: true },
  ollama: { name: "Ollama (local)", envVar: undefined, needsKey: false },
};

export function resolveApiKey(provider: string, config: AerinConfig): string | undefined {
  const meta = PROVIDERS[provider];
  const fromEnv = meta?.envVar ? process.env[meta.envVar] : undefined;
  return fromEnv ?? config.providers?.[provider]?.apiKey;
}

/**
 * Resolve "provider/model-id" to an AI SDK LanguageModel.
 * Keys come from env vars first, then config. Ollama needs no key.
 */
export function resolveModel(fullId: string, config: AerinConfig): LanguageModel {
  const slash = fullId.indexOf("/");
  if (slash < 1) {
    throw new Error(
      `Model must be "provider/model-id" (e.g. anthropic/claude-opus-4-8), got: ${fullId}`,
    );
  }
  const provider = fullId.slice(0, slash);
  const modelId = fullId.slice(slash + 1);
  const apiKey = resolveApiKey(provider, config);
  const baseURL = config.providers?.[provider]?.baseURL;

  const requireKey = (): string => {
    if (!apiKey) {
      const envVar = PROVIDERS[provider]?.envVar;
      throw new Error(
        `No API key for ${provider}. Set ${envVar ?? "an API key"} or add providers.${provider}.apiKey to your config.`,
      );
    }
    return apiKey;
  };

  switch (provider) {
    case "anthropic":
      return createAnthropic({ apiKey: requireKey(), ...(baseURL ? { baseURL } : {}) })(modelId);
    case "openai":
      return createOpenAI({ apiKey: requireKey(), ...(baseURL ? { baseURL } : {}) })(modelId);
    case "google":
      return createGoogleGenerativeAI({ apiKey: requireKey(), ...(baseURL ? { baseURL } : {}) })(modelId);
    case "openrouter":
      return createOpenRouter({ apiKey: requireKey(), ...(baseURL ? { baseURL } : {}) })(modelId);
    case "ollama":
      return createOpenAICompatible({
        name: "ollama",
        baseURL: baseURL ?? "http://localhost:11434/v1",
      })(modelId);
    default:
      throw new Error(
        `Unknown provider "${provider}". Supported: ${Object.keys(PROVIDERS).join(", ")}`,
      );
  }
}
