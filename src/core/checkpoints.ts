import fs from "node:fs/promises";

/**
 * Per-session undo for file changes made by write-tier tools. Before a tool
 * touches a file for the first time in a turn, its original content (or its
 * absence) is captured in memory; /undo restores the most recent turn that
 * changed anything. Bash side effects are NOT captured — only files written
 * through the write/edit/memory tools.
 */
export class Checkpoints {
  /** One map per turn: absolute path -> original content, or null if the file did not exist. */
  private turns: Map<string, string | null>[] = [];

  beginTurn(): void {
    this.turns.push(new Map());
  }

  /** Capture a file's pre-change state, once per turn. */
  async record(absPath: string): Promise<void> {
    const turn = this.turns[this.turns.length - 1];
    if (!turn || turn.has(absPath)) return;
    try {
      turn.set(absPath, await fs.readFile(absPath, "utf8"));
    } catch {
      turn.set(absPath, null); // file didn't exist yet
    }
  }

  /**
   * Restore the files of the most recent turn that changed anything.
   * Returns the restored paths (empty when there is nothing to undo).
   */
  async undoLastChange(): Promise<string[]> {
    while (this.turns.length > 0 && (this.turns[this.turns.length - 1]?.size ?? 0) === 0) {
      this.turns.pop();
    }
    const turn = this.turns.pop();
    if (!turn) return [];
    const restored: string[] = [];
    for (const [absPath, original] of turn) {
      try {
        if (original === null) await fs.rm(absPath, { force: true });
        else await fs.writeFile(absPath, original, "utf8");
        restored.push(absPath);
      } catch {
        // file locked/removed — restore what we can
      }
    }
    return restored;
  }
}
