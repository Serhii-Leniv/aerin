# Aerin

[![CI](https://github.com/Serhii-Leniv/aerin/actions/workflows/ci.yml/badge.svg)](https://github.com/Serhii-Leniv/aerin/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/aerin-agent)](https://www.npmjs.com/package/aerin-agent)

An open-source CLI coding agent — in the spirit of Claude Code and opencode, small enough to read in an afternoon.

- **Any model, any provider**: Anthropic, OpenAI, Google, OpenRouter (300+ models), and local Ollama via the [Vercel AI SDK](https://ai-sdk.dev). Bring your own API key. `/model` shows a live, filterable list of what your keys can actually access — nothing is hardcoded. Aerin never auto-selects a paid model on your behalf.
- **Real coding tools**: read / write / edit files (CRLF-safe), glob, grep (ripgrep-accelerated), a shell tool with a proper Windows strategy — plus background jobs (`background:true` + `bash_output`) for dev servers and watchers.
- **Sub-agents**: the `agent` tool delegates research to a read-only sub-agent with its own context window — it explores (and can search the web) and returns only a report, so file dumps never flood your conversation. Live status line, cost folded into the meter, optional cheaper `subagentModel`.
- **Web access**: keyless `websearch` (DuckDuckGo) and `webfetch` (pages as readable text) for both the main agent and sub-agents.
- **Plan mode**: `/plan` makes the agent read-only — it explores, presents a numbered plan, and nothing is written or executed until you toggle back.
- **Task list & clarifying questions**: the model keeps a live todo checklist in the TUI, and can ask you one multiple-choice question when it is genuinely blocked.
- **Auto-memory**: durable project facts are saved to `AGENTS.md` (`## Memory`) with your approval and loaded into every future session; `AGENTS.md` / `CLAUDE.md` instructions are injected into the system prompt.
- **Permission gate**: every write and command asks first, with colored diff previews. Approve once, or persist an allow-rule per project.
- **Sessions**: JSONL history per directory with human titles — `--continue`, `--resume <id>`, or `/resume` for a filterable picker that replays the conversation — plus automatic context compaction and a live context/cost meter.
- **Reliability**: transient provider errors (429/overload/network) retry automatically with backoff; Anthropic prompt caching cuts input cost on every agentic iteration.
- **MCP client**: paste your existing `mcpServers` config (stdio and HTTP servers) and their tools appear in the agent.
- **Terminal UI**: Ink-based TUI with Claude Code-style transcript (`⏺ Read(file)` / `⎿ 82 lines`), streamed markdown, input history, slash-command autocomplete, and a status bar — plus `--no-tui` (plain REPL) and `-p` (headless one-shot) modes.

## Install

```sh
npm install -g aerin-agent     # or: npx aerin-agent
```

The installed command is `aerin`.

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

Switch models any time with `-m provider/model-id` or `/model` inside the session:

```sh
aerin -m openai/gpt-4o
aerin -m google/gemini-flash-latest
aerin -m ollama/llama3.1               # local, no key needed
```

## Configuration

Global: `~/.config/aerin/config.json` (platform-appropriate). Per-project: `.aerin/settings.json`.

```json
{
  "model": "anthropic/claude-opus-4-8",
  "subagentModel": "anthropic/claude-haiku-4-5",
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

Choosing **"Yes, always for this project"** in a prompt appends a rule to `.aerin/settings.json`. `--yolo` skips all prompts (use with care).

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
