---
status: accepted, amended by ADR-0038
---

# Storage layout, branch names and Run retention

`.segno/` holds `segno.db` (the Event log), `server.json` (lock and token), `config.local.json`, `server.log` and one `runs/<run-id>/` directory per Run (`prompt.md`, then `transcript.jsonl`, `output.log` or `verdict.json`). Worktrees live outside the repo (ADR-0009). Phase branches are `segno/<plan-slug>/<phase-id>` and Task branches are `segno/<plan-slug>/<phase-id>--<task-id>`, which avoids git's nested-ref conflict. A Task's branch and worktree are deleted when it is done or superseded. Run directories older than `retention.runDays` (30 by default, 0 meaning never) are pruned on start and daily after that. Verdicts are copied into their Events first, so pruning loses no Verdict.
