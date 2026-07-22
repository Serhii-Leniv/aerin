import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentEvent } from "../src/core/events.js";
import { todoTool } from "../src/tools/todo-tool.js";
import { memoryTool } from "../src/tools/memory-tool.js";
import { createQuestionTool } from "../src/tools/question-tool.js";
import { PermissionPolicy } from "../src/permissions/policy.js";

async function tmpCwd(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "aerin-tools-"));
}

describe("todo tool", () => {
  test("emits todo-update, coerces bad statuses, renders checklist", async () => {
    const events: AgentEvent[] = [];
    const out = await todoTool.execute(
      {
        items: [
          { text: "step one", status: "done" },
          { text: "step two", status: "active" },
          { text: "step three", status: "banana" },
        ],
      },
      { cwd: process.cwd(), allowOutsideCwd: false, onProgress: (e) => events.push(e) },
    );
    expect(out).toBe("[x] step one\n[>] step two\n[ ] step three");
    const update = events.find((e) => e.type === "todo-update");
    expect(update?.type).toBe("todo-update");
    if (update?.type === "todo-update") {
      expect(update.items.map((i) => i.status)).toEqual(["done", "active", "pending"]);
    }
  });

  test("is read-tier and summarizes progress", () => {
    expect(todoTool.permission).toBe("read");
    expect(todoTool.summarize({ items: [{ text: "a", status: "done" }, { text: "b", status: "active" }] })).toBe(
      "Todo(1/2 done)",
    );
  });
});

describe("memory tool", () => {
  test("creates AGENTS.md with a Memory section and dedupes", async () => {
    const cwd = await tmpCwd();
    const ctx = { cwd, allowOutsideCwd: false };
    await memoryTool.execute({ note: "run tests with bun test" }, ctx);
    await memoryTool.execute({ note: "run tests with bun test" }, ctx);
    const content = await fs.readFile(path.join(cwd, "AGENTS.md"), "utf8");
    expect(content).toContain("## Memory");
    expect(content.match(/run tests with bun test/g)).toHaveLength(1);
  });

  test("inserts under an existing Memory heading without clobbering other content", async () => {
    const cwd = await tmpCwd();
    await fs.writeFile(
      path.join(cwd, "AGENTS.md"),
      "# Project\n\nIntro text.\n\n## Memory\n- old fact\n\n## Other\nkeep me\n",
    );
    await memoryTool.execute({ note: "new fact" }, { cwd, allowOutsideCwd: false });
    const content = await fs.readFile(path.join(cwd, "AGENTS.md"), "utf8");
    expect(content.indexOf("new fact")).toBeLessThan(content.indexOf("old fact"));
    expect(content).toContain("keep me");
    expect(content).toContain("Intro text.");
  });
});

describe("question tool", () => {
  test("returns the user's answer via the ask callback", async () => {
    const tool = createQuestionTool({ ask: async (_q, options) => options[0] ?? "" });
    const out = await tool.execute(
      { question: "Which db?", options: ["postgres", "sqlite"] },
      { cwd: process.cwd(), allowOutsideCwd: false },
    );
    expect(out).toBe("User answered: postgres");
  });

  test("throws without an interactive user", async () => {
    const tool = createQuestionTool({});
    await expect(
      tool.execute({ question: "x?", options: ["a", "b"] }, { cwd: process.cwd(), allowOutsideCwd: false }),
    ).rejects.toThrow(/No interactive user/);
  });
});

describe("plan mode", () => {
  test("denies write/execute but allows read; toggles off cleanly", () => {
    const policy = new PermissionPolicy(["bash(git *)"], false);
    policy.setPlanMode(true);
    expect(policy.decide("read", { tool: "read", target: "x" })).toBe("allow");
    expect(policy.decide("write", { tool: "write", target: "x" })).toBe("deny");
    expect(policy.decide("execute", { tool: "bash", target: "git status" })).toBe("deny");
    policy.setPlanMode(false);
    expect(policy.decide("execute", { tool: "bash", target: "git status" })).toBe("allow");
    expect(policy.decide("write", { tool: "write", target: "x" })).toBe("ask");
  });

  test("plan mode denies even with --yolo", () => {
    const policy = new PermissionPolicy([], true);
    policy.setPlanMode(true);
    expect(policy.decide("execute", { tool: "bash", target: "rm -rf" })).toBe("deny");
  });
});
