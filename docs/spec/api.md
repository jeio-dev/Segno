# API

The Engine host protocol. The Engine host is one Electron `utilityProcess` that runs one Engine per Project [ADR-0037] [ADR-0038]. The app's window is a pure client of it: it talks to the host over Electron IPC (MessagePorts), through a preload bridge, and has no Node access of its own [ADR-0037]. Nothing listens on a network port [ADR-0037]. Every call is typed from the same zod schemas the host validates against [ADR-0022].

## Lifecycle

- **One host per app.** The app starts the Engine host at launch. It loads the Project registry ([store.md](store.md#app-data-directory)) and starts an Engine for every Project that can run, whichever Project the window shows ([gui.md](gui.md#projects)) [ADR-0038] [ADR-0040].
- **Single instance.** A second launch of the app focuses the existing window and exits, through Electron's single-instance lock [ADR-0037].
- **Host crash.** If the host process dies, the app restarts it once and the window resumes each Event stream from its last `seq`. A second death within 60 s shows an error with **Restart Engine** ([gui.md](gui.md#connection-state)) [ADR-0020] [ADR-0037].
- **Quit** shuts every Engine down as in [engine.md](engine.md#startup-recovery-and-shutdown) [ADR-0041].

## Calls

Every call is a request with one response, except the two streams. Calls that act on a Project take its `projectId` first. An unknown `projectId` gets the error `unknown-project`.

| Call | Purpose | Section |
|---|---|---|
| `command(projectId, command)` | send one Command to that Project's Engine | [Commands](#commands) |
| `query(projectId, name, params)` | read derived state | [Queries](#queries) |
| `subscribe(projectId, since?)` | the Project's Event stream | [Event stream](#event-stream) |
| `runOutput(projectId, runId)` | a Run's live output | [Live Run output](#live-run-output) |
| `openWorktree(projectId, taskId)` | open a Task's worktree in the developer's editor | [Local actions](#local-actions) |
| `projects.*`, `settings.*`, `cli.install` | app-level calls | [App-level calls](#app-level-calls) |

## Commands

`command(projectId, command)` carries one Command (the full list is in [engine.md](engine.md#commands)) [ADR-0022].

```ts
// accepted
{ ok: true, events: number[] }                      // seq of every Event appended
// rejected by the Engine (nothing appended)
{ ok: false, code: RejectionCode, message: string, errors?: ValidationError[] }
```

- A rejection is a normal result, not an error. The error `bad-request` is used only when the Command has no recognizable `type` [ADR-0022].
- `RejectionCode` values are listed in [engine.md](engine.md#rejection-codes). `errors` is present for `validation` and uses the shape in [plan-format.md](plan-format.md#validation). For `onboarding.confirm`, config errors use the shape in [config.md](config.md#validation) [ADR-0049].
- Commands are processed in arrival order, per Project (see [engine.md](engine.md#processing-model)).

## Queries

`query(projectId, name, params)` returns JSON [ADR-0022].

| `name` | Params | Returns |
|---|---|---|
| `board` | none | the active Plan and its active or awaiting-merge Phase: Phase state; Tasks with state, pause flag, budgets used, Block reason, wait reason, high-risk flag and current Run; merge-queue order; board and rate-limit pause state; session meter; usage, if reported. `null` Plan when none is active |
| `awaiting` | none | the Awaiting-you items: `{ id, kind, planId, phaseId?, taskId?, title, createdAt }[]`, oldest first |
| `task` | `{ taskId }` | the full Task: current definition and revisions, state history, Runs, Verdicts, Findings (open and closed), risk, budgets |
| `taskDiff` | `{ taskId }` | a unified diff of the Task branch against its merge-base with the Phase branch, plus the open diff-line Findings anchored to it. Once the worktree is deleted, the diff recorded at merge time |
| `run` | `{ runId }` | Run metadata (kind, Role, model, timing, outcome) |
| `runTranscript` | `{ runId }` | `transcript.jsonl` or `output.log` as stored, or the error `pruned` |
| `runPrompt` | `{ runId }` | `prompt.md`, or the error `pruned` |
| `plans` | none | every Plan in the Project with its state (History) |
| `plan` | `{ planId }` | the Plan as currently derived |
| `planExport` | `{ planId }` | the Plan as YAML text, in the export form of [plan-format.md](plan-format.md#export) |
| `phases` | none | archived Phases (History): `{ id, planId, title, state, prUrl?, startedAt, mergedAt? }[]` |
| `phaseEvents` | `{ phaseId }` | every Event belonging to that Phase, for replay |
| `config` | none | `{ effective, sources, rejected, committed, pending }`: the effective config with defaults filled (`null` while not onboarded); the source of every leaf (`file`, `local`, `default`), keyed by JSON pointer; the latest unresolved `config.rejected` as `{ seq, source, errors }`, or `null`; and whether `segno.config.json` is on `<remote>/<baseBranch>`, which shows the commit hint while `false` ([gui.md](gui.md#adding-a-project)) [ADR-0047]; and the pending config while not onboarded, otherwise `null` [ADR-0049] |
| `onboarding` | none | `{ state, runId?, proposal?, failure?, detected }`: `state` is `idle`, `running`, `proposed`, `failed` or `done`; the latest proposal with its evidence and flags, or the failure reason; and the detected settings that prefill Set up manually ([gui.md](gui.md#onboarding)) [ADR-0049] |

Unknown ids get the error `not-found`. Task ids are unique only within a Plan, so a `taskId` means the Task of the newest Plan that has it, which is the active Plan's while one is active [ADR-0052].

Sources: [ADR-0022] [ADR-0007] [ADR-0025] [ADR-0033] [ADR-0012] [ADR-0037] [ADR-0047] [ADR-0049] [ADR-0052] [brief §The GUI].

## Local actions

`openWorktree(projectId, taskId)` runs the `editor` app setting ([config.md](config.md#app-settings)), with `{path}` replaced by the worktree path. It isn't a Command and writes no Event [ADR-0015] [ADR-0025]. It returns nothing, or the error `no-worktree`, or `no-editor` when `editor` is unset.

## Event stream

`subscribe(projectId, since?)` streams one Project's Event log [ADR-0007] [ADR-0037].

- Every appended Event is delivered as `{ seq, type, v, ts, payload }`.
- With `since`, the stream first delivers every Event after that `seq`, in order, then the live tail, with no gaps or duplicates.
- Without it, the stream starts with the live tail only. Clients load state from the `board` query or by replay, then subscribe with `since`.
- Clients derive state with the Engine's reducer, from the shared package [ADR-0007].

## Live Run output

`runOutput(projectId, runId)` streams one Run's output [ADR-0007].

- While the Run is live, its `output` text and script output lines are delivered as `{ kind: "output", text }`. When it ends, `{ kind: "end", outcome }` is delivered and the stream closes.
- For a finished Run, the stream delivers `end` immediately. Clients read the stored transcript instead.
- This output is never written to the Event log.

## App-level calls

These act on the app, not on one Project's Engine, and write no Event [ADR-0038] [ADR-0039] [ADR-0042] [ADR-0046] [ADR-0049].

| Call | Behavior |
|---|---|
| `projects.list()` | every Project: `{ id, name, path, status, awaitingCount }[]`, where `status` is `running`, `not-onboarded` (its Engine is running, [gui.md](gui.md#onboarding)) [ADR-0049], or `unavailable` with `awaitingCount: 0`, a `reason`, a human-readable `message`, and `errors` (every config error) for `invalid-config`. `reason` is the first failing check, in this order: `missing-folder`, `not-a-repo`, `invalid-config`, `unreadable-log`. When `segno.config.json` is missing, the Event log is read first: `unreadable-log` if it can't be replayed, otherwise `not-onboarded` if it has no `plan.submitted`, otherwise `invalid-config` with `missing-file` ([gui.md](gui.md#projects)) [ADR-0047] [ADR-0049] |
| `projects.inspect(path)` | checks the folder and returns the add-project proposal: the existing `segno.config.json` with its validation result, or the default model per agent Role ([gui.md](gui.md#adding-a-project)) [ADR-0049]. It also reports whether `gh` is missing or logged out. The error `not-a-repo`, `no-remote` or `already-added` when the folder can't be a Project |
| `projects.add(path, models?)` | registers the Project. When `segno.config.json` doesn't exist, `models` (`{ planner, coder, reviewer }`, each a non-empty string) becomes the Project's pending config ([config.md](config.md#pending-config)) and the Project is `not-onboarded`. An existing file is never touched, and `models` is then ignored. Returns `{ id }` and starts its Engine [ADR-0049] |
| `projects.remove(id, { deleteData })` | stops its Engine and unregisters it. With `deleteData`, its directory under the app data directory is deleted too. The repo is never touched |
| `projects.locate(id, path)` | points an `unavailable` Project at its moved folder. The error `not-a-repo` when the folder isn't one |
| `projects.rename(id, name)` | sets the Project's name to the trimmed `name`. A blank name is `bad-request`. Names need not be unique [ADR-0046] |
| `settings.get()` / `settings.set(changes)` | the app settings ([config.md](config.md#app-settings)) |
| `cli.install()` | writes the `segno` launcher onto PATH ([cli.md](cli.md#installing)). Returns the path it wrote, or the error `install-failed` with the reason |

## Error format

Every error is `{ code: string, message: string }` [ADR-0022].

| `code` | When |
|---|---|
| `bad-request` | a call or Command that doesn't match its schema well enough to route |
| `unknown-project` | the `projectId` isn't registered, or its Project is `unavailable` |
| `not-found` | an unknown task, run, plan or phase id |
| `no-worktree`, `no-editor` | `openWorktree` can't run |
| `pruned` | the Run's files were pruned |
| `not-a-repo`, `no-remote`, `already-added` | `projects.inspect`, `projects.add` or `projects.locate` refused the folder |
| `install-failed` | `cli.install` couldn't write the link |
| `internal` | anything else. The details go to the host log ([store.md](store.md#app-data-directory)), never to the client |
