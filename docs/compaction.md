# Compaction

Source: `src/core/compact.ts`; request-time hygiene `pruneOldToolResults` in `src/core/agent.ts`. Adopted from Hermes Agent's four-phase design.

Auto-compaction fires when the last request used more than 80% of the model's context window (`/compact` runs it manually). Four phases:

1. **Slim** — before the summary call, the head being folded has bulky tool outputs elided (400-char stub + size note), giant tool inputs replaced, long texts truncated, images swapped for `[image attached]` — the summarizer needs the shape of events, not file dumps.
2. **Token-budgeted tail** — the protected tail is chosen by walking back until ~15% of the context window (capped at 16k estimated tokens, 6-message floor) is spent, and never starts inside a tool-call/result pair.
3. **Structured summary** — fixed sections (Goal / Constraints & decisions / Done / In progress / Next steps), output budget 20% of folded content clamped to 1k–4k tokens.
4. **Iterative update** — on re-compaction, the existing summary (detected by its marker prefix) is fed back as "the running summary — merge into it, don't repeat it" and **updated**, not re-summarized. This is what prevents copy-of-a-copy decay across many compactions.

## Related
- `pruneOldToolResults` elides tool outputs >1500 chars outside the last 20 messages at request time — cheap hygiene that runs on every request, independent of compaction.
- Compaction runs on the **active** model, so it works during [provider failover](provider-failover.md).
- Lesson imported from Hermes: never inject mid-task "context is getting full" warnings — they measurably make models give up early. Compaction fires silently.
