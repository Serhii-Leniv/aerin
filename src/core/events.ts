/**
 * The core <-> UI contract. The agent loop emits these; any frontend
 * (Ink TUI, readline REPL, headless print mode) consumes them.
 * Nothing in src/core, src/tools, src/providers, src/mcp, src/session,
 * or src/config may import from src/tui.
 */

export type AgentEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "message-end" }
  | { type: "tool-call"; id: string; name: string; input: unknown; summary: string }
  | { type: "tool-result"; id: string; name: string; output: string; isError: boolean }
  | { type: "usage"; inputTokens: number; outputTokens: number; costUsd: number | undefined }
  | {
      type: "subagent-update";
      /** toolCallId of the parent `agent` tool call. */
      id: string;
      /** Short label from the tool input, e.g. "find permission checks". */
      description: string;
      status: "running" | "done" | "error";
      /** summarize() of the sub-agent's latest tool call. */
      lastTool?: string;
      /** Cumulative counts/usage for this sub-agent so far. */
      toolCalls: number;
      inputTokens: number;
      outputTokens: number;
      costUsd: number | undefined;
    }
  | { type: "compaction"; preTokens: number }
  | { type: "todo-update"; items: { text: string; status: "pending" | "active" | "done" }[] }
  /** Display-only detail for the UI (e.g. an edit's diff) — never sent to the model. */
  | { type: "tool-display"; text: string }
  /** Intentional end-of-turn sentinel; frontends may ignore it (iteration ends anyway). */
  | { type: "turn-end" }
  | { type: "retry"; attempt: number; maxAttempts: number; message: string }
  /** The active model failed and the turn continues on a configured fallback. */
  | { type: "failover"; from: string; to: string; message: string }
  /** /goal loop verdict after a finished turn; turnsLeft 0 with done=false means the budget ran out. */
  | { type: "goal-check"; done: boolean; reason: string; turnsLeft: number }
  | { type: "error"; message: string };

export type PermissionDecision =
  | { kind: "allow" }
  | { kind: "allow-always"; scope: "session" | "project" }
  | { kind: "deny"; reason?: string };

export interface PermissionRequest {
  tool: string;
  input: unknown;
  /** Human-readable one-liner, e.g. `Run: git push origin main` */
  summary: string;
  /** Optional rich preview (e.g. a diff for write/edit) */
  preview?: string;
}

export type OnPermission = (req: PermissionRequest) => Promise<PermissionDecision>;
