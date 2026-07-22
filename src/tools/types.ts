import type { z } from "zod";

export type PermissionTier = "read" | "write" | "execute";

export interface ToolContext {
  cwd: string;
  abortSignal?: AbortSignal;
  /** Set by --allow-outside-cwd; write tools refuse paths outside cwd otherwise. */
  allowOutsideCwd: boolean;
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

/** Cap tool output so a single result can't blow up the context window. */
export function truncateOutput(text: string): string {
  let out = text;
  let truncated = false;
  const lines = out.split("\n");
  if (lines.length > MAX_OUTPUT_LINES) {
    out = lines.slice(0, MAX_OUTPUT_LINES).join("\n");
    truncated = true;
  }
  if (out.length > MAX_OUTPUT_CHARS) {
    out = out.slice(0, MAX_OUTPUT_CHARS);
    truncated = true;
  }
  if (truncated) {
    out += `\n[output truncated — original was ${text.length} chars / ${lines.length} lines]`;
  }
  return out;
}
