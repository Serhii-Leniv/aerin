import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Agent } from "../src/core/agent.js";
import type { AgentEvent } from "../src/core/events.js";
import { detectDiagnosticsCommand, resolveDiagnosticsCommand } from "../src/core/diagnostics.js";
import { writeTool } from "../src/tools/fs-tools.js";
import { PermissionPolicy } from "../src/permissions/policy.js";
import { mockModel } from "./mock-model.js";

async function tmpProject(files: Record<string, string>): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "aerin-diag-"));
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(cwd, name), content);
  }
  return cwd;
}

const PKG_WITH_TYPECHECK = JSON.stringify({ scripts: { typecheck: "tsc --noEmit" } });

describe("detectDiagnosticsCommand", () => {
  test("finds the typecheck script and picks the lockfile's package manager", async () => {
    expect(await detectDiagnosticsCommand(await tmpProject({ "package.json": PKG_WITH_TYPECHECK, "bun.lock": "" }))).toBe(
      "bun run typecheck",
    );
    expect(
      await detectDiagnosticsCommand(await tmpProject({ "package.json": PKG_WITH_TYPECHECK, "pnpm-lock.yaml": "" })),
    ).toBe("pnpm run typecheck");
    expect(
      await detectDiagnosticsCommand(await tmpProject({ "package.json": PKG_WITH_TYPECHECK, "yarn.lock": "" })),
    ).toBe("yarn run typecheck");
    expect(await detectDiagnosticsCommand(await tmpProject({ "package.json": PKG_WITH_TYPECHECK }))).toBe(
      "npm run typecheck",
    );
  });

  test("returns undefined without a typecheck script or package.json", async () => {
    expect(await detectDiagnosticsCommand(await tmpProject({ "package.json": "{}" }))).toBeUndefined();
    expect(await detectDiagnosticsCommand(await tmpProject({}))).toBeUndefined();
  });
});

describe("resolveDiagnosticsCommand", () => {
  test("explicit command wins, false disables everything", async () => {
    const cwd = await tmpProject({ "package.json": PKG_WITH_TYPECHECK });
    expect(await resolveDiagnosticsCommand(cwd, { configured: "cargo check" })).toBe("cargo check");
    expect(await resolveDiagnosticsCommand(cwd, { configured: false })).toBeUndefined();
    expect(await resolveDiagnosticsCommand(cwd, { configured: undefined })).toBe("npm run typecheck");
  });

  test("auto-detection steps aside when a post hook is already wired", async () => {
    const cwd = await tmpProject({ "package.json": PKG_WITH_TYPECHECK });
    expect(
      await resolveDiagnosticsCommand(cwd, { configured: undefined, hooks: { "post:edit": "bun run typecheck" } }),
    ).toBeUndefined();
    // ...but an explicit command is the user's call, hooks or not.
    expect(
      await resolveDiagnosticsCommand(cwd, { configured: "eslint .", hooks: { "post:*": "x" } }),
    ).toBe("eslint .");
  });
});

describe("diagnostics feedback in the agent loop", () => {
  test("a failing check is appended to the write tool's result", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "aerin-diag-loop-"));
    const policy = new PermissionPolicy([], false);
    policy.setMode("accept"); // writes auto-approved
    const agent = new Agent({
      model: mockModel([
        { toolCalls: [{ toolCallId: "c1", toolName: "write", input: { path: "a.txt", content: "x" } }] },
        { text: "done" },
      ]),
      modelId: "mock/mock",
      systemPrompt: "test",
      tools: [writeTool],
      policy,
      onPermission: async () => ({ kind: "allow" }),
      cwd,
      allowOutsideCwd: false,
      diagnosticsCmd: `node -e "console.error('DIAGFAIL: a.txt broke types');process.exit(3)"`,
    });

    const events: AgentEvent[] = [];
    for await (const e of agent.send("go")) events.push(e);

    const result = events.find((e) => e.type === "tool-result") as Extract<AgentEvent, { type: "tool-result" }>;
    expect(result.isError).toBe(false); // the write itself succeeded
    expect(result.output).toContain("[diagnostics after this write");
    expect(result.output).toContain("exited 3");
    expect(result.output).toContain("DIAGFAIL: a.txt broke types");
    expect(await fs.readFile(path.join(cwd, "a.txt"), "utf8")).toBe("x");
  });

  test("a passing check appends nothing", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "aerin-diag-loop-"));
    const policy = new PermissionPolicy([], false);
    policy.setMode("accept");
    const agent = new Agent({
      model: mockModel([
        { toolCalls: [{ toolCallId: "c1", toolName: "write", input: { path: "a.txt", content: "x" } }] },
        { text: "done" },
      ]),
      modelId: "mock/mock",
      systemPrompt: "test",
      tools: [writeTool],
      policy,
      onPermission: async () => ({ kind: "allow" }),
      cwd,
      allowOutsideCwd: false,
      diagnosticsCmd: `node -e "process.exit(0)"`,
    });

    const events: AgentEvent[] = [];
    for await (const e of agent.send("go")) events.push(e);
    const result = events.find((e) => e.type === "tool-result") as Extract<AgentEvent, { type: "tool-result" }>;
    expect(result.output).not.toContain("[diagnostics");
  });
});
