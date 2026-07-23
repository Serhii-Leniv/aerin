import { describe, expect, test } from "bun:test";
import type { LanguageModel } from "ai";
import { Agent, isFailoverEligible } from "../src/core/agent.js";
import type { AgentEvent } from "../src/core/events.js";
import { PermissionPolicy } from "../src/permissions/policy.js";
import { mockModel } from "./mock-model.js";

/** A model whose doStream always throws the given error. */
function brokenModel(message: string): LanguageModel {
  const m = mockModel([{ text: "unreachable" }]) as unknown as { doStream: () => Promise<never> };
  m.doStream = async () => {
    throw new Error(message);
  };
  return m as unknown as LanguageModel;
}

function makeAgent(
  primary: LanguageModel,
  fallbacks: { modelId: string; resolve: () => LanguageModel }[],
): Agent {
  return new Agent({
    model: primary,
    modelId: "mock/primary",
    systemPrompt: "test",
    tools: [],
    policy: new PermissionPolicy([], false),
    onPermission: async () => ({ kind: "allow" }),
    cwd: process.cwd(),
    allowOutsideCwd: false,
    fallbacks,
  });
}

describe("isFailoverEligible", () => {
  test("retryable and quota/billing errors are eligible; auth errors are not", () => {
    expect(isFailoverEligible(new Error("429 too many requests"))).toBe(true);
    expect(isFailoverEligible(new Error("Daily quota exceeded for this model"))).toBe(true);
    expect(isFailoverEligible(new Error("insufficient credit — billing required"))).toBe(true);
    expect(isFailoverEligible(new Error("Invalid API key provided"))).toBe(false);
  });
});

describe("provider failover chain", () => {
  test("a spent quota fails over immediately and the turn completes on the fallback", async () => {
    // Quota errors are fail-fast (not retried), so this test has no backoff delays.
    const agent = makeAgent(brokenModel("Daily quota exceeded"), [
      { modelId: "mock/backup", resolve: () => mockModel([{ text: "SAVED BY BACKUP" }]) },
    ]);
    const events: AgentEvent[] = [];
    for await (const e of agent.send("go")) events.push(e);

    const fo = events.find((e) => e.type === "failover") as Extract<AgentEvent, { type: "failover" }>;
    expect(fo.from).toBe("mock/primary");
    expect(fo.to).toBe("mock/backup");
    expect(fo.message).toContain("quota");
    const text = events.filter((e) => e.type === "text-delta").map((e) => (e as { text: string }).text).join("");
    expect(text).toBe("SAVED BY BACKUP");
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  test("unresolvable and equally-broken fallbacks are walked past in order", async () => {
    const agent = makeAgent(brokenModel("Daily quota exceeded"), [
      {
        modelId: "mock/no-key",
        resolve: () => {
          throw new Error("no API key");
        },
      },
      { modelId: "mock/also-broken", resolve: () => brokenModel("insufficient credit billing") },
      { modelId: "mock/works", resolve: () => mockModel([{ text: "THIRD TIME LUCKY" }]) },
    ]);
    const events: AgentEvent[] = [];
    for await (const e of agent.send("go")) events.push(e);

    const fos = events.filter((e) => e.type === "failover") as Extract<AgentEvent, { type: "failover" }>[];
    expect(fos.map((f) => f.to)).toEqual(["mock/also-broken", "mock/works"]);
    const text = events.filter((e) => e.type === "text-delta").map((e) => (e as { text: string }).text).join("");
    expect(text).toBe("THIRD TIME LUCKY");
  });

  test("an exhausted chain surfaces the original error", async () => {
    const agent = makeAgent(brokenModel("Daily quota exceeded"), [
      { modelId: "mock/backup", resolve: () => brokenModel("billing limit reached") },
    ]);
    const events: AgentEvent[] = [];
    for await (const e of agent.send("go")) events.push(e);
    expect(events.filter((e) => e.type === "failover")).toHaveLength(1);
    const err = events.find((e) => e.type === "error") as Extract<AgentEvent, { type: "error" }>;
    expect(err.message.toLowerCase()).toContain("billing");
  });

  test("ineligible errors never fail over", async () => {
    const agent = makeAgent(brokenModel("Invalid API key provided"), [
      { modelId: "mock/backup", resolve: () => mockModel([{ text: "nope" }]) },
    ]);
    const events: AgentEvent[] = [];
    for await (const e of agent.send("go")) events.push(e);
    expect(events.some((e) => e.type === "failover")).toBe(false);
    const err = events.find((e) => e.type === "error") as Extract<AgentEvent, { type: "error" }>;
    expect(err.message.toLowerCase()).toContain("api key");
  });
});
