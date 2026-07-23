# Deferred MCP tools

Source: `src/core/deferred-tools.ts`, dispatch intercept in `src/core/agent.ts`. Hermes's bridge-tool pattern.

When connected MCP servers' tool schemas would cost more than **10% of the model's context window on every request**, the schemas are withheld and three bridge tools take their place:
- `tool_search(query)` — find deferred tools by keyword (empty query lists all).
- `tool_describe(name)` — full description plus the raw JSON input schema.
- `tool_call(name, args)` — invoke one; `args` is a JSON object string.

A few hundred tokens of bridge instead of tens of thousands of schema, at the cost of one extra round trip when a tool is actually used. A startup notice reports the deferral and the tokens saved; `"deferMcpTools": true/false` forces it either way.

## The security-critical detail
`tool_call` is never executed as itself. The agent loop translates it into a dispatch of the **real** tool before anything else runs — so permission tiers, `mcp__*` deny rules, "always allow" persistence, hooks, doom-loop tracking, and the `/undo` snapshot all see the actual tool name. Only the transcript pairing keeps the bridge call's id, preserving provider message validation.

## Error paths
Unknown names point back to `tool_search`; malformed `args` JSON gets an exact message; a model that sends `args` as a real object instead of a string is accepted.
