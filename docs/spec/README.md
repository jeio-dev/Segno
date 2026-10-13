# Segno specification

This spec states Segno's behavior and contracts: schemas, state transitions, commands, events and error cases. It doesn't say how to build them.

## Sources and citations

Every rule traces to one of three sources, cited inline:

| Tag | Source |
|---|---|
| `[brief §Section]` | [`../product-brief.md`](../product-brief.md), the original product description and its "Decided" list |
| `[ADR-NNNN]` | [`../adr/`](../adr/), one file per design decision |
| `[glossary]` | [`../glossary.md`](../glossary.md), which defines every capitalized domain term used here |

If a rule seems to have no source, it's a spec bug. Fix the spec or add an ADR, never just the code.

## Areas

| File | Covers |
|---|---|
| [plan-format.md](plan-format.md) | The Plan file: Segno's public contract. YAML schema, validation, fragments for replan and split |
| [engine.md](engine.md) | Plan, Phase and Task lifecycles, budgets, the merge queue, the Watchdog, rate limits, Commands and the Event catalog |
| [store.md](store.md) | The Event log, the `.segno/` layout, worktrees, branches, retention, recovery |
| [runners.md](runners.md) | Adapters, the Claude Code Adapter, permission profiles, script Runs, Run context, timeouts |
| [api.md](api.md) | The local HTTP server: auth, the command endpoint, queries, SSE streams, error codes |
| [gui.md](gui.md) | The browser GUI: board, drawer, actions, Awaiting you, notifications, History, planning, visual rules |
| [cli.md](cli.md) | The `segno` command set, its output and exit codes |
| [config.md](config.md) | `segno.config.json` and `.segno/config.local.json` |
| [../design-tokens.css](../design-tokens.css) | The visual identity's design tokens |

## v1 cut line

v1 is **the headless core, with the CLI as its only interface** [ADR-0030]. It proves the contract (Plan file → Events → merged Phase PR) before any UI is built on it.

**In v1:**

- The Plan file format, `plan validate`, and the whole Plan lifecycle: submit, approve, send back, abandon, export ([plan-format.md](plan-format.md), [engine.md](engine.md)).
- The full Engine:
  - all 11 Task states and the Pause flag
  - review, test and infra budgets
  - Verdict validation and repair
  - the merge queue
  - the Watchdog
  - timeouts
  - Rate-limit pause
  - restart recovery
  - multiple Phases per Plan
- The Event log, the `.segno/` layout, worktrees outside the repo, the setup command and Run pruning ([store.md](store.md)).
- The Claude Code Adapter only, with per-Role allowlists ([runners.md](runners.md)).
- `concurrency` fixed at `1`: one Task at a time. Config rejects any other value in v1 ([config.md](config.md)).
- The server: the command endpoint, the query endpoints, both SSE streams and token auth ([api.md](api.md)).
- The full CLI, including `segno watch` with a terminal bell in place of browser notifications ([cli.md](cli.md)).
- The GitHub forge through `gh`: Phase PRs, merge detection, and the next Phase starting automatically.
- `segno init`.
- Built-in prompt templates, including the Docs task's.

## Explicitly out of v1

These ship in this order. Their specs are already written, and each section that covers one is marked **(v1.1)**, **(v1.2)** or **(later)**.

1. **v1.1, the board GUI** [ADR-0030]:
   - the board, card drawer and card actions
   - diff-line notes in the UI
   - Awaiting you in the browser and browser notifications
   - the History replay view
   - per-Role model settings in the UI
   - the theme toggle
   - `segno open`
2. **v1.2, planning inside Segno** [ADR-0030]: Planning sessions ("New plan") and Ask Planner on Blocked Tasks.
3. **Later** [ADR-0030]:
   - parallel Tasks (`concurrency` > 1)
   - Codex and OpenCode Adapters
   - overridable prompt templates
   - forges other than GitHub
   - OS-level notifications

Until then, the v1 server answers a v1.1 or v1.2 Command with `unsupported-in-version`, as described in [api.md](api.md).

## Never in scope

These come from [brief §What it is not] and [brief §The GUI]:

- a hosted service, IDE or chat app
- being tied to one AI provider
- deciding scope or settling audits, which stay with the developer
- dragging cards between columns
- typing into a running agent
- editing files in the GUI
