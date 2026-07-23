import { z } from "zod";
import type { ToolDef } from "../tools/types.js";
import { modelInfo } from "../providers/models.js";

/**
 * Deferred tool loading (Hermes-style): when connected MCP servers would
 * flood the context with tool schemas, the schemas are withheld from the
 * model and replaced by three small bridge tools —
 *   tool_search(query)      find deferred tools by keyword
 *   tool_describe(name)     full description + input schema of one tool
 *   tool_call(name, args)   invoke one (args as a JSON object string)
 * ~300 tokens of bridge instead of tens of thousands of schema, at the cost
 * of one extra round trip when a tool is actually needed.
 *
 * The agent loop translates tool_call into a dispatch of the REAL tool
 * (agent.ts), so permission tiers, deny rules like mcp__github__*, hooks,
 * and /undo snapshots behave exactly as if the tool were called directly.
 *
 * Activation: automatic when deferred schemas would eat >10% of the model's
 * context window (Hermes's threshold); config "deferMcpTools" forces it
 * on or off.
 */

const DEFER_FRACTION = 0.1;

/** The raw JSON schema an MCP ToolDef carries inside the ai-sdk jsonSchema() wrapper. */
function rawSchemaOf(def: ToolDef): unknown {
  return (def.inputSchema as unknown as { jsonSchema?: unknown }).jsonSchema ?? {};
}

/** ~4 chars/token over what the schemas would add to every request. */
export function estimateToolTokens(defs: readonly ToolDef[]): number {
  let chars = 0;
  for (const d of defs) {
    chars += d.name.length + d.description.length + JSON.stringify(rawSchemaOf(d)).length;
  }
  return Math.ceil(chars / 4);
}

export function shouldDeferMcpTools(
  defs: readonly ToolDef[],
  modelId: string,
  configured: boolean | undefined,
): boolean {
  if (defs.length === 0) return false;
  if (configured !== undefined) return configured;
  return estimateToolTokens(defs) > modelInfo(modelId).contextWindow * DEFER_FRACTION;
}

export interface DeferredBridge {
  /** Schema-visible bridge tools to register in place of the deferred ones. */
  bridgeTools: ToolDef[];
  /** Lookup the agent loop uses to translate tool_call into the real tool. */
  byName: Map<string, ToolDef>;
}

export function createDeferredToolBridge(deferred: readonly ToolDef[]): DeferredBridge {
  const byName = new Map(deferred.map((d) => [d.name, d]));

  const searchTool: ToolDef<z.ZodTypeAny> = {
    name: "tool_search",
    description:
      `Search the ${deferred.length} deferred MCP tools (their schemas are not loaded to save context). ` +
      "Returns matching tool names with short descriptions. Use tool_describe for full input details, " +
      "then tool_call to invoke. An empty query lists everything.",
    inputSchema: z.object({
      query: z.string().describe("Keywords to match against tool names and descriptions; empty lists all"),
    }),
    permission: "read",
    summarize: (i) => `ToolSearch(${String((i as { query?: string }).query ?? "")})`,
    async execute(input) {
      const query = String((input as { query?: string }).query ?? "").toLowerCase();
      const terms = query.split(/\s+/).filter((t) => t.length >= 2);
      const scored = deferred
        .map((d) => {
          const hay = `${d.name} ${d.description}`.toLowerCase();
          const hits = terms.filter((t) => hay.includes(t)).length;
          return { d, hits };
        })
        .filter((s) => terms.length === 0 || s.hits > 0)
        .sort((a, b) => b.hits - a.hits);
      if (scored.length === 0) return `No deferred tools match "${query}". An empty query lists all of them.`;
      const lines = scored.slice(0, 25).map(({ d }) => `- ${d.name}: ${d.description.replace(/\s+/g, " ").slice(0, 140)}`);
      const more = scored.length > 25 ? `\n(${scored.length - 25} more — refine the query)` : "";
      return `${lines.join("\n")}${more}\nNext: tool_describe for input details, then tool_call.`;
    },
  };

  const describeTool: ToolDef<z.ZodTypeAny> = {
    name: "tool_describe",
    description: "Full description and JSON input schema of one deferred MCP tool (find names with tool_search).",
    inputSchema: z.object({
      name: z.string().describe("Exact tool name from tool_search"),
    }),
    permission: "read",
    summarize: (i) => `ToolDescribe(${String((i as { name?: string }).name ?? "")})`,
    async execute(input) {
      const name = String((input as { name?: string }).name ?? "");
      const def = byName.get(name);
      if (!def) return `No deferred tool named "${name}". Use tool_search to find the right name.`;
      const schema = JSON.stringify(rawSchemaOf(def), null, 2).slice(0, 4000);
      return `${def.name}\n${def.description}\n\nInput schema (pass matching JSON to tool_call as the args string):\n${schema}`;
    },
  };

  // Schema and description only — the agent loop intercepts tool_call and
  // dispatches the real tool, so this execute must never run.
  const callTool: ToolDef<z.ZodTypeAny> = {
    name: "tool_call",
    description:
      "Invoke a deferred MCP tool by exact name. args is a JSON OBJECT STRING matching the schema from " +
      'tool_describe, e.g. {"name":"mcp__github__create_issue","args":"{\\"title\\":\\"Bug\\"}"}. ' +
      "Permissions apply exactly as if the tool were called directly.",
    inputSchema: z.object({
      name: z.string().describe("Exact deferred tool name"),
      args: z.string().describe("The tool's arguments as a JSON object string; \"{}\" if none"),
    }),
    permission: "execute",
    summarize: (i) => `ToolCall(${String((i as { name?: string }).name ?? "")})`,
    async execute() {
      throw new Error("tool_call must be dispatched by the agent loop, never executed directly.");
    },
  };

  return { bridgeTools: [searchTool, describeTool, callTool], byName };
}
