# Aerin — agent instructions

- Runtime: developed with Bun, but **write Node-compatible code only** — no `Bun.*` APIs (`bun run check:no-bun-globals` enforces this). Use `node:fs/promises`, `node:child_process`, etc.
- Layering rule: nothing outside `src/tui/` may import from `src/tui/`, and nothing in `src/core|tools|providers|permissions|config|session|mcp` may import `ink` or `react`. The core <-> UI contract is `AgentEvent` in `src/core/events.ts`.
- Tool schemas stay flat with primitive types only — Google/OpenAI/Ollama all have JSON Schema quirks; unions and `format` break providers.
- Windows is a first-class target: normalize CRLF before string matching (see `applyEdit`), spawn with `windowsHide: true`, never build `cmd /c` command strings.
- Tests: `bun test`. Typecheck: `bun run typecheck`. Build: `bun run build` (shebang must stay the first line of `dist/index.js`).
- Keep dependencies lean — `npx aerin` cold-start matters. No packages with native postinstall steps.
