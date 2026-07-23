import { describe, expect, test } from "bun:test";
import { Agent } from "../src/core/agent.js";
import type { AgentEvent } from "../src/core/events.js";
import { runLifecycleHook } from "../src/core/hooks.js";
import { PermissionPolicy } from "../src/permissions/policy.js";
import { mockModel, type MockTurn } from "./mock-model.js";

function emitJson(obj: unknown): string {
  const b64 = Buffer.from(JSON.stringify(obj)).toString("base64");
  return `node -e "console.log(Buffer.from('${b64}','base64').toString())"`;
}

function makeAgent(turns: MockTurn[], hooks: Record<string, string>): Agent {
  return new Agent({
    model: mockModel(turns),
    modelId: "mock/mock",
    systemPrompt: "test",
    tools: [],
    policy: new PermissionPolicy([], false),
    onPermission: async () => ({ kind: "allow" }),
    cwd: process.cwd(),
    allowOutsideCwd: false,
    hooks,
  });
}

describe("runLifecycleHook", () => {
  const cwd = process.cwd();

  test("returns undefined when unconfigured; {} for non-JSON output", async () => {
    expect(await runLifecycleHook(undefined, "session:start", {}, cwd)).toBeUndefined();
    expect(await runLifecycleHook({ "session:start": `node -e "console.log('starting up')"` }, "session:start", {}, cwd)).toEqual({});
  });

  test("parses context and block verdicts", async () => {
    const ctx = await runLifecycleHook({ "session:start": emitJson({ context: "deploy freeze until Friday" }) }, "session:start", {}, cwd);
    expect(ctx?.context).toBe("deploy freeze until Friday");
    const block = await runLifecycleHook({ "prompt:submit": emitJson({ decision: "block", reason: "off-hours" }) }, "prompt:submit", {}, cwd);
    expect(block?.blockReason).toBe("off-hours");
  });
});

describe("lifecycle hooks in the agent loop", () => {
  test("prompt:submit block vetoes the prompt — the model is never called", async () => {
    const agent = makeAgent([{ text: "should not appear" }], {
      "prompt:submit": emitJson({ decision: "block", reason: "prompts are frozen" }),
    });
    const events: AgentEvent[] = [];
    for await (const e of agent.send("do something")) events.push(e);
    const err = events.find((e) => e.type === "error") as Extract<AgentEvent, { type: "error" }>;
    expect(err.message).toContain("prompts are frozen");
    expect(events.some((e) => e.type === "text-delta")).toBe(false);
    expect(agent.history).toHaveLength(0); // nothing was sent or stored
  });

  test("prompt:submit context rides along with the user message", async () => {
    const agent = makeAgent([{ text: "ok" }], {
      "prompt:submit": emitJson({ context: "REMEMBER-THE-FREEZE" }),
    });
    for await (const _ of agent.send("hello")) void _;
    const user = agent.history.find((m) => m.role === "user");
    expect(JSON.stringify(user)).toContain("REMEMBER-THE-FREEZE");
  });

  test("turn:end block sends the agent back to work, capped at 3 rounds", async () => {
    const agent = makeAgent(
      [{ text: "attempt 1" }, { text: "attempt 2" }, { text: "attempt 3" }, { text: "attempt 4" }],
      { "turn:end": emitJson({ decision: "block", reason: "tests were not run" }) },
    );
    const events: AgentEvent[] = [];
    for await (const e of agent.send("do the task")) events.push(e);

    const notices = events.filter(
      (e) => e.type === "tool-display" && (e as { text: string }).text.includes("turn:end hook"),
    );
    expect(notices).toHaveLength(3); // hard cap — an always-blocking hook cannot trap the turn
    const rejections = agent.history.filter(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("[turn:end hook]"),
    );
    expect(rejections).toHaveLength(3);
    const text = events.filter((e) => e.type === "text-delta").map((e) => (e as { text: string }).text).join("");
    expect(text).toContain("attempt 4"); // worked through all forced continuations
    expect(events.some((e) => e.type === "error")).toBe(false);
  });
});
