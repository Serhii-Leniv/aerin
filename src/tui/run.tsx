import React from "react";
import { render } from "ink";
import type { ModelMessage } from "ai";
import { setupAgent, stopMcpServers } from "../cli.js";
import type { AskUser } from "../tools/question-tool.js";
import { renderMarkdown } from "../terminal/markdown.js";
import { messageText } from "../terminal/format.js";
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
  // on exit.
  const leaveAltScreen = (): void => {
    process.stdout.write("\x1b[?1049l");
  };
  process.stdout.write("\x1b[?1049h\x1b[H");
  process.once("exit", leaveAltScreen);

  try {
    const instance = render(<App setup={tuiSetup} {...(initialPrompt ? { initialPrompt } : {})} />, {
      exitOnCtrlC: false,
    });
    await instance.waitUntilExit();
  } finally {
    leaveAltScreen();
    // The alt screen took the conversation with it — leave a plain transcript
    // in the normal terminal so the session survives in scrollback.
    printTranscript(setup.agent.history);
    await stopMcpServers(setup.mcpConnections);
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
  process.stdout.write(`\n── aerin session transcript ──\n\n${out.join("\n\n")}\n\n`);
}
