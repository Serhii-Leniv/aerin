import { describe, expect, test } from "bun:test";
import { PermissionPolicy, ruleMatches, targetFor } from "../src/permissions/policy.js";

describe("ruleMatches", () => {
  test("bash prefix rule matches command", () => {
    expect(ruleMatches("bash(git status*)", { tool: "bash", target: "git status --short" })).toBe(true);
    expect(ruleMatches("bash(git status*)", { tool: "bash", target: "git push" })).toBe(false);
  });

  test("write glob rule matches path prefix", () => {
    expect(ruleMatches("write(src/*)", { tool: "write", target: "src/foo.ts" })).toBe(true);
    expect(ruleMatches("write(src/*)", { tool: "write", target: "test/foo.ts" })).toBe(false);
  });

  test("bare rule matches tool name glob (MCP)", () => {
    expect(ruleMatches("mcp__github__*", { tool: "mcp__github__create_issue", target: "" })).toBe(true);
    expect(ruleMatches("mcp__github__*", { tool: "mcp__slack__post", target: "" })).toBe(false);
  });

  test("regex metacharacters in patterns are escaped", () => {
    expect(ruleMatches("bash(echo (hi)*)", { tool: "bash", target: "echo (hi) there" })).toBe(true);
    expect(ruleMatches("write(a.b*)", { tool: "write", target: "axb" })).toBe(false);
  });
});

describe("PermissionPolicy", () => {
  test("read tier always allowed", () => {
    const p = new PermissionPolicy([], false);
    expect(p.decide("read", { tool: "read", target: "x" })).toBe("allow");
  });

  test("execute tier asks without a rule, allows with one", () => {
    const p = new PermissionPolicy(["bash(npm *)"], false);
    expect(p.decide("execute", { tool: "bash", target: "npm test" })).toBe("allow");
    expect(p.decide("execute", { tool: "bash", target: "rm -rf /" })).toBe("ask");
  });

  test("yolo allows everything", () => {
    const p = new PermissionPolicy([], true);
    expect(p.decide("execute", { tool: "bash", target: "anything" })).toBe("allow");
  });

  test("session rules accumulate", () => {
    const p = new PermissionPolicy([], false);
    expect(p.decide("write", { tool: "write", target: "src/a.ts" })).toBe("ask");
    p.addSessionRule("write(src/*)");
    expect(p.decide("write", { tool: "write", target: "src/a.ts" })).toBe("allow");
  });

  test("ruleFor builds broad bash rule from first word", () => {
    expect(PermissionPolicy.ruleFor({ tool: "bash", target: "git push origin main" })).toBe("bash(git *)");
    expect(PermissionPolicy.ruleFor({ tool: "mcp__gh__pr", target: "" })).toBe("mcp__gh__pr");
    expect(PermissionPolicy.ruleFor({ tool: "write", target: "src/x.ts" })).toBe("write(src/x.ts*)");
  });
});

describe("targetFor", () => {
  test("bash uses command", () => {
    expect(targetFor("bash", { command: "ls -la" })).toEqual({ tool: "bash", target: "ls -la" });
  });
  test("write uses path", () => {
    expect(targetFor("write", { path: "a.txt", content: "x" })).toEqual({ tool: "write", target: "a.txt" });
  });
});
