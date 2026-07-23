import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSessionSearchTool } from "../src/tools/session-search-tool.js";

async function fixture(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aerin-sessions-"));
  const write = (id: string, createdAt: string, title: string, messages: unknown[]) =>
    fs.writeFile(
      path.join(dir, `${id}.jsonl`),
      [JSON.stringify({ type: "meta", id, cwd: "/p", model: "m", createdAt, title }), ...messages.map((m) => JSON.stringify(m))].join("\n") + "\n",
    );
  await write("older-aa", "2026-07-01T10:00:00.000Z", "fix the login redirect bug", [
    { role: "user", content: "the login redirect loops forever" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "The redirect bug lives in auth/session.ts — cookie SameSite was wrong." },
        { type: "tool-call", toolCallId: "t1", toolName: "edit", input: { path: "auth/session.ts" } },
      ],
    },
    {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "t1", toolName: "edit", output: { type: "text", value: "+2 -2 auth/session.ts" } }],
    },
  ]);
  await write("newer-bb", "2026-07-10T10:00:00.000Z", "palette tweaks", [
    { role: "user", content: "make the theme colors warmer" },
    { role: "assistant", content: "Adjusted the palette in theme.ts." },
  ]);
  await write("current-cc", "2026-07-15T10:00:00.000Z", "current work", [
    { role: "user", content: "login login login" },
  ]);
  return dir;
}

const ctx = { cwd: process.cwd(), allowOutsideCwd: false };

describe("session_search tool", () => {
  test("finds sessions by keywords with role-tagged snippets, excluding the current session", async () => {
    const dir = await fixture();
    const tool = createSessionSearchTool({ currentSessionId: "current-cc", dirOverride: dir });
    const out = await tool.execute({ query: "login redirect" }, ctx);
    expect(out).toContain("[older-aa]");
    expect(out).toContain("fix the login redirect bug");
    expect(out).toContain("user: ");
    expect(out).not.toContain("current-cc"); // the running session never surfaces
    expect(out).not.toContain("[newer-bb]"); // no matching terms
  });

  test("matches inside tool results too", async () => {
    const dir = await fixture();
    const tool = createSessionSearchTool({ dirOverride: dir });
    const out = await tool.execute({ query: "SameSite cookie" }, ctx);
    expect(out).toContain("[older-aa]");
  });

  test("reads a full transcript by session_id", async () => {
    const dir = await fixture();
    const tool = createSessionSearchTool({ dirOverride: dir });
    const out = await tool.execute({ session_id: "older-aa" }, ctx);
    expect(out).toContain('"fix the login redirect bug"');
    expect(out).toContain("-- user --");
    expect(out).toContain("-- assistant --");
    expect(out).toContain("SameSite");
  });

  test("handles no matches, unknown ids and empty input gracefully", async () => {
    const dir = await fixture();
    const tool = createSessionSearchTool({ dirOverride: dir });
    expect(await tool.execute({ query: "kubernetes yaml" }, ctx)).toContain("No past sessions match");
    expect(await tool.execute({ session_id: "nope" }, ctx)).toContain("No session nope");
    expect(await tool.execute({}, ctx)).toContain("Provide query keywords");
  });

  test("is read-tier and summarizes both modes", async () => {
    const tool = createSessionSearchTool({});
    expect(tool.permission).toBe("read");
    expect(tool.summarize({ query: "redirect bug" })).toBe("SessionSearch(redirect bug)");
    expect(tool.summarize({ session_id: "abc" })).toBe("SessionSearch(read abc)");
  });
});
