# MCP

Source: `src/mcp/manager.ts`.

Aerin is an MCP (Model Context Protocol) client: configured servers' tools appear to the model as `mcp__<server>__<tool>`.

## Configuration
```json
{
  "mcpServers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] },
    "remote": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer …" } }
  }
}
```
Stdio and Streamable HTTP transports; 15s connect timeout; a server that fails to start degrades to a startup warning, never a crash. `/mcp` lists connected servers and their tools.

## Notes
- MCP tools are execute-tier: they ask unless allowed by rules (`mcp__github__*` as a bare allow rule) — and deny rules block them even through the deferred bridge.
- Tool schemas are JSON-Schema passthrough (no local zod validation).
- When schemas would flood the context, see [deferred MCP tools](deferred-mcp-tools.md).
