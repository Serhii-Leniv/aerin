import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import { Agent } from "../src/core/agent.js";
import type { AgentEvent } from "../src/core/events.js";
import { createDeferredToolBridge, estimateToolTokens, shouldDeferMcpTools } from "../src/core/deferred-tools.js";
import type { ToolDef } from "../src/tools/types.js";
import { PermissionPolicy } from "../src/permissions/policy.js";
import { mockModel } from "./mock-model.js";

/** MCP-shaped ToolDef: JSON-schema passthrough (no zod), execute-tier. */
function fakeMcpTool(name: string, description: string, onExec?: (input: unknown) => string): ToolDef {
  return {
    name,
    description,
    inputSchema: { jsonSchema: { type: "object", properties: { who: { type: "string" } } } } as unknown as z.ZodTypeAny,
    permission: "execute",
    summarize: () => `${name} (MCP)`,
    execute: async (input) => onExec?.(input) ?? "ok",
  };
}

// anthropic/claude-opus-4-8: 200k window -> 10% threshold = 20k tokens (~80k chars).
const MODEL_ID = "anthropic/claude-opus-4-8";

describe("shouldDeferMcpTools", () => {
  test("defers only when schemas would exceed 10% of the context window", () => {
    const small = [fakeMcpTool("mcp__a__x", "tiny")];
    const big = Array.from({ length: 10 }, (_, i) => fakeMcpTool(`mcp__big__t${i}`, "d".repeat(10_000)));
    expect(shouldDeferMcpTools(small, MODEL_ID, undefined)).toBe(false);
    expect(shouldDeferMcpTools(big, MODEL_ID, undefined)).toBe(true);
    expect(estimateToolTokens(big)).toBeGreaterThan(20_000);
  });

  test("config forces it either way, but never with zero tools", () => {
    const small = [fakeMcpTool("mcp__a__x", "tiny")];
    expect(shouldDeferMcpTools(small, MODEL_ID, true)).toBe(true);
    const big = [fakeMcpTool("mcp__a__x", "d".repeat(200_000))];
    expect(shouldDeferMcpTools(big, MODEL_ID, false)).toBe(false);
    expect(shouldDeferMcpTools([], MODEL_ID, true)).toBe(false);
  });
});

describe("bridge tools", () => {
  const defs = [
    fakeMcpTool("mcp__gh__create_issue", "Create a GitHub issue in a repository"),
    fakeMcpTool("mcp__slack__post_message", "Post a message to a Slack channel"),
  ];
  const { bridgeTools, byName } = createDeferredToolBridge(defs);
  const search = bridgeTools.find((t) => t.name === "tool_search") as ToolDef;
  const describeT = bridgeTools.find((t) => t.name === "tool_describe") as ToolDef;
  const call = bridgeTools.find((t) => t.name === "tool_call") as ToolDef;
  const ctx = { cwd: process.cwd(), allowOutsideCwd: false };

  test("search finds by keyword, lists all on empty query", async () => {
    const hit = await search.execute({ query: "github issue" }, ctx);
    expect(hit).toContain("mcp__gh__create_issue");
    expect(hit).not.toContain("mcp__slack__post_message");
    const all = await search.execute({ query: "" }, ctx);
    expect(all).toContain("mcp__gh__create_issue");
    expect(all).toContain("mcp__slack__post_message");
  });

  test("describe returns the raw JSON schema; unknown names get a hint", async () => {
    const out = await describeT.execute({ name: "mcp__gh__create_issue" }, ctx);
    expect(out).toContain('"who"');
    expect(await describeT.execute({ name: "nope" }, ctx)).toContain("tool_search");
  });

  test("tool_call is execute-tier and never runs its own execute", async () => {
    expect(call.permission).toBe("execute");
    expect(call.execute({ name: "x", args: "{}" }, ctx)).rejects.toThrow(/agent loop/);
    expect(byName.size).toBe(2);
  });
});

describe("tool_call dispatch through the agent loop", () => {
  function makeAgent(policy: PermissionPolicy, args: string): { agent: Agent; events: AgentEvent[] } {
    const real = fakeMcpTool("mcp__srv__hello", "Says hello", (input) =>
      (input as { who?: string }).who === "x" ? "HI FROM MCP" : "BAD ARGS",
    );
    const { bridgeTools, byName } = createDeferredToolBridge([real]);
    const agent = new Agent({
      model: mockModel([
        { toolCalls: [{ toolCallId: "c1", toolName: "tool_call", input: { name: "mcp__srv__hello", args } }] },
        { text: "done" },
      ]),
      modelId: "mock/mock",
      systemPrompt: "test",
      tools: bridgeTools,
      policy,
      onPermission: async () => ({ kind: "allow" }),
      cwd: process.cwd(),
      allowOutsideCwd: false,
      deferredTools: byName,
    });
    return { agent, events: [] };
  }

  test("dispatches the real tool with parsed args — events show the real name", async () => {
    const { agent, events } = makeAgent(new PermissionPolicy(["mcp__srv__hello"], false), '{"who":"x"}');
    for await (const e of agent.send("go")) events.push(e);
    const callEv = events.find((e) => e.type === "tool-call") as Extract<AgentEvent, { type: "tool-call" }>;
    expect(callEv.name).toBe("mcp__srv__hello");
    const result = events.find((e) => e.type === "tool-result") as Extract<AgentEvent, { type: "tool-result" }>;
    expect(result.isError).toBe(false);
    expect(result.output).toBe("HI FROM MCP");
  });

  test("deny rules on the real tool name still bite through the bridge", async () => {
    const { agent, events } = makeAgent(new PermissionPolicy([], true, ["mcp__srv__*"]), '{"who":"x"}');
    for await (const e of agent.send("go")) events.push(e);
    const result = events.find((e) => e.type === "tool-result") as Extract<AgentEvent, { type: "tool-result" }>;
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Denied by permission rule");
  });

  test("unknown names and malformed args come back as actionable errors", async () => {
    const bad = makeAgent(new PermissionPolicy([], true), "not json{");
    for await (const e of bad.agent.send("go")) bad.events.push(e);
    const r1 = bad.events.find((e) => e.type === "tool-result") as Extract<AgentEvent, { type: "tool-result" }>;
    expect(r1.isError).toBe(true);
    expect(r1.output).toContain("JSON object string");

    const real = fakeMcpTool("mcp__srv__hello", "Says hello");
    const { bridgeTools, byName } = createDeferredToolBridge([real]);
    const agent = new Agent({
      model: mockModel([
        { toolCalls: [{ toolCallId: "c1", toolName: "tool_call", input: { name: "mcp__other__nope", args: "{}" } }] },
        { text: "done" },
      ]),
      modelId: "mock/mock",
      systemPrompt: "test",
      tools: bridgeTools,
      policy: new PermissionPolicy([], true),
      onPermission: async () => ({ kind: "allow" }),
      cwd: process.cwd(),
      allowOutsideCwd: false,
      deferredTools: byName,
    });
    const events: AgentEvent[] = [];
    for await (const e of agent.send("go")) events.push(e);
    const r2 = events.find((e) => e.type === "tool-result") as Extract<AgentEvent, { type: "tool-result" }>;
    expect(r2.isError).toBe(true);
    expect(r2.output).toContain("tool_search");
  });
});
