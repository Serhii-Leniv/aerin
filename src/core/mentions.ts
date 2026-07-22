import fs from "node:fs/promises";
import path from "node:path";

const MAX_FILES = 5;
const MAX_CHARS_PER_FILE = 20_000;

/**
 * Expand "@path/to/file" tokens in a prompt by appending the files' contents,
 * so the model reads exactly what the user pointed at instead of searching.
 * Tokens that don't resolve to a real file are left untouched.
 */
export async function expandMentions(prompt: string, cwd: string): Promise<string> {
  const tokens = [...prompt.matchAll(/(?:^|\s)@([\w~][\w./\\-]*)/g)]
    .map((m) => m[1])
    .filter((t): t is string => Boolean(t));
  if (tokens.length === 0) return prompt;

  const attachments: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    if (attachments.length >= MAX_FILES) break;
    const abs = path.resolve(cwd, token);
    if (seen.has(abs)) continue;
    seen.add(abs);
    try {
      const stat = await fs.stat(abs);
      if (!stat.isFile()) continue;
      const raw = await fs.readFile(abs, "utf8");
      const clipped = raw.length > MAX_CHARS_PER_FILE ? raw.slice(0, MAX_CHARS_PER_FILE) + "\n[...truncated]" : raw;
      attachments.push(`[Attached file: ${token}]\n${clipped}`);
    } catch {
      continue; // not a file — leave the token as plain text
    }
  }
  if (attachments.length === 0) return prompt;
  return `${prompt}\n\n${attachments.join("\n\n")}`;
}
