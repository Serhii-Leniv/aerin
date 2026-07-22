import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { enrichProviderError, isRetryableError, pruneOldToolResults, stripReasoningParts } from "../src/core/agent.js";
import { redactSecrets } from "../src/terminal/format.js";
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

describe("enrichProviderError", () => {
  test("auth errors point at /connect for the right provider", () => {
    const out = enrichProviderError("groq/qwen/qwen3.6-27b", "Invalid API Key");
    expect(out).toContain("[groq/qwen/qwen3.6-27b]");
    expect(out).toContain("/connect groq");
  });

  test("rate limits and quotas get actionable hints", () => {
    expect(enrichProviderError("xai/grok-4", "429 Too Many Requests")).toContain("rate limit");
    expect(enrichProviderError("openrouter/x", "insufficient credits")).toContain("billing");
  });

  test("tool/chat-unsupported models get a pick-another-model hint", () => {
    expect(enrichProviderError("groq/groq/compound", "`tool calling` is not supported with this model")).toContain(
      "pick a tool-capable chat model",
    );
    expect(
      enrichProviderError("groq/whisper-large-v3", "The model `whisper-large-v3` does not support chat completions"),
    ).toContain("pick a tool-capable chat model");
  });

  test("unknown errors still carry the model context", () => {
    expect(enrichProviderError("openai/gpt-4o", "something odd")).toBe("[openai/gpt-4o] something odd");
  });
});

describe("redactSecrets", () => {
  test("masks key-shaped strings, keeps prose", () => {
    const out = redactSecrets("use gsk_abc123def456ghi789 and sk-or-v1-aaaabbbbccccdddd please");
    expect(out).not.toContain("gsk_abc123def456ghi789");
    expect(out).not.toContain("sk-or-v1-aaaabbbbccccdddd");
    expect(out).toContain("[redacted]");
    expect(out).toContain("please");
    expect(redactSecrets("no secrets here")).toBe("no secrets here");
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

describe("edit diff display events", () => {
  test("edit emits a display-only diff via onProgress", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const { editTool } = await import("../src/tools/fs-tools.js");
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "aerin-diff-"));
    await fs.writeFile(path.join(cwd, "a.txt"), "one\ntwo\nthree\n");
    const events: import("../src/core/events.js").AgentEvent[] = [];
    const out = await editTool.execute(
      { path: "a.txt", old_string: "two", new_string: "TWO" },
      { cwd, allowOutsideCwd: false, onProgress: (e) => events.push(e) },
    );
    expect(out).toContain("+1 -1 lines");
    const display = events.find((e) => e.type === "tool-display");
    expect(display?.type).toBe("tool-display");
    if (display?.type === "tool-display") {
      expect(display.text).toContain("-two");
      expect(display.text).toContain("+TWO");
    }
  });
});

describe("assertSafePattern (ReDoS guard)", () => {
  test("rejects catastrophic shapes, allows normal regexes", async () => {
    const { assertSafePattern } = await import("../src/tools/search-tools.js");
    for (const evil of ["(a+)+$", "(.*)*b", "(x+)*y", "([a-z]+)+@"]) {
      expect(() => assertSafePattern(evil)).toThrow(/quantifiers/);
    }
    for (const fine of ["function\\s+\\w+", "TODO|FIXME", "^import .* from", "colou?r", "a{1,3}b"]) {
      expect(() => assertSafePattern(fine)).not.toThrow();
    }
  });
});

describe("checkpoints bounded depth", () => {
  test("keeps at most 20 turns", async () => {
    const { Checkpoints } = await import("../src/core/checkpoints.js");
    const cp = new Checkpoints();
    for (let i = 0; i < 50; i++) cp.beginTurn();
    // 50 empty turns collapse on undo without touching anything
    expect(await cp.undoLastChange()).toEqual([]);
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
