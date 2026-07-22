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
    expect(out).toContain("look at @notes.md and @nonexistent.txt please");
    expect(out).toContain("[Attached file: notes.md]");
    expect(out).toContain("remember the milk");
    expect(out).not.toContain("[Attached file: nonexistent.txt]");
  });

  test("no mentions → prompt unchanged", async () => {
    const cwd = await tmpCwd();
    expect(await expandMentions("plain question", cwd)).toBe("plain question");
    expect(await expandMentions("email me a@b.com", cwd)).toBe("email me a@b.com");
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
