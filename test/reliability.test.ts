import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { isRetryableError, pruneOldToolResults, stripReasoningParts } from "../src/core/agent.js";
import { startJob, getJob, bashOutputTool } from "../src/tools/bash-jobs.js";

describe("isRetryableError", () => {
  test("retryable: rate limits, overload, network", () => {
    expect(isRetryableError(new Error("429 Too Many Requests"))).toBe(true);
    expect(isRetryableError(new Error("Anthropic is overloaded"))).toBe(true);
    expect(isRetryableError(new Error("fetch failed"))).toBe(true);
    expect(isRetryableError(new Error("socket hang up"))).toBe(true);
    expect(isRetryableError(new Error("HTTP 503 Service Unavailable"))).toBe(true);
  });

  test("not retryable: auth, validation, generic", () => {
    expect(isRetryableError(new Error("401 invalid api key"))).toBe(false);
    expect(isRetryableError(new Error("model not found"))).toBe(false);
    expect(isRetryableError(new Error("invalid request: messages must not be empty"))).toBe(false);
  });
});

describe("stripReasoningParts", () => {
  test("removes reasoning, keeps text and tool calls", () => {
    const m = {
      role: "assistant",
      content: [
        { type: "reasoning", text: "thinking..." },
        { type: "text", text: "answer" },
        { type: "tool-call", toolCallId: "1", toolName: "read", input: {} },
      ],
    } as unknown as ModelMessage;
    const out = stripReasoningParts(m);
    expect((out.content as { type: string }[]).map((p) => p.type)).toEqual(["text", "tool-call"]);
  });

  test("leaves string content and other roles alone", () => {
    const user = { role: "user", content: "hi" } as ModelMessage;
    expect(stripReasoningParts(user)).toBe(user);
    const plain = { role: "assistant", content: "just text" } as ModelMessage;
    expect(stripReasoningParts(plain)).toBe(plain);
  });
});

describe("pruneOldToolResults", () => {
  const toolMsg = (value: string): ModelMessage =>
    ({
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "x", toolName: "read", output: { type: "text", value } }],
    }) as ModelMessage;

  test("elides big old outputs, keeps the tail and small outputs intact", () => {
    const big = "x".repeat(5000);
    const messages: ModelMessage[] = [
      { role: "user", content: "q" },
      toolMsg(big),
      toolMsg("small"),
      ...Array.from({ length: 20 }, (_, i) => ({ role: "user", content: `m${i}` }) as ModelMessage),
      toolMsg(big), // inside the kept tail
    ];
    const pruned = pruneOldToolResults(messages, 21);
    const val = (m: ModelMessage): string =>
      ((m.content as { output?: { value?: string } }[])[0]?.output?.value ?? "") as string;
    expect(val(pruned[1] as ModelMessage)).toContain("elided");
    expect(val(pruned[2] as ModelMessage)).toBe("small");
    expect(val(pruned[pruned.length - 1] as ModelMessage)).toBe(big);
    // original untouched
    expect(val(messages[1] as ModelMessage)).toBe(big);
  });

  test("short conversations pass through unchanged", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "hi" }, toolMsg("y".repeat(9000))];
    expect(pruneOldToolResults(messages, 20)).toBe(messages);
  });
});

describe("background bash jobs", () => {
  test("start, incremental read, exit code", async () => {
    const job = startJob('echo hello-from-job && echo second-line', process.cwd());
    expect(job.id).toMatch(/^job-\d+$/);
    // wait for the shell to finish
    for (let i = 0; i < 50 && getJob(job.id)?.running; i++) await new Promise((r) => setTimeout(r, 100));

    const first = await bashOutputTool.execute({ job: job.id }, { cwd: process.cwd(), allowOutsideCwd: false });
    expect(first).toContain("hello-from-job");
    expect(first).toContain("exited with code 0");

    // incremental: nothing new on second read
    const second = await bashOutputTool.execute({ job: job.id }, { cwd: process.cwd(), allowOutsideCwd: false });
    expect(second).toContain("(no new output)");
  });

  test("unknown job id errors helpfully", async () => {
    await expect(
      bashOutputTool.execute({ job: "job-999" }, { cwd: process.cwd(), allowOutsideCwd: false }),
    ).rejects.toThrow(/No such job/);
  });
});
