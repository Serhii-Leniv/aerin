import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MEMORY_BUDGET_CHARS, memoryTool, memoryUsage } from "../src/tools/memory-tool.js";

async function tmpCwd(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "aerin-mem-"));
}

const ctxFor = (cwd: string) => ({ cwd, allowOutsideCwd: false });
const read = (cwd: string) => fs.readFile(path.join(cwd, "AGENTS.md"), "utf8");

describe("bounded memory", () => {
  test("add reports usage; exact duplicates are no-ops", async () => {
    const cwd = await tmpCwd();
    const out = await memoryTool.execute({ note: "tests run with bun test" }, ctxFor(cwd));
    expect(out).toContain("Saved.");
    expect(out).toMatch(/\(memory \d+\/2500 chars, 1 entries\)/);
    expect(await memoryTool.execute({ note: "tests run with bun test" }, ctxFor(cwd))).toContain("Already saved");
  });

  test("replace rewrites the one matching entry; remove deletes it; other sections untouched", async () => {
    const cwd = await tmpCwd();
    await fs.writeFile(
      path.join(cwd, "AGENTS.md"),
      "# Project\n\nIntro.\n\n## Memory\n- deploy with make ship\n- tests run with bun test\n\n## Other\nkeep me\n",
    );
    const rep = await memoryTool.execute(
      { action: "replace", match: "deploy", note: "deploy with make ship-v2 (staging first)" },
      ctxFor(cwd),
    );
    expect(rep).toContain("Replaced.");
    let content = await read(cwd);
    expect(content).toContain("make ship-v2 (staging first)");
    expect(content).not.toContain("- deploy with make ship\n");
    expect(content).toContain("## Other\nkeep me");

    const rem = await memoryTool.execute({ action: "remove", match: "ship-v2" }, ctxFor(cwd));
    expect(rem).toContain("Removed.");
    content = await read(cwd);
    expect(content).not.toContain("ship-v2");
    expect(content).toContain("- tests run with bun test");
    expect(content).toContain("keep me");
  });

  test("no match and ambiguous matches are actionable errors", async () => {
    const cwd = await tmpCwd();
    await fs.writeFile(
      path.join(cwd, "AGENTS.md"),
      "## Memory\n- use bun for tests\n- use bun for builds\n",
    );
    expect(memoryTool.execute({ action: "remove", match: "cargo" }, ctxFor(cwd))).rejects.toThrow(/No memory entry/);
    expect(memoryTool.execute({ action: "remove", match: "use bun" }, ctxFor(cwd))).rejects.toThrow(/Ambiguous: 2/);
    // A longer substring disambiguates.
    await memoryTool.execute({ action: "remove", match: "for builds" }, ctxFor(cwd));
    expect(await read(cwd)).not.toContain("for builds");
  });

  test("error-at-capacity: a full memory refuses the add, then consolidation makes room", async () => {
    const cwd = await tmpCwd();
    // Fill to just under the budget with chunky entries.
    const filler = Array.from({ length: 14 }, (_, i) => `- fact-${i} ${"x".repeat(180)}`).join("\n");
    await fs.writeFile(path.join(cwd, "AGENTS.md"), `## Memory\n${filler}\n`);
    expect(memoryUsage(await read(cwd)).chars).toBeGreaterThan(MEMORY_BUDGET_CHARS * 0.8);

    const attempt = memoryTool.execute({ note: `important new fact ${"y".repeat(150)}` }, ctxFor(cwd));
    await expect(attempt).rejects.toThrow(/Memory is FULL/);
    await expect(memoryTool.execute({ note: `important new fact ${"y".repeat(150)}` }, ctxFor(cwd))).rejects.toThrow(
      /Consolidate NOW[\s\S]*fact-0/, // the error carries the entries to merge
    );

    // The model consolidates: merge two entries into one short one, drop another…
    await memoryTool.execute({ action: "replace", match: "fact-0", note: "facts 0+1 merged" }, ctxFor(cwd));
    await memoryTool.execute({ action: "remove", match: "fact-1 " }, ctxFor(cwd));
    await memoryTool.execute({ action: "remove", match: "fact-2 " }, ctxFor(cwd));
    // …then the retry succeeds.
    const ok = await memoryTool.execute({ note: `important new fact ${"y".repeat(150)}` }, ctxFor(cwd));
    expect(ok).toContain("Saved.");
    expect(await read(cwd)).toContain("important new fact");
  });

  test("replace that would blow the budget is refused", async () => {
    const cwd = await tmpCwd();
    const filler = Array.from({ length: 14 }, (_, i) => `- fact-${i} ${"x".repeat(180)}`).join("\n");
    await fs.writeFile(path.join(cwd, "AGENTS.md"), `## Memory\n${filler}\n`);
    await expect(
      memoryTool.execute({ action: "replace", match: "fact-0", note: "z".repeat(299) }, ctxFor(cwd)),
    ).rejects.toThrow(/exceed/);
  });

  test("memoryUsage parses a section embedded in larger content", () => {
    const usage = memoryUsage("# X\n\nstuff\n\n## Memory\n- one\n- two\n\n## Y\nmore");
    expect(usage.entries).toBe(2);
    expect(usage.chars).toBe("- one\n- two".length);
    expect(memoryUsage("no memory here").entries).toBe(0);
  });
});
