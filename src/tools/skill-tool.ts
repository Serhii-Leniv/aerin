import { z } from "zod";
import type { ToolDef } from "./types.js";
import { truncateOutput } from "./types.js";
import { loadSkillBody, type Skill } from "../core/skills.js";

export function createSkillTool(skills: readonly Skill[]): ToolDef<z.ZodTypeAny> {
  return {
    name: "skill",
    description:
      "Load a skill: a reusable instruction pack for a specific kind of task. The available skills " +
      "are listed in the system prompt. Load one BEFORE starting a task it covers, then follow its " +
      "instructions. Reference files it mentions live in the same directory.",
    inputSchema: z.object({
      name: z.string().describe("Exact skill name from the available-skills list"),
    }),
    permission: "read",
    summarize: (i) => `Skill(${i.name})`,
    async execute(input) {
      const skill = skills.find((s) => s.name === String(input.name));
      if (!skill) {
        const known = skills.map((s) => s.name).join(", ") || "none";
        throw new Error(`Unknown skill: ${input.name}. Available: ${known}`);
      }
      const body = await loadSkillBody(skill);
      return truncateOutput(
        `[Skill: ${skill.name} — follow these instructions. Files referenced by relative path live in ${skill.dir}]\n\n${body}`,
      );
    },
  };
}
