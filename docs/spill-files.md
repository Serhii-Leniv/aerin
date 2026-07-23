# Spill files

Source: `truncateOutput` in `src/tools/types.ts` — the single truncation point every tool shares.

When a tool result exceeds the caps (30k chars / 2000 lines; head AND tail kept, since errors live at the end), the **complete** output is written to a spill file under the aerin data dir and the truncated result gains a pointer:

```
[full output (184,201 chars) saved to <data>/spill/tool-abc123.txt — grep it or
read it with offset/limit for the omitted parts instead of re-running the command;
for broad analysis, delegate reading it to an agent]
```

The model then greps or slices the file instead of re-running an expensive command — or hands the file to a research sub-agent so the bulk never enters the main conversation.

## Notes
- Applies everywhere automatically: bash, read, grep/glob, web tools, MCP results, sub-agent reports, session search.
- Spills live outside the project (never accidentally committed), 7-day retention swept once per process.
- Spill failure degrades silently to plain truncation — context protection never depends on the disk write.
- Tests pass `{ spillDir: false }` or a temp dir so suites don't touch the real data dir.
