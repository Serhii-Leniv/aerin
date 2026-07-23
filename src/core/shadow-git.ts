import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { shadowGitDir } from "../config/paths.js";

/**
 * Turn-level undo/redo backed by a shadow git repository (OpenCode-style).
 *
 * A bare-ish repo lives in the aerin data dir (never inside the project) and
 * treats the project cwd as its work tree. Before the first state-changing
 * tool of a turn we `add -A` + `write-tree` a snapshot; /undo diffs the last
 * snapshot against the current tree and restores exactly the files that
 * changed — which covers bash side effects, not just write-tool paths.
 *
 * Deliberate semantics:
 * - Respects the project's .gitignore, so node_modules and secrets like .env
 *   are never copied into the shadow object store (and never restored).
 * - Undo reverts everything that changed since the snapshot, including manual
 *   user edits made after the turn — the price of catching bash side effects.
 * - Files outside the work tree (writes under --allow-outside-cwd) are not
 *   captured; the in-memory Checkpoints fallback in agent.ts is not either
 *   once shadow git is active. Documented, accepted.
 * - Snapshot trees accumulate in the object store; turn depth is capped but
 *   objects are only reclaimed if the user deletes the data dir. Cheap in
 *   practice: unchanged files share blobs.
 */
export class ShadowGit {
  /** Pre-turn tree hashes, oldest first — one per turn that ran a state-changing tool. */
  private turns: string[] = [];
  /** Trees captured at undo time, so /redo can walk forward again. */
  private redoTrees: string[] = [];
  private needSnapshot = true;
  private broken = false;
  private static readonly MAX_TURNS = 20;
  private static readonly GIT_TIMEOUT_MS = 60_000;

  private constructor(
    private gitDir: string,
    private workTree: string,
  ) {}

  /** Init (or reuse) the shadow repo. Returns null when git is missing/unusable. */
  static async create(cwd: string, gitDir = shadowGitDir(cwd)): Promise<ShadowGit | null> {
    const sg = new ShadowGit(gitDir, path.resolve(cwd));
    try {
      await fs.mkdir(gitDir, { recursive: true });
      await sg.git(["init", "-q"]); // idempotent on an existing repo
      return sg;
    } catch {
      return null;
    }
  }

  beginTurn(): void {
    this.needSnapshot = true;
  }

  /** Snapshot the work tree once per turn, before its first state-changing tool. */
  async snapshotIfNeeded(): Promise<void> {
    if (this.broken || !this.needSnapshot) return;
    this.needSnapshot = false; // even on failure, don't retry every tool call
    try {
      const tree = await this.writeTree();
      this.turns.push(tree);
      while (this.turns.length > ShadowGit.MAX_TURNS) this.turns.shift();
      this.redoTrees.length = 0; // new changes invalidate the redo chain
    } catch {
      this.broken = true;
    }
  }

  /**
   * Restore the files of the most recent turn whose snapshot differs from the
   * current tree. Returns absolute paths restored (empty = nothing to undo).
   */
  async undoLastChange(): Promise<string[]> {
    if (this.broken) return [];
    try {
      const now = await this.writeTree();
      while (this.turns.length > 0) {
        const tree = this.turns.pop() as string;
        const changes = await this.diffTree(tree, now);
        if (changes.length === 0) continue; // turn changed nothing — keep walking back
        await this.restore(tree, changes);
        this.redoTrees.push(now);
        return changes.map((c) => path.join(this.workTree, c.path));
      }
      return [];
    } catch {
      this.broken = true;
      return [];
    }
  }

  /** Walk forward again after /undo. Returns absolute paths restored. */
  async redoLastUndo(): Promise<string[]> {
    if (this.broken) return [];
    try {
      const tree = this.redoTrees.pop();
      if (!tree) return [];
      const now = await this.writeTree();
      const changes = await this.diffTree(tree, now);
      if (changes.length === 0) return [];
      await this.restore(tree, changes);
      this.turns.push(now); // so another /undo reverts this redo
      return changes.map((c) => path.join(this.workTree, c.path));
    } catch {
      this.broken = true;
      return [];
    }
  }

  private async writeTree(): Promise<string> {
    await this.git(["add", "-A", "."]);
    return (await this.git(["write-tree"])).trim();
  }

  private async diffTree(a: string, b: string): Promise<{ status: string; path: string }[]> {
    const out = await this.git(["diff-tree", "-r", "-z", "--name-status", "--no-renames", a, b]);
    const fields = out.split("\0").filter((f) => f.length > 0);
    const changes: { status: string; path: string }[] = [];
    for (let i = 0; i + 1 < fields.length; i += 2) {
      changes.push({ status: fields[i] as string, path: fields[i + 1] as string });
    }
    return changes;
  }

  /** Make the work tree match `tree` for exactly the changed paths. */
  private async restore(tree: string, changes: { status: string; path: string }[]): Promise<void> {
    await this.git(["read-tree", tree]);
    // Status is tree->current: "A" = created since the snapshot, so remove it;
    // everything else existed in the snapshot, so write it back from the index.
    const restorable: string[] = [];
    for (const c of changes) {
      if (c.status === "A") await fs.rm(path.join(this.workTree, c.path), { force: true });
      else restorable.push(c.path);
    }
    if (restorable.length > 0) {
      // Paths over stdin: immune to Windows command-line length limits.
      await this.git(["checkout-index", "-f", "-z", "--stdin"], restorable.join("\0") + "\0");
    }
  }

  private git(args: string[], stdin?: string): Promise<string> {
    const env = { ...process.env };
    // The user's environment must not redirect our plumbing to another repo.
    for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_CEILING_DIRECTORIES"]) {
      delete env[k];
    }
    env.GIT_TERMINAL_PROMPT = "0";
    env.GIT_OPTIONAL_LOCKS = "0";
    const fullArgs = [
      "--git-dir",
      this.gitDir,
      "--work-tree",
      this.workTree,
      "-c",
      "core.autocrlf=false", // snapshot and restore bytes exactly as on disk
      "-c",
      "core.longpaths=true",
      "-c",
      "gc.auto=0",
      ...args,
    ];
    return new Promise((resolve, reject) => {
      const child = spawn("git", fullArgs, { cwd: this.workTree, windowsHide: true, env });
      let out = "";
      let err = "";
      child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
      child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
      const timer = setTimeout(() => child.kill(), ShadowGit.GIT_TIMEOUT_MS);
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(out);
        else reject(new Error(`git ${args[0]} exited ${code}: ${err.trim().slice(0, 300)}`));
      });
      if (stdin !== undefined) child.stdin.write(stdin);
      child.stdin.end();
    });
  }
}
