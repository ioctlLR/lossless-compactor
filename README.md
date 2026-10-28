# lossless-compactor

Zero-LLM compaction for Claude Code, ported from [`@pi-unipi/compactor`](https://github.com/Neuron-Mr-White/unipi/tree/main/packages/compactor).

When the context fills, Claude Code normally asks the model to write a summary. With local models that call is slow and lossy. This mod answers every main-conversation compaction itself: it rebuilds a budgeted summary from the full session transcript (never merging older summaries), keeps the most recent turns verbatim, and gives the model a `session_recall` tool over everything compaction removed.

## Install

At the prompt of a terminal session:

```
/plugin install lossless-compactor --marketplace ioctlLR/lossless-compactor
```

Answer `y` to add the marketplace, then pick a scope (user is first; press Enter).

From a shell:

```bash
claude plugin install lossless-compactor --marketplace ioctlLR/lossless-compactor
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `ioctlLR/lossless-compactor`, then Add plugin.

## What it does

- **`session.compact`**: auto, `/compact` and plugin compactions of the main conversation get the lossless summary plus the kept tail. Subagents keep Claude Code's own compaction. If anything fails, it falls back to Claude Code's own and says so in a toast.
- **Summary sections**: Your Requests, Latest State, Decisions & Constraints, Files, Lessons, Project Knowledge, Commits, Open Errors, Recent Transcript. Secrets are redacted from the summary; recall still finds them.
- **`session_recall`** tool: keyword/regex search over the full transcript, `expand` by transcript line (`#123`), `#123:path` drill-down, `mode: "touched"`.
- **`/compactor-stats`**: opens a pane with each compaction (before → after tokens, kept turns, sections, time) and recall usage. Nothing is shown until you open it.

## /compact arguments

- `keep:N` keeps the last N user turns (`keep:0` keeps none).
- `method:llm` uses Claude Code's own summarizer once; any other text becomes its focus.

## Settings (`/config`)

| Option | Default | What it does |
|---|---|---|
| `method` | `lossless` | `llm` hands every compaction to Claude Code's own summarizer. |
| `autoCompactWindow` | `0` | Sets Claude Code's `autoCompactWindow` (tokens); it compacts a buffer below this. `0` leaves Claude Code's own. |
| `summaryBudgetTokens` | `0` | Summary size; `0` is auto (1.5k–4k, at most 8% of the window). |
| `smartKeepTail` | `true` | Keeps more recent turns when the tail would be under 5k tokens (up to 25k). |
| `notify` | `true` | Toast after each automatic compaction. |

## How it reads history

The transcript file (`~/.claude/projects/<project>/<session>.jsonl`) is read incrementally with `tail -n +K`, so only new lines are parsed on each compaction or recall. User rows marked `origin.kind: "human"` are your requests; injected, meta and summary rows are skipped.
