import { setupAgent, stopMcpServers } from "../cli.js";

interface PrintFlags {
  model?: string;
  yolo: boolean;
  continue: boolean;
  resume?: string;
  allowOutsideCwd: boolean;
  cwd?: string;
  mcp: boolean;
}

/**
 * Headless mode: run one prompt, stream text to stdout, exit.
 * Permissions auto-deny unless --yolo. This is the scriptable/CI surface and
 * the debugging escape hatch when the TUI misbehaves.
 */
export async function runPrint(flags: PrintFlags, prompt: string): Promise<void> {
  const setup = await setupAgent(flags, async () =>
    flags.yolo ? { kind: "allow" } : { kind: "deny", reason: "Non-interactive mode; re-run with --yolo to allow tools." },
  );
  for (const w of setup.warnings) process.stderr.write(`warning: ${w}\n`);

  try {
    for await (const event of setup.agent.send(prompt)) {
      switch (event.type) {
        case "text-delta":
          process.stdout.write(event.text);
          break;
        case "message-end":
          process.stdout.write("\n");
          break;
        case "tool-call":
          process.stderr.write(`[tool] ${event.summary}\n`);
          break;
        case "tool-result":
          if (event.isError) process.stderr.write(`[tool error] ${event.output.slice(0, 200)}\n`);
          break;
        case "subagent-update":
          if (event.status !== "running") {
            process.stderr.write(
              `[agent ${event.status}] ${event.description} (${event.toolCalls} tools, ${event.inputTokens + event.outputTokens} tok)\n`,
            );
          }
          break;
        case "error":
          process.stderr.write(`error: ${event.message}\n`);
          process.exitCode = 1;
          break;
        default:
          break;
      }
    }
  } finally {
    await stopMcpServers(setup.mcpConnections);
  }
}
