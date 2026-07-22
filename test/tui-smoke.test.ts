import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import path from "node:path";

/**
 * End-to-end TUI smoke: boot the real app headless (AERIN_SMOKE fakes a TTY),
 * let it render, self-exit via a synthesized /exit, and assert the pipeline
 * produced the banner and died cleanly. Catches startup crashes, render
 * exceptions, and broken exit paths that unit tests can't see.
 */

const ROOT = path.resolve(import.meta.dir, "..");

describe("tui smoke", () => {
  test(
    "boots, renders the banner, and exits cleanly",
    async () => {
      // Under bun test, execPath IS bun — no shell shims involved.
      const result = await new Promise<{ code: number | null; out: string }>((resolve, reject) => {
        const app = spawn(process.execPath, ["run", path.join(ROOT, "src", "index.ts"), "--no-mcp"], {
          cwd: ROOT,
          windowsHide: true,
          env: {
            ...process.env,
            AERIN_SMOKE: "1",
            OPENROUTER_API_KEY: "sk-or-smoke-test-key-not-real",
          },
        });
        app.on("error", reject);
        let out = "";
        app.stdout.on("data", (d: Buffer) => (out += d.toString()));
        app.stderr.on("data", (d: Buffer) => (out += d.toString()));
        const timer = setTimeout(() => {
          app.kill();
          resolve({ code: -1, out: out + "\n[TIMEOUT]" });
        }, 25_000);
        app.on("exit", (code) => {
          clearTimeout(timer);
          resolve({ code, out });
        });
      });

      expect(result.out).toContain("█████╗"); // the wordmark rendered
      expect(result.out).toContain("❯"); // the input prompt rendered
      expect(result.code).toBe(0); // clean exit through the /exit path
    },
    { timeout: 40_000 },
  );
});
