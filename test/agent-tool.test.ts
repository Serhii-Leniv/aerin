import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "../src/core/events.js";
import { createAgentTool, subagentTools } from "../src/tools/agent-tool.js";
import { mockModel } from "./mock-model.js";

describe("subagentTools", () => {
  test("is exactly the read-only set — no agent (recursion guard), no write/edit/bash", () => {
    const names = subagentTools().map((t) => t.name).sort();
    expect(names).toEqual(["glob", "grep", "ls", "read"]);
  });

  test("every sub-agent tool is read-tier", () => {
    for (const t of subagentTools()) expect(t.permission).toBe("read");
  });
});

describe("agent tool", () => {
  const deps = { getModel: () => ({ model: mockModel([{ text: "unused" }]), modelId: "mock/mock" }) };

  test("is read-tier and validates its flat schema", () => {
    const tool = createAgentTool(deps);
    expect(tool.permission).toBe("read");
    expect(tool.inputSchema.safeParse({ description: "x", prompt: "y" }).success).toBe(true);
    expect(tool.inputSchema.safeParse({ description: "x" }).success).toBe(false);
    expect(tool.summarize({ description: "find stuff", prompt: "y" })).toBe("Agent(find stuff)");
  });

  test("runs a sub-agent and returns its report, emitting one final update", async () => {
    const tool = createAgentTool({
      getModel: () => ({
        model: mockModel([{ text: "REPORT", usage: { inputTokens: 100, outputTokens: 20 } }]),
        modelId: "mock/mock",
      }),
    });
    const events: AgentEvent[] = [];
    const output = await tool.execute(
      { description: "test task", prompt: "go" },
      { cwd: process.cwd(), allowOutsideCwd: false, onProgress: (e) => events.push(e), toolCallId: "tc1" },
    );
    expect(output).toBe("REPORT");
    const finals = events.filter((e) => e.type === "subagent-update" && e.status !== "running");
    expect(finals).toHaveLength(1);
    const final = finals[0] as Extract<AgentEvent, { type: "subagent-update" }>;
    expect(final.id).toBe("tc1");
    expect(final.status).toBe("done");
    expect(final.description).toBe("test task");
    expect(final.inputTokens).toBe(100);
    expect(final.outputTokens).toBe(20);
  });

  test("uses the subagent model override when provided", async () => {
    let overrideUsed = false;
    const tool = createAgentTool({
      getModel: () => ({ model: mockModel([{ text: "main" }]), modelId: "mock/main" }),
      getSubagentModel: () => {
        overrideUsed = true;
        return { model: mockModel([{ text: "cheap" }]), modelId: "mock/cheap" };
      },
    });
    const output = await tool.execute(
      { description: "x", prompt: "y" },
      { cwd: process.cwd(), allowOutsideCwd: false },
    );
    expect(overrideUsed).toBe(true);
    expect(output).toBe("cheap");
  });

  test("throws when the sub-agent errors without producing a report", async () => {
    const broken = {
      getModel: () => ({
        model: (() => {
          const m = mockModel([{ text: "x" }]) as unknown as { doStream: () => Promise<never> };
          m.doStream = async () => {
            throw new Error("provider exploded");
          };
          return m as unknown as ReturnType<typeof mockModel>;
        })(),
        modelId: "mock/mock",
      }),
    };
    const tool = createAgentTool(broken);
    await expect(
      tool.execute({ description: "x", prompt: "y" }, { cwd: process.cwd(), allowOutsideCwd: false }),
    ).rejects.toThrow(/Sub-agent failed/);
  });
});
