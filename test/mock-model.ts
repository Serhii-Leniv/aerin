import type { LanguageModel } from "ai";

/**
 * Minimal hand-rolled LanguageModelV2 mock (ai/test needs msw, which we don't
 * want as a dependency). Each `Turn` is one doStream() response; calls consume
 * turns in order and the last turn repeats if the loop calls again.
 */
export interface MockTurn {
  text?: string;
  toolCalls?: { toolCallId: string; toolName: string; input: unknown }[];
  usage?: { inputTokens: number; outputTokens: number };
}

export function mockModel(turns: MockTurn[]): LanguageModel {
  let call = 0;
  return {
    specificationVersion: "v2",
    provider: "mock",
    modelId: "mock",
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error("mockModel supports doStream only");
    },
    doStream: async () => {
      const turn = turns[Math.min(call++, turns.length - 1)];
      if (!turn) throw new Error("mockModel: no turns configured");
      const usage = {
        inputTokens: turn.usage?.inputTokens ?? 0,
        outputTokens: turn.usage?.outputTokens ?? 0,
        totalTokens: (turn.usage?.inputTokens ?? 0) + (turn.usage?.outputTokens ?? 0),
      };
      const parts: unknown[] = [{ type: "stream-start", warnings: [] }];
      if (turn.text !== undefined) {
        parts.push(
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: turn.text },
          { type: "text-end", id: "t1" },
        );
      }
      for (const tc of turn.toolCalls ?? []) {
        parts.push({
          type: "tool-call",
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: JSON.stringify(tc.input),
        });
      }
      parts.push({ type: "finish", finishReason: turn.toolCalls?.length ? "tool-calls" : "stop", usage });
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const p of parts) controller.enqueue(p);
            controller.close();
          },
        }),
      };
    },
  } as unknown as LanguageModel;
}
