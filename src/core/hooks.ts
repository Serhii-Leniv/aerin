import { spawn } from "node:child_process";
import { detectShell } from "../tools/bash.js";

/**
 * Tool hooks: shell commands from config, keyed "pre:<tool>" / "post:<tool>"
 * (or "pre:*" / "post:*"). The hook receives AERIN_TOOL and AERIN_TOOL_INPUT
 * (JSON) in its environment. A pre-hook exiting non-zero BLOCKS the tool call
 * and its output becomes the error the model sees; a post-hook's non-zero
 * output is appended to the tool result (e.g. typecheck errors after an edit).
 */

export interface HookResult {
  code: number;
  output: string;
}

const HOOK_TIMEOUT_MS = 60_000;
const MAX_HOOK_OUTPUT = 4_000;

export function runHook(command: string, toolName: string, input: unknown, cwd: string): Promise<HookResult> {
  const shell = detectShell();
  return new Promise((resolve) => {
    const child = spawn(shell.path, shell.args(command), {
      cwd,
      windowsHide: true,
      shell: false,
      env: {
        ...process.env,
        AERIN_TOOL: toolName,
        AERIN_TOOL_INPUT: JSON.stringify(input).slice(0, 8_000),
      },
    });
    let output = "";
    const append = (d: Buffer): void => {
      if (output.length < MAX_HOOK_OUTPUT) output += d.toString();
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: 124, output: output + "\n[hook timed out after 60s]" });
    }, HOOK_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 127, output: `hook failed to start: ${err.message}` });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output });
    });
  });
}

/** Pick the hook command for a tool from a config hooks map. */
export function hookFor(hooks: Record<string, string> | undefined, phase: "pre" | "post", toolName: string): string | undefined {
  if (!hooks) return undefined;
  return hooks[`${phase}:${toolName}`] ?? hooks[`${phase}:*`];
}
