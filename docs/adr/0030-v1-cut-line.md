---
status: superseded by ADR-0042
---

# v1 is the headless core with the CLI as its only interface

v1 includes:

- the Plan file format and lifecycle
- the full Engine (task states, budgets, Verdicts, merge queue, Watchdog, timeouts, rate-limit pause, restart recovery)
- the store, worktrees and pruning
- the Claude Code Adapter with allowlists
- the server API with SSE and token auth
- the full CLI
- GitHub Phase PRs over multiple Phases
- `segno init`

Concurrency is fixed at 1 in v1. After v1:

- v1.1 adds the board GUI: board, drawer, actions, notifications, History and model settings.
- v1.2 adds planning inside Segno: Planning sessions and Ask Planner.
- Later: parallel Tasks, Codex and OpenCode Adapters, overridable prompts, other forges and OS notifications.

Proving the contract (Plan file → Events → merged PR) before building UI on it means the GUI arrives as a pure client of an API that already exists.
