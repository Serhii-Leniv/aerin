import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expandMentions } from "../src/core/mentions.js";
import { discoverSkills, loadSkillBody } from "../src/core/skills.js";
import { diffStat } from "../src/tools/fs-tools.js";

async function tmpCwd(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "aerin-ms-"));
}

describe("expandMentions", () => {
  test("attaches referenced files, leaves non-files alone", async () => {
    const cwd = await tmpCwd();
    await fs.writeFile(path.join(cwd, "notes.md"), "remember the milk");
    const out = await expandMentions("look at @notes.md and @nonexistent.txt please", cwd);
    expect(out.text).toContain("look at @notes.md and @nonexistent.txt please");
    expect(out.text).toContain("[Attached file: notes.md]");
    expect(out.text).toContain("remember the milk");
    expect(out.text).not.toContain("[Attached file: nonexistent.txt]");
    expect(out.images).toEqual([]);
  });

  test("no mentions → prompt unchanged", async () => {
    const cwd = await tmpCwd();
    expect((await expandMentions("plain question", cwd)).text).toBe("plain question");
    expect((await expandMentions("email me a@b.com", cwd)).text).toBe("email me a@b.com");
  });

  test("image mentions become base64 attachments", async () => {
    const cwd = await tmpCwd();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    await fs.writeFile(path.join(cwd, "shot.png"), png);
    const out = await expandMentions("what is wrong in @shot.png here", cwd);
    expect(out.images).toHaveLength(1);
    expect(out.images[0]?.mediaType).toBe("image/png");
    expect(out.images[0]?.data).toBe(png.toString("base64"));
    expect(out.text).not.toContain("[Attached file: shot.png]"); // not inlined as text
  });
});

describe("named agents", () => {
  test("discovers .aerin and .claude agents with frontmatter and body prompt", async () => {
    const { discoverAgents } = await import("../src/core/agents.js");
    const cwd = await tmpCwd();
    const d = path.join(cwd, ".aerin", "agents");
    await fs.mkdir(d, { recursive: true });
    await fs.writeFile(
      path.join(d, "reviewer.md"),
      `---\nname: reviewer\ndescription: adversarial code reviewer\nmodel: groq/llama-3.3-70b-versatile\n---\n\nYou review code harshly.`,
    );
    const agents = await discoverAgents(cwd);
    expect(agents).toHaveLength(1);
    expect(agents[0]?.name).toBe("reviewer");
    expect(agents[0]?.model).toBe("groq/llama-3.3-70b-versatile");
    expect(agents[0]?.systemPrompt).toBe("You review code harshly.");
  });
});

describe("skills", () => {
  test("discovers .aerin and .claude skills, .aerin wins on name clash", async () => {
    const cwd = await tmpCwd();
    const mk = async (root: string, dir: string, name: string, desc: string): Promise<void> => {
      const d = path.join(cwd, root, "skills", dir);
      await fs.mkdir(d, { recursive: true });
      await fs.writeFile(
        path.join(d, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${desc}\n---\n\nBody of ${name}.\n`,
      );
    };
    await mk(".aerin", "deploy", "deploy", "aerin deploy skill");
    await mk(".claude", "deploy", "deploy", "claude deploy skill");
    await mk(".claude", "review", "review", "review checklist");

    const skills = await discoverSkills(cwd);
    expect(skills.map((s) => s.name).sort()).toEqual(["deploy", "review"]);
    const deploy = skills.find((s) => s.name === "deploy");
    expect(deploy?.description).toBe("aerin deploy skill");
    expect(await loadSkillBody(deploy!)).toBe("Body of deploy.");
  });

  test("directory name is the fallback skill name", async () => {
    const cwd = await tmpCwd();
    const d = path.join(cwd, ".aerin", "skills", "no-frontmatter");
    await fs.mkdir(d, { recursive: true });
    await fs.writeFile(path.join(d, "SKILL.md"), "Just instructions.");
    const skills = await discoverSkills(cwd);
    expect(skills[0]?.name).toBe("no-frontmatter");
  });
});

describe("diffStat", () => {
  test("counts added and removed lines", () => {
    expect(diffStat("a\nb\nc\n", "a\nX\nc\nd\n")).toBe("+2 -1 lines");
    expect(diffStat("same\n", "same\n")).toBe("+0 -0 lines");
  });
});
