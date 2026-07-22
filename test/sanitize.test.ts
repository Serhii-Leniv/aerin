import { describe, expect, test } from "bun:test";
import { toPlainJson } from "../src/core/agent.js";

describe("toPlainJson", () => {
  test("strips undefined-valued properties (OpenRouter reasoning_details bug)", () => {
    const msg = {
      role: "assistant",
      content: [
        {
          type: "reasoning",
          text: "hmm",
          providerOptions: {
            openrouter: {
              reasoning_details: [{ type: "reasoning.text", text: "x", signature: undefined }],
            },
          },
        },
      ],
    };
    const clean = toPlainJson(msg) as typeof msg;
    const detail = clean.content[0]?.providerOptions.openrouter.reasoning_details[0] as Record<string, unknown>;
    expect("signature" in detail).toBe(false);
    expect(detail["text"]).toBe("x");
  });

  test("leaves plain JSON untouched", () => {
    const msg = { role: "user", content: "hello" };
    expect(toPlainJson(msg)).toEqual(msg);
  });
});
