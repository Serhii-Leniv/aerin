import fs from "node:fs/promises";
import path from "node:path";
import { GLOBAL_CONFIG_DIR } from "../config/paths.js";

/**
 * Custom slash commands, Claude Code-compatible layout: a markdown file per
 * command whose content is the prompt template; "$ARGUMENTS" is replaced with
 * whatever follows the command. Discovered from, in order of precedence:
 *   <cwd>/.aerin/commands/<name>.md
 *   <cwd>/.claude/commands/<name>.md   (compatibility with Claude Code)
 *   <global config dir>/commands/<name>.md
 */

export interface CustomCommand {
  /** Without the leading slash. */
  name: string;
  /** First non-empty template line, for menus. */
  description: string;
  template: string;
}

async function scanDir(root: string, commands: Map<string, CustomCommand>): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const name = entry.slice(0, -3);
    if (commands.has(name)) continue; // earlier roots win
    try {
      const template = (await fs.readFile(path.join(root, entry), "utf8")).trim();
      if (!template) continue;
      const firstLine = template.split("\n").find((l) => l.trim()) ?? "";
      commands.set(name, {
        name,
        description: firstLine.replace(/^#+\s*/, "").slice(0, 70),
        template,
      });
    } catch {
      continue;
    }
  }
}

export async function discoverCommands(cwd: string): Promise<CustomCommand[]> {
  const commands = new Map<string, CustomCommand>();
  await scanDir(path.join(cwd, ".aerin", "commands"), commands);
  await scanDir(path.join(cwd, ".claude", "commands"), commands);
  await scanDir(path.join(GLOBAL_CONFIG_DIR, "commands"), commands);
  return [...commands.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Fill the template: $ARGUMENTS gets the raw argument string (or ""). */
export function renderCommand(command: CustomCommand, args: string): string {
  return command.template.includes("$ARGUMENTS")
    ? command.template.split("$ARGUMENTS").join(args)
    : args
      ? `${command.template}\n\n${args}`
      : command.template;
}
