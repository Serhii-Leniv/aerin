import type { PermissionTier } from "../tools/types.js";

/**
 * Permission rules are simple strings, matched by tool name + prefix/glob on
 * the "target" (first command word for bash, path for write/edit, tool name
 * for MCP tools). Examples:
 *   bash(git status*)
 *   bash(npm *)
 *   write(src/**)
 *   mcp__github__*
 * Deliberately NOT a policy language — prefix matching covers 95% of cases
 * and stays auditable.
 */

export type Decision = "allow" | "ask";

export interface RuleTarget {
  tool: string;
  /** What the rule pattern matches against (command string, path, or tool name). */
  target: string;
}

const RULE_RE = /^([a-zA-Z0-9_]+)\((.*)\)$/;

export function ruleMatches(rule: string, t: RuleTarget): boolean {
  // Bare rule like "mcp__github__*" matches on tool name only.
  const m = RULE_RE.exec(rule);
  if (!m) return globMatch(rule, t.tool);
  const [, toolName, pattern] = m;
  if (toolName !== t.tool) return false;
  return globMatch(pattern ?? "", t.target);
}

function globMatch(pattern: string, value: string): boolean {
  // Convert a minimal glob (* only) to a regex, escaping everything else.
  const re = new RegExp(
    "^" + pattern.split("*").map(escapeRegExp).join(".*") + "$",
  );
  return re.test(value);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class PermissionPolicy {
  private sessionRules: string[] = [];

  constructor(
    private projectRules: string[],
    private yolo: boolean,
  ) {}

  decide(tier: PermissionTier, t: RuleTarget): Decision {
    if (tier === "read") return "allow";
    if (this.yolo) return "allow";
    const rules = [...this.projectRules, ...this.sessionRules];
    return rules.some((r) => ruleMatches(r, t)) ? "allow" : "ask";
  }

  addSessionRule(rule: string): void {
    this.sessionRules.push(rule);
  }

  /** Build a persistable rule from a tool call the user approved with "always". */
  static ruleFor(t: RuleTarget): string {
    if (t.tool === "bash") {
      // Allow the command's first word broadly: `git status` -> bash(git *)
      const firstWord = t.target.trim().split(/\s+/)[0] ?? t.target;
      return `bash(${firstWord} *)`;
    }
    if (t.tool.startsWith("mcp__")) return t.tool;
    return `${t.tool}(${t.target}*)`;
  }
}

/** Extract the matchable target for a tool call. */
export function targetFor(toolName: string, input: unknown): RuleTarget {
  const obj = (input ?? {}) as Record<string, unknown>;
  if (toolName === "bash") return { tool: toolName, target: String(obj["command"] ?? "") };
  if (typeof obj["path"] === "string") return { tool: toolName, target: obj["path"] };
  return { tool: toolName, target: "" };
}
