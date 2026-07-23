# Configuration

Source: `src/config/config.ts`. Two files, merged global ← project: the global config (`config.json` in the aerin config dir) and `.aerin/settings.json` in the project. Never put API keys in the project file — it gets committed; use env vars, the global config, or `/connect`.

| Key | Type | What it does |
|---|---|---|
| `model` | string | `provider/model-id` to use; aerin never auto-selects a paid model |
| `subagentModel` | string | Cheaper model for sub-agents and the goal-loop judge |
| `fallbackModels` | string[] | Ordered [failover chain](provider-failover.md) |
| `providers` | record | `{ apiKey?, baseURL? }` per provider; any name with a `baseURL` gets the OpenAI-compatible adapter |
| `mcpServers` | record | [MCP servers](mcp.md), stdio or HTTP |
| `deferMcpTools` | boolean | Force [deferral](deferred-mcp-tools.md) on/off (default: auto at >10% of context) |
| `permissions.allow` | string[] | [Allow rules](permissions.md) — `bash(git *)`, `write(src/*)`, `mcp__github__*` |
| `permissions.deny` | string[] | Deny rules — beat allow/accept/`--yolo`; match chained bash segments |
| `hooks` | record | `"pre:<tool>"`/`"post:<tool>"` shell commands — [hooks](hooks.md) |
| `diagnostics` | string \| false | Post-edit check command; false disables; unset auto-detects a `typecheck` script — [diagnostics](diagnostics.md) |
| `recentModels` | string[] | Maintained automatically by `/model` |

CLI flags that interact: `--yolo` (auto-approve everything not denied), `--allow-outside-cwd`, `-m/--model`, `--continue`, `--resume <id>`, `--no-tui`, `-p` (headless print).
