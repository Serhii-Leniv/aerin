# Goal loop

Source: `src/core/goal-judge.ts` + the finished-turn branch in `src/core/agent.ts`. Adopted from Hermes Agent's `/goal` ("Ralph loop").

`/goal <text>` arms an autonomous loop and starts working immediately. After each finished turn, a small completion judge (~200 output tokens) reads the goal and the turn's report and returns `{"done", "reason"}`. Not done → the reason feeds back as a steering user message and the agent continues with a fresh tool-iteration budget. `/goal clear` stops; `/goal` shows the current goal.

## The three safety properties
1. **Evidence required** — the judge prompt treats plans, promises, and partial progress as not-done; only concrete evidence (test output, diffs, command results) completes a goal.
2. **Fail-open** — any judge failure (provider down, junk output) means "keep going", never a dead loop. The judge steers; it does not gate.
3. **Turn budget** — 20 autonomous continuations (`AgentOptions.maxGoalTurns`), the hard backstop. Exhaustion leaves the goal pinned so `/goal <same text>` resumes.

## Mechanics
- The loop lives inside `Agent.send()`, so the TUI, REPL, and headless mode all get it with no frontend-specific logic; frontends only render the `goal-check` event.
- The judge runs on the cheaper `subagentModel` when configured (`AgentOptions.getJudgeModel`), else the active model.
- Achieved goals disarm and unpin themselves; user messages always preempt (interrupt aborts the turn, the goal stays armed until cleared). `/clear` also drops the goal — a cleared session is a fresh start.
- While a goal is armed, ANY finished turn is judged — asking the agent something unrelated mid-goal will pull it back toward the goal afterward. That is the design; `/goal clear` if you want a plain conversation.
