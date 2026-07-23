# Sub-agents

Source: `src/tools/agent-tool.ts`, `src/core/agents.ts` (named agents), prompts in `src/core/system-prompt.ts`.

The `agent` tool delegates a task to a sub-agent with its own context window; only its final text report returns — the raw files it reads never enter the parent conversation.

## Research mode (default)
Read-only toolset: `read, ls, glob, grep, websearch, webfetch`. No bash, no writes, and no `agent` tool (the recursion guard). Several research calls in one batch run in parallel; cost folds into the parent's meter; `subagentModel` in config routes them to a cheaper model. Use for broad or exploratory questions ("where is X handled?").

## Worker mode (`mode: "worker"`)
Adds `write`, `edit`, `bash` (30 iterations vs 15). Hermes-style isolation: **the worker sees none of the parent conversation** — the prompt must carry every fact (exact files, conventions, verification steps, what to report). Safety:
- Workers act under the **parent's live permission policy** — allow/deny rules, session approvals, and mode all apply.
- Permission asks surface to the user **serialized** (one dialog at a time) and labeled with the worker's task.
- Worker writes land in the parent turn's shadow-git snapshot, so `/undo` covers them (`getShadow` passthrough).
- Workers can never spawn agents (spawn depth of one).
- `"deny": ["agent(worker)"]` disables workers entirely; `"deny": ["agent(deploy-*)"]` blocks specific named agents.

## Named agents
Markdown files in `.aerin/agents/*.md` (also `.claude/agents/` and the global config dir): frontmatter `name`, `description`, optional `model` override and `mode: worker`; the body becomes the sub-agent's system prompt (the standard sub-agent rules always apply underneath). Selected via `agent: "name"` in the tool input; listed in the system prompt.
