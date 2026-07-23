import { spawn } from "node:child_process";
import { detectShell } from "../tools/bash.js";

/**
 * Tool hooks: shell commands from config, keyed "pre:<tool>" / "post:<tool>"
 * (or "pre:*" / "post:*"). Every hook receives AERIN_TOOL and AERIN_TOOL_INPUT
 * (JSON) in its environment plus a JSON payload on stdin:
 *   {"phase":"pre"|"post","tool":...,"input":{...},"cwd":...,"output"?:...}
 * (post hooks also get the tool's output).
 *
 * Two protocols, chosen by what the hook prints:
 *
 * LEGACY (stdout is not JSON): exit code decides. A pre-hook exiting non-zero
 * BLOCKS the call and its output becomes the error the model sees; a
 * post-hook's non-zero output is appended to the tool result.
 *
 * JSON (stdout — or its last line — parses as a JSON object): the object
 * decides and the exit code is ignored.
 *   pre:  {"decision": "allow" | "deny" | "ask", "reason": "...", "input": {...}}
 *         allow = skip the user permission prompt; deny = block (reason goes
 *         to the model); ask = force a prompt even when rules would allow;
 *         input = replace the tool's input (re-validated before running).
 *         Pre-hooks run BEFORE the permission prompt; explicit deny rules in
 *         the permission config still beat everything, including hooks.
 *   post: {"context": "..."} — text appended to the tool result regardless
 *         of exit code.
 */

export interface HookResult {
  code: number;
  output: string;
}

export interface PreHookResult {
  decision: "allow" | "deny" | "ask" | "none";
  reason?: string;
  /** Replacement tool input, when the hook rewrote it. */
  replacedInput?: unknown;
}

/** stdout (or its last non-empty line) as a JSON object, else undefined. */
export function parseHookJson(output: string): Record<string, unknown> | undefined {
  const tryParse = (s: string): Record<string, unknown> | undefined => {
    try {
      const v = JSON.parse(s) as unknown;
      return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  };
  const trimmed = output.trim();
  if (!trimmed) return undefined;
  const whole = tryParse(trimmed);
  if (whole) return whole;
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return lines.length > 1 ? tryParse(lines[lines.length - 1] as string) : undefined;
}

export async function runPreHook(command: string, toolName: string, input: unknown, cwd: string): Promise<PreHookResult> {
  const r = await runHook(command, toolName, input, cwd, { phase: "pre" });
  const j = parseHookJson(r.output);
  if (j) {
    const decision = j["decision"] === "allow" || j["decision"] === "deny" || j["decision"] === "ask" ? j["decision"] : "none";
    return {
      decision,
      ...(typeof j["reason"] === "string" ? { reason: j["reason"] } : {}),
      ...(j["input"] !== undefined && typeof j["input"] === "object" && j["input"] !== null
        ? { replacedInput: j["input"] }
        : {}),
    };
  }
  if (r.code !== 0) {
    return { decision: "deny", reason: `pre-hook exited ${r.code}: ${r.output.trim().slice(0, 800) || "(no output)"}` };
  }
  return { decision: "none" };
}

/**
 * Lifecycle events, config keys alongside the tool hooks:
 *   "session:start"  — after setup; JSON {"context"} is appended to the system prompt
 *   "prompt:submit"  — before each user prompt; {"decision":"block","reason"} stops it,
 *                      {"context"} is appended to the prompt
 *   "turn:end"       — when a turn finishes; {"decision":"block","reason"} makes the
 *                      agent keep working (capped at 3 per turn)
 *   "compact:pre"    — before compaction (observational)
 *   "session:end"    — on shutdown (observational)
 * Non-JSON output is ignored — lifecycle hooks are observational unless they
 * speak the JSON protocol. Each receives the payload on stdin plus AERIN_TOOL
 * set to the event name.
 */
export interface LifecycleResult {
  context?: string;
  blockReason?: string;
}

export async function runLifecycleHook(
  hooks: Record<string, string> | undefined,
  event: string,
  payload: Record<string, unknown>,
  cwd: string,
): Promise<LifecycleResult | undefined> {
  const cmd = hooks?.[event];
  if (!cmd) return undefined;
  const r = await runHook(cmd, event, payload, cwd, { event });
  const j = parseHookJson(r.output);
  if (!j) return {};
  return {
    ...(typeof j["context"] === "string" && j["context"].trim()
      ? { context: j["context"].trim().slice(0, 2_000) }
      : {}),
    ...(j["decision"] === "block" || j["decision"] === "deny"
      ? { blockReason: typeof j["reason"] === "string" && j["reason"].trim() ? j["reason"].trim() : "blocked by hook" }
      : {}),
  };
}

export async function runPostHook(
  command: string,
  toolName: string,
  input: unknown,
  cwd: string,
  toolOutput: string,
): Promise<{ appended?: string }> {
  const r = await runHook(command, toolName, input, cwd, { phase: "post", output: toolOutput.slice(0, 8_000) });
  const j = parseHookJson(r.output);
  if (j) {
    return typeof j["context"] === "string" && j["context"].trim()
      ? { appended: `\n[post-hook "${toolName}"]:\n${(j["context"] as string).trim().slice(0, 1500)}` }
      : {};
  }
  if (r.code !== 0) {
    return { appended: `\n[post-hook "${toolName}" failed (exit ${r.code})]:\n${r.output.trim().slice(0, 1500)}` };
  }
  return {};
}

const HOOK_TIMEOUT_MS = 60_000;
const MAX_HOOK_OUTPUT = 4_000;

export function runHook(
  command: string,
  toolName: string,
  input: unknown,
  cwd: string,
  extra?: Record<string, unknown>,
): Promise<HookResult> {
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
    // The JSON payload; a command that never reads stdin must not crash us.
    child.stdin.on("error", () => {});
    try {
      child.stdin.write(JSON.stringify({ tool: toolName, input, cwd, ...extra }).slice(0, 32_000));
    } catch {
      // stdin already closed — env vars still carry the essentials
    }
    child.stdin.end();
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
