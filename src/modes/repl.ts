import readline from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";
import { setupAgent, stopMcpServers } from "../cli.js";
import type { PermissionDecision, PermissionRequest } from "../core/events.js";
import { SessionStore } from "../session/store.js";
import { discoverModels } from "../providers/list-models.js";
import { resolveModel } from "../providers/registry.js";
import { renderMarkdown } from "../terminal/markdown.js";

interface ReplFlags {
  model?: string;
  yolo: boolean;
  continue: boolean;
  resume?: string;
  allowOutsideCwd: boolean;
  cwd?: string;
  mcp: boolean;
}

const HELP = `Commands:
  /help         show this help
  /clear        clear conversation history
  /compact      summarize and compact the conversation
  /models       list models available from your providers
  /model <id>   switch model (any provider/model-id)
  /sessions     list sessions in this directory
  /resume [id]  resume a session (latest if no id)
  /exit         quit
Anything else is sent to the agent. Ctrl+C interrupts a running turn.`;

/** Plain readline REPL — no Ink. Kept forever as the TUI's debugging lifeline. */
export async function runRepl(flags: ReplFlags, initialPrompt?: string): Promise<void> {
  // Created only after setup: attaching readline earlier would emit (and drop)
  // any input lines that arrive while setup is still running, e.g. piped stdin.
  let rl!: ReturnType<typeof readline.createInterface>;

  const askPermission = async (req: PermissionRequest): Promise<PermissionDecision> => {
    stdout.write(`\n  ${req.summary}\n`);
    if (req.preview) stdout.write(indent(req.preview, "  | ") + "\n");
    const answer = (await rl.question("  Allow? [y]es / [a]lways (project) / [n]o: ")).trim().toLowerCase();
    if (answer === "y" || answer === "yes") return { kind: "allow" };
    if (answer === "a" || answer === "always") return { kind: "allow-always", scope: "project" };
    const reason = (await rl.question("  Tell the agent what to do instead (optional): ")).trim();
    return { kind: "deny", ...(reason ? { reason } : {}) };
  };

  const setup = await setupAgent(flags, askPermission);
  rl = readline.createInterface({ input: stdin, output: stdout });
  for (const w of setup.warnings) stderr.write(`warning: ${w}\n`);
  const { VERSION } = await import("../version.js");
  stdout.write(`✦ Aerin v${VERSION} — ${setup.modelId}\n  ${setup.cwd} · /help for commands\n\n`);

  let running = false;
  rl.on("SIGINT", () => {
    if (running) {
      setup.agent.abort();
    } else {
      stdout.write("\n");
      rl.close();
    }
  });

  // Humans (TTY) get each message rendered as markdown once it completes;
  // pipes/scripts get the raw token stream so output stays machine-readable.
  const renderForTty = stdout.isTTY === true;

  const runTurn = async (prompt: string): Promise<void> => {
    running = true;
    let textBuf = "";
    try {
      for await (const event of setup.agent.send(prompt)) {
        switch (event.type) {
          case "text-delta":
            if (renderForTty) textBuf += event.text;
            else stdout.write(event.text);
            break;
          case "message-end":
            if (renderForTty) {
              stdout.write(renderMarkdown(textBuf) + "\n");
              textBuf = "";
            } else {
              stdout.write("\n");
            }
            break;
          case "tool-call":
            stdout.write(`\n  ⏺ ${event.summary}\n`);
            break;
          case "tool-result":
            if (event.isError) stdout.write(`  ✗ ${firstLine(event.output)}\n`);
            break;
          case "compaction":
            stdout.write(`  [compacting context — was ${event.preTokens} tokens]\n`);
            break;
          case "usage":
            break;
          case "error":
            stdout.write(`\n  error: ${event.message}\n`);
            break;
          default:
            break;
        }
      }
    } finally {
      running = false;
      // A message cut short by interrupt/error never saw message-end — don't drop it.
      if (renderForTty && textBuf.trim()) stdout.write(renderMarkdown(textBuf) + "\n");
    }
    const cost = setup.agent.totalCostUsd;
    stdout.write(
      `  [${setup.agent.totalInputTokens} in / ${setup.agent.totalOutputTokens} out${cost ? ` / ~$${cost.toFixed(4)}` : ""}]\n\n`,
    );
  };

  // "quit" ends the REPL; anything else continues.
  const handleLine = async (line: string): Promise<"quit" | undefined> => {
      if (!line) return undefined;
      if (line === "/exit" || line === "/quit") return "quit";
      if (line === "/help") {
        stdout.write(HELP + "\n");
        return undefined;
      }
      if (line === "/clear") {
        await setup.agent.clear();
        stdout.write("  (history cleared)\n");
        return undefined;
      }
      if (line === "/compact") {
        try {
          await setup.agent.compactNow();
          stdout.write("  (compacted)\n");
        } catch (err) {
          stdout.write(`  compact failed: ${err instanceof Error ? err.message : err}\n`);
        }
        return undefined;
      }
      if (line === "/resume" || line.startsWith("/resume ")) {
        const id = line.slice("/resume".length).trim() || (await SessionStore.latest(setup.cwd))?.id;
        if (!id) {
          stdout.write("  (no sessions to resume)\n");
          return undefined;
        }
        try {
          const opened = await SessionStore.open(setup.cwd, id);
          setup.agent.loadSession(opened.store, opened.messages);
          stdout.write(`  resumed ${id} (${opened.messages.length} messages)\n`);
        } catch (err) {
          stdout.write(`  resume failed: ${err instanceof Error ? err.message : err}\n`);
        }
        return undefined;
      }
      if (line === "/models") {
        stdout.write("  fetching model lists from your providers...\n");
        const { models, warnings } = await discoverModels(setup.config);
        for (const w of warnings) stderr.write(`  warning: ${w}\n`);
        if (models.length === 0) stdout.write("  (no provider reachable — set an API key first)\n");
        for (const m of models) stdout.write(`  ${m.id}\n`);
        return undefined;
      }
      if (line.startsWith("/model ")) {
        const id = line.slice("/model ".length).trim();
        try {
          setup.agent.setModel(resolveModel(id, setup.config), id);
          stdout.write(`  model switched to ${id}\n`);
        } catch (err) {
          stdout.write(`  ${err instanceof Error ? err.message : err}\n`);
        }
        return undefined;
      }
      if (line === "/sessions") {
        const sessions = await SessionStore.list(setup.cwd);
        for (const s of sessions.slice(0, 20)) {
          stdout.write(`  ${s.id}  ${s.createdAt}  ${s.model}\n`);
        }
        if (sessions.length === 0) stdout.write("  (none)\n");
        return undefined;
      }
      await runTurn(line);
      return undefined;
  };

  try {
    if (initialPrompt) await runTurn(initialPrompt);
    // The async iterator (unlike rl.question) buffers lines that arrive while
    // a command is still being processed — required for piped stdin.
    stdout.write("> ");
    for await (const raw of rl) {
      if (await handleLine(raw.trim()) === "quit") break;
      stdout.write("> ");
    }
  } finally {
    rl.close();
    await stopMcpServers(setup.mcpConnections);
  }
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .slice(0, 40)
    .map((l) => prefix + l)
    .join("\n");
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? "";
}
