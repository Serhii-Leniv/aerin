import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Agent } from "../src/core/agent.js";
import type { AgentEvent } from "../src/core/events.js";
import type { ToolDef } from "../src/tools/types.js";
import { PermissionPolicy } from "../src/permissions/policy.js";
import { mockModel } from "./mock-model.js";

function progressTool(): ToolDef<z.ZodTypeAny> {
  return {
    name: "slow",
    description: "test tool that reports progress",
    inputSchema: z.object({}),
    permission: "read",
    summarize: () => "slow tool",
    async execute(_input, ctx) {
      ctx.onProgress?.({
        type: "subagent-update",
        id: "sub1",
        description: "probe",
        status: "running",
        toolCalls: 1,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: undefined,
      });
      await new Promise((r) => setTimeout(r, 10));
      ctx.onProgress?.({
        type: "subagent-update",
        id: "sub1",
        description: "probe",
        status: "done",
        toolCalls: 2,
        inputTokens: 50,
        outputTokens: 5,
        costUsd: 0.01,
      });
      return "tool output";
    },
  };
}

describe("tool progress pump", () => {
  test("progress events are yielded between tool-call and tool-result, and spend is folded", async () => {
    const agent = new Agent({
      model: mockModel([
        { toolCalls: [{ toolCallId: "c1", toolName: "slow", input: {} }], usage: { inputTokens: 10, outputTokens: 2 } },
        { text: "all done", usage: { inputTokens: 10, outputTokens: 2 } },
      ]),
      modelId: "mock/mock",
      systemPrompt: "test",
      tools: [progressTool()],
      policy: new PermissionPolicy([], false),
      onPermission: async () => ({ kind: "allow" }),
      cwd: process.cwd(),
      allowOutsideCwd: false,
    });

    const events: AgentEvent[] = [];
    for await (const e of agent.send("go")) events.push(e);

    const types = events.map((e) => e.type);
    const callIdx = types.indexOf("tool-call");
    const resultIdx = types.indexOf("tool-result");
    const progressIdxs = events
      .map((e, i) => (e.type === "subagent-update" ? i : -1))
      .filter((i) => i >= 0);
    expect(progressIdxs).toHaveLength(2);
    for (const i of progressIdxs) {
      expect(i).toBeGreaterThan(callIdx);
      expect(i).toBeLessThan(resultIdx);
    }

    const result = events[resultIdx] as Extract<AgentEvent, { type: "tool-result" }>;
    expect(result.output).toBe("tool output");
    expect(result.isError).toBe(false);

    // Model usage (10+10 in, 2+2 out) plus the folded sub-agent spend (50 in, 5 out, $0.01).
    expect(agent.totalInputTokens).toBe(70);
    expect(agent.totalOutputTokens).toBe(9);
    expect(agent.totalCostUsd).toBeCloseTo(0.01);
  });

  test("iteration cap yields an error event instead of stopping silently", async () => {
    const agent = new Agent({
      model: mockModel([
        { toolCalls: [{ toolCallId: "c1", toolName: "slow", input: {} }], usage: { inputTokens: 1, outputTokens: 1 } },
      ]),
      modelId: "mock/mock",
      systemPrompt: "test",
      tools: [progressTool()],
      policy: new PermissionPolicy([], false),
      onPermission: async () => ({ kind: "allow" }),
      cwd: process.cwd(),
      allowOutsideCwd: false,
      maxIterations: 2,
    });

    const events: AgentEvent[] = [];
    for await (const e of agent.send("go")) events.push(e);
    const errors = events.filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
    expect((errors[0] as Extract<AgentEvent, { type: "error" }>).message).toContain("2 tool iterations");
  });
});
