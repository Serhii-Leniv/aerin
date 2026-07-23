import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ToolDef } from "./types.js";

const HEADING = "## Memory";
/** Hard budget for the whole `## Memory` section (~900 tokens in every prompt). */
export const MEMORY_BUDGET_CHARS = 2_500;
const MAX_ENTRY_CHARS = 300;

/**
 * Bounded auto-memory (Hermes-style): durable project facts live under a
 * `## Memory` heading in AGENTS.md, loaded into every session's prompt. The
 * section has a hard character budget; when a write would exceed it, the tool
 * ERRORS with the current entries and instructions to consolidate (merge with
 * replace, drop stale with remove, then retry) — the model curates its own
 * memory under pressure instead of the file growing forever.
 */

interface ParsedMemory {
  /** Lines before the entries (including the heading when present). */
  head: string[];
  entries: string[];
  /** Lines after the entries. */
  tail: string[];
  hasHeading: boolean;
}

function parseMemory(content: string): ParsedMemory {
  const lines = content.split("\n");
  const headingIdx = lines.findIndex((l) => l.trim() === HEADING);
  if (headingIdx === -1) return { head: lines, entries: [], tail: [], hasHeading: false };
  const entries: string[] = [];
  let i = headingIdx + 1;
  for (; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (line.startsWith("- ")) entries.push(line.slice(2));
    else if (line === "") continue; // blank lines inside the section are dropped on rebuild
    else break; // next heading or prose — section over
  }
  return { head: lines.slice(0, headingIdx + 1), entries, tail: lines.slice(i), hasHeading: true };
}

function renderEntries(entries: string[]): string {
  return entries.map((e) => `- ${e}`).join("\n");
}

export function memoryUsage(content: string): { chars: number; budget: number; entries: number } {
  const { entries } = parseMemory(content);
  return { chars: renderEntries(entries).length, budget: MEMORY_BUDGET_CHARS, entries: entries.length };
}

function rebuild(parsed: ParsedMemory, entries: string[], original: string): string {
  if (!parsed.hasHeading) {
    const base = original.trim() ? original.trimEnd() + "\n\n" : "# AGENTS.md\n\n";
    return `${base}${HEADING}\n${renderEntries(entries)}\n`;
  }
  const tail = parsed.tail.join("\n");
  return `${parsed.head.join("\n")}\n${renderEntries(entries)}\n${tail ? `\n${tail}` : ""}`.replace(/\n{3,}/g, "\n\n");
}

function usageLine(entries: string[]): string {
  const chars = renderEntries(entries).length;
  return `(memory ${chars}/${MEMORY_BUDGET_CHARS} chars, ${entries.length} entries)`;
}

/** Case-insensitive substring match against entries; errors on none/ambiguous. */
function findOne(entries: string[], match: string): { index: number } {
  // Match verbatim (trailing spaces can disambiguate "fact-1 " from "fact-10").
  const needle = match.toLowerCase();
  if (!needle.trim()) throw new Error('replace/remove need a "match" substring identifying ONE existing entry.');
  const hits = entries.map((e, i) => ({ e, i })).filter(({ e }) => e.toLowerCase().includes(needle));
  if (hits.length === 0) {
    throw new Error(`No memory entry contains "${match}". Current entries:\n${renderEntries(entries) || "(none)"}`);
  }
  if (hits.length > 1) {
    throw new Error(
      `Ambiguous: ${hits.length} entries contain "${match}" — use a longer, unique substring.\n` +
        hits.map(({ e }) => `- ${e}`).join("\n"),
    );
  }
  return { index: (hits[0] as { i: number }).i };
}

export const memoryTool: ToolDef<z.ZodTypeAny> = {
  name: "memory",
  description:
    "Durable project memory in AGENTS.md, loaded into every future session — for build/test commands, " +
    "conventions, decisions, gotchas the user corrected you on. Actions: add (default; new fact in " +
    '"note"), replace (rewrite the ONE entry matching "match" with "note" — use it to merge or update), ' +
    'remove (delete the ONE entry matching "match"). The section has a hard ' +
    `${MEMORY_BUDGET_CHARS}-char budget: when full, adds fail with the current entries — consolidate ` +
    "(replace/remove) and retry in the same turn. Do not save things obvious from the code or specific " +
    "to this conversation.",
  inputSchema: z.object({
    action: z.string().optional().describe('"add" (default), "replace", or "remove"'),
    note: z.string().optional().describe("The fact (add) or replacement text (replace) — one concise line"),
    match: z.string().optional().describe("Substring identifying ONE existing entry (replace/remove)"),
  }),
  permission: "write",
  summarize: (i) => {
    const inp = i as { action?: string; note?: string; match?: string };
    const action = inp.action === "replace" || inp.action === "remove" ? inp.action : "add";
    return `Memory(${action}: ${String(inp.note ?? inp.match ?? "").slice(0, 60)})`;
  },
  preview: async (i) => {
    const inp = i as { action?: string; note?: string; match?: string };
    if (inp.action === "remove") return `- ${String(inp.match ?? "").trim()}`;
    if (inp.action === "replace") return `~ "${String(inp.match ?? "").trim()}" → ${String(inp.note ?? "").trim()}`;
    return `+ ${String(inp.note ?? "").trim()}`;
  },
  async execute(input, ctx) {
    const inp = input as { action?: string; note?: string; match?: string };
    const action = inp.action === "replace" || inp.action === "remove" ? inp.action : "add";
    // Injection hardening: single line (no heading breakouts), bounded length.
    const clean = String(inp.note ?? "").trim().replace(/\s+/g, " ").slice(0, MAX_ENTRY_CHARS);

    const file = path.join(ctx.cwd, "AGENTS.md");
    let content = "";
    try {
      content = await fs.readFile(file, "utf8");
    } catch {
      // no AGENTS.md yet — created on first add
    }
    const parsed = parseMemory(content);
    let entries = [...parsed.entries];

    if (action === "add") {
      if (!clean) throw new Error('add needs a "note".');
      if (entries.includes(clean)) return `Already saved. ${usageLine(entries)}`;
      const next = [clean, ...entries]; // newest first
      if (renderEntries(next).length > MEMORY_BUDGET_CHARS) {
        throw new Error(
          `Memory is FULL ${usageLine(entries)} — adding would exceed the ${MEMORY_BUDGET_CHARS}-char budget. ` +
            `Consolidate NOW, in this turn: merge overlapping entries with action:"replace", delete stale ones ` +
            `with action:"remove", then retry this add. Current entries:\n${renderEntries(entries)}`,
        );
      }
      entries = next;
    } else if (action === "replace") {
      if (!clean) throw new Error('replace needs a "note" with the replacement text.');
      const { index } = findOne(entries, String(inp.match ?? ""));
      entries[index] = clean;
      if (renderEntries(entries).length > MEMORY_BUDGET_CHARS) {
        throw new Error(
          `That replacement would exceed the ${MEMORY_BUDGET_CHARS}-char budget ${usageLine(parsed.entries)}. ` +
            `Write a tighter entry or remove something first.`,
        );
      }
    } else {
      const { index } = findOne(entries, String(inp.match ?? ""));
      entries.splice(index, 1);
    }

    if (entries.length === 0 && !parsed.hasHeading) return `Nothing to write. ${usageLine(entries)}`;
    await fs.writeFile(file, rebuild(parsed, entries, content), "utf8");
    const verb = action === "add" ? "Saved" : action === "replace" ? "Replaced" : "Removed";
    return `${verb}. ${usageLine(entries)}`;
  },
};
