# Aerin

[![CI](https://github.com/Serhii-Leniv/aerin/actions/workflows/ci.yml/badge.svg)](https://github.com/Serhii-Leniv/aerin/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/aerin-agent)](https://www.npmjs.com/package/aerin-agent)

An open-source CLI coding agent — in the spirit of Claude Code and opencode, small enough to read in an afternoon.

- **Any model, any provider**: Anthropic, OpenAI, Google, OpenRouter (300+ models), xAI/Grok, local Ollama — plus **any OpenAI-compatible endpoint** (DeepSeek, Kimi, Groq, LM Studio, vLLM…) via a two-line config entry. `/model` shows a live, filterable, fuzzy-searchable list with a Recent section; your pick is remembered for the next session. `/connect` adds an API key from inside aerin. Aerin never auto-selects a paid model on your behalf. The system prompt is tuned per model family (GPT, Gemini, open/local models get short addenda targeting their known failure modes), and the tuning follows `/model` switches mid-session.
- **Real coding tools**: read / write / edit files (CRLF-safe, `+A -R` diff stats), glob, grep (ripgrep-accelerated, finds VS Code's bundled rg too), a shell tool with a proper Windows strategy, and background jobs (`background:true` + `bash_output`) for dev servers and watchers.
- **Sub-agents**: the `agent` tool delegates research to read-only sub-agents with their own context windows — several run in parallel, each can search the web, and only reports come back. Live status lines, cost folded into the meter, optional cheaper `subagentModel`. With `mode:"worker"` a sub-agent can also edit files and run commands for self-contained tasks: workers see none of the parent conversation (the prompt must carry full context), act under the same permission rules with asks surfacing to you one at a time, write into the same `/undo` snapshot, and can't spawn further agents. Named agents opt in with `mode: worker` frontmatter; a `"deny": ["agent(worker)"]` rule turns workers off entirely.
- **@file mentions**: type `@src/foo.ts` (fuzzy path autocomplete in the TUI) to attach files to your prompt precisely instead of making the model search.
- **Post-edit diagnostics**: after every successful write/edit, aerin runs your project's check command and feeds failures straight back to the model, so type errors get fixed immediately instead of at the end. Zero-config when `package.json` has a `typecheck` script (run via your lockfile's package manager); override with `"diagnostics": "<command>"` in the config or disable with `"diagnostics": false`. Worker sub-agents self-correct the same way. Keep the command fast — it runs on every edit.
- **Session recall**: the `session_search` tool searches this project's past conversations (decisions, fixes, files touched) and reads old transcripts on demand — "like we did last week" actually works.
- **Undo/redo**: `/undo` reverts the file changes of the last turn — including bash side effects, via a shadow git repo snapshotted before every state-changing tool — and `/redo` re-applies them. Falls back to write-tool-only undo when git isn't installed.
- **Skills & custom commands**: `.aerin/skills/<name>/SKILL.md` instruction packs the model loads on demand, and `.aerin/commands/<name>.md` prompt templates run as `/name args` (`$ARGUMENTS` substitution). Both also read your existing `.claude/` equivalents — Claude Code-compatible.
- **Web access**: keyless `websearch` (DuckDuckGo) and `webfetch` (pages as readable text), wrapped in untrusted-content guards.
- **Plan mode**: `/plan` makes the agent read-only — it explores, presents a numbered plan, and nothing is written or executed until you toggle back (even under `--yolo`).
- **Task list & clarifying questions**: a live todo checklist in the TUI, and the model can ask you one multiple-choice question when genuinely blocked.
- **Auto-memory**: durable project facts saved to `AGENTS.md` (`## Memory`) with your approval, loaded into every future session; `AGENTS.md` / `CLAUDE.md` instructions are injected into the system prompt, along with your git branch/status.
- **Permission gate**: every write and command asks first, with colored diff previews. Approve once, persist an allow-rule per project, or hard-block actions with deny rules that even `--yolo` can't cross.
- **Sessions**: JSONL history per directory with human titles — `--continue`, `--resume <id>`, or `/resume` for a picker that replays the conversation — plus automatic context compaction (a structured running summary that gets *updated* on each compaction, with a token-budgeted protected tail), stale tool-output pruning, and a live context/cost meter.
- **Reliability**: transient provider errors retry with backoff (daily quotas fail fast); Anthropic prompt caching cuts input cost on every agentic iteration.
- **MCP client**: paste your existing `mcpServers` config (stdio and HTTP servers) and their tools appear in the agent.
- **Terminal UI**: full-screen Ink TUI (alt-screen; your shell scrollback survives, and the transcript is printed on exit) with Claude Code-style output, streamed markdown, PgUp/PgDn scrolling, multi-line input (paste or `\`+Enter), interactive `/help`, and a status bar — plus `--no-tui` (plain REPL) and `-p` (headless: `cat log | aerin -p "why?"`).

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
    "xai": { "apiKey": "xai-..." },
    "deepseek": { "baseURL": "https://api.deepseek.com/v1", "apiKey": "sk-..." },
    "lmstudio": { "baseURL": "http://localhost:1234/v1" },
    "ollama": { "baseURL": "http://localhost:11434/v1" }
  },
  "mcpServers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] },
    "remote": { "url": "https://example.com/mcp" }
  },
  "permissions": {
    "allow": ["bash(git *)", "write(src/*)", "mcp__github__*"],
    "deny": ["bash(rm *)", "write(.env*)", "edit(.env*)"]
  }
}
```

Any provider name that isn't built in but has a `baseURL` is served through the OpenAI-compatible adapter — that one mechanism covers DeepSeek, Kimi, Groq, Cerebras, Together, Fireworks, LM Studio, vLLM, and friends. `/model` discovers their model lists from `baseURL/models`.

Never put API keys in the *project* config — it gets committed. Use env vars, the global config, or `/connect` inside aerin.

## Permission rules

Three tiers: reads are always allowed; writes and commands ask. Rules are simple prefix globs:

| Rule | Meaning |
|---|---|
| `bash(git *)` | any git command |
| `write(src/*)` | writes under `src/` |
| `mcp__github__*` | all tools from the github MCP server |

Choosing **"Yes, always for this project"** in a prompt appends a rule to `.aerin/settings.json`. `--yolo` skips all prompts (use with care).

A `deny` list uses the same syntax and beats everything — allow rules, accept mode, even `--yolo`. Denies also apply to read-tier tools (`"read(*.pem*)"`), and bash denies are matched against each segment of chained commands, so `bash(rm *)` catches `git pull && rm -rf x`. The agent is told which rule blocked it and not to work around it.

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
