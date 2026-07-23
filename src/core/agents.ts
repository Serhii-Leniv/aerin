import fs from "node:fs/promises";
import path from "node:path";
import { GLOBAL_CONFIG_DIR } from "../config/paths.js";

/**
 * Named custom sub-agents, Claude Code-compatible layout: one markdown file
 * per agent whose frontmatter carries name/description (+ optional model) and
 * whose body becomes the sub-agent's system prompt. Discovered from:
 *   <cwd>/.aerin/agents/<name>.md
 *   <cwd>/.claude/agents/<name>.md   (compatibility with Claude Code)
 *   <global config dir>/agents/<name>.md
 * Named agents run read-only like the default researcher unless their
 * frontmatter opts in with `mode: worker` — then they get write/edit/bash,
 * still gated by the user's permission rules.
 */

export interface NamedAgent {
  name: string;
  description: string;
  /** Optional "provider/model-id" override for this agent. */
  model?: string;
  /** "worker" grants the write-capable toolset; anything else is read-only research. */
  mode?: "worker";
  systemPrompt: string;
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return { meta: {}, body: raw.trim() };
  const meta: Record<string, string> = {};
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.+)$/.exec(line.trim());
    if (kv?.[1] && kv[2]) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body: raw.slice(m[0].length).trim() };
}

async function scanDir(root: string, agents: Map<string, NamedAgent>): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    try {
      const raw = await fs.readFile(path.join(root, entry), "utf8");
      const { meta, body } = parseFrontmatter(raw);
      const name = meta["name"] ?? entry.slice(0, -3);
      if (agents.has(name) || !body) continue; // earlier roots win
      agents.set(name, {
        name,
        description: meta["description"] ?? "(no description)",
        ...(meta["model"] ? { model: meta["model"] } : {}),
        ...(meta["mode"] === "worker" ? { mode: "worker" as const } : {}),
        systemPrompt: body,
      });
    } catch {
      continue;
    }
  }
}

export async function discoverAgents(cwd: string): Promise<NamedAgent[]> {
  const agents = new Map<string, NamedAgent>();
  await scanDir(path.join(cwd, ".aerin", "agents"), agents);
  await scanDir(path.join(cwd, ".claude", "agents"), agents);
  await scanDir(path.join(GLOBAL_CONFIG_DIR, "agents"), agents);
  return [...agents.values()].sort((a, b) => a.name.localeCompare(b.name));
}
