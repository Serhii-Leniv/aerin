import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ShadowGit } from "../src/core/shadow-git.js";

const hasGit = spawnSync("git", ["--version"], { windowsHide: true }).status === 0;
const t = hasGit ? test : test.skip;

/** A work tree + shadow repo, both in temp dirs so no real data dir is touched. */
async function setup(): Promise<{ cwd: string; sg: ShadowGit }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "aerin-shadow-"));
  const cwd = path.join(base, "work");
  await fs.mkdir(cwd);
  const sg = await ShadowGit.create(cwd, path.join(base, "shadow"));
  if (!sg) throw new Error("ShadowGit.create failed with git available");
  return { cwd, sg };
}

describe("shadow git undo/redo", () => {
  t("undoes edits, deletions and created files — bash-style side effects", async () => {
    const { cwd, sg } = await setup();
    await fs.writeFile(path.join(cwd, "a.txt"), "one\n");
    await fs.writeFile(path.join(cwd, "sp ace.txt"), "keep\n");

    sg.beginTurn();
    await sg.snapshotIfNeeded();
    // Simulate what a bash command might do: edit, delete, create.
    await fs.writeFile(path.join(cwd, "a.txt"), "two\n");
    await fs.rm(path.join(cwd, "sp ace.txt"));
    await fs.writeFile(path.join(cwd, "new.txt"), "created\n");

    const restored = await sg.undoLastChange();
    expect(restored.sort()).toEqual(
      [path.join(cwd, "a.txt"), path.join(cwd, "new.txt"), path.join(cwd, "sp ace.txt")].sort(),
    );
    expect(await fs.readFile(path.join(cwd, "a.txt"), "utf8")).toBe("one\n");
    expect(await fs.readFile(path.join(cwd, "sp ace.txt"), "utf8")).toBe("keep\n");
    expect(fs.access(path.join(cwd, "new.txt"))).rejects.toThrow();
  });

  t("redo re-applies an undone turn, and undo reverts the redo", async () => {
    const { cwd, sg } = await setup();
    await fs.writeFile(path.join(cwd, "a.txt"), "one\n");
    sg.beginTurn();
    await sg.snapshotIfNeeded();
    await fs.writeFile(path.join(cwd, "a.txt"), "two\n");

    await sg.undoLastChange();
    expect(await fs.readFile(path.join(cwd, "a.txt"), "utf8")).toBe("one\n");

    const redone = await sg.redoLastUndo();
    expect(redone).toEqual([path.join(cwd, "a.txt")]);
    expect(await fs.readFile(path.join(cwd, "a.txt"), "utf8")).toBe("two\n");

    const reverted = await sg.undoLastChange();
    expect(reverted).toEqual([path.join(cwd, "a.txt")]);
    expect(await fs.readFile(path.join(cwd, "a.txt"), "utf8")).toBe("one\n");
  });

  t("skips turns that changed nothing and undoes the last real change", async () => {
    const { cwd, sg } = await setup();
    await fs.writeFile(path.join(cwd, "a.txt"), "one\n");
    sg.beginTurn();
    await sg.snapshotIfNeeded();
    await fs.writeFile(path.join(cwd, "a.txt"), "two\n");

    sg.beginTurn(); // e.g. a turn whose bash command was read-only
    await sg.snapshotIfNeeded();

    const restored = await sg.undoLastChange();
    expect(restored).toEqual([path.join(cwd, "a.txt")]);
    expect(await fs.readFile(path.join(cwd, "a.txt"), "utf8")).toBe("one\n");
  });

  t("respects .gitignore — ignored files are neither snapshotted nor restored", async () => {
    const { cwd, sg } = await setup();
    await fs.writeFile(path.join(cwd, ".gitignore"), "secret.env\n");
    await fs.writeFile(path.join(cwd, "secret.env"), "TOKEN=abc\n");
    await fs.writeFile(path.join(cwd, "a.txt"), "one\n");

    sg.beginTurn();
    await sg.snapshotIfNeeded();
    await fs.writeFile(path.join(cwd, "a.txt"), "two\n");
    await fs.rm(path.join(cwd, "secret.env"));

    const restored = await sg.undoLastChange();
    expect(restored).toEqual([path.join(cwd, "a.txt")]);
    expect(await fs.readFile(path.join(cwd, "a.txt"), "utf8")).toBe("one\n");
    expect(fs.access(path.join(cwd, "secret.env"))).rejects.toThrow(); // not resurrected
  });

  t("a new snapshot invalidates the redo chain", async () => {
    const { cwd, sg } = await setup();
    await fs.writeFile(path.join(cwd, "a.txt"), "one\n");
    sg.beginTurn();
    await sg.snapshotIfNeeded();
    await fs.writeFile(path.join(cwd, "a.txt"), "two\n");
    await sg.undoLastChange();

    sg.beginTurn(); // new turn writes something else
    await sg.snapshotIfNeeded();
    await fs.writeFile(path.join(cwd, "b.txt"), "other\n");

    expect(await sg.redoLastUndo()).toEqual([]);
  });

  t("snapshot is taken once per turn and undo returns [] with no history", async () => {
    const { cwd, sg } = await setup();
    expect(await sg.undoLastChange()).toEqual([]);
    await fs.writeFile(path.join(cwd, "a.txt"), "one\n");
    sg.beginTurn();
    await sg.snapshotIfNeeded();
    await fs.writeFile(path.join(cwd, "a.txt"), "two\n");
    await sg.snapshotIfNeeded(); // second call same turn must NOT snapshot "two"
    await fs.writeFile(path.join(cwd, "a.txt"), "three\n");

    await sg.undoLastChange();
    expect(await fs.readFile(path.join(cwd, "a.txt"), "utf8")).toBe("one\n");
  });
});
