import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Agent } from "../src/core/agent.js";
import type { AgentEvent, PermissionRequest } from "../src/core/events.js";
import type { ToolDef } from "../src/tools/types.js";
import { PermissionPolicy } from "../src/permissions/policy.js";
import { mockModel, type MockTurn } from "./mock-model.js";

/** Read-tier tool — outside a doom loop it never triggers a permission ask. */
function probeTool(): ToolDef<z.ZodTypeAny> {
  return {
    name: "probe",
    description: "test probe",
    inputSchema: z.object({ q: z.string() }),
    permission: "read",
    summarize: (i) => `Probe(${String((i as { q?: string }).q)})`,
    execute: async () => "same result",
  };
}

function probeTurns(inputs: string[]): MockTurn[] {
  return [
    ...inputs.map((q, i) => ({ toolCalls: [{ toolCallId: `c${i}`, toolName: "probe", input: { q } }] })),
    { text: "done" },
  ];
}

function makeAgent(turns: MockTurn[], onPermission: (req: PermissionRequest) => Promise<import("../src/core/events.js").PermissionDecision>): Agent {
  return new Agent({
    model: mockModel(turns),
    modelId: "mock/mock",
    systemPrompt: "test",
    tools: [probeTool()],
    policy: new PermissionPolicy([], false),
    onPermission,
    cwd: process.cwd(),
    allowOutsideCwd: false,
  });
}

describe("doom-loop detection", () => {
  test("the 4th identical call asks; denial returns change-your-approach guidance", async () => {
    const asks: PermissionRequest[] = [];
    const agent = makeAgent(probeTurns(["x", "x", "x", "x"]), async (req) => {
      asks.push(req);
      return { kind: "deny", reason: "that file will never contain it" };
    });
    const events: AgentEvent[] = [];
    for await (const e of agent.send("go")) events.push(e);

    expect(asks).toHaveLength(1); // read tool: the ONLY ask is the doom-loop one
    expect(asks[0]?.summary).toContain("Doom loop");
    const results = events.filter((e) => e.type === "tool-result") as Extract<AgentEvent, { type: "tool-result" }>[];
    expect(results.slice(0, 3).every((r) => !r.isError)).toBe(true);
    const fourth = results[3] as Extract<AgentEvent, { type: "tool-result" }>;
    expect(fourth.isError).toBe(true);
    expect(fourth.output).toContain("IDENTICAL input");
    expect(fourth.output).toContain("that file will never contain it");
    expect(fourth.output).toContain("Change your approach");
  });

  test("allow-always whitelists the tool — no second ask on the 5th identical call", async () => {
    let asks = 0;
    const agent = makeAgent(probeTurns(["x", "x", "x", "x", "x"]), async () => {
      asks++;
      return { kind: "allow-always", scope: "session" };
    });
    const events: AgentEvent[] = [];
    for await (const e of agent.send("go")) events.push(e);

    expect(asks).toBe(1);
    const results = events.filter((e) => e.type === "tool-result") as Extract<AgentEvent, { type: "tool-result" }>[];
    expect(results).toHaveLength(5);
    expect(results.every((r) => !r.isError)).toBe(true); // all executed
  });

  test("varying inputs never trigger, however many calls", async () => {
    let asks = 0;
    const agent = makeAgent(probeTurns(["a", "b", "a", "b", "a", "b"]), async () => {
      asks++;
      return { kind: "allow" };
    });
    for await (const _ of agent.send("go")) void _;
    expect(asks).toBe(0);
  });

  test("tracking resets between turns", async () => {
    let asks = 0;
    const onPerm = async (): Promise<import("../src/core/events.js").PermissionDecision> => {
      asks++;
      return { kind: "allow" };
    };
    // 3 identical calls in turn one, then a 4th identical in a fresh turn: no trigger.
    const agent = new Agent({
      model: mockModel([...probeTurns(["x", "x", "x"]), ...probeTurns(["x"])]),
      modelId: "mock/mock",
      systemPrompt: "test",
      tools: [probeTool()],
      policy: new PermissionPolicy([], false),
      onPermission: onPerm,
      cwd: process.cwd(),
      allowOutsideCwd: false,
    });
    for await (const _ of agent.send("turn one")) void _;
    for await (const _ of agent.send("turn two")) void _;
    expect(asks).toBe(0);
  });
});
