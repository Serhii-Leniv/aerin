# Contributing to aerin

Thanks for being here. Aerin's whole identity is that you can read it — start with the [architecture tour](docs/architecture.md) (8 stops, ~20 minutes) and the [docs index](docs/index.md) (one page per feature, with the invariants that must hold).

## Setup

```sh
bun install
bun test              # unit tests (~230, a few seconds)
bun run typecheck     # tsc --noEmit
bun run dev           # run from source
bun run build         # dist/ via tsdown
```

Developed with Bun, but the shipped code runs on plain Node ≥20 — **no `Bun.*` APIs** (`bun run check:no-bun-globals` enforces this). Windows is a first-class target: CI runs the suite on Windows, macOS, and Linux.

## The two constraints that keep aerin readable

1. **The line budget.** `src/` stays under **10,000 lines** — CI enforces it. This is the product: a full-featured agent you can hold in your head. New features pay line-count rent; if a feature can't justify its lines, it doesn't go in. Refactors that *shrink* code while keeping tests green are always welcome.
2. **No new runtime dependencies without an issue first.** `npx aerin-agent` cold-start matters, and every dependency is code nobody reads. Dev-dependencies are less strict but still discussed.

## Architecture rules (enforced by convention, checked in review)

- The core ↔ UI contract is `AgentEvent` (`src/core/events.ts`). Nothing outside `src/tui/` imports from it; nothing in `core/`, `tools/`, `providers/`, `permissions/`, `config/`, `session/`, `mcp/` imports Ink or React.
- Tool schemas stay **flat with primitive types** — provider JSON-Schema quirks break on unions and `format`.
- Windows: normalize CRLF before string matching, spawn with `windowsHide: true`, never build `cmd /c` strings.
- When you change a subsystem's behavior, update its `docs/` page **in the same PR**.

## What to work on

- [Good first issues](https://github.com/Serhii-Leniv/aerin/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) — each names the file, function, and test pattern to follow.
- Skills, custom commands, and named agents are **markdown** — you can contribute packs without touching TypeScript at all (your existing `.claude/` layouts work unchanged).
- Bug reports with a failing test are gold.

## PR expectations

Small and focused beats large and complete. Tests for behavior changes (`test/*.test.ts` — plain `bun:test`, no mocks framework; see `test/mock-model.ts` for the model mock). `bun test && bun run typecheck` green. We aim to respond to every PR within 24 hours.
