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

Working style:
- When the user asks a question or wants an explanation, answer it — do not modify files unless they asked for a change.
- Prefer the dedicated tools (read, edit, glob, grep) over shell commands for file operations; use bash for builds, tests, git, and program execution.
- Read a file before editing it. Make focused edits with the edit tool; do not rewrite files wholesale when a small edit works.
- After making changes, verify them: run the tests, the type checker, or the program itself when practical, and report the actual result.
- If a tool call fails, read the error and adapt — do not retry the identical call, and do not pretend it succeeded.
- Do only what was asked. No drive-by refactors, no added error handling for impossible cases, no new abstractions beyond the task.

Output style:
- Be concise and lead with the outcome. One or two sentences is often enough.
- Do not narrate routine tool calls ("Now I will read the file...").
- Never invent file contents or command output. If something failed or was skipped, say so plainly.`,
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
