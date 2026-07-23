# Doom-loop breaker

Source: `src/core/agent.ts` (`dispatchToolCall`), adopted from opencode's `doom_loop` permission.

When the model calls the **same tool with byte-identical JSON input for the 4th time in one turn**, aerin interrupts with a synthetic permission ask — `Doom loop: Grep(TODO) repeated 4× with identical input — continue?` — regardless of permission tier or mode, including `--yolo`. Identical retries never produce different results; this stops the token burn before it compounds.

## Decisions
- **Allow** — this one call proceeds.
- **Always** — the tool is whitelisted for doom-loop checks for the rest of the session (legitimate polling exists).
- **Deny** — the model receives targeted guidance: it has repeated the call, repetition won't help, change approach or explain the blocker. A typed deny-reason is folded in as user steering.

## Mechanics
- Tracking is per turn (`turnToolCalls`, reset each `send()`), so deliberate repetition across turns never triggers.
- The check runs after the deferred-tool remap, so bridged MCP calls compare real tool names, not `tool_call`.
- Sub-agents inherit it: a looping research sub-agent's auto-deny callback feeds it the change-your-approach error (self-correction, no human needed); workers surface a real labeled prompt.
