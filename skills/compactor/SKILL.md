---
name: compactor
description: Session recall and compaction — use when earlier parts of this session are missing from context, or after a lossless compaction summary.
---

# Compactor

Compaction is automatic: when the context fills, older messages are replaced by a summary built from the full session transcript, and the work carries on. Keep working through it.

## After a compaction

The summary opens with the user's requests, then the latest state, decisions, files, project knowledge, commits, open errors and a ranked recent transcript. Continue the work it describes; do not redo work it says is done.

## Recall

The full session history is kept. Reach for `session_recall` (`mcp__lossless-compactor__session_recall`) whenever a detail is missing:

- `session_recall(query: "redis cache decision")` — plain keywords work best; a regex works too.
- `#123`-style refs in the summary are transcript lines: `session_recall(expand: [123])` returns the full content.
- `session_recall(query: "#123:src/cache.ts")` reads the file content of that tool call.
- `mode: "touched"` lists the files worked on; `scope: "all"` also covers rewound branches.
