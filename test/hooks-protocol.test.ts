import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Agent } from "../src/core/agent.js";
import type { AgentEvent } from "../src/core/events.js";
import { parseHookJson, runPostHook, runPreHook } from "../src/core/hooks.js";
import { writeTool } from "../src/tools/fs-tools.js";
import { PermissionPolicy } from "../src/permissions/policy.js";
import { mockModel } from "./mock-model.js";

/** Shell command that prints the given object as JSON (portable via node). */
function emitJson(obj: unknown, exitCode = 0): string {
  const b64 = Buffer.from(JSON.stringify(obj)).toString("base64");
  return `node -e "console.log(Buffer.from('${b64}','base64').toString());process.exit(${exitCode})"`;
}

describe("parseHookJson", () => {
  test("whole stdout, last line, and rejections", () => {
    expect(parseHookJson('{"decision":"deny"}')).toEqual({ decision: "deny" });
    expect(parseHookJson('checking...\ndone\n{"decision":"allow"}')).toEqual({ decision: "allow" });
    expect(parseHookJson("plain text output")).toBeUndefined();
    expect(parseHookJson("[1,2,3]")).toBeUndefined();
    expect(parseHookJson("")).toBeUndefined();
  });
});

describe("runPreHook", () => {
  const cwd = process.cwd();

  test("legacy: non-zero exit denies with the output as reason, zero is a no-op", async () => {
    const denied = await runPreHook(`node -e "console.log('not allowed here');process.exit(3)"`, "bash", {}, cwd);
    expect(denied.decision).toBe("deny");
    expect(denied.reason).toContain("not allowed here");
    expect((await runPreHook(`node -e "process.exit(0)"`, "bash", {}, cwd)).decision).toBe("none");
  });

  test("JSON: decision and reason are honored, exit code ignored", async () => {
    const deny = await runPreHook(emitJson({ decision: "deny", reason: "policy script says no" }), "bash", {}, cwd);
    expect(deny).toMatchObject({ decision: "deny", reason: "policy script says no" });
    // exit 1 + JSON allow: the JSON wins
    const allow = await runPreHook(emitJson({ decision: "allow" }, 1), "bash", {}, cwd);
    expect(allow.decision).toBe("allow");
  });

  test("JSON: input replacement is surfaced", async () => {
    const r = await runPreHook(emitJson({ input: { path: "b.txt", content: "x" } }), "write", { path: "a.txt" }, cwd);
    expect(r.decision).toBe("none");
    expect(r.replacedInput).toEqual({ path: "b.txt", content: "x" });
  });
});

describe("runPostHook", () => {
  const cwd = process.cwd();

  test("JSON context appends even on exit 0; empty JSON appends nothing despite exit 1", async () => {
    const r = await runPostHook(emitJson({ context: "coverage dropped 2%" }), "edit", {}, cwd, "tool output");
    expect(r.appended).toContain("coverage dropped 2%");
    expect(await runPostHook(emitJson({}, 1), "edit", {}, cwd, "out")).toEqual({});
  });

  test("legacy: non-zero exit appends its output", async () => {
    const r = await runPostHook(`node -e "console.log('lint failed');process.exit(2)"`, "edit", {}, cwd, "out");
    expect(r.appended).toContain("lint failed");
    expect(r.appended).toContain("exit 2");
  });
});

describe("JSON hooks in the agent loop", () => {
  function writeAgent(cwd: string, hooks: Record<string, string>, policy?: PermissionPolicy, onAsk?: () => void): Agent {
    return new Agent({
      model: mockModel([
        { toolCalls: [{ toolCallId: "c1", toolName: "write", input: { path: "a.txt", content: "original" } }] },
        { text: "done" },
      ]),
      modelId: "mock/mock",
      systemPrompt: "test",
      tools: [writeTool],
      policy: policy ?? new PermissionPolicy([], false),
      onPermission: async () => {
        onAsk?.();
        return { kind: "allow" };
      },
      cwd,
      allowOutsideCwd: false,
      hooks,
    });
  }

  test('{"decision":"allow"} skips the permission prompt entirely', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "aerin-hooks-"));
    let asked = 0;
    const agent = writeAgent(cwd, { "pre:write": emitJson({ decision: "allow" }) }, undefined, () => asked++);
    for await (const _ of agent.send("go")) void _;
    expect(asked).toBe(0); // manual mode would normally prompt for a write
    expect(await fs.readFile(path.join(cwd, "a.txt"), "utf8")).toBe("original");
  });

  test('{"decision":"deny"} blocks before the tool runs, reason reaches the model', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "aerin-hooks-"));
    const agent = writeAgent(cwd, { "pre:write": emitJson({ decision: "deny", reason: "frozen until release" }) });
    const events: AgentEvent[] = [];
    for await (const e of agent.send("go")) events.push(e);
    const result = events.find((e) => e.type === "tool-result") as Extract<AgentEvent, { type: "tool-result" }>;
    expect(result.isError).toBe(true);
    expect(result.output).toContain("frozen until release");
    expect(fs.access(path.join(cwd, "a.txt"))).rejects.toThrow();
  });

  test("input rewriting redirects the write and is re-validated", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "aerin-hooks-"));
    const agent = writeAgent(cwd, {
      "pre:write": emitJson({ decision: "allow", input: { path: "redirected.txt", content: "REWRITTEN" } }),
    });
    for await (const _ of agent.send("go")) void _;
    expect(await fs.readFile(path.join(cwd, "redirected.txt"), "utf8")).toBe("REWRITTEN");
    expect(fs.access(path.join(cwd, "a.txt"))).rejects.toThrow();
  });

  test("a rewrite cannot route around a permission deny rule", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "aerin-hooks-"));
    const policy = new PermissionPolicy([], false, ["write(secrets*)"]);
    policy.setMode("accept");
    const agent = writeAgent(cwd, {
      "pre:write": emitJson({ decision: "allow", input: { path: "secrets.txt", content: "sneaky" } }),
    }, policy);
    const events: AgentEvent[] = [];
    for await (const e of agent.send("go")) events.push(e);
    const result = events.find((e) => e.type === "tool-result") as Extract<AgentEvent, { type: "tool-result" }>;
    expect(result.isError).toBe(true);
    expect(result.output).toContain("deny rule");
    expect(fs.access(path.join(cwd, "secrets.txt"))).rejects.toThrow();
  });

  test('post-hook {"context"} lands in the tool result on exit 0', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "aerin-hooks-"));
    const policy = new PermissionPolicy([], false);
    policy.setMode("accept");
    const agent = writeAgent(cwd, { "post:write": emitJson({ context: "reminder: update the changelog" }) }, policy);
    const events: AgentEvent[] = [];
    for await (const e of agent.send("go")) events.push(e);
    const result = events.find((e) => e.type === "tool-result") as Extract<AgentEvent, { type: "tool-result" }>;
    expect(result.isError).toBe(false);
    expect(result.output).toContain("reminder: update the changelog");
  });
});
