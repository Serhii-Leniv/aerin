# Aerin — agent instructions

## Architecture (orientation)
- The agent loop is `Agent.send()` in `src/core/agent.ts` — an async generator of `AgentEvent`s (src/core/events.ts), consumed by three frontends: Ink TUI (`src/tui/`), plain REPL (`src/modes/repl.ts`), headless print (`src/modes/print.ts`).
- Permission tiers read/write/execute in `src/permissions/policy.ts`; deny rules beat allow/accept/--yolo (bash denies match chained-command segments); plan mode denies write/execute outright; chained bash commands always ask.
- Cross-cutting core: undo/redo via shadow-git snapshots (`core/shadow-git.ts`; in-memory fallback `core/checkpoints.ts` when git is missing), compaction + stale tool-output pruning (`core/compact.ts`, `pruneOldToolResults`), @mentions (`core/mentions.ts`), skills (`core/skills.ts`), custom commands (`core/commands.ts`).
- Providers: built-ins + any OpenAI-compatible baseURL (`providers/registry.ts`); model pricing/context from models.dev (`providers/modelsdev.ts`) — dynamic data wins over the static table.

- Runtime: developed with Bun, but **write Node-compatible code only** — no `Bun.*` APIs (`bun run check:no-bun-globals` enforces this). Use `node:fs/promises`, `node:child_process`, etc.
- Layering rule: nothing outside `src/tui/` may import from `src/tui/`, and nothing in `src/core|tools|providers|permissions|config|session|mcp` may import `ink` or `react`. The core <-> UI contract is `AgentEvent` in `src/core/events.ts`.
- Tool schemas stay flat with primitive types only — Google/OpenAI/Ollama all have JSON Schema quirks; unions and `format` break providers.
- Windows is a first-class target: normalize CRLF before string matching (see `applyEdit`), spawn with `windowsHide: true`, never build `cmd /c` command strings.
- Tests: `bun test`. Typecheck: `bun run typecheck`. Build: `bun run build` (shebang must stay the first line of `dist/index.js`).
- Keep dependencies lean — `npx aerin` cold-start matters. No packages with native postinstall steps.

## Memory
- test suite runs with bun test
