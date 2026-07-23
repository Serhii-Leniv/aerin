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

      // eslint-disable-next-line no-control-regex
      const plain = result.out.replace(/\x1b\[[0-9;]*m/g, ""); // the wordmark is gradient-styled per glyph
      expect(plain).toContain("█████╗"); // the wordmark rendered
      expect(result.out).toContain("❯"); // the input prompt rendered
      expect(result.code).toBe(0); // clean exit through the /exit path

      // REGRESSION (v0.0.89-96 scroll saga): the app must own the whole
      // window — alternate screen entered on start and left on exit, SGR
      // mouse reporting on/off in the same way, so the user can never scroll
      // above the app into shell history.
      expect(result.out).toContain("\x1b[?1049h"); // enter alt screen
      expect(result.out).toContain("\x1b[?1049l"); // leave alt screen on exit
      expect(result.out).toContain("\x1b[?1000h"); // mouse reporting on (wheel scrolls in-app)
      expect(result.out).toContain("\x1b[?1006l"); // mouse reporting off on exit

      // REGRESSION: Ink's clear-terminal-per-frame fullscreen path (frame
      // height >= terminal rows) must never fire — it wipes the screen and
      // reprints the whole transcript every frame.
      expect(result.out).not.toContain("\x1b[2J");
    },
    { timeout: 40_000 },
  );
});
