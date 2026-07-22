import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { GLOBAL_CONFIG_FILE, projectSettingsFile } from "./paths.js";

const mcpServerSchema = z.union([
  z.object({
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
  }),
  z.object({
    url: z.string().url(),
    headers: z.record(z.string()).optional(),
  }),
]);

const providerSchema = z.object({
  apiKey: z.string().optional(),
  baseURL: z.string().optional(),
});

export const configSchema = z.object({
  model: z.string().optional(),
  /** Optional cheaper model for the agent (sub-agent) tool, e.g. "anthropic/claude-haiku-4-5". */
  subagentModel: z.string().optional(),
  providers: z.record(providerSchema).optional(),
  mcpServers: z.record(mcpServerSchema).optional(),
  permissions: z.object({ allow: z.array(z.string()).default([]) }).optional(),
});

export type AerinConfig = z.infer<typeof configSchema>;
export type McpServerConfig = z.infer<typeof mcpServerSchema>;

export const DEFAULT_MODEL = "anthropic/claude-opus-4-8";

async function readJsonIfExists(file: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Failed to parse ${file}: ${err instanceof Error ? err.message : err}`);
  }
}

export interface LoadedConfig {
  config: AerinConfig;
  globalConfig: AerinConfig;
  projectConfig: AerinConfig;
}

/** Merge order: global <- project <- CLI flags (flags applied by caller). */
export async function loadConfig(cwd: string): Promise<LoadedConfig> {
  const globalRaw = (await readJsonIfExists(GLOBAL_CONFIG_FILE)) ?? {};
  const projectRaw = (await readJsonIfExists(projectSettingsFile(cwd))) ?? {};
  const globalConfig = configSchema.parse(globalRaw);
  const projectConfig = configSchema.parse(projectRaw);

  const config: AerinConfig = {
    model: projectConfig.model ?? globalConfig.model,
    subagentModel: projectConfig.subagentModel ?? globalConfig.subagentModel,
    providers: { ...globalConfig.providers, ...projectConfig.providers },
    mcpServers: { ...globalConfig.mcpServers, ...projectConfig.mcpServers },
    permissions: {
      allow: [
        ...(globalConfig.permissions?.allow ?? []),
        ...(projectConfig.permissions?.allow ?? []),
      ],
    },
  };
  return { config, globalConfig, projectConfig };
}

/** Append a permission rule to the project settings file. */
export async function persistProjectRule(cwd: string, rule: string): Promise<void> {
  const file = projectSettingsFile(cwd);
  const raw = ((await readJsonIfExists(file)) ?? {}) as Record<string, unknown>;
  const perms = (raw["permissions"] ?? {}) as Record<string, unknown>;
  const allow = Array.isArray(perms["allow"]) ? (perms["allow"] as string[]) : [];
  if (!allow.includes(rule)) allow.push(rule);
  raw["permissions"] = { ...perms, allow };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(raw, null, 2) + "\n", "utf8");
}
