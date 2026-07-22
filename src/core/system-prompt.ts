import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { detectShell } from "../tools/bash.js";

const MAX_AGENTS_MD_CHARS = 20_000;

/** Walk from cwd upward collecting AGENTS.md files (nearest last, so it wins). */
export async function discoverAgentsMd(cwd: string): Promise<string[]> {
  const found: string[] = [];
  let dir = path.resolve(cwd);
  for (;;) {
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      try {
        const content = await fs.readFile(path.join(dir, name), "utf8");
        found.unshift(`# ${path.join(dir, name)}\n\n${content.slice(0, MAX_AGENTS_MD_CHARS)}`);
        break; // prefer AGENTS.md over CLAUDE.md within one directory
      } catch {
        // not present — keep walking
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}

export async function buildSystemPrompt(cwd: string, modelId: string): Promise<string> {
  const shell = detectShell();
  const agentsMd = await discoverAgentsMd(cwd);

  const sections = [
    `You are Aerin, an open-source CLI coding agent. You help the user with software engineering tasks in their working directory by reading files, searching, editing, and running commands with the provided tools.

Guidelines:
- Prefer the dedicated tools (read, edit, glob, grep) over shell commands for file operations.
- Read a file before editing it. Make focused edits; do not rewrite files wholesale when a small edit works.
- After making changes, verify them when practical (run tests, type checks, or the code itself).
- Be concise. Lead with the outcome. Do not narrate routine tool calls.
- Never invent file contents or command output. If something failed, say so plainly.`,
    `Environment:
- Working directory: ${cwd}
- Platform: ${process.platform} (${os.release()})
- Shell for the bash tool: ${shell.promptDescription}
- Model: ${modelId}
- Date: ${new Date().toDateString()}`,
  ];

  if (agentsMd.length > 0) {
    sections.push(`Project instructions from AGENTS.md files (follow these):\n\n${agentsMd.join("\n\n---\n\n")}`);
  }

  return sections.join("\n\n");
}
