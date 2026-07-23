import { describe, expect, test } from "bun:test";
import type { LanguageModel, ModelMessage } from "ai";
import { COMPACTION_MARKER, compact } from "../src/core/compact.js";

/** generateText-capable mock that records every prompt it receives. */
function mockGenModel(reply: string, prompts: unknown[]): LanguageModel {
  return {
    specificationVersion: "v2",
    provider: "mock",
    modelId: "mock",
    supportedUrls: {},
    doGenerate: async (options: { prompt: unknown }) => {
      prompts.push(options.prompt);
      return {
        content: [{ type: "text", text: reply }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    },
    doStream: async () => {
      throw new Error("doStream not used by compact");
    },
  } as unknown as LanguageModel;
}

// claude-opus-4-8 has a 200k window -> tail budget caps at 16k estimated tokens.
const MODEL_ID = "anthropic/claude-opus-4-8";

/** ~500 estimated tokens per message so the 16k tail budget cuts after ~32. */
function bigMsg(role: "user" | "assistant", i: number): ModelMessage {
  return { role, content: `msg-${i} ${"x".repeat(2000)}` } as ModelMessage;
}

describe("compact", () => {
  test("small histories are returned untouched without an LLM call", async () => {
    const prompts: unknown[] = [];
    const model = mockGenModel("SUMMARY", prompts);
    const messages: ModelMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    expect(await compact(model, MODEL_ID, messages)).toBe(messages);
    expect(prompts.length).toBe(0);
  });

  test("folds the head into a marker summary and keeps a token-budgeted tail", async () => {
    const prompts: unknown[] = [];
    const model = mockGenModel("Goal: test\nDone: things", prompts);
    const messages = Array.from({ length: 60 }, (_, i) => bigMsg(i % 2 === 0 ? "user" : "assistant", i));
    const out = await compact(model, MODEL_ID, messages);

    expect(prompts.length).toBe(1);
    expect(out.length).toBeLessThan(messages.length);
    const first = out[0] as { role: string; content: string };
    expect(first.role).toBe("user");
    expect(first.content.startsWith(COMPACTION_MARKER)).toBe(true);
    expect(first.content).toContain("Goal: test");
    // The tail is the original trailing messages, verbatim and in order.
    const tail = out.slice(1);
    expect(tail).toEqual(messages.slice(messages.length - tail.length));
    // Budget math: ~500 tokens/message against a 16k budget keeps ~32 messages.
    expect(tail.length).toBeGreaterThan(20);
    expect(tail.length).toBeLessThan(40);
  });

  test("re-compaction updates the prior summary instead of re-summarizing it", async () => {
    const prompts: unknown[] = [];
    const model = mockGenModel("Goal: updated", prompts);
    const messages: ModelMessage[] = [
      { role: "user", content: `${COMPACTION_MARKER}\n\nGoal: OLD-RUNNING-SUMMARY` },
      ...Array.from({ length: 60 }, (_, i) => bigMsg(i % 2 === 0 ? "assistant" : "user", i)),
    ];
    const out = await compact(model, MODEL_ID, messages);

    const sent = JSON.stringify(prompts[0]);
    expect(sent).toContain("OLD-RUNNING-SUMMARY");
    expect(sent).toContain("merge into it");
    expect(sent).toContain("UPDATED running summary");
    const first = out[0] as { content: string };
    expect(first.content).toContain("Goal: updated");
    expect(first.content).not.toContain("OLD-RUNNING-SUMMARY"); // replaced, not stacked
  });

  test("the tail never starts inside a tool-call/result pair", async () => {
    const prompts: unknown[] = [];
    const model = mockGenModel("SUMMARY", prompts);
    const filler = Array.from({ length: 40 }, (_, i) => bigMsg(i % 2 === 0 ? "user" : "assistant", i));
    const giantCall: ModelMessage = {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "c1", toolName: "write", input: { path: "a.txt", content: "y".repeat(68_000) } }],
    } as ModelMessage;
    const toolResult: ModelMessage = {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "c1", toolName: "write", output: { type: "text", value: "ok" } }],
    } as ModelMessage;
    const smallTail = Array.from({ length: 5 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `t${i}` }) as ModelMessage);
    const messages = [...filler, giantCall, toolResult, ...smallTail];

    const out = await compact(model, MODEL_ID, messages);
    const tail = out.slice(1);
    expect((tail[0] as { role: string }).role).not.toBe("tool");
    // The pair survived intact at the tail boundary.
    const first = tail[0] as { role: string; content: { type: string }[] };
    expect(first.role).toBe("assistant");
    expect(first.content[0]?.type).toBe("tool-call");
    expect((tail[1] as { role: string }).role).toBe("tool");
  });

  test("bulky tool outputs are elided from the summarization prompt", async () => {
    const prompts: unknown[] = [];
    const model = mockGenModel("SUMMARY", prompts);
    const noisy = "Z".repeat(6000);
    const head: ModelMessage[] = [
      { role: "user", content: "goal: build the parser" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "c1", toolName: "read", input: { path: "big.txt" } }],
      } as ModelMessage,
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "c1", toolName: "read", output: { type: "text", value: noisy } }],
      } as ModelMessage,
    ];
    const filler = Array.from({ length: 50 }, (_, i) => bigMsg(i % 2 === 0 ? "assistant" : "user", i));
    await compact(model, MODEL_ID, [...head, ...filler]);

    const sent = JSON.stringify(prompts[0]);
    expect(sent).not.toContain(noisy);
    expect(sent).toContain("output elided");
    expect(sent).toContain("goal: build the parser"); // real content survives
  });
});
