import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import { truncateOutput, type ToolDef } from "./types.js";
import { sessionsDir } from "../config/paths.js";
import type { SessionMeta } from "../session/store.js";

/**
 * Episodic recall over past sessions (Hermes-style, minus the database): the
 * JSONL files in the project's sessions dir ARE the index. A keyword scan is
 * plenty at the scale of one project's history and keeps aerin dependency-free
 * — no SQLite, no embeddings. Search returns scored snippets; passing a
 * session id returns that session's transcript for the model to read.
 */

interface SessionText {
  meta: SessionMeta;
  /** One entry per message: role plus its searchable text. */
  parts: { role: string; text: string }[];
}

/** Pull the human-meaningful text out of one stored ModelMessage. */
function extractText(msg: Record<string, unknown>): { role: string; text: string } | undefined {
  const role = typeof msg["role"] === "string" ? (msg["role"] as string) : undefined;
  if (!role) return undefined;
  const content = msg["content"];
  if (typeof content === "string") return { role, text: content };
  if (!Array.isArray(content)) return undefined;
  const chunks: string[] = [];
  for (const part of content as Record<string, unknown>[]) {
    if (typeof part !== "object" || part === null) continue;
    if (typeof part["text"] === "string") chunks.push(part["text"] as string);
    else if (part["type"] === "tool-call") {
      chunks.push(`${String(part["toolName"] ?? "tool")}(${JSON.stringify(part["input"] ?? "")})`);
    } else if (part["type"] === "tool-result") {
      const out = part["output"] as Record<string, unknown> | undefined;
      if (out && typeof out["value"] === "string") chunks.push(out["value"] as string);
    }
  }
  const text = chunks.join("\n").trim();
  return text ? { role, text } : undefined;
}

async function loadSession(file: string): Promise<SessionText | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  let meta: SessionMeta | undefined;
  const parts: { role: string; text: string }[] = [];
  for (const line of lines) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // torn line
    }
    if (parsed["type"] === "meta") meta = parsed as unknown as SessionMeta;
    else {
      const t = extractText(parsed);
      if (t) parts.push(t);
    }
  }
  return meta ? { meta, parts } : undefined;
}

/** ~160-char window around the first match, whitespace-flattened. */
function snippet(text: string, index: number): string {
  const start = Math.max(0, index - 60);
  const win = text.slice(start, start + 160).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${win}…`;
}

const MAX_RESULTS = 5;
const SNIPPETS_PER_SESSION = 3;

export function createSessionSearchTool(deps: { currentSessionId?: string; dirOverride?: string }): ToolDef<z.ZodTypeAny> {
  return {
    name: "session_search",
    description:
      "Search this project's past aerin conversations for earlier work: decisions made, bugs fixed, " +
      "files touched, approaches tried. Use it when the user references previous sessions ('like we did " +
      "before', 'that bug from last week') or when past context would prevent redoing work. " +
      "Provide query keywords to find sessions; then pass session_id from a result to read that transcript.",
    inputSchema: z.object({
      query: z.string().optional().describe("Keywords to search for across past sessions"),
      session_id: z.string().optional().describe("Read this session's transcript instead of searching"),
    }),
    permission: "read",
    summarize: (i) =>
      i.session_id ? `SessionSearch(read ${String(i.session_id)})` : `SessionSearch(${String(i.query ?? "").slice(0, 60)})`,
    async execute(input, ctx) {
      const dir = deps.dirOverride ?? sessionsDir(ctx.cwd);
      const sessionId = typeof input.session_id === "string" ? input.session_id.trim() : "";

      if (sessionId) {
        const loaded = await loadSession(path.join(dir, `${sessionId}.jsonl`));
        if (!loaded) return `No session ${sessionId} found in this project.`;
        const when = loaded.meta.createdAt.slice(0, 10);
        const body = loaded.parts.map((p) => `-- ${p.role} --\n${p.text}`).join("\n\n");
        return truncateOutput(`Session ${sessionId} ("${loaded.meta.title ?? "untitled"}", ${when}):\n\n${body}`);
      }

      const query: string = typeof input.query === "string" ? input.query.trim() : "";
      if (!query) return "Provide query keywords to search, or session_id to read a transcript.";
      const terms: string[] = [
        ...new Set(
          query
            .toLowerCase()
            .split(/\s+/)
            .filter((t) => t.length >= 2),
        ),
      ];
      if (terms.length === 0) return "Query terms are too short — use words of 2+ characters.";

      let files: string[];
      try {
        files = (await fs.readdir(dir)).filter((f) => f.endsWith(".jsonl"));
      } catch {
        return "No past sessions found for this project.";
      }

      const scored: { s: SessionText; distinct: number; hits: number; snippets: string[] }[] = [];
      for (const f of files) {
        if (deps.currentSessionId && f === `${deps.currentSessionId}.jsonl`) continue; // already in context
        const s = await loadSession(path.join(dir, f));
        if (!s) continue;
        const title = (s.meta.title ?? "").toLowerCase();
        let distinct = 0;
        let hits = 0;
        const snippets: string[] = [];
        for (const term of terms) {
          let termHits = title.includes(term) ? 3 : 0; // title matches weigh extra
          for (const p of s.parts) {
            const lower = p.text.toLowerCase();
            let idx = lower.indexOf(term);
            while (idx >= 0 && termHits < 50) {
              termHits++;
              if (snippets.length < SNIPPETS_PER_SESSION) snippets.push(`${p.role}: ${snippet(p.text, idx)}`);
              idx = lower.indexOf(term, idx + term.length);
            }
            if (termHits >= 50) break;
          }
          if (termHits > 0) distinct++;
          hits += termHits;
        }
        if (distinct > 0) scored.push({ s, distinct, hits, snippets });
      }

      // Sessions matching more distinct terms first, then by hit count, then newest.
      scored.sort(
        (a, b) =>
          b.distinct - a.distinct || b.hits - a.hits || b.s.meta.createdAt.localeCompare(a.s.meta.createdAt),
      );
      if (scored.length === 0) return `No past sessions match "${query}".`;

      const top = scored.slice(0, MAX_RESULTS);
      const out = top.map((r, i) => {
        const when = r.s.meta.createdAt.slice(0, 10);
        const head = `${i + 1}. [${r.s.meta.id}] "${r.s.meta.title ?? "untitled"}" — ${when}, ${r.s.parts.length} messages`;
        return [head, ...r.snippets.map((sn) => `   ${sn}`)].join("\n");
      });
      return truncateOutput(
        `${scored.length} past session${scored.length === 1 ? "" : "s"} match "${query}"${scored.length > MAX_RESULTS ? ` (top ${MAX_RESULTS} shown)` : ""}:\n\n` +
          out.join("\n\n") +
          "\n\nPass session_id to read a full transcript.",
      );
    },
  };
}
