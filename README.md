# Aerin

An open-source CLI coding agent — in the spirit of Claude Code and opencode, small enough to read in an afternoon.

- **Multi-provider**: Anthropic, OpenAI, Google, OpenRouter, and local Ollama via the [Vercel AI SDK](https://ai-sdk.dev). Bring your own API key.
- **Real coding tools**: read / write / edit files (CRLF-safe), glob, grep (ripgrep-accelerated), and a shell tool with a proper Windows strategy.
- **Permission gate**: every write and command asks first, with diff previews. Approve once, or persist an allow-rule per project.
- **Sessions**: JSONL history per directory — `--continue`, `--resume <id>`, `/sessions`.
- **MCP client**: paste your existing `mcpServers` config (stdio and HTTP servers) and their tools appear in the agent.
- **Terminal UI**: Ink-based TUI with streaming, markdown rendering, tool cards, and a status bar — plus `--no-tui` (plain REPL) and `-p` (headless one-shot) modes.
- **AGENTS.md aware**: project instructions from `AGENTS.md` / `CLAUDE.md` files are injected into the system prompt.

## Install

```sh
npm install -g aerin     # or: npx aerin
```

Requires Node 20+.

## Quick start

```sh
export ANTHROPIC_API_KEY=sk-ant-...   # or OPENAI_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, OPENROUTER_API_KEY
cd your-project
aerin                                  # interactive TUI
aerin "fix the failing test"           # TUI with an opening prompt
aerin --no-tui                         # plain readline REPL
aerin -p --yolo "summarize this repo"  # headless, auto-approve, print, exit
```

Switch models any time:

```sh
aerin -m openai/gpt-4o
aerin -m ollama/llama3.1               # local, no key needed
```

or `/model` inside the session.

## Configuration

Global config: `~/.config/aerin/config.json` (platform-appropriate via env-paths).
Per-project: `.aerin/settings.json`.

```json
{
  "model": "anthropic/claude-opus-4-8",
  "providers": {
    "openrouter": { "apiKey": "sk-or-..." },
    "ollama": { "baseURL": "http://localhost:11434/v1" }
  },
  "mcpServers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] },
    "remote": { "url": "https://example.com/mcp" }
  },
  "permissions": {
    "allow": ["bash(git *)", "write(src/*)", "mcp__github__*"]
  }
}
```

Never put API keys in the *project* config — it gets committed. Use env vars or the global config.

## Permission rules

Three tiers: reads are always allowed; writes and commands ask. Rules are simple prefix globs:

| Rule | Meaning |
|---|---|
| `bash(git *)` | any git command |
| `write(src/*)` | writes under `src/` |
| `mcp__github__*` | all tools from the github MCP server |

Choosing **"Yes, always for this project"** in the prompt appends a rule to `.aerin/settings.json`. `--yolo` skips all prompts (use with care).

## Development

```sh
bun install
bun test            # unit tests
bun run typecheck
bun run dev         # run from source
bun run build       # dist/ via tsdown
```

The core (`src/core`, `src/tools`, …) never imports Ink/React — the TUI is one of three frontends over the same `AsyncIterable<AgentEvent>` stream, which keeps everything testable headless.

## License

MIT
