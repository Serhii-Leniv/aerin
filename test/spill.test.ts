import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MAX_OUTPUT_CHARS, MAX_OUTPUT_LINES, truncateOutput } from "../src/tools/types.js";

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "aerin-spill-"));
}

describe("tool-output spill files", () => {
  test("truncation saves the FULL output to a spill file and points the model at it", async () => {
    const dir = await tmpDir();
    const big = Array.from({ length: MAX_OUTPUT_LINES + 100 }, (_, i) => `row-${i}`).join("\n");
    const out = truncateOutput(big, { spillDir: dir });

    const m = /saved to (.+?) — /.exec(out);
    expect(m).not.toBeNull();
    const spillPath = m?.[1] as string;
    expect(spillPath.startsWith(dir)).toBe(true);
    expect(await fs.readFile(spillPath, "utf8")).toBe(big); // complete, byte-identical
    expect(out).toContain("grep it or read it with offset/limit");
    expect(out).toContain(`${big.length} chars`);
  });

  test("char-cap truncation spills too", async () => {
    const dir = await tmpDir();
    const big = "x".repeat(MAX_OUTPUT_CHARS + 5_000);
    const out = truncateOutput(big, { spillDir: dir });
    expect(out).toContain("saved to");
    expect(await fs.readdir(dir)).toHaveLength(1);
  });

  test("short output never spills; spillDir:false disables spilling", async () => {
    const dir = await tmpDir();
    expect(truncateOutput("small", { spillDir: dir })).toBe("small");
    expect(await fs.readdir(dir)).toHaveLength(0);

    const big = "y".repeat(MAX_OUTPUT_CHARS + 5_000);
    const out = truncateOutput(big, { spillDir: false });
    expect(out).toContain("output truncated");
    expect(out).not.toContain("saved to");
  });

  test("a broken spill dir degrades to plain truncation", () => {
    const big = "z".repeat(MAX_OUTPUT_CHARS + 5_000);
    // A path that cannot be created as a directory (file in the way is enough on all platforms).
    const bad = path.join(os.tmpdir(), `aerin-spill-collision-${Date.now()}`);
    const out = truncateOutput(big, { spillDir: path.join(bad, "\0nul", "x") });
    expect(out).toContain("output truncated");
    expect(out).not.toContain("saved to");
  });
});
