# GUI **(v1.1; planning views v1.2)**

The browser GUI is a React and Vite app served by the local server [brief §Decided]. It is for **watching and stepping in. It does not do the work** [brief §The GUI].

The GUI is a pure client of the API. It sends Commands, reads queries, and derives state from the Event stream with the Engine's reducer [ADR-0007] [ADR-0022]. Nothing on screen moves a Task by itself: every move is a Command the Engine may reject. A rejection is shown inline with its `message` [brief §Principles] [ADR-0022].

**The GUI never offers** dragging cards between columns, typing into a running agent, or editing files. Take over and Open worktree cover hands-on work [brief §The GUI].

## Screens

| Screen | Purpose |
|---|---|
| **Board** | the active Phase, with the Awaiting-you panel and global controls |
| **Card drawer** | a side panel over the board for one Task |
| **History** | archived Phases, read-only and replayable |
| **Planning** (v1.2) | a Planning session thread |

Sources: [brief §The GUI] [ADR-0010].

## Board

- **Phase scope.** It shows only the active Phase, or the Phase `awaiting-merge` [brief §The GUI]. With no active Plan, it shows an empty state that offers **New plan** (v1.2), or the CLI command `segno plan submit <file>` (v1.1) [ADR-0030].
- **Header.** It shows the Plan title, the Phase title, the Phase branch name (mono), the Phase state, and the PR link once one is open [brief §Visual identity] [ADR-0023].

### Columns

| Column | Task states | Role dot | Source |
|---|---|---|---|
| Queued | `waiting`, `ready` | none | [ADR-0028] |
| Coding | `coding`, `taken-over` | Coder; **you** when taken over | [ADR-0028] |
| Testing | `testing` | Tests | [ADR-0028] |
| Review | `reviewing` | Reviewer | [ADR-0028] |
| Merge | `held`, `merging` | **you** when held; Tests during the merge re-test | [ADR-0028] |
| Blocked | `blocked` | **you** | [ADR-0028] |
| Done | `done` | none | [ADR-0028] |

- **Superseded Tasks** never appear on the board [ADR-0028].
- **Done collapses** after its five newest cards, with a control showing the hidden count that expands them [brief §The GUI].
- **Blocked styling.** The Blocked column uses `--blocked-bg` with a dashed outline in `--bad` [brief §Visual identity].

### Card

Each card shows [ADR-0028] [brief §The GUI] [brief §Visual identity]:

- the **Task id** (mono, `--accent`) and title
- the **Role dot and label** for whoever holds it, pulsing at `--pulse` while a Run is live
- **retry counters** as mono badges: `R n/2`, `T n/2`, and `I n/3` once any infra budget is used
- a **pause badge** when paused
- the **Block reason** badge in Blocked
- the **wait reason** in Queued: `needs <id>`, `waiting on blocked <id>`, `slots full`, `board paused`, `rate-limited until HH:MM`
- "queued to merge" in Merge when another Task is merging ([engine.md](engine.md#task-lifecycle))
- a **high-risk badge** listing the Risk flags

**Selection.** Selecting a card opens its drawer and marks the card with the accent selection style [brief §Visual identity].

**Card moves** animate between columns with `--ease-move` and `--dur-move` [brief §Visual identity].

### Global controls

| Control | Effect | Source |
|---|---|---|
| Pause all / Resume all | `board.pause` / `board.resume` | [brief §The GUI] |
| Model settings | per Role (planner, coder, coder-docs, reviewer): shows the effective model and its source; changing it sends `config.setModel`, which writes `config.local.json` only | [brief §The GUI] [ADR-0025] |
| Session meter | live agent Runs / `concurrency`, plus agent sessions started in this Phase | [ADR-0028] |
| Subscription usage | used / limit and reset time, **only** when the Adapter reports usage. Otherwise the last known reset time, or nothing. Never estimated | [ADR-0021] |
| Rate-limit banner | "Rate-limited until HH:MM" or "Rate-limited, next check HH:MM" while a Rate-limit pause is on | [ADR-0021] |
| Config warning | shown while a `config.rejected` is unresolved, with its errors | [ADR-0025] |
| Theme | system / light / dark, stored per browser | [ADR-0032] |
| History | opens History | [brief §The GUI] |

## Card drawer

Its header shows the Task id, title, state, Role dot, budgets, risk, and the actions available in the current state ([Card actions](#card-actions)). It has four tabs [brief §The GUI]:

| Tab | Content |
|---|---|
| **Diff** | the Task's diff (`/api/tasks/:id/diff`), with additions on `--diff-add` and deletions on `--diff-del`. Any diff line can take a **note**: the developer types text and submits `task.note`. The note then shows as an open blocking Finding on that line [brief §The GUI] [ADR-0015] |
| **Review** | every Verdict, newest first: decision, summary, the acceptance checklist (met or unmet, with notes), the docs check, Findings grouped by blocking or advisory and source, and raised risk. Malformed Verdicts are listed with their validation errors [ADR-0016] |
| **Tests** | every `tests`, `setup` and `merge` Run: exit code as a status badge, duration, and output in a terminal panel [brief §Visual identity] [ADR-0029] |
| **Transcript** | every agent Run for the Task: Role, model, outcome, and the transcript in a terminal panel. A live Run streams from `/api/runs/:id/stream`. Pruned Runs show "transcript pruned" [brief §The GUI] [ADR-0033] |

The drawer also shows the Task's current definition (description, acceptance, context hints) and, for replanned Tasks, earlier revisions [ADR-0015].

## Card actions

Each action is shown only in the states where the Engine allows it ([engine.md](engine.md#developer-commands-on-a-task)) [brief §The GUI] [ADR-0015]:

| Action | Command | Input required |
|---|---|---|
| Approve | `task.approve` | none |
| Send back | `task.sendBack` | notes (text) |
| Pause / Resume | `task.pause` / `task.resume` | none |
| Stop and retry | `task.stopRetry` | confirmation |
| Retry | `task.retry` | optional note |
| Replan | `task.replan` | a Task fragment (YAML text, validated before sending) |
| Split | `task.split` | a list of Task fragments (YAML text, validated before sending) |
| Force-approve | `task.forceApprove` | reason (text), which is required; submit is disabled while it's blank |
| Take over / Hand back | `task.takeOver` / `task.handBack` | confirmation |
| Open worktree | none: the server runs the configured `editor` command on the worktree path | none |
| Ask Planner (v1.2) | `task.askPlanner`, then the advice is shown with **Apply** (`task.applyPlannerAdvice`) | optional question |

Typing in these inputs is allowed. Every one of them becomes a Command the Engine validates. None of them reaches a running agent [ADR-0010].

## Awaiting you

- **Location.** A panel beside the board, listing `/api/awaiting` items oldest first, with a count badge [brief §Where the developer steps in].
- **Actions.** Each item shows its kind, Task or Plan id, title and age, plus the actions that resolve it [ADR-0013] [ADR-0023]:
  - `plan-approval`: Approve / Send back / Abandon, with the full Plan readable
  - `merge-hold`: Approve / Send back / Take over
  - `blocked`: opens the drawer
  - `pr-ready` and `pr-manual`: the PR link or compare link, and Confirm merged for `pr-manual`
  - `pr-closed`: Reopen PR / Abandon plan
  - `planning-reply` (v1.2): opens Planning
- **Plan review.** A plan to approve renders every Phase and Task, with dependencies and Risk flags, before Approve is enabled [brief §Where the developer steps in].

## Notifications

These follow [ADR-0027].

- **Trigger.** A browser notification fires once for each **new** Awaiting-you item, keyed by the id (the creating Event's `seq`).
- **No notification** for items already present when the page loaded, or while the tab is visible and focused. A focused tab highlights the new item in the panel instead.
- **One per item across tabs.** Tabs coordinate through a `BroadcastChannel`, and the notification `tag` is the item id.
- **Permission** is requested only from an explicit **Enable notifications** control, never on load. If it's denied, the panel shows a quiet banner explaining how to re-enable it.
- **Content:** the item kind (e.g. "Blocked: review-limit"), the Task id and the title. Never code or Findings.
- **Click** focuses the tab and opens the item.
- **Without a notification:** the tab title shows the count (`(3) Segno`) and the favicon shows a dot.
- `notifications: false` in `config.local.json` turns notifications off.

## History

- **Archived Phases** from `/api/phases`, grouped by Plan (complete, abandoned and returned Plans included) [brief §The GUI] [ADR-0013].
- **Read-only.** No actions are offered [brief §The GUI].
- **Replay.** Loads `/api/phases/:id/events` and rebuilds the board with the shared reducer. A scrubber steps through Events, showing the board as it was at each `seq` [ADR-0007].

## Planning (v1.2)

This follows [ADR-0010].

- **New plan** opens a thread. The developer types a brief, which sends `planning.start`.
- **Replies.** Each Planner reply appears as a message. Suggested questions show inline with their recommendations, and the developer can always just type a free-form reply (`planning.reply`).
- **While the Planner is replying,** the text box is disabled, the thread shows "Planner is thinking…", and **Stop** (`planning.stop`) is available. The developer never types into a live Run.
- **Draft the plan now** sends `planning.draftNow`. A drafted Plan appears in Awaiting you as `plan-approval`. Sending it back adds a turn to the same thread.
- **Discard** (`planning.discard`) closes the session without a Plan.

## Connection state

- **Reconnecting.** If the event stream drops, a banner shows "Reconnecting…". The client reconnects with `Last-Event-ID`, so no Event is missed [ADR-0007].
- **Restarted server.** If the server restarted, the token changed and requests return `401`. The GUI then shows "Segno restarted. Run `segno open` to reconnect" [ADR-0008].

## Visual rules

The tokens are in [`../design-tokens.css`](../design-tokens.css). These rules are normative [brief §Visual identity]:

- **Typography:**
  - Bricolage Grotesque (600 and 800) for the wordmark and headings only.
  - IBM Plex Sans (400, 500 and 600) for interface text.
  - JetBrains Mono for task ids, branch names, counters, commands and logs.
  - All three are bundled with the GUI and never loaded from a CDN [ADR-0032].
- **Accent** marks primary buttons, the selected card and task ids, and nothing else.
- **Status colors** appear only on badges, Verdicts, exit codes and run-state pills.
- **Badges** are mono, 10.5px, semibold, on the matching `*-soft` tint.
- **Role colors** appear only as small dots and labels showing who holds a card. The dot pulses while a Run is live.
- **The Blocked column** has `--blocked-bg` with a dashed outline in `--bad`.
- **Transcripts and test output** render in terminal panels (`--term-*`) in both themes.
- **Controls** are at least `--control-h` (40px) tall.
- **Motion.** Card moves use `--ease-move` and `--dur-move`, and the dot pulse uses `--pulse`. **All** motion is off under `prefers-reduced-motion` [ADR-0032].
- **Theme.** Light and dark themes. With no stored choice, the theme follows `prefers-color-scheme`. A stored choice sets `data-theme` on `:root` [ADR-0032].
