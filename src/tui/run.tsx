import React from "react";
import { render } from "ink";
import { PassThrough } from "node:stream";
import { setupAgent, stopMcpServers } from "../cli.js";
import type { AskUser } from "../tools/question-tool.js";
import { setTerminalTitle } from "../terminal/format.js";
import { filterChunk } from "../terminal/input-filter.js";
import { resolveModel } from "../providers/registry.js";
import type { OnPermission } from "../core/events.js";
import { App, type TuiSetup } from "./App.js";

interface TuiFlags {
  model?: string;
  yolo: boolean;
  continue: boolean;
  resume?: string;
  allowOutsideCwd: boolean;
  cwd?: string;
  mcp: boolean;
}

export async function runTui(flags: TuiFlags, initialPrompt?: string): Promise<void> {
  // The Agent needs onPermission at construction, but the dialog only exists
  // once the App mounts — so route through swappable refs.
  const onPermissionRef: { current: OnPermission } = {
    current: async () => ({ kind: "deny", reason: "UI not ready" }),
  };
  const onQuestionRef: { current: AskUser } = {
    current: async () => {
      throw new Error("UI not ready");
    },
  };

  const setup = await setupAgent(
    flags,
    (req) => onPermissionRef.current(req),
    (q, options) => onQuestionRef.current(q, options),
  );

  const tuiSetup: TuiSetup = {
    agent: setup.agent,
    modelId: setup.modelId,
    cwd: setup.cwd,
    warnings: setup.warnings,
    onPermissionRef,
    onQuestionRef,
    policy: setup.policy,
    customCommands: setup.customCommands,
    skills: setup.skills,
    mcpConnections: setup.mcpConnections,
    sessionId: setup.sessionId,
    resolveModelFn: (id) => resolveModel(id, setup.config),
    config: setup.config,
    ...(setup.modelUnavailable !== undefined ? { modelUnavailable: setup.modelUnavailable } : {}),
  };

  // Claude Code-style: the app renders in the NORMAL screen buffer. The
  // transcript is printed into the terminal's own scrollback (<Static> in
  // App.tsx), so the mouse wheel scrolls natively — no mouse capture, no alt
  // screen. Only bracketed paste is enabled; stdin is still filtered so any
  // stray mouse/paste sequences never reach Ink's key parser as garbage text.
  // AERIN_SMOKE=1: CI smoke mode — pretend the streams are a TTY so the full
  // render pipeline runs headless, then self-exit via a synthesized /exit.
  const smoke = process.env["AERIN_SMOKE"] === "1";
  const filteredStdin = new PassThrough();
  Object.assign(filteredStdin, {
    isTTY: smoke || process.stdin.isTTY,
    setRawMode: (mode: boolean) => {
      if (process.stdin.isTTY) process.stdin.setRawMode(mode);
      return filteredStdin;
    },
    ref: () => process.stdin.ref(),
    unref: () => process.stdin.unref(),
  });
  if (smoke) {
    // One keystroke per chunk — coalesced writes would parse as pasted text.
    [..."/exit\r"].forEach((ch, i) => {
      setTimeout(() => filteredStdin.write(ch), 1500 + i * 80);
    });
  }

  let carry = "";
  let carryTimer: ReturnType<typeof setTimeout> | undefined;
  const onStdinData = (chunk: Buffer): void => {
    if (carryTimer) clearTimeout(carryTimer);
    const result = filterChunk(carry, chunk.toString("utf8"));
    carry = result.carry;
    // result.wheel is ignored — mouse reporting is off; the terminal scrolls itself.
    if (result.clean.length > 0) filteredStdin.write(result.clean);
    if (carry) {
      // Flush held-back bytes shortly if no continuation arrives — they were
      // real input, not a mouse event.
      carryTimer = setTimeout(() => {
        if (carry) {
          filteredStdin.write(carry);
          carry = "";
        }
      }, 60);
    }
  };
  process.stdin.on("data", onStdinData);
  process.stdin.resume(); // background detection may have left stdin explicitly paused

  const resetTerminalModes = (): void => {
    process.stdout.write("\x1b[?2004l");
  };
  process.stdout.write("\x1b[?2004h");
  process.once("exit", resetTerminalModes);
  setTerminalTitle(`✦ aerin — ${setup.cwd.split(/[\\/]/).filter(Boolean).pop() ?? "aerin"}`);

  try {
    const instance = render(<App setup={tuiSetup} {...(initialPrompt ? { initialPrompt } : {})} />, {
      exitOnCtrlC: false,
      stdin: filteredStdin as unknown as NodeJS.ReadStream,
    });
    await instance.waitUntilExit();
  } finally {
    process.stdin.removeListener("data", onStdinData);
    process.stdin.pause();
    resetTerminalModes();
    setTerminalTitle(""); // hand the title back to the shell
    // No alt screen: the whole conversation is already in the terminal's
    // scrollback — nothing to re-print on exit.
    await stopMcpServers(setup.mcpConnections);
    // index.ts force-exits after main() resolves — nothing left to do here.
  }
}
