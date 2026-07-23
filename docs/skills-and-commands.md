# Skills & custom commands

Source: `src/core/skills.ts`, `src/core/commands.ts`, `src/tools/skill-tool.ts`.

## Skills
Instruction packs the model loads on demand: `.aerin/skills/<name>/SKILL.md` (also `.claude/skills/` — Claude Code-compatible — and the global config dir). YAML frontmatter carries `name` and `description`; the list goes in the system prompt (cheap), the body loads via the `skill` tool only when a task matches (progressive disclosure). `/skills` lists them.

## Custom commands
Prompt templates run as slash commands: `.aerin/commands/<name>.md` (also `.claude/commands/`, global) with `$ARGUMENTS` substitution — `/name args` renders the template and submits it as a prompt.

## Named agents
Related but separate: `.aerin/agents/<name>.md` defines custom sub-agents — see [sub-agents](subagents.md).
