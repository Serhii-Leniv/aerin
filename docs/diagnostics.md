# Post-edit diagnostics

Source: `src/core/diagnostics.ts`, run in `src/core/agent.ts` after successful `write`/`edit`.

After every successful file change, the project's check command runs; failures are appended to the tool result — `[diagnostics after this edit: … — fix these before moving on]` — so the model repairs type/lint fallout in the next iteration instead of discovering it at the end. A passing check appends nothing; the edit's own success is never overridden.

## Resolution order
1. `"diagnostics": "<command>"` in config — always used, hooks or not.
2. `"diagnostics": false` — disabled entirely, including auto-detection.
3. Unset — auto-detect a `typecheck` script in package.json, run via the package manager the lockfile implies (bun/pnpm/yarn/npm). Detection is deliberately that conservative — only the `typecheck` convention.
4. Auto-detection steps aside when a `post:write`/`post:edit`/`post:*` hook exists, so the same check never runs twice.

## Notes
- Keep the command fast — it runs on **every** edit. Point `diagnostics` at a fast checker or `false` if it hurts.
- Worker sub-agents get the same command, which matters most since you aren't watching them work.
- Execution reuses the hook runner (60s timeout, bounded output).
