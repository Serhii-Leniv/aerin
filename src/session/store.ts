import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { ModelMessage } from "ai";
import { sessionsDir } from "../config/paths.js";

/**
 * One JSONL file per session: a meta header line followed by one ModelMessage
 * per line. Append-only during a run; a torn final line (crash mid-write) is
 * dropped on load.
 */

export interface SessionMeta {
  type: "meta";
  id: string;
  cwd: string;
  model: string;
  createdAt: string;
  title?: string;
}

export interface SessionSummary {
  id: string;
  createdAt: string;
  title: string | undefined;
  model: string;
  file: string;
}

export class SessionStore {
  private file: string;
  readonly id: string;

  private constructor(private dir: string, meta: SessionMeta) {
    this.id = meta.id;
    this.file = path.join(dir, `${meta.id}.jsonl`);
  }

  static async create(cwd: string, model: string): Promise<SessionStore> {
    const dir = sessionsDir(cwd);
    await fs.mkdir(dir, { recursive: true });
    const meta: SessionMeta = {
      type: "meta",
      id: `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`,
      cwd,
      model,
      createdAt: new Date().toISOString(),
    };
    const store = new SessionStore(dir, meta);
    await fs.writeFile(store.file, JSON.stringify(meta) + "\n", "utf8");
    return store;
  }

  static async open(cwd: string, id: string): Promise<{ store: SessionStore; messages: ModelMessage[] }> {
    const dir = sessionsDir(cwd);
    const file = path.join(dir, `${id}.jsonl`);
    const raw = await fs.readFile(file, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    let meta: SessionMeta | undefined;
    const messages: ModelMessage[] = [];
    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // torn line from a crash — drop it
      }
      const obj = parsed as Record<string, unknown>;
      if (obj["type"] === "meta") meta = obj as unknown as SessionMeta;
      else messages.push(parsed as ModelMessage);
    }
    if (!meta) throw new Error(`Session file ${file} has no meta line`);
    return { store: new SessionStore(dir, meta), messages };
  }

  static async list(cwd: string): Promise<SessionSummary[]> {
    const dir = sessionsDir(cwd);
    let files: string[];
    try {
      files = (await fs.readdir(dir)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      return [];
    }
    const summaries: SessionSummary[] = [];
    for (const f of files) {
      const file = path.join(dir, f);
      try {
        const fh = await fs.open(file, "r");
        const { buffer, bytesRead } = await fh.read(Buffer.alloc(4096), 0, 4096, 0);
        await fh.close();
        const firstLine = buffer.toString("utf8", 0, bytesRead).split("\n")[0] ?? "";
        const meta = JSON.parse(firstLine) as SessionMeta;
        if (meta.type !== "meta") continue;
        summaries.push({ id: meta.id, createdAt: meta.createdAt, title: meta.title, model: meta.model, file });
      } catch {
        continue;
      }
    }
    summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return summaries;
  }

  static async latest(cwd: string): Promise<SessionSummary | undefined> {
    return (await SessionStore.list(cwd))[0];
  }

  async append(messages: ModelMessage[]): Promise<void> {
    if (messages.length === 0) return;
    const lines = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
    await fs.appendFile(this.file, lines, "utf8");
  }

  /** Replace the whole message log (used after compaction). Keeps the meta line. */
  async rewrite(messages: ModelMessage[]): Promise<void> {
    const raw = await fs.readFile(this.file, "utf8");
    const metaLine = raw.split("\n")[0] ?? "";
    const lines = messages.map((m) => JSON.stringify(m)).join("\n");
    await fs.writeFile(this.file, metaLine + "\n" + (lines ? lines + "\n" : ""), "utf8");
  }
}
