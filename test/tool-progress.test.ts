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

  test("multiple agent tool calls in one turn run concurrently", async () => {
    // Two fake "agent" tools that overlap in time: if run sequentially, total
    // would be ~2x the single duration; concurrently they interleave.
    const running: number[] = [];
    let maxConcurrent = 0;
    const agentDef: ToolDef<z.ZodTypeAny> = {
      name: "agent",
      description: "fake sub-agent",
      inputSchema: z.object({ n: z.number() }),
      permission: "read",
      summarize: (i) => `Agent(${i.n})`,
      async execute(input) {
        running.push(1);
        maxConcurrent = Math.max(maxConcurrent, running.length);
        await new Promise((r) => setTimeout(r, 40));
        running.pop();
        return `report-${input.n}`;
      },
    };
    const agent = new Agent({
      model: mockModel([
        {
          toolCalls: [
            { toolCallId: "a1", toolName: "agent", input: { n: 1 } },
            { toolCallId: "a2", toolName: "agent", input: { n: 2 } },
          ],
          usage: { inputTokens: 1, outputTokens: 1 },
        },
        { text: "done", usage: { inputTokens: 1, outputTokens: 1 } },
      ]),
      modelId: "mock/mock",
      systemPrompt: "test",
      tools: [agentDef],
      policy: new PermissionPolicy([], false),
      onPermission: async () => ({ kind: "allow" }),
      cwd: process.cwd(),
      allowOutsideCwd: false,
    });

    const events: AgentEvent[] = [];
    for await (const e of agent.send("go")) events.push(e);
    expect(maxConcurrent).toBe(2);
    const results = events.filter((e) => e.type === "tool-result") as Extract<
      AgentEvent,
      { type: "tool-result" }
    >[];
    expect(results.map((r) => r.output).sort()).toEqual(["report-1", "report-2"]);
    expect(results.every((r) => !r.isError)).toBe(true);
  });

  test("missing usage (local models) falls back to estimates", async () => {
    const agent = new Agent({
      model: mockModel([{ text: "a reasonably long local-model reply for estimation purposes" }]), // no usage reported
      modelId: "ollama/qwen3",
      systemPrompt: "test",
      tools: [],
      policy: new PermissionPolicy([], false),
      onPermission: async () => ({ kind: "allow" }),
      cwd: process.cwd(),
      allowOutsideCwd: false,
    });
    const events: AgentEvent[] = [];
    for await (const e of agent.send("hello there")) events.push(e);
    const usage = events.find((e) => e.type === "usage") as Extract<AgentEvent, { type: "usage" }>;
    expect(usage.inputTokens).toBeGreaterThan(0); // estimated, not zero
    expect(usage.outputTokens).toBeGreaterThan(0);
    expect(agent.totalInputTokens).toBeGreaterThan(0);
  });

  test("inject() delivers a mid-turn user message into the running turn", async () => {
    const requests: string[] = [];
    const slowTool: ToolDef<z.ZodTypeAny> = {
      name: "slow",
      description: "t",
      inputSchema: z.object({}),
      permission: "read",
      summarize: () => "slow",
      execute: async () => "tool done",
    };
    const model = mockModel([
      { toolCalls: [{ toolCallId: "c1", toolName: "slow", input: {} }], usage: { inputTokens: 1, outputTokens: 1 } },
      { text: "final answer", usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const orig = (model as unknown as { doStream: (o: { prompt: unknown }) => Promise<unknown> }).doStream;
    (model as unknown as { doStream: (o: { prompt: unknown }) => Promise<unknown> }).doStream = (o) => {
      requests.push(JSON.stringify(o.prompt));
      return orig.call(model, o);
    };
    const agent = new Agent({
      model,
      modelId: "mock/mock",
      systemPrompt: "s",
      tools: [slowTool],
      policy: new PermissionPolicy([], false),
      onPermission: async () => ({ kind: "allow" }),
      cwd: process.cwd(),
      allowOutsideCwd: false,
    });
    for await (const e of agent.send("start the task")) {
      if (e.type === "tool-call") agent.inject("ALSO check the tests please");
    }
    expect(requests.length).toBe(2);
    expect(requests[1]).toContain("ALSO check the tests please");
    expect(requests[1]).toContain("while you were working");
    // the injected message persists in history
    expect(JSON.stringify(agent.history)).toContain("ALSO check the tests please");
  });

  test("a pinned goal reaches the system prompt; clearing removes it", async () => {
    const requests: string[] = [];
    const model = mockModel([{ text: "ok", usage: { inputTokens: 1, outputTokens: 1 } }]);
    const orig = (model as unknown as { doStream: (o: { prompt: unknown }) => Promise<unknown> }).doStream;
    (model as unknown as { doStream: (o: { prompt: unknown }) => Promise<unknown> }).doStream = (o) => {
      requests.push(JSON.stringify(o.prompt));
      return orig.call(model, o);
    };
    const agent = new Agent({
      model,
      modelId: "mock/mock",
      systemPrompt: "base rules",
      tools: [],
      policy: new PermissionPolicy([], false),
      onPermission: async () => ({ kind: "allow" }),
      cwd: process.cwd(),
      allowOutsideCwd: false,
    });
    agent.setGoal("ship the release");
    for await (const e of agent.send("hi")) void e;
    expect(requests[0]).toContain("Session goal");
    expect(requests[0]).toContain("ship the release");
    agent.setGoal(undefined);
    expect(agent.currentGoal).toBeUndefined();
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
