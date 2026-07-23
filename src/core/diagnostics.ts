import fs from "node:fs/promises";
import path from "node:path";

/**
 * Post-edit diagnostics (opencode's LSP idea, without the LSP): after every
 * successful write/edit, a project check command runs and its FAILURES are
 * appended to the tool result, so the model sees and fixes type/lint fallout
 * immediately instead of discovering it at the end of the task.
 *
 * Resolution order:
 *   config "diagnostics": "<command>"  — always used
 *   config "diagnostics": false       — disabled, including auto-detection
 *   unset — auto-detect a "typecheck" script in package.json (run with the
 *   package manager the lockfile implies), UNLESS the user already wired a
 *   post:write/post:edit/post:* hook — then hooks stay the single mechanism
 *   and nothing runs twice.
 *
 * Deliberately conservative: only the "typecheck" script is auto-detected.
 * A slow checker is felt on every edit — point "diagnostics" at a fast
 * command (or false) if the default hurts.
 */

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** Auto-detect: package.json "typecheck" script via the lockfile's package manager. */
export async function detectDiagnosticsCommand(cwd: string): Promise<string | undefined> {
  let scripts: Record<string, unknown>;
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(cwd, "package.json"), "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    scripts = pkg.scripts ?? {};
  } catch {
    return undefined;
  }
  if (typeof scripts["typecheck"] !== "string") return undefined;
  const pm = (await exists(path.join(cwd, "bun.lock"))) || (await exists(path.join(cwd, "bun.lockb")))
    ? "bun"
    : (await exists(path.join(cwd, "pnpm-lock.yaml")))
      ? "pnpm"
      : (await exists(path.join(cwd, "yarn.lock")))
        ? "yarn"
        : "npm";
  return `${pm} run typecheck`;
}

export interface DiagnosticsOpts {
  /** From config: a command, false to disable, or undefined to auto-detect. */
  configured: string | false | undefined;
  hooks?: Record<string, string> | undefined;
}

/** The command to run after edits, or undefined when diagnostics are off. */
export async function resolveDiagnosticsCommand(cwd: string, opts: DiagnosticsOpts): Promise<string | undefined> {
  if (opts.configured === false) return undefined;
  if (typeof opts.configured === "string" && opts.configured.trim()) return opts.configured;
  // Don't stack auto-detection on top of user-wired post hooks.
  const h = opts.hooks ?? {};
  if (h["post:write"] || h["post:edit"] || h["post:*"]) return undefined;
  return detectDiagnosticsCommand(cwd);
}
