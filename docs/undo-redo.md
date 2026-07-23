# Undo & redo

Source: `src/core/shadow-git.ts` (primary), `src/core/checkpoints.ts` (in-memory fallback when git is missing).

`/undo` reverts the file changes of the last turn — **including bash and MCP side effects** — and `/redo` re-applies them.

## How it works
A shadow git repository lives in the aerin data dir (never inside the project) and treats your cwd as its work tree via `--git-dir`/`--work-tree`. Before the first write- or execute-tier tool of each turn, the whole tree is snapshotted (`git add -A` + `write-tree`); the snapshot is lazy, so read-only turns cost nothing. `/undo` diffs the last snapshot against the current tree and restores exactly the changed files: created files deleted, modified/deleted files restored via `read-tree` + `checkout-index --stdin` (stdin path list — immune to Windows command-line limits). Turns that changed nothing are skipped.

## Properties
- Works whether or not the project itself uses git.
- `.gitignore` respected: `node_modules` and secrets like `.env` are never copied into the shadow store, never resurrected by undo.
- Byte-exact snapshots (`core.autocrlf=false`), `core.longpaths=true`, user `GIT_*` env vars stripped.
- Undo reverts everything changed since the snapshot, including manual edits made after that turn — the price of catching bash side effects; the window is only the most recent turn.
- A new snapshot invalidates the redo chain; another `/undo` reverts a `/redo`.
- Worker sub-agents share the parent's shadow instance (`AgentOptions.getShadow`) so their writes land in the same per-turn snapshot; two instances on one shadow index would race.
- Any git failure degrades silently; without git installed, the fallback captures write-tool files only.
