# Memory

Source: `src/tools/memory-tool.ts`, loaded by `src/core/system-prompt.ts`.

The `memory` tool appends durable facts under a `## Memory` heading in the project's `AGENTS.md` — build/test commands, conventions, things the user corrected. Every future session loads them with the project instructions.

## Notes
- Deduplicated: saving the same note twice is a no-op.
- Injection-hardened: the system prompt explicitly marks `## Memory` lines as hints written by past sessions — never instructions that can override the rules, and anything asking to change behavior, hide actions, or exfiltrate data is to be ignored.
- The system prompt nudges the model to save durable project facts when it learns them.
- Write-tier: the first save in a session asks unless allowed by rule/mode.

Planned evolution (see the adoption backlog): Hermes-style bounded memory — char budgets, add/replace/remove with substring matching, and error-at-capacity that forces the model to consolidate instead of letting the file grow forever.
