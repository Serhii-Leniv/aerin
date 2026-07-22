import fs from "node:fs/promises";
import path from "node:path";
import { GLOBAL_CONFIG_DIR } from "../config/paths.js";

/**
 * Skills: reusable instruction packs, Claude Code-compatible layout — a
 * directory per skill containing SKILL.md with YAML-ish frontmatter
 * (name, description). Discovered from, in order of precedence:
 *   <cwd>/.aerin/skills/<name>/SKILL.md
 *   <cwd>/.claude/skills/<name>/SKILL.md   (compatibility with Claude Code)
 *   <global config dir>/skills/<name>/SKILL.md
 * The list (name + description) goes into the system prompt; the body is
 * loaded on demand via the skill tool.
 */

export interface Skill {
  name: string;
  description: string;
  /** Absolute path to SKILL.md. */
  file: string;
  /** Directory of the skill — reference files live beside SKILL.md. */
  dir: string;
}

function parseFrontmatter(raw: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!m) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const kv = /^(name|description):\s*(.+)$/.exec(line.trim());
    if (kv?.[1] === "name") out.name = kv[2]?.trim().replace(/^["']|["']$/g, "");
    if (kv?.[1] === "description") out.description = kv[2]?.trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

async function scanDir(root: string, skills: Map<string, Skill>): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    const dir = path.join(root, entry);
    const file = path.join(dir, "SKILL.md");
    try {
      const raw = await fs.readFile(file, "utf8");
      const fm = parseFrontmatter(raw);
      const name = fm.name ?? entry;
      if (skills.has(name)) continue; // earlier roots win
      skills.set(name, {
        name,
        description: fm.description ?? "(no description)",
        file,
        dir,
      });
    } catch {
      continue; // not a skill dir
    }
  }
}

export async function discoverSkills(cwd: string): Promise<Skill[]> {
  const skills = new Map<string, Skill>();
  await scanDir(path.join(cwd, ".aerin", "skills"), skills);
  await scanDir(path.join(cwd, ".claude", "skills"), skills);
  await scanDir(path.join(GLOBAL_CONFIG_DIR, "skills"), skills);
  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Read a skill's full body (frontmatter stripped). */
export async function loadSkillBody(skill: Skill): Promise<string> {
  const raw = await fs.readFile(skill.file, "utf8");
  return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}
