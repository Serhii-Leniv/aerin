import type { z } from "zod";
import type { AgentEvent } from "../core/events.js";

export type PermissionTier = "read" | "write" | "execute";

export interface ToolContext {
  cwd: string;
  abortSignal?: AbortSignal;
  /** Set by --allow-outside-cwd; write tools refuse paths outside cwd otherwise. */
  allowOutsideCwd: boolean;
  /** Long-running tools push mid-execution events here; the agent loop yields them. */
  onProgress?: (event: AgentEvent) => void;
  /** Id of the tool call being executed; set by the agent loop. */
  toolCallId?: string;
}

export interface ToolDef<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: S;
  permission: PermissionTier;
  /** One-line human-readable summary shown in permission prompts and the transcript. */
  summarize: (input: z.infer<S>) => string;
  /** Optional rich preview for permission dialogs (e.g. a diff). */
  preview?: (input: z.infer<S>, ctx: ToolContext) => Promise<string | undefined>;
  execute: (input: z.infer<S>, ctx: ToolContext) => Promise<string>;
}

export const MAX_OUTPUT_CHARS = 30_000;
export const MAX_OUTPUT_LINES = 2_000;

/**
 * Cap tool output so a single result can't blow up the context window.
 * Keeps the head AND the tail — errors and summaries usually live at the
 * end of command output, so pure head-truncation hides exactly what the
 * model needs to see.
 */
export function truncateOutput(text: string): string {
  const lines = text.split("\n");
  let out = text;

  if (lines.length > MAX_OUTPUT_LINES) {
    const headLines = Math.floor(MAX_OUTPUT_LINES * 0.75);
    const tailLines = MAX_OUTPUT_LINES - headLines;
    out = [
      ...lines.slice(0, headLines),
      `[... output truncated: ${lines.length - MAX_OUTPUT_LINES} lines omitted ...]`,
      ...lines.slice(-tailLines),
    ].join("\n");
  }

  if (out.length > MAX_OUTPUT_CHARS) {
    const headChars = Math.floor(MAX_OUTPUT_CHARS * 0.7);
    const tailChars = MAX_OUTPUT_CHARS - headChars;
    out =
      out.slice(0, headChars) +
      `\n[... output truncated: ${out.length - MAX_OUTPUT_CHARS} chars omitted ...]\n` +
      out.slice(-tailChars);
  }

  return out;
}
