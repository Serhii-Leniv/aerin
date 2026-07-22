import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Checkpoints } from "../src/core/checkpoints.js";
import { discoverCommands, renderCommand } from "../src/core/commands.js";
import { resolveModel, customProviders, providersWithKeys, PROVIDERS } from "../src/providers/registry.js";
import { persistProviderKey } from "../src/config/config.js";

async function tmpCwd(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "aerin-hv-"));
}

describe("checkpoints", () => {
  test("undo restores edited and deletes created files, newest turn first", async () => {
    const cwd = await tmpCwd();
    const existing = path.join(cwd, "a.txt");
    const created = path.join(cwd, "b.txt");
    await fs.writeFile(existing, "original");

    const cp = new Checkpoints();
    cp.beginTurn();
    await cp.record(existing);
    await cp.record(created); // does not exist yet
    await fs.writeFile(existing, "modified");
    await fs.writeFile(created, "new file");

    const restored = await cp.undoLastChange();
    expect(restored.sort()).toEqual([existing, created].sort());
    expect(await fs.readFile(existing, "utf8")).toBe("original");
    await expect(fs.readFile(created, "utf8")).rejects.toThrow();
    expect(await cp.undoLastChange()).toEqual([]);
  });

  test("empty turns are skipped", async () => {
    const cwd = await tmpCwd();
    const f = path.join(cwd, "x.txt");
    await fs.writeFile(f, "v1");
    const cp = new Checkpoints();
    cp.beginTurn();
    await cp.record(f);
    await fs.writeFile(f, "v2");
    cp.beginTurn(); // turn with no changes
    cp.beginTurn(); // another
    const restored = await cp.undoLastChange();
    expect(restored).toEqual([f]);
    expect(await fs.readFile(f, "utf8")).toBe("v1");
  });
});

describe("custom commands", () => {
  test("discovers .aerin and .claude commands, substitutes $ARGUMENTS", async () => {
    const cwd = await tmpCwd();
    const mk = async (root: string, name: string, body: string): Promise<void> => {
      const d = path.join(cwd, root, "commands");
      await fs.mkdir(d, { recursive: true });
      await fs.writeFile(path.join(d, `${name}.md`), body);
    };
    await mk(".aerin", "review", "# Review the code\nReview $ARGUMENTS carefully.");
    await mk(".claude", "review", "claude version — should lose");
    await mk(".claude", "test-it", "Run the tests and report.");

    const commands = await discoverCommands(cwd);
    expect(commands.map((c) => c.name).sort()).toEqual(["review", "test-it"]);
    const review = commands.find((c) => c.name === "review");
    expect(review?.description).toBe("Review the code");
    expect(renderCommand(review!, "src/foo.ts")).toContain("Review src/foo.ts carefully.");
    const testIt = commands.find((c) => c.name === "test-it");
    expect(renderCommand(testIt!, "")).toBe("Run the tests and report.");
    expect(renderCommand(testIt!, "only unit")).toBe("Run the tests and report.\n\nonly unit");
  });
});

describe("custom providers", () => {
  test("baseURL entries resolve through the OpenAI-compatible adapter", () => {
    const config = { providers: { deepseek: { baseURL: "https://api.deepseek.com/v1", apiKey: "sk-x" } } };
    expect(customProviders(config)).toEqual(["deepseek"]);
    expect(providersWithKeys(config)).toContain("deepseek");
    const model = resolveModel("deepseek/deepseek-chat", config) as { modelId?: string };
    expect(model.modelId).toBe("deepseek-chat");
  });

  test("unknown provider without baseURL gives config guidance", () => {
    expect(() => resolveModel("mysterio/model-1", {})).toThrow(/baseURL/);
  });

  test("xai is a first-class provider", () => {
    expect(PROVIDERS["xai"]?.envVar).toBe("XAI_API_KEY");
    const model = resolveModel("xai/grok-code-fast-1", {
      providers: { xai: { apiKey: "xai-test" } },
    }) as { modelId?: string };
    expect(model.modelId).toBe("grok-code-fast-1");
  });
});

describe("provider catalog", () => {
  test("catalog entries have valid endpoints and resolve after connecting", async () => {
    const { PROVIDER_CATALOG, catalogEntry } = await import("../src/providers/catalog.js");
    for (const e of PROVIDER_CATALOG) {
      if (e.baseURL) expect(e.baseURL).toMatch(/^https?:\/\//);
    }
    const groq = catalogEntry("groq");
    expect(groq?.baseURL).toContain("api.groq.com");
    const model = resolveModel("groq/llama-3.3-70b-versatile", {
      providers: { groq: { baseURL: groq!.baseURL!, apiKey: "gsk-test" } },
    }) as { modelId?: string };
    expect(model.modelId).toBe("llama-3.3-70b-versatile");
  });
});

describe("persistProviderKey", () => {
  test("writes and merges provider entries", async () => {
    const file = path.join(await tmpCwd(), "config.json");
    await persistProviderKey("xai", "xai-abc", undefined, file);
    await persistProviderKey("kimi", "sk-k", "https://api.moonshot.ai/v1", file);
    const raw = JSON.parse(await fs.readFile(file, "utf8"));
    expect(raw.providers.xai.apiKey).toBe("xai-abc");
    expect(raw.providers.kimi.baseURL).toBe("https://api.moonshot.ai/v1");
  });
});
