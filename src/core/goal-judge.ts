import { generateText, type LanguageModel } from "ai";

/**
 * Completion judge for the /goal loop (Hermes's "Ralph loop" design): after
 * each finished turn a small (~200 output tokens) LLM call decides whether
 * the goal is truly achieved. Evidence-based by prompt: plans and promises
 * are not completion. FAIL-OPEN: any judge failure means "keep going" — the
 * goal turn budget, not the judge, is what bounds the loop.
 */

export interface GoalVerdict {
  done: boolean;
  reason: string;
}

const JUDGE_SYSTEM =
  "You are the completion judge for an autonomous coding agent working toward a goal. " +
  "Read the goal and the agent's latest report, then respond with ONLY a JSON object: " +
  '{"done": true|false, "reason": "one short sentence"}. ' +
  "done=true ONLY if the report contains concrete evidence that the goal is fully achieved " +
  "(command output, test results, file changes). Plans, promises, questions, and partial " +
  "progress are done=false. Be conservative: when unsure, done=false with the missing evidence as the reason.";

export async function judgeGoal(
  model: LanguageModel,
  goal: string,
  report: string,
  abortSignal?: AbortSignal,
): Promise<GoalVerdict> {
  try {
    const { text } = await generateText({
      model,
      maxOutputTokens: 200,
      system: JUDGE_SYSTEM,
      messages: [
        {
          role: "user",
          content: `Goal:\n${goal}\n\nAgent's latest report (tail):\n${report.slice(-4000) || "(the agent produced no text this turn)"}\n\nJudge now.`,
        },
      ],
      ...(abortSignal ? { abortSignal } : {}),
    });
    const m = /\{[\s\S]*\}/.exec(text);
    if (!m) throw new Error("judge returned no JSON");
    const j = JSON.parse(m[0]) as { done?: unknown; reason?: unknown };
    return {
      done: j.done === true,
      reason: typeof j.reason === "string" && j.reason.trim() ? j.reason.trim() : "(no reason given)",
    };
  } catch {
    return { done: false, reason: "(judge unavailable — continuing; the turn budget bounds the loop)" };
  }
}
