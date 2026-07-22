import { z } from "zod";
import type { LanguageModel } from "ai";
import type { ToolDef, ToolContext } from "./types.js";
import { truncateOutput } from "./types.js";
import { readTool, lsTool } from "./fs-tools.js";
import { globTool, grepTool } from "./search-tools.js";
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
 */
export function subagentTools(): ToolDef[] {
  return [readTool, lsTool, globTool, grepTool];
}

export interface AgentToolDeps {
  /** Live view of the parent's model so /model switches carry over. */
  getModel: () => { model: LanguageModel; modelId: string };
  /** Optional cheaper model override, from config.subagentModel. */
  getSubagentModel?: () => { model: LanguageModel; modelId: string };
}

interface AgentToolInput {
  description: string;
  prompt: string;
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
            "The sub-agent has read-only access (read, ls, glob, grep) and returns a single text report.",
        ),
    }),
    permission: "read",
    summarize: (input) => `Agent: ${(input as AgentToolInput).description}`,
    async execute(rawInput, ctx: ToolContext): Promise<string> {
      const input = rawInput as AgentToolInput;
      const { model, modelId } = deps.getSubagentModel?.() ?? deps.getModel();
      const id = ctx.toolCallId ?? `subagent-${++subagentCounter}`;

      const sub = new Agent({
        model,
        modelId,
        systemPrompt: buildSubagentSystemPrompt(ctx.cwd),
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
