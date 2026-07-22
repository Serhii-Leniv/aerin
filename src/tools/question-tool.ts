import { z } from "zod";
import type { ToolDef } from "./types.js";

/** How a frontend answers the model's clarifying question. */
export type AskUser = (question: string, options: string[]) => Promise<string>;

export function createQuestionTool(deps: { ask?: AskUser }): ToolDef<z.ZodTypeAny> {
  return {
    name: "question",
    description:
      "Ask the user ONE clarifying question when you are blocked on a decision only they can make " +
      "(ambiguous requirements, a choice between approaches). Provide 2-4 short options; the user " +
      "may also answer free-form. Do not use it for things you can decide with sensible defaults.",
    inputSchema: z.object({
      question: z.string().describe("The complete question, ending with a question mark"),
      options: z.array(z.string()).describe("2-4 short answer options, most recommended first"),
    }),
    permission: "read",
    summarize: (i) => `Question(${String(i.question).slice(0, 70)})`,
    async execute(input) {
      if (!deps.ask) {
        throw new Error("No interactive user is available to answer questions — decide with sensible defaults.");
      }
      const options = ((input.options ?? []) as string[]).filter((o) => typeof o === "string" && o.trim()).slice(0, 4);
      const answer = (await deps.ask(String(input.question), options)).trim();
      if (!answer) throw new Error("The user gave no answer — proceed with your best judgment.");
      return `User answered: ${answer}`;
    },
  };
}
