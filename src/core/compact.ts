import { generateText, type LanguageModel, type ModelMessage } from "ai";
import { modelInfo } from "../providers/models.js";

/**
 * Hermes-style compaction in four phases:
 *   1. slim — bulky tool outputs/inputs and images in the head are elided
 *      before the summary call (request-time hygiene for the live history is
 *      pruneOldToolResults in agent.ts).
 *   2. boundaries — the protected tail is chosen by TOKEN BUDGET (15% of the
 *      context window, capped), not a fixed message count, and never starts
 *      inside a tool-call/result pair.
 *   3. structured summary — Goal / Constraints & decisions / Done /
 *      In progress / Next steps, with an output budget proportional to the
 *      folded content. On re-compaction the existing summary is UPDATED
 *      (events merged into its sections) rather than re-summarized blind —
 *      the running summary survives many compactions without decaying.
 *   4. reassemble — [summary-as-user-message, ...tail].
 */

export const COMPACT_THRESHOLD = 0.8;
/** Prefix that marks (and lets us re-find) the running summary message. */
export const COMPACTION_MARKER = "[Conversation compacted. Summary of earlier context:]";

/** The tail always keeps at least this many messages, whatever their size. */
const MIN_TAIL = 6;
const TAIL_BUDGET_FRACTION = 0.15;
const TAIL_BUDGET_CAP = 16_000;
/** Summary output budget: 20% of folded content, clamped to this range. */
const SUMMARY_MIN_TOKENS = 1_000;
const SUMMARY_MAX_TOKENS = 4_000;
const SLIM_TOOL_CHARS = 800;
const SLIM_TEXT_CHARS = 8_000;

export function shouldCompact(modelId: string, lastInputTokens: number): boolean {
  return lastInputTokens > modelInfo(modelId).contextWindow * COMPACT_THRESHOLD;
}

/** ~4 chars/token, same estimate used everywhere else in aerin. */
function estTokens(m: ModelMessage): number {
  return Math.ceil(JSON.stringify(m).length / 4);
}

/** Walk back from the end until the tail's token budget is spent. */
function tailBoundary(messages: ModelMessage[], tailBudget: number): number {
  let cut = messages.length;
  let tokens = 0;
  while (cut > 0) {
    const kept = messages.length - cut;
    const cost = estTokens(messages[cut - 1] as ModelMessage);
    if (kept >= MIN_TAIL && tokens + cost > tailBudget) break;
    cut--;
    tokens += cost;
  }
  // Never start the tail inside a tool-call/result pair.
  while (cut > 0 && messages[cut]?.role === "tool") cut--;
  return cut;
}

/**
 * Shrink head messages for the summary call: the model summarizing them needs
 * the shape of events, not full file dumps, giant tool inputs, or images.
 */
function slimForSummary(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((m) => {
    if (typeof m.content === "string") {
      return m.content.length > SLIM_TEXT_CHARS
        ? ({ ...m, content: `${m.content.slice(0, SLIM_TEXT_CHARS)} …[truncated]` } as ModelMessage)
        : m;
    }
    if (!Array.isArray(m.content)) return m;
    const content = (m.content as unknown as Record<string, unknown>[]).map((part) => {
      if (part["type"] === "image") return { type: "text", text: "[image attached]" };
      if (part["type"] === "text" && typeof part["text"] === "string" && (part["text"] as string).length > SLIM_TEXT_CHARS) {
        return { ...part, text: `${(part["text"] as string).slice(0, SLIM_TEXT_CHARS)} …[truncated]` };
      }
      if (part["type"] === "tool-call" && JSON.stringify(part["input"] ?? "").length > SLIM_TOOL_CHARS) {
        return { ...part, input: { elided: `tool input elided (${JSON.stringify(part["input"]).length} chars)` } };
      }
      const out = part["output"] as Record<string, unknown> | undefined;
      if (part["type"] === "tool-result" && out && typeof out["value"] === "string" && (out["value"] as string).length > SLIM_TOOL_CHARS) {
        return {
          ...part,
          output: { ...out, value: `${(out["value"] as string).slice(0, 400)} …[output elided (${(out["value"] as string).length} chars)]` },
        };
      }
      return part;
    });
    return { ...m, content } as unknown as ModelMessage;
  });
}

const SUMMARY_SYSTEM =
  "You maintain the running summary of a coding-agent session so work continues seamlessly after older " +
  "messages are dropped. Output exactly these sections:\n\n" +
  "Goal: the user's overall objective, in one or two lines\n" +
  "Constraints & decisions: standing requirements, conventions, and choices made (carry forward old ones that still apply)\n" +
  "Done: completed work — specific, with file paths\n" +
  "In progress: the current task and its exact state\n" +
  "Next steps: what remains, in order\n\n" +
  "Be terse and concrete: prefer file paths, symbol names, commands, and error messages over prose. " +
  "When updating an existing summary, fold new events into the sections (move finished items to Done) " +
  "instead of appending a second history.";

export async function compact(
  model: LanguageModel,
  modelId: string,
  messages: ModelMessage[],
): Promise<ModelMessage[]> {
  if (messages.length <= MIN_TAIL + 2) return messages;
  const tailBudget = Math.min(modelInfo(modelId).contextWindow * TAIL_BUDGET_FRACTION, TAIL_BUDGET_CAP);
  const cut = tailBoundary(messages, tailBudget);
  if (cut <= 1) return messages; // everything fits in the tail budget — nothing to fold

  const head = messages.slice(0, cut);
  const tail = messages.slice(cut);

  // Iterative update: a previous compaction's summary is folded as the
  // starting point, not re-summarized as if it were conversation.
  const first = head[0];
  const prior =
    first?.role === "user" && typeof first.content === "string" && first.content.startsWith(COMPACTION_MARKER)
      ? first.content.slice(COMPACTION_MARKER.length).trim()
      : undefined;
  const events = slimForSummary(prior ? head.slice(1) : head);
  if (events.length === 0) return messages;

  const headTokens = events.reduce((n, m) => n + estTokens(m), 0);
  const summaryBudget = Math.min(SUMMARY_MAX_TOKENS, Math.max(SUMMARY_MIN_TOKENS, Math.round(headTokens * 0.2)));

  const { text } = await generateText({
    model,
    maxOutputTokens: summaryBudget,
    system: SUMMARY_SYSTEM,
    messages: [
      ...(prior
        ? [{ role: "user" as const, content: `Running summary from earlier compactions — merge into it, don't repeat it:\n\n${prior}` }]
        : []),
      ...events,
      {
        role: "user" as const,
        content: prior
          ? "Produce the UPDATED running summary now — fold the events above into its sections, as instructed."
          : "Produce the summary now, as instructed.",
      },
    ],
  });

  const summaryMessage: ModelMessage = { role: "user", content: `${COMPACTION_MARKER}\n\n${text}` };
  return [summaryMessage, ...tail];
}
