import React from "react";
import { render } from "ink";
import { setupAgent, stopMcpServers } from "../cli.js";
import type { AskUser } from "../tools/question-tool.js";
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
    resolveModelFn: (id) => resolveModel(id, setup.config),
    config: setup.config,
    ...(setup.modelUnavailable !== undefined ? { modelUnavailable: setup.modelUnavailable } : {}),
  };

  // Start with a clean viewport so the banner renders at the top of the window
  // (2J clears the visible screen only — the user's scrollback is preserved).
  process.stdout.write("\x1b[2J\x1b[H");

  const instance = render(<App setup={tuiSetup} {...(initialPrompt ? { initialPrompt } : {})} />, {
    exitOnCtrlC: false,
  });
  await instance.waitUntilExit();
  await stopMcpServers(setup.mcpConnections);
}
