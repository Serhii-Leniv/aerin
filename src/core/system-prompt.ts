import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { detectShell } from "../tools/bash.js";
import type { Skill } from "./skills.js";

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

/** One-line git snapshot for the environment block; empty outside a repo. */
export async function gitContext(cwd: string): Promise<string> {
  const git = (args: string[]): Promise<string> =>
    new Promise((resolve) => {
      execFile("git", args, { cwd, timeout: 3000, windowsHide: true }, (err, stdout) =>
        resolve(err ? "" : stdout.trim()),
      );
    });
  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch) return "";
  const status = await git(["status", "--porcelain"]);
  const dirty = status ? status.split("\n").length : 0;
  const lastCommit = await git(["log", "-1", "--format=%h %s"]);
  return `Git: branch ${branch}, ${dirty === 0 ? "clean" : `${dirty} changed file${dirty === 1 ? "" : "s"}`}${lastCommit ? `, last commit: ${lastCommit.slice(0, 80)}` : ""}`;
}

export async function buildSystemPrompt(cwd: string, modelId: string, skills: readonly Skill[] = []): Promise<string> {
  const shell = detectShell();
  const agentsMd = await discoverAgentsMd(cwd);
  const git = await gitContext(cwd);

  const sections = [
    `You are Aerin, an open-source CLI coding agent. You help the user with software engineering tasks in their working directory by reading files, searching, editing, and running commands with the provided tools.

Working style:
- When the user asks a question or wants an explanation, answer it — do not modify files unless they asked for a change.
- Prefer the dedicated tools (read, edit, glob, grep) over shell commands for file operations; use bash for builds, tests, git, and program execution.
- Read a file before editing it. Make focused edits with the edit tool; do not rewrite files wholesale when a small edit works.
- After making changes, verify them: run the tests, the type checker, or the program itself when practical, and report the actual result.
- If a tool call fails, read the error and adapt — do not retry the identical call, and do not pretend it succeeded.
- Do only what was asked. No drive-by refactors, no added error handling for impossible cases, no new abstractions beyond the task.
- For broad or exploratory searches ("where is X handled?", "how does Y work across the codebase?"), delegate to the agent tool: it explores with its own context window and returns only a report, keeping this conversation small. For a single known file or a quick targeted grep, use read/grep directly.
- You can issue several agent tool calls in one turn for independent questions.
- For current external information (library docs, error messages, APIs, versions), use websearch, then webfetch on a promising result. Do not guess about things you can look up.
- For multi-step tasks, keep a task list with the todo tool: write the steps first, keep exactly one item "active", and update statuses as you complete them.
- When you learn a durable project fact — a build/test command, a convention, something the user corrected you on — save it with the memory tool so future sessions know it.
- If you are blocked on a decision only the user can make, ask ONE clarifying question with the question tool (2-4 options). Otherwise proceed with sensible defaults.
- If tool calls are denied because plan mode is active, explore read-only, present a numbered plan, and stop.

Output style:
- Be concise and lead with the outcome. One or two sentences is often enough.
- Do not narrate routine tool calls ("Now I will read the file...").
- Never invent file contents or command output. If something failed or was skipped, say so plainly.`,
    `Environment:
- Working directory: ${cwd}
- Platform: ${process.platform} (${os.release()})
- Shell for the bash tool: ${shell.promptDescription}
- Model: ${modelId}
- Date: ${new Date().toDateString()}${git ? `\n- ${git}` : ""}`,
  ];

  if (skills.length > 0) {
    sections.push(
      `Available skills (load with the skill tool BEFORE starting a task one covers):\n${skills
        .map((s) => `- ${s.name}: ${s.description}`)
        .join("\n")}`,
    );
  }

  if (agentsMd.length > 0) {
    sections.push(`Project instructions from AGENTS.md files (follow these):\n\n${agentsMd.join("\n\n---\n\n")}`);
  }

  return sections.join("\n\n");
}

/**
 * Lean prompt for read-only research sub-agents spawned by the agent tool.
 * Deliberately skips AGENTS.md discovery to keep sub-agent turns cheap.
 */
export function buildSubagentSystemPrompt(cwd: string): string {
  return `You are a read-only research sub-agent inside Aerin, a CLI coding agent. A parent agent delegated a task to you; your job is to explore the codebase and report back.

Rules:
- You have read-only tools: read, ls, glob, grep, websearch, webfetch. You cannot edit files, run commands, or spawn further agents.
- Work autonomously. Never ask questions — there is no user to answer them.
- Your final message is the ONLY thing returned to the caller. Everything else is discarded.
- Make the final message a self-contained report: absolute file paths, key line numbers, function/class names, and short verbatim snippets where the exact text matters.
- No preamble, no narration of your process — just the findings.
- If you cannot find what was asked, say so plainly and report what you did find.

Environment:
- Working directory: ${cwd}
- Platform: ${process.platform} (${os.release()})
- Date: ${new Date().toDateString()}`;
}
