# Sessions

Source: `src/session/store.ts`.

One JSONL file per session per project directory (under the aerin data dir, keyed by a hash of the cwd): a meta header line, then one message per line, append-only during a run. A torn final line from a crash is dropped on load.

## Usage
- `aerin --continue` resumes the latest session; `--resume <id>` a specific one; `/resume` opens a picker that replays the conversation.
- Sessions get a human title from the first prompt.
- `/clear` starts fresh (and resets the cost meter); compaction rewrites the file with the compacted history.

## Notes
- Key-shaped strings are redacted before anything lands on disk (`redactSecrets`) — `cat .env` output never persists.
- Reasoning ("thinking") parts are streamed to the UI but stripped before storage; replaying them breaks strict providers.
- Messages are JSON-sanitized to survive strict provider validation and the JSONL format.
- The stored files double as the corpus for [session search](session-search.md).
