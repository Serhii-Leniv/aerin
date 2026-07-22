import { z } from "zod";
import type { LanguageModel } from "ai";
import type { ToolDef, ToolContext } from "./types.js";
import { truncateOutput } from "./types.js";
import { readTool, lsTool } from "./fs-tools.js";
import { globTool, grepTool } from "./search-tools.js";
import { webFetchTool, webSearchTool } from "./web-tools.js";
import { Agent } from "../core/agent.js";
import { buildSubagentSystemPrompt } from "../core/system-prompt.js";
import { PermissionPolicy } from "../permissions/policy.js";

const SUBAGENT_MAX_ITERATIONS = 15;
/** Cumulative in+out tokens after which a runaway sub-agent is aborted. */
const SUBAGENT_TOKEN_BUDGET = 500_000;

/**
 * Read-only toolset for sub-agents. No bash (keeps the agent tool read-tier,
 * so it auto-runs without a permission prompt), no write/edit, and — the
 * recursion guard — no agent tool, so a sub-agent cannot spawn sub-agents.
 * Web tools are read-only too, so research sub-agents can consult the web.
 */
export function subagentTools(): ToolDef[] {
  return [readTool, lsTool, globTool, grepTool, webSearchTool, webFetchTool];
}

export interface AgentToolDeps {
  /** Live view of the parent's model so /model switches carry over. */
  getModel: () => { model: LanguageModel; modelId: string };
  /** Optional cheaper model override, from config.subagentModel. */
  getSubagentModel?: () => { model: LanguageModel; modelId: string };
  /** Named custom agents (.aerin/agents/*.md) selectable via input.agent. */
  namedAgents?: readonly import("../core/agents.js").NamedAgent[];
  /** Resolve a named agent's model override. */
  resolveModelFn?: (id: string) => LanguageModel;
}

interface AgentToolInput {
  description: string;
  prompt: string;
  agent?: string;
}

let subagentCounter = 0;

export function createAgentTool(deps: AgentToolDeps): ToolDef<z.ZodTypeAny> {
  return {
    name: "agent",
    description:
      "Delegate a research task to a read-only sub-agent with its own context window. " +
      "It explores the codebase (read, ls, glob, grep) and returns a single text report — " +
      "the raw file contents it reads never enter this conversation. " +
      "Use it for broad or exploratory questions; read files directly when you know exactly where to look.",
    inputSchema: z.object({
      description: z.string().describe("Short 3-6 word label for the task, shown to the user"),
      prompt: z
        .string()
        .describe(
          "The full task. Be specific: what to find, what to report back. " +
            "The sub-agent has read-only access (read, ls, glob, grep, websearch, webfetch) " +
            "and returns a single text report.",
        ),
      agent: z
        .string()
        .optional()
        .describe("Named custom agent to use (listed in the system prompt); omit for the default researcher"),
    }),
    permission: "read",
    summarize: (input) => {
      const i = input as AgentToolInput;
      return `Agent(${i.agent ? `${i.agent}: ` : ""}${i.description})`;
    },
    async execute(rawInput, ctx: ToolContext): Promise<string> {
      const input = rawInput as AgentToolInput;
      const named = input.agent ? deps.namedAgents?.find((a) => a.name === input.agent) : undefined;
      if (input.agent && !named) {
        const known = deps.namedAgents?.map((a) => a.name).join(", ") || "none";
        throw new Error(`Unknown named agent: ${input.agent}. Available: ${known}`);
      }
      let { model, modelId } = deps.getSubagentModel?.() ?? deps.getModel();
      if (named?.model && deps.resolveModelFn) {
        model = deps.resolveModelFn(named.model);
        modelId = named.model;
      }
      const id = ctx.toolCallId ?? `subagent-${++subagentCounter}`;

      const sub = new Agent({
        model,
        modelId,
        // A named agent's own prompt leads; the standard sub-agent rules
        // (read-only, report contract) always apply underneath.
        systemPrompt: named
          ? `${named.systemPrompt}\n\n${buildSubagentSystemPrompt(ctx.cwd)}`
          : buildSubagentSystemPrompt(ctx.cwd),
        tools: subagentTools(),
        policy: new PermissionPolicy([], false),
        // Belt-and-braces: every sub-agent tool is read-tier and never asks,
        // but if that invariant is ever broken, deny rather than hang.
        onPermission: async () => ({ kind: "deny", reason: "Sub-agents cannot request permissions." }),
        cwd: ctx.cwd,
        allowOutsideCwd: ctx.allowOutsideCwd,
        maxIterations: SUBAGENT_MAX_ITERATIONS,
      });

      const onAbort = (): void => sub.abort();
      ctx.abortSignal?.addEventListener("abort", onAbort);

      let toolCalls = 0;
      let lastTool: string | undefined;
      let inputTokens = 0;
      let outputTokens = 0;
      let costUsd: number | undefined;
      let errorMsg: string | undefined;
      let budgetExceeded = false;
      let textBuf = "";
      let finalText = "";

      const progress = (status: "running" | "done" | "error"): void => {
        ctx.onProgress?.({
          type: "subagent-update",
          id,
          description: input.description,
          status,
          ...(lastTool !== undefined ? { lastTool } : {}),
          toolCalls,
          inputTokens,
          outputTokens,
          costUsd,
        });
      };

      try {
        for await (const event of sub.send(input.prompt)) {
          switch (event.type) {
            case "text-delta":
              textBuf += event.text;
              break;
            case "message-end":
              // The last completed assistant message is the report;
              // intermediate narration is discarded.
              finalText = textBuf;
              textBuf = "";
              break;
            case "tool-call":
              toolCalls++;
              lastTool = event.summary;
              progress("running");
              break;
            case "usage":
              inputTokens += event.inputTokens;
              outputTokens += event.outputTokens;
              if (event.costUsd !== undefined) costUsd = (costUsd ?? 0) + event.costUsd;
              progress("running");
              if (inputTokens + outputTokens > SUBAGENT_TOKEN_BUDGET && !budgetExceeded) {
                budgetExceeded = true;
                sub.abort(); // keep whatever report text exists
              }
              break;
            case "error":
              errorMsg = event.message;
              break;
            default:
              break;
          }
        }
      } finally {
        ctx.abortSignal?.removeEventListener("abort", onAbort);
      }
      // A partial stream that never reached message-end still counts as a report.
      if (!finalText && textBuf.trim()) finalText = textBuf;

      if (ctx.abortSignal?.aborted) {
        progress("error");
        throw new Error("Interrupted.");
      }
      if (errorMsg && !finalText) {
        progress("error");
        throw new Error(
          budgetExceeded ? "Sub-agent exceeded its token budget before producing a report." : `Sub-agent failed: ${errorMsg}`,
        );
      }
      progress("done");
      return truncateOutput(finalText || "(sub-agent produced no report)");
    },
  };
}
