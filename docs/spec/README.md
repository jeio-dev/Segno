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
| [store.md](store.md) | The app data directory, the Project registry, the Event log, worktrees, branches, retention, recovery |
| [runners.md](runners.md) | Adapters, the Claude Code Adapter, permission profiles, script Runs, Run context, timeouts |
| [api.md](api.md) | The Engine host protocol over IPC: Commands, queries, the Event stream, app-level calls, error codes |
| [gui.md](gui.md) | The desktop app: Projects, board, drawer, actions, Awaiting you, tray and notifications, History, planning, visual rules |
| [cli.md](cli.md) | The `segno` command (`plan validate`), its output and exit codes |
| [config.md](config.md) | `segno.config.json`, per-Project local settings and app settings |
| [../design-tokens.css](../design-tokens.css) | The visual identity's design tokens |

## v1 cut line

v1 is **the desktop app** on Linux and macOS [ADR-0042] [ADR-0037]. On Windows it runs through WSLg.

**In v1:**

- The Plan file format and the whole Plan lifecycle: submit, approve, send back, abandon, export ([plan-format.md](plan-format.md), [engine.md](engine.md)).
- The full Engine:
  - all 11 Task states and the Pause flag
  - review, test and infra budgets
  - Verdict validation and repair
  - the merge queue
  - the Watchdog
  - timeouts
  - Rate-limit pause, shared by every Project [ADR-0040]
  - restart recovery
  - multiple Phases per Plan
- Many Projects in one app, each running independently with `concurrency` fixed at `1`. Config rejects any other value in v1 ([config.md](config.md)) [ADR-0038] [ADR-0040].
- Adding a Project with only a model per agent Role, then onboarding it: a Planner Run proposes a verified `segno.config.json` that the developer confirms, or the developer sets it up by hand [ADR-0039] [ADR-0049].
- The app data directory, worktrees outside the repo, the setup command and Run pruning ([store.md](store.md)).
- The Claude Code Adapter only, with per-Role allowlists ([runners.md](runners.md)).
- The Engine host and its IPC protocol ([api.md](api.md)) [ADR-0037].
- The GUI: board, card drawer and card actions, diff-line notes, Awaiting you, History replay, per-Role model settings, the theme toggle, the tray and native notifications ([gui.md](gui.md)) [ADR-0041].
- The GitHub forge through `gh`: Phase PRs, merge detection, and the next Phase starting automatically.
- `segno plan validate`, bundled in the app with an install-to-PATH action ([cli.md](cli.md)) [ADR-0042].
- Built-in prompt templates, including the Docs task's.
- Signed GitHub Releases with auto-update [ADR-0043].

## Explicitly out of v1

These ship in this order. Their specs are already written where noted, and each section that covers one is marked **(v1.2)** or **(later)**.

1. **v1.2, planning inside Segno** [ADR-0030] [ADR-0042]: Planning sessions ("New plan") and Ask Planner on Blocked Tasks.
2. **Later** [ADR-0030] [ADR-0042]:
   - parallel Tasks (`concurrency` > 1)
   - Codex and OpenCode Adapters
   - overridable prompt templates
   - forges other than GitHub
   - a native Windows build
   - a `segno` CLI that scripts the running app
   - an embedded terminal for take-over

Until then, the Engine answers a v1.2 Command with `unsupported-in-version`, as described in [api.md](api.md).

## Never in scope

These come from [brief §What it is not] and [brief §The GUI]:

- a hosted service, IDE or chat app (Segno orchestrates; coding happens in the developer's own editor and terminal)
- being tied to one AI provider
- deciding scope or settling audits, which stay with the developer
- dragging cards between columns
- typing into a running agent
- editing files in the GUI
