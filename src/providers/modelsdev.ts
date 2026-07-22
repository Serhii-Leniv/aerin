import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../config/paths.js";
import { registerModelInfo } from "./models.js";

/**
 * models.dev integration: a community registry of provider/model metadata
 * (pricing per MTok, context windows) — the same source opencode uses.
 * Fetched once a day, cached on disk, applied best-effort: failures are
 * silent and aerin just shows less pricing info.
 */

const API_URL = "https://models.dev/api.json";
const CACHE_FILE = path.join(DATA_DIR, "models-dev-cache.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** aerin provider id -> models.dev provider id candidates. */
const PROVIDER_ALIASES: Record<string, string[]> = {
  moonshot: ["moonshot", "moonshotai"],
  zai: ["zai", "zhipuai", "z-ai"],
  lmstudio: ["lmstudio"],
};

interface ModelsDevModel {
  cost?: { input?: number; output?: number };
  limit?: { context?: number; output?: number };
}
type ModelsDevData = Record<string, { models?: Record<string, ModelsDevModel> }>;

async function fetchRegistry(): Promise<ModelsDevData | undefined> {
  try {
    const cachedRaw = await fs.readFile(CACHE_FILE, "utf8");
    const cached = JSON.parse(cachedRaw) as { fetchedAt: number; data: ModelsDevData };
    if (Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.data;
  } catch {
    // no cache — fetch
  }
  try {
    const res = await fetch(API_URL, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return undefined;
    const data = (await res.json()) as ModelsDevData;
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(CACHE_FILE, JSON.stringify({ fetchedAt: Date.now(), data }), "utf8").catch(() => {});
    return data;
  } catch {
    return undefined;
  }
}

let primed: Promise<number> | undefined;

/**
 * Load the registry and register metadata for every model under the aerin
 * "provider/model-id" naming. Returns how many models were registered.
 * Idempotent — concurrent callers share one fetch.
 */
export function primeModelsDev(providerIds: readonly string[]): Promise<number> {
  primed ??= (async () => {
    const data = await fetchRegistry();
    if (!data) return 0;
    let count = 0;
    for (const aerinId of providerIds) {
      const candidates = PROVIDER_ALIASES[aerinId] ?? [aerinId];
      for (const devId of candidates) {
        const models = data[devId]?.models;
        if (!models) continue;
        for (const [modelId, m] of Object.entries(models)) {
          const contextWindow = m.limit?.context;
          const inputPerMTok = m.cost?.input;
          const outputPerMTok = m.cost?.output;
          if (!contextWindow && inputPerMTok === undefined) continue;
          registerModelInfo(`${aerinId}/${modelId}`, {
            contextWindow: contextWindow ?? 200_000,
            maxOutput: m.limit?.output ?? 8_192,
            ...(inputPerMTok !== undefined ? { inputPerMTok } : {}),
            ...(outputPerMTok !== undefined ? { outputPerMTok } : {}),
          });
          count++;
        }
        break; // first matching alias wins
      }
    }
    return count;
  })();
  return primed;
}
