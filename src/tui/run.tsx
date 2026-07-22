import React from "react";
import { render } from "ink";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ModelMessage } from "ai";
import { setupAgent, stopMcpServers } from "../cli.js";
import type { AskUser } from "../tools/question-tool.js";
import { renderMarkdown } from "../terminal/markdown.js";
import { messageText, redactSecrets, setTerminalTitle } from "../terminal/format.js";
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
    resolveModelFn: (id) => resolveModel(id, setup.config),
    config: setup.config,
    ...(setup.modelUnavailable !== undefined ? { modelUnavailable: setup.modelUnavailable } : {}),
  };

  // Full-screen app on the alternate screen buffer (opencode-style): the UI
  // owns the whole window, and the user's shell scrollback is restored intact
  // on exit. SGR mouse reporting is enabled so the wheel scrolls the
  // transcript; the sequences are stripped from stdin BEFORE Ink parses them
  // (Ink would otherwise insert them into the input as garbage text).
  const mouse = new EventEmitter();
  tuiSetup.mouse = mouse;
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
    let s = carry + chunk.toString("utf8");
    carry = "";
    // Hold back a partial mouse sequence split across chunks — but flush it
    // shortly if no continuation arrives (it was real input, not a mouse event).
    const partial = /\x1b\[<[\d;]*$/.exec(s);
    if (partial) {
      carry = partial[0];
      s = s.slice(0, partial.index);
      carryTimer = setTimeout(() => {
        if (carry) {
          filteredStdin.write(carry);
          carry = "";
        }
      }, 60);
    }
    const re = /\x1b\[<(\d+);\d+;\d+[Mm]/g;
    let clean = "";
    let last = 0;
    for (let m = re.exec(s); m; m = re.exec(s)) {
      clean += s.slice(last, m.index);
      last = m.index + m[0].length;
      const button = Number(m[1]);
      if ((button & 64) !== 0) mouse.emit("wheel", (button & 1) === 0 ? -1 : 1);
      // other mouse events (clicks, drags) are swallowed for now
    }
    clean += s.slice(last);
    if (clean.length > 0) filteredStdin.write(clean);
  };
  process.stdin.on("data", onStdinData);

  const leaveAltScreen = (): void => {
    process.stdout.write("\x1b[?1006l\x1b[?1000l\x1b[?1049l");
  };
  process.stdout.write("\x1b[?1049h\x1b[H\x1b[?1000h\x1b[?1006h");
  process.once("exit", leaveAltScreen);
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
    leaveAltScreen();
    setTerminalTitle(""); // hand the title back to the shell
    // The alt screen took the conversation with it — leave a plain transcript
    // in the normal terminal so the session survives in scrollback.
    printTranscript(setup.agent.history);
    await stopMcpServers(setup.mcpConnections);
    // index.ts force-exits after main() resolves — nothing left to do here.
  }
}

function printTranscript(history: readonly ModelMessage[]): void {
  const out: string[] = [];
  for (const m of history) {
    if (m.role === "user") {
      const t = messageText(m).trim();
      if (t) out.push(`> ${t}`);
    } else if (m.role === "assistant") {
      if (Array.isArray(m.content)) {
        for (const part of m.content as { type?: string; text?: string; toolName?: string }[]) {
          if (part?.type === "text" && part.text?.trim()) out.push(renderMarkdown(part.text));
          else if (part?.type === "tool-call" && part.toolName) out.push(`⏺ ${part.toolName}`);
        }
      } else {
        const t = messageText(m).trim();
        if (t) out.push(renderMarkdown(t));
      }
    }
  }
  if (out.length === 0) return;
  // Never let key-shaped strings land in shell scrollback.
  process.stdout.write(`\n── aerin session transcript ──\n\n${redactSecrets(out.join("\n\n"))}\n\n`);
}
