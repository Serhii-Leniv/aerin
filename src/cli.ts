import { Command } from "commander";
import type { ModelMessage } from "ai";
import { Agent } from "./core/agent.js";
import type { OnPermission } from "./core/events.js";
import { buildSystemPrompt } from "./core/system-prompt.js";
import { builtinTools } from "./tools/index.js";
import { PermissionPolicy } from "./permissions/policy.js";
import { loadConfig, DEFAULT_MODEL } from "./config/config.js";
import { resolveModel } from "./providers/registry.js";
import { SessionStore } from "./session/store.js";
import { startMcpServers, stopMcpServers, type McpConnection } from "./mcp/manager.js";
import { runPrint } from "./modes/print.js";
import { runRepl } from "./modes/repl.js";
import { VERSION } from "./version.js";

interface CliFlags {
  model?: string;
  print?: string;
  tui: boolean;
  yolo: boolean;
  continue: boolean;
  resume?: string;
  allowOutsideCwd: boolean;
  cwd?: string;
  mcp: boolean;
}

export interface AgentSetup {
  agent: Agent;
  mcpConnections: McpConnection[];
  warnings: string[];
  modelId: string;
  cwd: string;
  config: import("./config/config.js").AerinConfig;
}

export async function setupAgent(
  flags: Pick<CliFlags, "model" | "yolo" | "continue" | "resume" | "allowOutsideCwd" | "cwd" | "mcp">,
  onPermission: OnPermission,
): Promise<AgentSetup> {
  const cwd = flags.cwd ?? process.cwd();
  const { config } = await loadConfig(cwd);
  const modelId = flags.model ?? config.model ?? DEFAULT_MODEL;
  const model = resolveModel(modelId, config);

  const warnings: string[] = [];
  let mcpConnections: McpConnection[] = [];
  const tools = builtinTools();
  if (flags.mcp && config.mcpServers && Object.keys(config.mcpServers).length > 0) {
    const res = await startMcpServers(config.mcpServers);
    mcpConnections = res.connections;
    warnings.push(...res.warnings);
    for (const c of mcpConnections) tools.push(...c.tools);
  }

  const policy = new PermissionPolicy(config.permissions?.allow ?? [], flags.yolo);
  const systemPrompt = await buildSystemPrompt(cwd, modelId);

  let store: SessionStore;
  let initialMessages: ModelMessage[] = [];
  if (flags.resume) {
    const opened = await SessionStore.open(cwd, flags.resume);
    store = opened.store;
    initialMessages = opened.messages;
  } else if (flags.continue) {
    const latest = await SessionStore.latest(cwd);
    if (latest) {
      const opened = await SessionStore.open(cwd, latest.id);
      store = opened.store;
      initialMessages = opened.messages;
    } else {
      store = await SessionStore.create(cwd, modelId);
    }
  } else {
    store = await SessionStore.create(cwd, modelId);
  }

  const agent = new Agent({
    model,
    modelId,
    systemPrompt,
    tools,
    policy,
    onPermission,
    cwd,
    allowOutsideCwd: flags.allowOutsideCwd,
    store,
    initialMessages,
  });

  return { agent, mcpConnections, warnings, modelId, cwd, config };
}

export async function main(argv: string[]): Promise<void> {
  const program = new Command();
  program
    .name("aerin")
    .description("Aerin — an open-source CLI coding agent")
    .version(VERSION)
    .argument("[prompt...]", "prompt to run (interactive if omitted)")
    .option("-m, --model <id>", 'model as "provider/model-id", e.g. anthropic/claude-opus-4-8')
    .option("-p, --print", "non-interactive: run the prompt, print the result, exit")
    .option("--no-tui", "use the plain readline REPL instead of the TUI")
    .option("--yolo", "auto-approve all tool permissions (careful!)", false)
    .option("-c, --continue", "continue the most recent session in this directory", false)
    .option("-r, --resume <id>", "resume a specific session id")
    .option("--allow-outside-cwd", "permit writes outside the working directory", false)
    .option("--cwd <dir>", "working directory override")
    .option("--no-mcp", "skip connecting to configured MCP servers")
    .addHelpText(
      "after",
      "\nSubcommands:\n  aerin doctor    diagnose your environment (shell, keys, config, ripgrep, MCP)\n",
    );

  // Routed before commander parsing so it can't collide with the prompt argument.
  if (argv[2] === "doctor") {
    const { runDoctor } = await import("./modes/doctor.js");
    await runDoctor(process.cwd());
    return;
  }

  program.parse(argv);

  const opts = program.opts();
  const promptArgs = program.args.join(" ").trim();

  const flags = {
    model: opts["model"] as string | undefined,
    yolo: Boolean(opts["yolo"]),
    continue: Boolean(opts["continue"]),
    resume: opts["resume"] as string | undefined,
    allowOutsideCwd: Boolean(opts["allowOutsideCwd"]),
    cwd: opts["cwd"] as string | undefined,
    mcp: opts["mcp"] !== false,
  };

  try {
    if (opts["print"]) {
      if (!promptArgs) {
        process.stderr.write("aerin -p requires a prompt argument\n");
        process.exitCode = 1;
        return;
      }
      await runPrint(flags, promptArgs);
      return;
    }

    if (opts["tui"] === false) {
      await runRepl(flags, promptArgs || undefined);
      return;
    }

    // Rich TUI (default). Imported lazily so --print/--no-tui never load Ink/React.
    const { runTui } = await import("./tui/run.js");
    await runTui(flags, promptArgs || undefined);
  } catch (err) {
    process.stderr.write(`aerin: ${err instanceof Error ? err.message : err}\n`);
    process.exitCode = 1;
  }
}

export { stopMcpServers };
