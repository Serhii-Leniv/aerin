import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../src/session/store.js";

async function tmpCwd(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "aerin-test-"));
}

describe("SessionStore", () => {
  test("create, append, reopen roundtrip", async () => {
    const cwd = await tmpCwd();
    const store = await SessionStore.create(cwd, "anthropic/claude-opus-4-8");
    await store.append([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    const { messages } = await SessionStore.open(cwd, store.id);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: "user", content: "hi" });
  });

  test("list returns newest first and latest() picks it", async () => {
    const cwd = await tmpCwd();
    const a = await SessionStore.create(cwd, "m");
    await new Promise((r) => setTimeout(r, 10));
    const b = await SessionStore.create(cwd, "m");
    const list = await SessionStore.list(cwd);
    expect(list.length).toBe(2);
    expect(list[0]?.id).toBe(b.id);
    expect((await SessionStore.latest(cwd))?.id).toBe(b.id);
    expect(list.map((s) => s.id)).toContain(a.id);
  });

  test("torn final line is dropped on load", async () => {
    const cwd = await tmpCwd();
    const store = await SessionStore.create(cwd, "m");
    await store.append([{ role: "user", content: "ok" }]);
    // simulate a crash mid-write
    const { sessionsDir } = await import("../src/config/paths.js");
    const file = path.join(sessionsDir(cwd), `${store.id}.jsonl`);
    await fs.appendFile(file, '{"role":"assistant","content":"trunc', "utf8");
    const { messages } = await SessionStore.open(cwd, store.id);
    expect(messages).toHaveLength(1);
  });

  test("ensureTitle sets the title once and list() reports it with counts", async () => {
    const cwd = await tmpCwd();
    const store = await SessionStore.create(cwd, "m");
    await store.append([{ role: "user", content: "fix the login bug" }]);
    await store.ensureTitle("fix the login bug");
    await store.ensureTitle("something else"); // no-op: title already set
    const [s] = await SessionStore.list(cwd);
    expect(s?.title).toBe("fix the login bug");
    expect(s?.messageCount).toBe(1);
  });

  test("list() falls back to the first user prompt for untitled sessions", async () => {
    const cwd = await tmpCwd();
    const store = await SessionStore.create(cwd, "m");
    await store.append([
      { role: "user", content: "explain the build" },
      { role: "assistant", content: "sure" },
    ]);
    const [s] = await SessionStore.list(cwd);
    expect(s?.title).toBe("explain the build");
    expect(s?.messageCount).toBe(2);
  });

  test("rewrite preserves meta and replaces messages", async () => {
    const cwd = await tmpCwd();
    const store = await SessionStore.create(cwd, "m");
    await store.append([{ role: "user", content: "a" }, { role: "user", content: "b" }]);
    await store.rewrite([{ role: "user", content: "summary" }]);
    const { messages } = await SessionStore.open(cwd, store.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ role: "user", content: "summary" });
  });
});
