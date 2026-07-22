import { z } from "zod";
import type { ToolDef } from "./types.js";

export type TodoStatus = "pending" | "active" | "done";

export interface TodoItem {
  text: string;
  status: TodoStatus;
}

const STATUSES: TodoStatus[] = ["pending", "active", "done"];

export const todoTool: ToolDef<z.ZodTypeAny> = {
  name: "todo",
  description:
    "Replace your visible task list for the current work. Use it for any multi-step task: " +
    "write the steps up front, then update statuses as you go — exactly one item should be " +
    '"active" at a time. The user sees this list live, so keep items short and outcome-focused.',
  inputSchema: z.object({
    items: z
      .array(
        z.object({
          text: z.string().describe("Short task description"),
          status: z.string().describe('One of: "pending", "active", "done"'),
        }),
      )
      .describe("The complete task list — this replaces the previous list entirely"),
  }),
  permission: "read",
  summarize: (i) => {
    const items = (i.items ?? []) as { status?: string }[];
    const done = items.filter((it) => it.status === "done").length;
    return `Todo(${done}/${items.length} done)`;
  },
  async execute(input, ctx) {
    const items: TodoItem[] = ((input.items ?? []) as { text?: string; status?: string }[])
      .filter((it) => typeof it.text === "string" && it.text.trim())
      .map((it) => ({
        text: (it.text as string).trim(),
        status: STATUSES.includes(it.status as TodoStatus) ? (it.status as TodoStatus) : "pending",
      }));
    ctx.onProgress?.({ type: "todo-update", items });
    if (items.length === 0) return "(todo list cleared)";
    return items
      .map((it) => `${it.status === "done" ? "[x]" : it.status === "active" ? "[>]" : "[ ]"} ${it.text}`)
      .join("\n");
  },
};
