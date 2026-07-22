/**
 * Curated connect catalog (opencode-style): providers users can hook up by
 * just picking a name and pasting a key. Built-ins route through their native
 * SDK adapters; entries with a baseURL ride the OpenAI-compatible adapter.
 */
export interface CatalogEntry {
  /** Provider id as used in "provider/model-id" and config.providers. */
  id: string;
  name: string;
  /** Preset endpoint for OpenAI-compatible providers; omit for built-ins. */
  baseURL?: string;
  needsKey: boolean;
  /** Provider offers a usable free tier — surfaced in the model picker. */
  freeTier?: boolean;
}

export const PROVIDER_CATALOG: CatalogEntry[] = [
  { id: "anthropic", name: "Anthropic (Claude)", needsKey: true },
  { id: "openai", name: "OpenAI (GPT)", needsKey: true },
  { id: "google", name: "Google (Gemini)", needsKey: true, freeTier: true },
  { id: "openrouter", name: "OpenRouter (300+ models)", needsKey: true },
  { id: "xai", name: "xAI (Grok)", needsKey: true },
  { id: "deepseek", name: "DeepSeek", baseURL: "https://api.deepseek.com/v1", needsKey: true },
  { id: "groq", name: "Groq (fast open models)", baseURL: "https://api.groq.com/openai/v1", needsKey: true, freeTier: true },
  { id: "moonshot", name: "Moonshot (Kimi)", baseURL: "https://api.moonshot.ai/v1", needsKey: true },
  { id: "mistral", name: "Mistral", baseURL: "https://api.mistral.ai/v1", needsKey: true },
  { id: "together", name: "Together AI", baseURL: "https://api.together.xyz/v1", needsKey: true },
  { id: "fireworks", name: "Fireworks AI", baseURL: "https://api.fireworks.ai/inference/v1", needsKey: true },
  { id: "cerebras", name: "Cerebras (ultra fast)", baseURL: "https://api.cerebras.ai/v1", needsKey: true, freeTier: true },
  { id: "zai", name: "Z.ai (GLM)", baseURL: "https://api.z.ai/api/paas/v4", needsKey: true },
  { id: "lmstudio", name: "LM Studio (local)", baseURL: "http://localhost:1234/v1", needsKey: false },
];

export function catalogEntry(id: string): CatalogEntry | undefined {
  return PROVIDER_CATALOG.find((e) => e.id === id);
}
