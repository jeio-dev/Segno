# Store

This covers where Segno keeps state on disk, and the guarantees about it.

## The Event log

- **Medium.** SQLite through better-sqlite3, one database per Project at `projects/<id>/segno.db` in the app data directory [brief §Decided] [ADR-0033] [ADR-0038].
- **Append-only.** Rows are never updated or deleted, and old Events are never migrated [brief §Decided] [ADR-0031].
- **Kept forever.** Events and Verdicts are never pruned [brief §Housekeeping].
- **The source of truth.** All board state is derived from it, so replaying it reproduces the board exactly [brief §User journey] [ADR-0007].

### Event record

| Column | Type | Rule |
|---|---|---|
| `seq` | integer | primary key, gap-free, strictly increasing from 1 |
| `type` | text | one of the types in the [Event catalog](engine.md#event-catalog) |
| `v` | integer | ≥ 1, the schema version of that type |
| `ts` | text | ISO-8601 UTC timestamp |
| `plan_id` | text, nullable | set on every Event that concerns a Plan, its Phases, Tasks or Runs |
| `task_id` | text, nullable | set on every Event that concerns one Task |
| `payload` | text (JSON) | the type's payload, as in the Event catalog |

Sources: [ADR-0031] [ADR-0007].

- All Events produced by one Command or Run outcome are appended in a single transaction [ADR-0022].
- Anything kept alongside the log to speed up reads must be rebuildable entirely from it. Deleting it loses no information [ADR-0007].
- An Event whose `type` or `v` the running Segno doesn't recognize stops startup with an error that names it, so the log is never silently misread [ADR-0031].

## App data directory

Segno keeps everything it stores under the app's data directory: `SEGNO_APP_DATA` when it's set, otherwise `${XDG_DATA_HOME:-~/.local/share}/Segno` on Linux and Electron's `appData` plus `Segno` on macOS. Nothing is stored in the repo except Segno's branches and commits, and the committed `segno.config.json` [ADR-0038] [ADR-0039] [ADR-0048].

```
<appData>/
  projects.json            the Project registry
  settings.json            app settings (see config.md)
  host.log                 Engine host diagnostics
  chromium/                Electron's own state, including the single-instance lock
  projects/<id>/
    segno.db               the Project's Event log
    local.json             per-Project local settings (see config.md)
    runs/<run-id>/
      prompt.md            exactly what the Run was given (agent Runs)
      transcript.jsonl     raw agent CLI output (agent Runs)
      output.log           combined stdout and stderr (tests, setup, merge, probe Runs)
      verdict.json         the Verdict exactly as received (Reviewer Runs), even if malformed
    tasks/<task-id>/
      merged.diff          the Task's final diff against the Phase branch, written when it reaches done
    worktrees/<task-id>/   Task worktrees, unless worktreeRoot is set
```

Sources: [ADR-0033] [ADR-0038] [ADR-0025] [ADR-0009] [ADR-0048].

- **The registry.** `projects.json` holds `{ id, name, path, addedAt }` for each Project. `id` is generated when the Project is added and never reused. `name` defaults to the folder name. The registry is app state, not an Event log, and only the app-level calls in [api.md](api.md#app-level-calls) change it, including `projects.rename` [ADR-0038] [ADR-0046].
- **One Project is one repo.** A folder whose git top-level is already registered can't be added again [ADR-0039].
- **Removing a Project** stops its Engine and unregisters it. Its `projects/<id>/` directory is deleted only when the developer chooses to [ADR-0038].
- `run-id` values are unique across the Project's history. Events refer to Run files by `run-id` only, never by absolute path [ADR-0033].

## Worktrees

- **Location.** `projects/<id>/worktrees/<task-id>/` in the app data directory, or `<worktreeRoot>/<id>/<task-id>/` when the Project's `worktreeRoot` local setting is set. They are never inside the repo [ADR-0009] [ADR-0038].
- **One per Task.** The worktree is on the Task branch `segno/<plan-slug>/<phase-id>--<task-id>` [brief §Decided] [ADR-0033].
- **Created** when the Task first leaves `ready` (or on take over, if it's missing), from the Phase branch tip. The setup command then runs ([runners.md](runners.md#script-runs)) [ADR-0029].
- **Deleted, together with its Task branch,** when the Task becomes `done` or `superseded`, or its Plan is abandoned [brief §Housekeeping] [ADR-0033].
- **Deleted and recreated** on replan [ADR-0015].
- **Never shared** between Tasks.

## Branches

| Branch | Name | Created | Deleted |
|---|---|---|---|
| Phase branch | `segno/<plan-slug>/<phase-id>` | Phase `starting` → `active`, from `<remote>/<baseBranch>` | never by Segno |
| Task branch | `segno/<plan-slug>/<phase-id>--<task-id>` | with the Task's worktree | with the Task's worktree |

Sources: [ADR-0033] [ADR-0029] [ADR-0013].

- The `--` separator keeps a Task branch from nesting under its Phase branch's ref [ADR-0033].
- The Phase branch only ever moves by fast-forward to a Task branch that has passed the merge re-test, or skipped it under the rule in [engine.md](engine.md#task-lifecycle) [ADR-0005].
- Segno never commits to, merges into or pushes `baseBranch` [brief §How it works].

## Retention

- **What gets pruned.** Run directories (`runs/<run-id>/`) older than `retention.runDays` (default 30). `0` means never [brief §Housekeeping] [ADR-0033].
- **When.** When the Project's Engine starts, every 24 h while it runs, and on `store.prune` (the Project's **Prune runs now** setting), where `olderThanDays` overrides the configured value for that call [ADR-0033] [ADR-0038].
- **Task diffs are never pruned.** `tasks/<task-id>/merged.diff` is kept forever, because diffs are kept for every Task, and the worktree and Task branch are gone once it's done [brief §Principles] [brief §Housekeeping].
- **Live Runs are never pruned.** A Run's age is measured from its `run.finished` timestamp [ADR-0033].
- **It's recorded.** Pruning appends `store.pruned { runIds }`. Every Verdict is already in its `verdict.recorded` Event, so pruning loses no Verdict [ADR-0033] [brief §Decided].
- **The GUI** shows "transcript pruned" for a pruned Run [ADR-0033].

## Recovery guarantees

- **Restarting at any point restores every Project's board exactly,** through replay [brief §User journey] [ADR-0038].
- **Crashes.** A crash between appending Events and acting on them (for example, starting a process) is recovered at startup. Any Run recorded as started without a `run.finished` is treated as `interrupted` [ADR-0020].
- **Stale git state.** Worktrees or branches left behind by an interrupted cleanup are deleted at startup if their Task is `done` or `superseded` [ADR-0033] [ADR-0020].
