import { generateText, type LanguageModel, type ModelMessage } from "ai";
import { modelInfo } from "../providers/models.js";

export const COMPACT_THRESHOLD = 0.8;
/** How many trailing messages to keep verbatim after compaction. */
const KEEP_TAIL = 4;

export function shouldCompact(modelId: string, lastInputTokens: number): boolean {
  return lastInputTokens > modelInfo(modelId).contextWindow * COMPACT_THRESHOLD;
}

/**
 * Summarize-and-truncate: one LLM call to summarize the conversation, then
 * rebuild history as [summary-as-user-message, ...last few messages].
 * The tail must not start inside a tool-call/result pair, so we cut at a
 * user or plain assistant boundary.
 */
export async function compact(
  model: LanguageModel,
  messages: ModelMessage[],
): Promise<ModelMessage[]> {
  if (messages.length <= KEEP_TAIL + 2) return messages;

  let cut = messages.length - KEEP_TAIL;
  while (cut > 0 && messages[cut]?.role === "tool") cut--;
  const head = messages.slice(0, cut);
  const tail = messages.slice(cut);

  const { text } = await generateText({
    model,
    system:
      "Summarize this coding-agent conversation for continuation. Include: the user's overall goal, files read or modified (with paths), key decisions and findings, current task state, and what remains to be done. Be specific and terse.",
    messages: [
      ...head,
      { role: "user", content: "Summarize the conversation so far as instructed." },
    ],
  });

  const summaryMessage: ModelMessage = {
    role: "user",
    content: `[Conversation compacted. Summary of earlier context:]\n\n${text}`,
  };
  return [summaryMessage, ...tail];
}
