import { Command } from "commander";
import type { LanguageModel, ModelMessage } from "ai";
import { Agent } from "./core/agent.js";
import type { OnPermission } from "./core/events.js";
import { buildSystemPrompt } from "./core/system-prompt.js";
import { builtinTools } from "./tools/index.js";
import { createAgentTool } from "./tools/agent-tool.js";
import { createQuestionTool, type AskUser } from "./tools/question-tool.js";
import { createSkillTool } from "./tools/skill-tool.js";
import { discoverSkills } from "./core/skills.js";
import { discoverCommands, type CustomCommand } from "./core/commands.js";
import { PermissionPolicy } from "./permissions/policy.js";
import { loadConfig, DEFAULT_MODEL } from "./config/config.js";
import { resolveModel, providersWithKeys, PROVIDERS } from "./providers/registry.js";
import { detectOllamaModel } from "./providers/list-models.js";
import { GLOBAL_CONFIG_FILE } from "./config/paths.js";
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
  /** Exposed so frontends can toggle plan mode. */
  policy: PermissionPolicy;
  customCommands: CustomCommand[];
  /** Set when no model could be resolved; the agent holds an inert stub that
   *  makes no requests until the user picks a model with /model. */
  modelUnavailable?: string;
}

/** Inert placeholder: errors on use, so nothing is ever called (or billed)
 *  until the user explicitly picks a model. */
function unavailableModel(modelId: string, reason: string): LanguageModel {
  const fail = (): never => {
    throw new Error(`No model selected — ${modelId} is unavailable (${reason}). Pick one with /model.`);
  };
  return {
    specificationVersion: "v2",
    provider: "none",
    modelId,
    supportedUrls: {},
    doGenerate: async () => fail(),
    doStream: async () => fail(),
  } as unknown as LanguageModel;
}

/** First-run guidance shown when no model provider is usable at all. */
function onboardingError(cause: unknown): Error {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return new Error(`no usable model provider found (${reason})

To get started, aerin needs a model. Pick one:

  1. Set a provider API key as an environment variable:
       ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, or OPENROUTER_API_KEY
     (an OpenRouter key unlocks models from every lab, including free-tier ones)

  2. Or run a local model — no key needed:
       install Ollama (https://ollama.com), then e.g.: ollama pull qwen3

Keys can also live in ${GLOBAL_CONFIG_FILE}:
  { "providers": { "openrouter": { "apiKey": "sk-or-..." } } }

Check your setup with: aerin doctor`);
}

export async function setupAgent(
  flags: Pick<CliFlags, "model" | "yolo" | "continue" | "resume" | "allowOutsideCwd" | "cwd" | "mcp">,
  onPermission: OnPermission,
  onQuestion?: AskUser,
): Promise<AgentSetup> {
  const cwd = flags.cwd ?? process.cwd();
  const { config } = await loadConfig(cwd);
  const warnings: string[] = [];

  let modelId = flags.model ?? config.model ?? DEFAULT_MODEL;
  let model: LanguageModel;
  let modelUnavailable: string | undefined;
  try {
    model = resolveModel(modelId, config);
  } catch (err) {
    // An explicitly requested model (-m) fails loud. For a configured/default
    // one, never auto-pick a PAID model — that spends money the user didn't
    // agree to. Free local Ollama is the only automatic fallback; otherwise
    // the agent starts with an inert stub and the user must /model-pick.
    if (flags.model) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    const ollama = await detectOllamaModel(config);
    if (ollama && ollama !== modelId) {
      warnings.push(`${modelId} is unavailable (${reason}) — using local ${ollama} (free). Use /model to switch.`);
      modelId = ollama;
      model = resolveModel(modelId, config);
    } else if (providersWithKeys(config).length > 0) {
      modelUnavailable = reason;
      model = unavailableModel(modelId, reason);
      warnings.push(`${modelId} is unavailable (${reason}). No requests will be made until you pick a model with /model.`);
    } else {
      throw onboardingError(err);
    }
  }
  let mcpConnections: McpConnection[] = [];
  const tools = builtinTools();
  if (flags.mcp && config.mcpServers && Object.keys(config.mcpServers).length > 0) {
    const res = await startMcpServers(config.mcpServers);
    mcpConnections = res.connections;
    warnings.push(...res.warnings);
    for (const c of mcpConnections) tools.push(...c.tools);
  }

  // Pricing/context metadata in the background — cost meter fills in as it lands.
  void import("./providers/modelsdev.js")
    .then(({ primeModelsDev }) =>
      primeModelsDev([...new Set([...Object.keys(PROVIDERS), ...Object.keys(config.providers ?? {})])]),
    )
    .catch(() => {});

  const policy = new PermissionPolicy(config.permissions?.allow ?? [], flags.yolo);
  const skills = await discoverSkills(cwd);
  const customCommands = await discoverCommands(cwd);
  const systemPrompt = await buildSystemPrompt(cwd, modelId, skills);
  if (skills.length > 0) tools.push(createSkillTool(skills));

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

  // Registered after construction so the tool tracks /model switches via the
  // live agent. Resolved lazily so a bad subagentModel surfaces as a tool
  // error, not a startup crash.
  const subModelId = config.subagentModel;
  agent.registerTool(
    createAgentTool({
      getModel: () => ({ model: agent.model, modelId: agent.modelId }),
      ...(subModelId
        ? { getSubagentModel: () => ({ model: resolveModel(subModelId, config), modelId: subModelId }) }
        : {}),
    }),
  );
  agent.registerTool(createQuestionTool({ ...(onQuestion ? { ask: onQuestion } : {}) }));

  return {
    agent,
    mcpConnections,
    warnings,
    modelId,
    cwd,
    config,
    policy,
    customCommands,
    ...(modelUnavailable !== undefined ? { modelUnavailable } : {}),
  };
}

const MAX_STDIN_CHARS = 400_000;

async function readStdin(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) {
    data += chunk.toString();
    if (data.length > MAX_STDIN_CHARS) {
      data = data.slice(0, MAX_STDIN_CHARS) + "\n[...stdin truncated]";
      break;
    }
  }
  return data;
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
      "\nSubcommands:\n  aerin doctor    diagnose your environment (shell, keys, config, ripgrep, MCP)\n  aerin update    update aerin to the latest version from npm\n",
    );

  // Routed before commander parsing so they can't collide with the prompt argument.
  if (argv[2] === "doctor") {
    const { runDoctor } = await import("./modes/doctor.js");
    await runDoctor(process.cwd());
    return;
  }
  if (argv[2] === "update") {
    const { runUpdate } = await import("./modes/update.js");
    await runUpdate();
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
      // Piped input becomes part of the prompt: `cat error.log | aerin -p "why?"`.
      const piped = process.stdin.isTTY ? "" : (await readStdin()).trim();
      const prompt = piped
        ? promptArgs
          ? `${promptArgs}\n\n[piped stdin]:\n${piped}`
          : piped
        : promptArgs;
      if (!prompt) {
        process.stderr.write("aerin -p requires a prompt argument or piped stdin\n");
        process.exitCode = 1;
        return;
      }
      await runPrint(flags, prompt);
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
