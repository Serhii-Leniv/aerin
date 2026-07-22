import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ToolDef } from "./types.js";

const HEADING = "## Memory";

/**
 * Persist a durable project fact into AGENTS.md, which is loaded into the
 * system prompt on every future session — aerin's auto-memory.
 */
export const memoryTool: ToolDef<z.ZodTypeAny> = {
  name: "memory",
  description:
    "Save one durable fact about this project to AGENTS.md so future sessions know it: build/test " +
    "commands, conventions, architectural decisions, gotchas the user corrected you on. One concise " +
    "fact per call. Do not save things obvious from the code or specific to this conversation.",
  inputSchema: z.object({
    note: z.string().describe("The fact to remember, one line, concise and specific"),
  }),
  permission: "write",
  summarize: (i) => `Memory(${String(i.note).slice(0, 70)})`,
  preview: async (i) => `+ ${String(i.note).trim()}`,
  async execute(input, ctx) {
    // Injection hardening: single line (no heading breakouts), bounded length.
    const clean = String(input.note).trim().replace(/\s+/g, " ").slice(0, 300);
    const note = `- ${clean}`;
    if (note === "-") throw new Error("Empty note.");
    const file = path.join(ctx.cwd, "AGENTS.md");
    let content = "";
    try {
      content = await fs.readFile(file, "utf8");
    } catch {
      // no AGENTS.md yet — we'll create one
    }
    if (content.includes(note)) return "Already saved.";
    if (new RegExp(`^${HEADING}\\s*$`, "m").test(content)) {
      // Insert right under the heading (newest first).
      content = content.replace(new RegExp(`^${HEADING}\\s*$`, "m"), `${HEADING}\n${note}`);
    } else {
      content = (content ? content.trimEnd() + "\n\n" : "# AGENTS.md\n\n") + `${HEADING}\n${note}\n`;
    }
    if (!content.endsWith("\n")) content += "\n";
    await fs.writeFile(file, content, "utf8");
    return `Saved to AGENTS.md: ${note.slice(2)}`;
  },
};
