import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig, persistProjectRule } from "../src/config/config.js";
import { truncateOutput, MAX_OUTPUT_LINES } from "../src/tools/types.js";

async function tmpCwd(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "aerin-cfg-"));
}

describe("config", () => {
  test("loads defaults when no files exist", async () => {
    const cwd = await tmpCwd();
    const { config } = await loadConfig(cwd);
    expect(config.permissions?.allow).toEqual([]);
  });

  test("project settings override and merge", async () => {
    const cwd = await tmpCwd();
    await fs.mkdir(path.join(cwd, ".aerin"), { recursive: true });
    await fs.writeFile(
      path.join(cwd, ".aerin", "settings.json"),
      JSON.stringify({ model: "ollama/llama3", permissions: { allow: ["bash(git *)"] } }),
    );
    const { config } = await loadConfig(cwd);
    expect(config.model).toBe("ollama/llama3");
    expect(config.permissions?.allow).toContain("bash(git *)");
  });

  test("persistProjectRule appends without duplicates", async () => {
    const cwd = await tmpCwd();
    await persistProjectRule(cwd, "bash(npm *)");
    await persistProjectRule(cwd, "bash(npm *)");
    const { config } = await loadConfig(cwd);
    expect(config.permissions?.allow).toEqual(["bash(npm *)"]);
  });

  test("invalid JSON in settings raises a clear error", async () => {
    const cwd = await tmpCwd();
    await fs.mkdir(path.join(cwd, ".aerin"), { recursive: true });
    await fs.writeFile(path.join(cwd, ".aerin", "settings.json"), "{nope");
    await expect(loadConfig(cwd)).rejects.toThrow(/Failed to parse/);
  });
});

describe("truncateOutput", () => {
  test("passes short output through", () => {
    expect(truncateOutput("hello")).toBe("hello");
  });

  test("caps line count keeping head and tail", () => {
    const total = MAX_OUTPUT_LINES + 500;
    const big = Array.from({ length: total }, (_, i) => `line${i}`).join("\n");
    const out = truncateOutput(big);
    expect(out).toContain("output truncated");
    expect(out.split("\n").length).toBeLessThan(MAX_OUTPUT_LINES + 10);
    expect(out).toContain("line0");
    expect(out).toContain(`line${total - 1}`); // tail preserved — errors live there
  });
});
