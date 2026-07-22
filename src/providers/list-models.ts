import type { AerinConfig } from "../config/config.js";
import { resolveApiKey } from "./registry.js";

/**
 * Live model discovery: query each provider's models endpoint for whatever
 * the user's key can actually access. Nothing is hardcoded — the static
 * MODEL_TABLE is only pricing/context metadata for models we recognize.
 * Providers without a configured key are skipped; failures degrade to
 * warnings, never crashes.
 */

export interface DiscoveredModel {
  /** Full id usable everywhere: "provider/model-id" */
  id: string;
  provider: string;
}

export interface DiscoveryResult {
  models: DiscoveredModel[];
  warnings: string[];
}

const FETCH_TIMEOUT_MS = 10_000;

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

type Lister = (config: AerinConfig) => Promise<string[] | undefined>;

const listers: Record<string, Lister> = {
  async anthropic(config) {
    const key = resolveApiKey("anthropic", config);
    if (!key) return undefined;
    const data = (await fetchJson("https://api.anthropic.com/v1/models?limit=100", {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    })) as { data?: { id: string }[] };
    return (data.data ?? []).map((m) => m.id);
  },

  async openai(config) {
    const key = resolveApiKey("openai", config);
    if (!key) return undefined;
    const data = (await fetchJson("https://api.openai.com/v1/models", {
      Authorization: `Bearer ${key}`,
    })) as { data?: { id: string }[] };
    // The OpenAI list includes embeddings/audio/etc — keep chat-capable families.
    return (data.data ?? [])
      .map((m) => m.id)
      .filter((id) => /^(gpt|o[0-9]|chatgpt)/.test(id) && !/embedding|audio|tts|whisper|image|dall-e|realtime|transcribe/.test(id));
  },

  async google(config) {
    const key = resolveApiKey("google", config);
    if (!key) return undefined;
    const data = (await fetchJson(
      `https://generativelanguage.googleapis.com/v1beta/models?pageSize=100&key=${encodeURIComponent(key)}`,
    )) as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
    return (data.models ?? [])
      .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
      .map((m) => m.name.replace(/^models\//, ""))
      .filter((id) => !/embedding|aqa|tts|image/.test(id));
  },

  async openrouter(config) {
    const key = resolveApiKey("openrouter", config);
    if (!key) return undefined; // listing works keyless, but showing models you can't call is noise
    const data = (await fetchJson("https://openrouter.ai/api/v1/models")) as {
      data?: { id: string }[];
    };
    return (data.data ?? []).map((m) => m.id);
  },

  async ollama(config) {
    const baseURL = config.providers?.["ollama"]?.baseURL ?? "http://localhost:11434/v1";
    const root = baseURL.replace(/\/v1\/?$/, "");
    try {
      const data = (await fetchJson(`${root}/api/tags`)) as { models?: { name: string }[] };
      return (data.models ?? []).map((m) => m.name);
    } catch {
      return undefined; // Ollama simply not running — not a warning-worthy failure
    }
  },
};

export async function discoverModels(config: AerinConfig): Promise<DiscoveryResult> {
  const models: DiscoveredModel[] = [];
  const warnings: string[] = [];

  await Promise.all(
    Object.entries(listers).map(async ([provider, list]) => {
      try {
        const ids = await list(config);
        if (!ids) return; // no key / not running — silently skipped
        for (const id of ids) models.push({ id: `${provider}/${id}`, provider });
      } catch (err) {
        warnings.push(`${provider}: model list unavailable (${err instanceof Error ? err.message : err})`);
      }
    }),
  );

  models.sort((a, b) => a.id.localeCompare(b.id));
  return { models, warnings };
}
