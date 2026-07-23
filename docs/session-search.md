# Session search

Source: `src/tools/session-search-tool.ts`.

The `session_search` tool gives the agent episodic recall over this project's past conversations — decisions made, bugs fixed, files touched, approaches tried. Cues like "like we did before" or "that bug from last week" work.

## Two modes
- **Search**: `query` keywords are scored across user text, assistant text, tool-call inputs, and tool-result outputs (so a string that only appeared in a diff still matches). Ranking: distinct terms matched, then hit count, then recency; title matches weigh extra. Results show session id, title, date, and up to 3 role-tagged snippets.
- **Read**: passing a `session_id` from a result returns that session's full transcript (standard truncation applies), so the model summarizes past work itself — no second LLM call baked in.

## Notes
- No database: the JSONL session files ARE the index; a keyword scan is plenty at one project's scale and keeps aerin dependency-free.
- The running session is excluded from results (already in context).
- Read-tier — no permission prompts. Secrets were redacted at JSONL-write time, so nothing sensitive resurfaces.
- Registered on the main agent only; sub-agents keep their lean toolset.
