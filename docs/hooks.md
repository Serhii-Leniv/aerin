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

Example — auto-approve doc edits, freeze migrations:

```json
{ "hooks": { "pre:edit": "node scripts/edit-policy.mjs" } }
```

where the script reads stdin JSON and prints `{"decision":"allow"}` for `docs/**` paths or `{"decision":"deny","reason":"migrations are frozen until release"}` for `migrations/**`.

Post-edit typecheck is better served by [diagnostics](diagnostics.md), which auto-detects and steps aside if you wire a post hook yourself.
