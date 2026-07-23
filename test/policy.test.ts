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

describe("deny rules", () => {
  test("deny beats an allow rule for the same command", () => {
    const p = new PermissionPolicy(["bash(git *)"], false, ["bash(git push*)"]);
    expect(p.decide("execute", { tool: "bash", target: "git status" })).toBe("allow");
    expect(p.decide("execute", { tool: "bash", target: "git push origin main" })).toBe("deny");
  });

  test("deny beats --yolo", () => {
    const p = new PermissionPolicy([], true, ["bash(rm *)"]);
    expect(p.decide("execute", { tool: "bash", target: "rm -rf node_modules" })).toBe("deny");
    expect(p.decide("execute", { tool: "bash", target: "ls" })).toBe("allow");
  });

  test("deny beats accept mode for writes", () => {
    const p = new PermissionPolicy([], false, ["write(.env*)", "edit(.env*)"]);
    p.setMode("accept");
    expect(p.decide("write", { tool: "write", target: ".env" })).toBe("deny");
    expect(p.decide("write", { tool: "write", target: "src/a.ts" })).toBe("allow");
  });

  test("deny catches segments of chained bash commands", () => {
    const p = new PermissionPolicy([], false, ["bash(rm *)"]);
    expect(p.decide("execute", { tool: "bash", target: "git pull && rm -rf x" })).toBe("deny");
    expect(p.decide("execute", { tool: "bash", target: "echo `rm -rf x`" })).toBe("deny");
    expect(p.decide("execute", { tool: "bash", target: "git pull && npm install" })).toBe("ask"); // chained still asks
  });

  test("deny applies to read-tier tools", () => {
    const p = new PermissionPolicy([], false, ["read(*.pem*)"]);
    expect(p.decide("read", { tool: "read", target: "certs/server.pem" })).toBe("deny");
    expect(p.decide("read", { tool: "read", target: "src/a.ts" })).toBe("allow");
  });

  test("deniedBy names the matching rule", () => {
    const p = new PermissionPolicy([], false, ["bash(rm *)", "write(.env*)"]);
    expect(p.deniedBy({ tool: "bash", target: "rm -rf x" })).toBe("bash(rm *)");
    expect(p.deniedBy({ tool: "write", target: ".env" })).toBe("write(.env*)");
    expect(p.deniedBy({ tool: "bash", target: "ls" })).toBeUndefined();
  });

  test("deny works for MCP tools by bare name", () => {
    const p = new PermissionPolicy([], true, ["mcp__github__delete_*"]);
    expect(p.decide("execute", { tool: "mcp__github__delete_repo", target: "" })).toBe("deny");
    expect(p.decide("execute", { tool: "mcp__github__create_issue", target: "" })).toBe("allow");
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
