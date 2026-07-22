import { describe, expect, test } from "bun:test";
import { isRetryableError } from "../src/core/agent.js";
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
