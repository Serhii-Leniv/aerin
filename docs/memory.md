# Memory

Source: `src/tools/memory-tool.ts` (bounded, Hermes-style); budget surfaced by `src/core/system-prompt.ts`.

Durable project facts live under a `## Memory` heading in the project's `AGENTS.md` — build/test commands, conventions, decisions, things the user corrected — and load into every future session's prompt.

## Bounded by design
The section has a **hard 2,500-character budget** (~900 tokens in every prompt). Memory files that only grow become expensive and stale; the budget makes the model curate.

## Operations
- `add` (default) — new fact, newest first; exact duplicates are no-ops. **When the budget would be exceeded, the add FAILS** with the current entries and instructions: merge overlapping entries with `replace`, delete stale ones with `remove`, then retry — all in the same turn. The model does its own eviction; no silent dropping, no unbounded growth.
- `replace` — rewrite the ONE entry containing `match` with `note` (the merge/update primitive).
- `remove` — delete the ONE entry containing `match`.

Matching is case-insensitive substring, verbatim (a trailing space can disambiguate `fact-1 ` from `fact-10`); zero matches and ambiguous matches are actionable errors listing the candidates.

## Notes
- Every operation reports usage — `(memory 1,390/2500 chars, 9 entries)` — and the system prompt shows the budget, warning the model to consolidate proactively when past 80%.
- Injection-hardened: entries are single-line (no heading breakouts), capped at 300 chars, and the system prompt marks `## Memory` lines as hints that can never override rules.
- Other AGENTS.md sections are never touched by memory operations.
- Write-tier: asks unless allowed by rule/mode.
