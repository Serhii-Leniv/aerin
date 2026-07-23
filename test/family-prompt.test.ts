import { describe, expect, test } from "bun:test";
import { modelFamily, modelFamilyGuidance } from "../src/core/system-prompt.js";

describe("modelFamily", () => {
  test("claude ids, wherever the provider serves them from", () => {
    expect(modelFamily("anthropic/claude-opus-4-8")).toBe("claude");
    expect(modelFamily("openrouter/anthropic/claude-sonnet-5")).toBe("claude");
  });

  test("gpt family: gpt/o-series/codex, token-wise", () => {
    expect(modelFamily("openai/gpt-5.2")).toBe("gpt");
    expect(modelFamily("openai/gpt-4o")).toBe("gpt");
    expect(modelFamily("openai/o3")).toBe("gpt");
    expect(modelFamily("openai/o1-preview")).toBe("gpt");
    expect(modelFamily("openai/codex-mini")).toBe("gpt");
    expect(modelFamily("openrouter/openai/gpt-4.1")).toBe("gpt");
  });

  test("gemini family includes gemma", () => {
    expect(modelFamily("google/gemini-2.5-pro")).toBe("gemini");
    expect(modelFamily("ollama/gemma3:12b")).toBe("gemini");
  });

  test("everything else is other — no substring false positives", () => {
    expect(modelFamily("xai/grok-4")).toBe("other");
    expect(modelFamily("ollama/qwen3:14b")).toBe("other");
    expect(modelFamily("deepseek/deepseek-chat")).toBe("other");
    expect(modelFamily("moonshot/kimi-k2")).toBe("other");
    expect(modelFamily("mistral/mistral-7b")).toBe("other");
  });
});

describe("modelFamilyGuidance", () => {
  test("claude gets no addendum — the base prompt targets it", () => {
    expect(modelFamilyGuidance("anthropic/claude-opus-4-8")).toBe("");
  });

  test("other families get distinct non-empty guidance", () => {
    const gpt = modelFamilyGuidance("openai/gpt-5.2");
    const gemini = modelFamilyGuidance("google/gemini-2.5-pro");
    const other = modelFamilyGuidance("ollama/qwen3:14b");
    for (const g of [gpt, gemini, other]) expect(g.length).toBeGreaterThan(50);
    expect(gpt).not.toBe(gemini);
    expect(gemini).not.toBe(other);
    expect(gpt).toContain("GPT family");
    expect(gemini).toContain("Gemini family");
    expect(other).toContain("EXACT match");
  });
});
