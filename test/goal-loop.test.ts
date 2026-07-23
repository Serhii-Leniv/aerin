import { describe, expect, test } from "bun:test";
import type { LanguageModel } from "ai";
import { Agent } from "../src/core/agent.js";
import type { AgentEvent } from "../src/core/events.js";
import { judgeGoal } from "../src/core/goal-judge.js";
import { PermissionPolicy } from "../src/permissions/policy.js";
import { mockModel } from "./mock-model.js";

/** generateText mock returning replies in sequence (last repeats); optionally throws. */
function seqGenModel(replies: (string | Error)[]): LanguageModel {
  let call = 0;
  return {
    specificationVersion: "v2",
    provider: "mock",
    modelId: "mock-judge",
    supportedUrls: {},
    doGenerate: async () => {
      const r = replies[Math.min(call++, replies.length - 1)] as string | Error;
      if (r instanceof Error) throw r;
      return {
        content: [{ type: "text", text: r }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    },
    doStream: async () => {
      throw new Error("judge mock is generate-only");
    },
  } as unknown as LanguageModel;
}

function goalAgent(turns: { text: string }[], judge: LanguageModel, maxGoalTurns: number): Agent {
  return new Agent({
    model: mockModel(turns),
    modelId: "mock/mock",
    systemPrompt: "test",
    tools: [],
    policy: new PermissionPolicy([], false),
    onPermission: async () => ({ kind: "allow" }),
    cwd: process.cwd(),
    allowOutsideCwd: false,
    maxGoalTurns,
    getJudgeModel: () => judge,
  });
}

describe("judgeGoal", () => {
  test("parses verdicts, tolerating prose around the JSON", async () => {
    const yes = await judgeGoal(seqGenModel(['Sure. {"done": true, "reason": "tests pass"}']), "g", "r");
    expect(yes).toEqual({ done: true, reason: "tests pass" });
    const no = await judgeGoal(seqGenModel(['{"done": false, "reason": "tests not run"}']), "g", "r");
    expect(no.done).toBe(false);
  });

  test("fails open on judge errors and non-JSON output", async () => {
    const err = await judgeGoal(seqGenModel([new Error("provider down")]), "g", "r");
    expect(err.done).toBe(false);
    expect(err.reason).toContain("judge unavailable");
    const junk = await judgeGoal(seqGenModel(["I think it is done!"]), "g", "r");
    expect(junk.done).toBe(false);
  });
});

describe("/goal autonomous loop", () => {
  test("continues after a not-done verdict and stops when the judge sees completion", async () => {
    const judge = seqGenModel([
      '{"done": false, "reason": "tests not run yet"}',
      '{"done": true, "reason": "tests pass"}',
    ]);
    const agent = goalAgent([{ text: "made the change" }, { text: "ran tests: 5 pass" }], judge, 5);
    agent.startGoal("make tests pass");

    const events: AgentEvent[] = [];
    for await (const e of agent.send("make tests pass")) events.push(e);

    const checks = events.filter((e) => e.type === "goal-check") as Extract<AgentEvent, { type: "goal-check" }>[];
    expect(checks.map((c) => c.done)).toEqual([false, true]);
    expect(checks[0]?.reason).toBe("tests not run yet");
    // Both model turns streamed inside ONE send() — the loop is frontend-free.
    const text = events.filter((e) => e.type === "text-delta").map((e) => (e as { text: string }).text).join("");
    expect(text).toContain("made the change");
    expect(text).toContain("ran tests: 5 pass");
    expect(agent.currentGoal).toBeUndefined(); // achieved goals disarm and unpin
    // The continuation rode as a user message carrying the judge's reason.
    const cont = agent.history.find(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("[goal check]"),
    );
    expect(cont).toBeDefined();
  });

  test("stops at the turn budget with the goal still pinned for resumption", async () => {
    const judge = seqGenModel(['{"done": false, "reason": "still failing"}']);
    const agent = goalAgent([{ text: "attempt" }], judge, 2);
    agent.startGoal("fix the flaky test");

    const events: AgentEvent[] = [];
    for await (const e of agent.send("fix the flaky test")) events.push(e);

    const checks = events.filter((e) => e.type === "goal-check") as Extract<AgentEvent, { type: "goal-check" }>[];
    expect(checks).toHaveLength(2);
    expect(checks[1]?.turnsLeft).toBe(0);
    expect(checks[1]?.reason).toContain("budget exhausted");
    expect(agent.currentGoal).toBe("fix the flaky test"); // pinned, resumable
  });

  test("a broken judge fails open — the loop runs to its budget instead of dying", async () => {
    const judge = seqGenModel([new Error("judge exploded")]);
    const agent = goalAgent([{ text: "working" }], judge, 2);
    agent.startGoal("some goal");

    const events: AgentEvent[] = [];
    for await (const e of agent.send("some goal")) events.push(e);

    const checks = events.filter((e) => e.type === "goal-check") as Extract<AgentEvent, { type: "goal-check" }>[];
    expect(checks).toHaveLength(2);
    expect(checks.every((c) => !c.done)).toBe(true);
    expect(checks[0]?.reason).toContain("judge unavailable");
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  test("without an armed goal, send() never judges", async () => {
    const judge = seqGenModel(['{"done": false, "reason": "x"}']);
    const agent = goalAgent([{ text: "hello" }], judge, 5);
    const events: AgentEvent[] = [];
    for await (const e of agent.send("hi")) events.push(e);
    expect(events.some((e) => e.type === "goal-check")).toBe(false);
  });

  test("/clear drops the goal and disarms the loop — a cleared session is a fresh start", async () => {
    const judge = seqGenModel(['{"done": false, "reason": "x"}']);
    const agent = goalAgent([{ text: "t" }], judge, 5);
    agent.startGoal("some goal");
    await agent.clear();
    expect(agent.currentGoal).toBeUndefined();
    const events: AgentEvent[] = [];
    for await (const e of agent.send("hi")) events.push(e);
    expect(events.some((e) => e.type === "goal-check")).toBe(false);
  });

  test("/goal clear disarms the loop", async () => {
    const judge = seqGenModel(['{"done": false, "reason": "x"}']);
    const agent = goalAgent([{ text: "t" }], judge, 5);
    agent.startGoal("g");
    agent.setGoal(undefined);
    const events: AgentEvent[] = [];
    for await (const e of agent.send("hi")) events.push(e);
    expect(events.some((e) => e.type === "goal-check")).toBe(false);
  });
});
