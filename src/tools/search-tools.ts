import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import fg from "fast-glob";
import ignoreFactory from "ignore";
import type { ToolDef, ToolContext } from "./types.js";
import { truncateOutput } from "./types.js";
import { assertReadable } from "./fs-tools.js";

const GLOB_RESULT_CAP = 200;

async function loadGitignore(cwd: string) {
  const ig = ignoreFactory();
  ig.add(["node_modules", ".git", "dist", "build"]);
  try {
    ig.add(await fs.readFile(path.join(cwd, ".gitignore"), "utf8"));
  } catch {
    // no .gitignore — fine
  }
  return ig;
}

export const globTool: ToolDef<z.ZodTypeAny> = {
  name: "glob",
  description:
    'Find files by glob pattern (e.g. "src/**/*.ts"). Results sorted by modification time, newest first. Respects .gitignore.',
  permission: "read",
  inputSchema: z.object({
    pattern: z.string().describe("Glob pattern"),
    path: z.string().optional().describe("Base directory (default: cwd)"),
  }),
  summarize: (i) => `Glob(${i.pattern})`,
  async execute(input, ctx) {
    const base = input.path ? path.resolve(ctx.cwd, input.path) : ctx.cwd;
    assertReadable(base, ctx);
    const ig = await loadGitignore(base);
    const matches = await fg(input.pattern, {
      cwd: base,
      dot: false,
      onlyFiles: true,
      suppressErrors: true,
      ignore: ["**/node_modules/**", "**/.git/**"],
    });
    const filtered = matches.filter((m) => !ig.ignores(m));
    const withTimes = await Promise.all(
      filtered.map(async (m) => {
        try {
          const st = await fs.stat(path.join(base, m));
          return { m, t: st.mtimeMs };
        } catch {
          return { m, t: 0 };
        }
      }),
    );
    withTimes.sort((a, b) => b.t - a.t);
    const capped = withTimes.slice(0, GLOB_RESULT_CAP).map((x) => x.m);
    const suffix =
      withTimes.length > GLOB_RESULT_CAP
        ? `\n[${withTimes.length - GLOB_RESULT_CAP} more matches not shown]`
        : "";
    return truncateOutput(capped.join("\n") + suffix || "(no matches)");
  },
};

let rgPath: string | null | undefined; // undefined = not probed, null = unavailable

/**
 * Reject regex patterns with the classic catastrophic-backtracking shapes
 * (nested/adjacent quantifiers like (a+)+ or (.*)*) before the JS fallback
 * runs them per line. Heuristic, not a proof — paired with the line-length
 * cap and scan deadline it keeps a hostile pattern from hanging the process.
 */
export function assertSafePattern(pattern: string): void {
  if (pattern.length > 500) throw new Error("Pattern too long — simplify the regex.");
  if (/[+*}]\s*\)[+*{?]|\)[+*]\s*[+*]/.test(pattern) || /\((?:[^()]*[+*][^()]*)\)[+*]/.test(pattern)) {
    throw new Error(
      "Pattern rejected: nested quantifiers like (a+)+ can hang the JS search fallback. Simplify it, or install ripgrep for full regex support.",
    );
  }
}

/** Places a ripgrep binary hides when it's not on PATH — most commonly the
 *  one bundled inside VS Code. (No @vscode/ripgrep dependency: its postinstall
 *  download conflicts with aerin's lean-install rule.) */
function bundledRgCandidates(): string[] {
  const rgBin = process.platform === "win32" ? "rg.exe" : "rg";
  const suffix = path.join("resources", "app", "node_modules", "@vscode", "ripgrep", "bin", rgBin);
  const roots = [
    process.env["LOCALAPPDATA"] ? path.join(process.env["LOCALAPPDATA"], "Programs", "Microsoft VS Code") : undefined,
    "C:\\Program Files\\Microsoft VS Code",
    "/usr/share/code",
    "/Applications/Visual Studio Code.app/Contents/Resources/app/node_modules/@vscode/ripgrep/bin",
  ].filter((r): r is string => Boolean(r));
  return roots.map((r) => (r.endsWith("bin") ? path.join(r, rgBin) : path.join(r, suffix)));
}

export async function findRipgrep(): Promise<string | null> {
  if (rgPath !== undefined) return rgPath;
  const works = (bin: string): Promise<boolean> =>
    new Promise((resolve) => {
      const p = spawn(bin, ["--version"], { windowsHide: true, shell: false });
      p.on("error", () => resolve(false));
      p.on("exit", (code) => resolve(code === 0));
    });
  if (await works("rg")) {
    rgPath = "rg";
    return rgPath;
  }
  for (const candidate of bundledRgCandidates()) {
    if (await works(candidate)) {
      rgPath = candidate;
      return rgPath;
    }
  }
  rgPath = null;
  return rgPath;
}

async function hasRipgrep(): Promise<boolean> {
  return (await findRipgrep()) !== null;
}

function runRipgrep(args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(rgPath ?? "rg", args, { cwd, windowsHide: true, shell: false, signal });
    let out = "";
    let err = "";
    p.stdout.on("data", (d: Buffer) => (out += d.toString()));
    p.stderr.on("data", (d: Buffer) => (err += d.toString()));
    p.on("error", reject);
    p.on("exit", (code) => {
      // rg exits 1 for "no matches" — not an error for us
      if (code === 0 || code === 1) resolve(out);
      else reject(new Error(err || `ripgrep exited with code ${code}`));
    });
  });
}

export const grepTool: ToolDef<z.ZodTypeAny> = {
  name: "grep",
  description:
    "Search file contents with a regular expression. Uses ripgrep when available. mode 'content' shows matching lines with line numbers; 'files' shows only file paths.",
  permission: "read",
  inputSchema: z.object({
    pattern: z.string().describe("Regular expression to search for"),
    path: z.string().optional().describe("Directory or file to search (default: cwd)"),
    glob: z.string().optional().describe('Filter files by glob, e.g. "*.ts"'),
    case_insensitive: z.boolean().optional().describe("Case-insensitive search"),
    context: z.number().int().min(0).max(10).optional().describe("Lines of context around matches"),
    mode: z.enum(["content", "files"]).optional().describe("Output mode (default content)"),
  }),
  summarize: (i) => `Search("${i.pattern}"${i.glob ? ` in ${i.glob}` : ""})`,
  async execute(input, ctx) {
    const searchPath = input.path ? path.resolve(ctx.cwd, input.path) : ctx.cwd;
    assertReadable(searchPath, ctx);
    const mode = input.mode ?? "content";

    if (await hasRipgrep()) {
      const args = ["--no-heading", "--color", "never"];
      if (mode === "files") args.push("-l");
      else args.push("-n");
      if (input.case_insensitive) args.push("-i");
      if (input.context && mode === "content") args.push("-C", String(input.context));
      if (input.glob) args.push("--glob", input.glob);
      args.push("-e", input.pattern, searchPath);
      const out = await runRipgrep(args, ctx.cwd, ctx.abortSignal);
      return truncateOutput(out.trim() || "(no matches)");
    }

    // JS fallback: fast-glob + line-by-line regex
    assertSafePattern(input.pattern);
    const re = new RegExp(input.pattern, input.case_insensitive ? "i" : "");
    const ig = await loadGitignore(searchPath);
    const deadline = Date.now() + 10_000;
    const files = (
      await fg(input.glob ?? "**/*", {
        cwd: searchPath,
        onlyFiles: true,
        dot: false,
        suppressErrors: true,
        ignore: ["**/node_modules/**", "**/.git/**"],
      })
    ).filter((f) => !ig.ignores(f));

    const results: string[] = [];
    for (const f of files) {
      if (ctx.abortSignal?.aborted) break;
      let text: string;
      try {
        const buf = await fs.readFile(path.join(searchPath, f));
        if (buf.includes(0)) continue;
        text = buf.toString("utf8");
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if ((i & 511) === 0 && Date.now() > deadline) {
          results.push("[search stopped: pattern too slow — simplify it or install ripgrep]");
          return truncateOutput(results.join("\n"));
        }
        const line = lines[i];
        // Cap tested line length: backtracking cost grows with input size.
        if (line !== undefined && re.test(line.length > 4000 ? line.slice(0, 4000) : line)) {
          if (mode === "files") {
            results.push(f);
            break;
          }
          results.push(`${f}:${i + 1}:${line}`);
        }
      }
      if (results.length > 5000) break;
    }
    return truncateOutput(results.join("\n") || "(no matches)");
  },
};
