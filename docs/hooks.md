# Hooks

Source: `src/core/hooks.ts`, wired in `src/core/agent.ts` (`dispatchToolCall`).

Config `hooks` maps `"pre:<tool>"` / `"post:<tool>"` (or `"pre:*"` / `"post:*"`) to shell commands. Every hook receives `AERIN_TOOL` and `AERIN_TOOL_INPUT` env vars plus a JSON payload on stdin: `{"phase","tool","input","cwd"}` — post hooks also get `"output"` (the tool's result, capped at 8k).

## Two protocols, chosen by what the hook prints
**Legacy** (stdout is not JSON): exit code decides. A pre-hook exiting non-zero blocks the call (its output becomes the error the model sees); a post-hook's non-zero output is appended to the tool result.

**JSON** (stdout — or its last line — parses as a JSON object): the object decides, exit code ignored.
- Pre: `{"decision": "allow" | "deny" | "ask", "reason": "...", "input": {...}}` — `allow` skips the user permission prompt, `deny` blocks with the reason sent to the model, `ask` forces a prompt even where rules would allow, `input` rewrites the tool's arguments.
- Post: `{"context": "..."}` — appended to the tool result on any exit code.

## Ordering & safety invariants
- Pre-hooks run **before** the permission prompt (Claude Code's ordering) — they are a policy point, not an afterthought.
- Permission **deny rules always beat hooks**.
- Rewritten input is re-validated against the tool's schema **and** re-checked against the policy — a hook cannot redirect a write into a denied path.

## Lifecycle events
Beyond per-tool hooks, five lifecycle keys use the same config map and JSON protocol:

| Key | When | JSON effect |
|---|---|---|
| `session:start` | after setup (payload: sessionId, model, resumed) | `{"context"}` appended to the system prompt |
| `prompt:submit` | before each user prompt | `{"decision":"block","reason"}` vetoes it; `{"context"}` rides along with the prompt |
| `turn:end` | when a turn finishes (payload: response tail) | `{"decision":"block","reason"}` sends the agent back to work — capped at 3 per turn so an always-blocking hook can't trap it |
| `compact:pre` | before compaction (payload: preTokens) | observational |
| `session:end` | on shutdown (payload: sessionId, message count) | observational |

Lifecycle hooks are observational unless they speak JSON — plain output and exit codes are ignored. Each receives its payload on stdin with `AERIN_TOOL` set to the event name. `turn:end` is the custom stop-gate: a script that runs the test suite and blocks with "tests were not run" turns any turn into verified work.

Example — auto-approve doc edits, freeze migrations:

```json
{ "hooks": { "pre:edit": "node scripts/edit-policy.mjs" } }
```

where the script reads stdin JSON and prints `{"decision":"allow"}` for `docs/**` paths or `{"decision":"deny","reason":"migrations are frozen until release"}` for `migrations/**`.

Post-edit typecheck is better served by [diagnostics](diagnostics.md), which auto-detects and steps aside if you wire a post hook yourself.
