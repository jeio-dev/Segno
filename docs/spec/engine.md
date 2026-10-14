# Engine

The Engine is the only component that decides state changes, and the only writer of the Event log [brief §Decided] [glossary]. Each Project has its own Engine and Event log, all run by one Engine host ([api.md](api.md)) [ADR-0037] [ADR-0038]. The GUI and agent output never move a Task. They send Commands or produce Run outcomes, and the Engine either validates each one into Events or rejects it [brief §Principles].

## Processing model

- Commands and Run outcomes are processed **one at a time, in arrival order**. Each is handled atomically: either all of its Events are appended in one transaction, or nothing is [brief §Decided] [ADR-0022].
- A rejected Command appends **no** Event and returns a rejection code ([Rejection codes](#rejection-codes)) [ADR-0022].
- All state (Plans, Phases, Tasks, Runs, Awaiting you, pause state) is derived by a pure reducer over the Event log. The Engine, GUI and History replay share one reducer [ADR-0007].
- Run outcomes are internal inputs. Agents and scripts can't send Commands [brief §Principles].

## Plan lifecycle

States: `awaiting-approval`, `active`, `complete`, `returned`, `abandoned` [ADR-0013].

| From | Trigger | To | Effects |
|---|---|---|---|
| none | `plan.submit` with a valid file and no Plan `awaiting-approval` or `active` | `awaiting-approval` | Plan recorded in full. Awaiting-you item `plan-approval` |
| none | `plan.submit` while another Plan is `awaiting-approval` or `active` | rejected `plan-exists` | none |
| none | `plan.submit` with an invalid file | rejected `validation` | none |
| `awaiting-approval` | `plan.approve` | `active` | first Phase starts ([Phase lifecycle](#phase-lifecycle)) |
| `awaiting-approval` | `plan.sendBack` (notes required) | `returned` (terminal) | notes stored and shown. From v1.2, a Plan drafted in a Planning session instead returns to that session as a new turn [ADR-0010] |
| `active` | last Phase `merged` | `complete` (terminal) | archived to History |
| `active` or `awaiting-approval` | `plan.abandon` (reason required) | `abandoned` (terminal) | all live Runs stopped. Every non-`done` Task → `superseded`, and its worktree and Task branch are deleted. Phase branches are kept. Segno never closes a PR [ADR-0013] |

The **plan slug** comes from `title`: lower-cased, with each run of characters outside `[a-z0-9]` replaced by `-`, truncated to 40 characters, and stripped of any leading or trailing `-`. An empty result uses `plan` [ADR-0045]. If a slug is already taken by any Plan in this Project's Event log, or by a local branch `segno/<slug>/*` or remote-tracking ref `<remote>/segno/<slug>/*` in the repo, `-2`, `-3`, … is appended [ADR-0033] [ADR-0053].

## Phase lifecycle

States: `pending`, `starting`, `active`, `awaiting-merge`, `merged`, plus `abandoned` when its Plan is abandoned [ADR-0001] [ADR-0023] [ADR-0029].

| From | Trigger | To | Effects |
|---|---|---|---|
| `pending` | it's the first Phase and the Plan is approved, or the previous Phase is `merged` | `starting` | the Engine fetches `<remote>` |
| `starting` | fetch succeeds | `active` | Phase branch `segno/<plan-slug>/<phase-id>` cut from `<remote>/<baseBranch>`. Its Docs task is added. Tasks with no unfinished dependencies → `ready`, all others → `waiting` |
| `starting` | fetch fails | `starting` | `phase.startDeferred` with reason `remote-unreachable` and `nextAttemptAt` = now + 5 min. Retried at that time. The local branch is never used as a fallback [ADR-0029] |
| `active` | every non-superseded Task is `done` | `awaiting-merge` | Phase branch pushed to `<remote>`, Phase PR opened ([Phase PR](#phase-pr)). Awaiting-you item `pr-ready` |
| `awaiting-merge` | forge reports `MERGED`, or `phase.confirmMerged` | `merged` | next Phase → `starting`, or Plan → `complete` |
| `awaiting-merge` | forge reports `CLOSED` without a merge | `awaiting-merge` | Awaiting-you item `pr-closed`, offering `phase.reopenPr` or `plan.abandon` [ADR-0023] |

The board shows only the `active` or `awaiting-merge` Phase. Earlier Phases go to History [brief §The GUI].

### Phase PR

The Phase PR targets `baseBranch` from the Phase branch [brief §How it works] [ADR-0023]. Its body is generated from the Event log [ADR-0023] and includes:

- the Plan title and summary, and the Phase title
- every `done` Task: id, title and the summary of its final Verdict
- Risk flags, and who approved each Merge hold
- every Force-approve reason
- advisory Findings
- totals of rejected reviews, failed test runs and infra failures

If the forge adapter can't open the PR because `gh` is missing or not logged in, the branch is still pushed. The Awaiting-you item becomes `pr-manual`, with a compare URL, and merge detection falls back to `phase.confirmMerged` [ADR-0023].

**Merge detection** polls the PR state every 60 s while the Phase is `awaiting-merge`. It goes by the forge's PR state, not git ancestry, so squash and rebase merges are recognized [ADR-0023].

## Task lifecycle

States: `waiting`, `ready`, `coding`, `testing`, `reviewing`, `held`, `merging`, `done`, `blocked`, `taken-over`, `superseded` [ADR-0014].

Separate from the state are:

- the **pause** flag
- three **budgets** (review 2, test 2, infra 3)
- a **high-risk** marker
- a **revision** number, raised by each replan
- a list of open blocking **Findings**

### Automatic transitions

| From | Condition or Run outcome | To | Budget |
|---|---|---|---|
| `waiting` | every `dependsOn` Task is `done` | `ready` | none |
| `ready` | a run slot is free, the Task isn't paused, and its Adapter isn't rate-limit-paused | `coding` | none. The worktree is created and the setup Run done first if needed (see [store.md](store.md)) |
| `coding` | Coder Run `completed` | `testing` | none. Anything uncommitted is committed first [ADR-0029] |
| `testing` | test Run exit code 0 | `reviewing` | none |
| `testing` | test Run exit ≠ 0, or test timeout | `coding` with the log tail attached, or `blocked` `test-limit` | test +1 [ADR-0019] |
| `reviewing` | valid Verdict `approve`, Task not high-risk | `merging` | none |
| `reviewing` | valid Verdict `approve`, Task high-risk (including a risk raised in this Verdict) | `held` | none. Awaiting-you item `merge-hold` |
| `reviewing` | valid Verdict `reject` | `coding` with its blocking Findings, or `blocked` `review-limit` | review +1 |
| `reviewing` | malformed Verdict | `reviewing` (repair Run), or `blocked` `verdict-invalid` | infra +1 [ADR-0016] |
| `merging` | clean merge and the merge re-test passes, or the re-test is skipped | `done` | none. Phase branch fast-forwarded. Task branch and worktree deleted [ADR-0005] [ADR-0033] |
| `merging` | clean merge but the re-test fails | `coding` with the log tail, or `blocked` `test-limit` | test +1 [ADR-0005] |
| `merging` | merge conflict | `coding` with the conflicting files listed. The merge is left in progress in the worktree | none [ADR-0005] |
| `coding` / `testing` / `reviewing` / `merging` | infra failure ([Infra failures](#infra-failures)) | same state, step rerun after backoff, or `blocked` `infra-limit` / `setup-failed` | infra +1 [ADR-0019] |

**Budget rule.** A budget is exhausted when its count reaches its cap: the **2nd** rejected review, the **2nd** failed test run or the **3rd** infra failure blocks the Task [brief §How it works] [ADR-0019]. Caps can't be configured [ADR-0019].

**Merge queue.** Only one Task is in the merge step at any moment. Others that reach `merging` wait in arrival order, and their cards show "queued to merge" [ADR-0005] [glossary]. A merge re-test is skipped when the Phase branch hasn't moved since the Task branch was cut [ADR-0005].

**Scheduling.** When several Tasks are `ready`, they start in Plan file order: Phase order, then Task order, with split Tasks taking the position of the Task they replaced. A Docs task always comes last [ADR-0030] [ADR-0011]. In v1 there is one slot [ADR-0030]. A Task holds its slot from `coding` through `testing`, `reviewing` and `merging`, and releases it when it becomes `done`, `held`, `blocked`, `taken-over` or `superseded` [ADR-0051].

**Ordering of steps.** Code → Tests → Review [ADR-0003]. A rejected review is followed by Code → Tests → Review again.

### Developer Commands on a Task

| Command | Allowed from | To | Budget and notes | Source |
|---|---|---|---|---|
| `task.approve` | `held` | `merging` | none | [ADR-0015] |
| `task.sendBack` (notes required) | `held` | `coding` | none. Notes become a blocking developer Finding | [ADR-0015] |
| `task.note` (file, line, text) | any state except `waiting`, `ready`, `superseded`, once at least one Coder Run has completed | unchanged | adds a blocking Finding with `source: developer` | [ADR-0015] [brief §The GUI] |
| `task.pause` / `task.resume` | any non-terminal state | unchanged | sets or clears the pause flag. Pausing stops the live Run, which is recorded `stopped`. Resuming reruns that step from the start | [ADR-0014] |
| `task.stopRetry` | `coding`, `testing`, `reviewing`, `merging` | unchanged | stops the live Run and reruns the step from the start. No budget used | [ADR-0015] |
| `task.takeOver` | any state except `waiting`, `done`, `superseded` | `taken-over` | stops any live Run. The worktree is kept, and created if missing | [ADR-0015] |
| `task.handBack` | `taken-over` | `testing` | uncommitted changes are committed as `developer changes`. Budgets unchanged | [ADR-0014] [ADR-0015] |
| `task.retry` (note optional) | `blocked` | `coding` after `review-limit` or `test-limit`. Otherwise the failed step reruns | resets **only** the exhausted budget. The note becomes a blocking developer Finding | [ADR-0015] |
| `task.replan` (fragment) | `blocked` | `ready` | new revision. **All** budgets reset. The worktree and Task branch are deleted and recreated from the current Phase branch tip on start | [ADR-0015] |
| `task.split` (fragment) | `blocked` | original → `superseded`. New Tasks → `waiting` or `ready` | dependents re-pointed at all new Tasks. The original's worktree is deleted | [ADR-0015] |
| `task.forceApprove` (reason required) | `blocked` with `review-limit` or `verdict-invalid`, or `reviewing` | `merging` (skipping `held`) | the reason is recorded and appears in the Phase PR. The merge re-test still applies. If it fails, the Task is `blocked` `test-limit` | [ADR-0015] |

Open worktree isn't a Command. It writes no Event [ADR-0015].

### Blocked Tasks and their dependents

- **Block reasons:** `review-limit`, `test-limit`, `infra-limit`, `verdict-invalid`, `setup-failed` [glossary] [ADR-0015].
- A Task that depends on a Blocked Task stays `waiting`. Its card says "waiting on blocked `<id>`" [ADR-0020].
- Every entry into `blocked` creates an Awaiting-you item `blocked` [brief §Where the developer steps in].

### Findings

- A Finding is `{ id, source: reviewer | developer, severity: blocking | advisory, file?, line?, body, createdInRun? }` [ADR-0016] [glossary].
- Developer Findings are always `blocking` [ADR-0016].
- Blocking Findings stay **open** until the next Verdict on that Task. A valid Verdict closes every Finding that was open before it, and opens its own [ADR-0016] [ADR-0024].

## Verdict handling

The Verdict schema is defined in [runners.md](runners.md#verdict-schema) [ADR-0016]. The Engine itself checks it for consistency [ADR-0016]:

| Check | Malformed if… |
|---|---|
| presence | no Verdict was produced |
| parse | not JSON |
| schema | it fails the Verdict JSON Schema |
| coverage | `acceptance` doesn't have exactly one entry per criterion index |
| approve consistency | `decision: approve` with any `met: false`, `docs.needed && !docs.satisfied`, or any `blocking` Finding |
| reject consistency | `decision: reject` with no `blocking` Finding and no `met: false` |

A malformed Verdict uses 1 infra budget and causes a **repair**. If the Adapter has `resume`, the same session gets one follow-up containing the validation errors. Otherwise a fresh Reviewer Run starts. A malformed Verdict is never treated as either approve or reject [ADR-0016].

A Verdict's `risk[]` entries are stored on the Task and make it high-risk from then on. Nothing can clear them [ADR-0011] [ADR-0016].

## Infra failures

An infra failure is any of these [brief §Principles] [ADR-0019] [ADR-0016] [ADR-0029]:

- a Run outcome `crashed` or `failed`
- a wall-clock or idle timeout of an **agent** Run
- the Watchdog finding a dead process
- a malformed Verdict
- a failed setup Run
- a git operation that fails without a conflict

Each one uses 1 infra budget, and the step reruns after a backoff of **30 s, 2 min, then 5 min** [ADR-0019]. When the budget is exhausted, the Block reason is `verdict-invalid` if the last failure was a malformed Verdict, `setup-failed` if it was the setup Run, and `infra-limit` otherwise [ADR-0016] [ADR-0029].

Interruptions (restart, pause, stop and retry, a Rate-limit pause) are **not** infra failures and use no budget [ADR-0014] [ADR-0020] [ADR-0021].

## Pause, pause all and rate limits

- **`board.pause`** sets the pause flag on every non-terminal Task, and **`board.resume`** clears it everywhere. Tasks the developer paused individually stay paused [ADR-0014] [brief §The GUI].
- **Rate-limit pause** [ADR-0021]:
  - The pause is shared by every Project, because agent subscriptions belong to the developer, not the repo [ADR-0040].
  - When a Run outcome is `rate-limited`, every Project's Engine stops its live agent Runs of **that Adapter** (recorded `interrupted`) and records `ratelimit.paused { adapter, resetAt?, nextCheckAt }` in its own Event log.
  - Test, setup and merge Runs continue.
  - It lifts at `resetAt + 60 s`. Without a `resetAt`, the Project whose Run hit the limit starts a minimal probe Run after 5, 15 and 30 minutes, then every 60. A probe that isn't rate-limited lifts the pause, and one that is schedules the next check.
  - Lifting records `ratelimit.lifted { adapter }` in every Project's Event log and reruns each interrupted step. No budget is used.
  - A Project whose Engine starts while a pause is on records it in its own log, with the shared `resetAt` and `nextCheckAt`.

## Watchdog

Every 30 s, and once after startup recovery, the Watchdog checks each non-terminal Task in the active Phase [ADR-0020] [glossary]:

| State | Invariant | Correction when violated |
|---|---|---|
| `coding`, `testing`, `reviewing`, `merging` (not paused) | a Run is live with a live process, or that Run's outcome is being processed | treated as a crash: infra failure |
| `ready` (not paused) | no slot is free, or the board or Adapter is paused, or the Task is behind others in scheduling order | Task started |
| `waiting` | at least one dependency isn't `done` | → `ready` |
| `held`, `blocked` | an Awaiting-you item exists | item recreated |
| `taken-over` | none (the developer owns it) | none |

Each correction records `watchdog.corrected { taskId, violation, action }` [ADR-0020].

## Startup recovery and shutdown

- **Startup** [ADR-0020]:
  - The reducer replays the Event log.
  - Every Run that was live becomes `interrupted` and its leftover process is killed.
  - Each interrupted step reruns with no budget used. Coder Runs resume their agent session if the Adapter has `resume`, prefixed with a notice to check the worktree and continue. Otherwise they start fresh on the same worktree.
  - Due timers (backoffs, deferred Phase starts, rate-limit lifts) fire immediately when already past.
- **Startup** happens when the app launches, and for one Project when it's added or located ([api.md](api.md#app-level-calls)) [ADR-0038].
- **Shutdown.** Quitting the app, or SIGINT or SIGTERM, stops live Runs in every Project, records them as `interrupted`, flushes, and exits. Closing the window is not a shutdown [ADR-0020] [ADR-0041].

## Onboarding

This follows [ADR-0049].

- **When a Project is not onboarded:** its repo has no `segno.config.json` and its Event log has no `plan.submitted`. Telling this apart from `missing-file` needs the log, so a missing file is classified only after the log has been replayed, in the order in [api.md](api.md#app-level-calls). The Engine runs with the pending config ([config.md](config.md#pending-config)). It accepts only the `onboarding.*` Commands, `store.prune` and `config.setModel`, and rejects every other Command `not-onboarded`.
- **`onboarding.start`** starts one `onboarding` Run as the Planner ([runners.md](runners.md#run-kinds)). The Run uses:
  - the pending config's Planner model
  - a scratch worktree, detached at the detected base branch's remote-tracking ref
  - the run slot, like any agent Run

  It's rejected `invalid-transition` while an onboarding Run is live or a proposal awaits confirmation.
- **The Run ends in exactly one of these Events:**
  - **`onboarding.proposed`** carries a valid proposal ([runners.md](runners.md#onboarding-proposal)) and creates `onboarding-review`.
  - **`onboarding.failed`** records a `reason`:
    - `unable`: the agent said it can't onboard, with its explanation
    - `invalid-proposal`: the output is missing or fails the schema or config validation, with the errors
    - `crashed`, `timeout` or `hung`

    Onboarding has no budget, and `onboarding.start` retries.
- **The scratch worktree** is deleted when the Run ends, whatever the outcome.
- **`onboarding.stop`** stops the live Run. It's recorded as `run.finished { outcome: stopped }` and `onboarding.stopped`.
- **Restarts and rate limits.** An interrupted onboarding Run reruns on startup, as any interrupted step does. A rate-limited one waits under the rate-limit pause. Neither records a failure.
- **`onboarding.confirm { config }`** validates `config`, overlaid with the pending config's models, exactly as `segno.config.json` is validated ([config.md](config.md#validation)). A failure is rejected `validation`, with the config errors. On success:
  1. The Engine writes `segno.config.json`, without committing it, and deletes the pending config. The host owns every config file, so the Engine writes through the config store the host gives it, as `config.setModel` does.
  2. The Engine records `onboarding.confirmed { via: proposal | manual }`, where `proposal` means an `onboarding-review` was open, and resolves it.
  3. The host loads the new effective config, and the Project becomes `running` without its Engine restarting.

  It's rejected `invalid-transition` while an onboarding Run is live, or when the Project is already onboarded.
- **A config that appears by itself** (for example a teammate's commit is pulled) onboards the Project. The Engine records `onboarding.confirmed { via: file }`, deletes the pending config through the config store and withdraws any open `onboarding-review`. Before B8's config watching, this is noticed when the Engine starts.

## Awaiting you

The Awaiting-you queue is derived state. Its item kinds are [brief §Where the developer steps in] [ADR-0023] [ADR-0010] [ADR-0049]:

| Kind | Created by | Resolved by |
|---|---|---|
| `onboarding-review` | `onboarding.proposed` | `onboarding.confirm`, `onboarding.start`, `onboarding.confirmed { via: file }` [ADR-0049] |
| `plan-approval` | `plan.submitted` | `plan.approve`, `plan.sendBack`, `plan.abandon` |
| `merge-hold` | approve on a high-risk Task | `task.approve`, `task.sendBack`, `task.takeOver` |
| `blocked` | any transition into `blocked` | leaving `blocked` |
| `pr-ready` | Phase PR opened | Phase `merged` |
| `pr-manual` | push succeeded but the PR couldn't be opened | `phase.confirmMerged` |
| `pr-closed` | PR closed without merging | `phase.reopenPr`, `plan.abandon` |
| `planning-reply` **(v1.2)** | a Planner turn finished in a Planning session | `planning.reply`, `planning.draftNow`, `planning.discard` |

Each item's id is the `seq` of the Event that created it. Notifications key on the Project and that id [ADR-0041].

## Commands

Every Command is `{ type, ...payload }`, sent to one Project's Engine. It's validated by zod at the host boundary and again by the Engine for state [ADR-0022] [ADR-0037].

| `type` | Payload | Version |
|---|---|---|
| `onboarding.start` / `onboarding.stop` | `{}` | v1 |
| `onboarding.confirm` | `{ config: object }` (a `segno.config.json` without `roles.<role>.model`, which come from the pending config) | v1 |
| `plan.submit` | `{ yaml: string, sourcePath?: string }` | v1 |
| `plan.approve` | `{ planId }` | v1 |
| `plan.sendBack` | `{ planId, notes: string≥1 }` | v1 |
| `plan.abandon` | `{ planId, reason: string≥1 }` | v1 |
| `phase.confirmMerged` | `{ phaseId }` | v1 |
| `phase.reopenPr` | `{ phaseId }` | v1 |
| `task.approve` | `{ taskId }` | v1 |
| `task.sendBack` | `{ taskId, notes: string≥1 }` | v1 |
| `task.note` | `{ taskId, file, line: int≥1, text: string≥1 }` | v1 |
| `task.pause` / `task.resume` | `{ taskId }` | v1 |
| `task.stopRetry` | `{ taskId }` | v1 |
| `task.takeOver` / `task.handBack` | `{ taskId }` | v1 |
| `task.retry` | `{ taskId, note?: string }` | v1 |
| `task.replan` | `{ taskId, yaml: string }` | v1 |
| `task.split` | `{ taskId, yaml: string }` | v1 |
| `task.forceApprove` | `{ taskId, reason: string≥1 }` | v1 |
| `board.pause` / `board.resume` | `{}` | v1 |
| `config.setModel` | `{ role: planner \| coder \| coder-docs \| reviewer, model: string≥1 }` | v1 |
| `store.prune` | `{ olderThanDays?: int≥0 }` | v1 |
| `planning.start` | `{ brief: string≥1 }` | v1.2 |
| `planning.reply` | `{ sessionId, text: string≥1 }` | v1.2 |
| `planning.draftNow` | `{ sessionId }` | v1.2 |
| `planning.stop` | `{ sessionId }` | v1.2 |
| `planning.discard` | `{ sessionId }` | v1.2 |
| `task.askPlanner` | `{ taskId, text?: string }` | v1.2 |
| `task.applyPlannerAdvice` | `{ taskId, adviceId }` | v1.2 |

Sources: [ADR-0013] [ADR-0015] [ADR-0021] [ADR-0023] [ADR-0025] [ADR-0010] [ADR-0030] [ADR-0042] [ADR-0049].

### Rejection codes

| `code` | When |
|---|---|
| `validation` | the payload fails its schema, or an embedded Plan or fragment fails validation (errors as in [plan-format.md](plan-format.md#validation)) |
| `not-found` | an unknown plan, phase, task or session id |
| `invalid-transition` | the Command isn't allowed from the target's current state. The message names the state |
| `plan-exists` | `plan.submit` or `planning.start` while a Plan is `awaiting-approval` or `active`, or a Planning session is open |
| `reason-required` | `plan.abandon` or `task.forceApprove` without a non-blank reason |
| `notes-required` | `plan.sendBack` or `task.sendBack` without non-blank notes |
| `unsupported-in-version` | a Command marked for a later version than the running one |
| `not-onboarded` | any Command other than `onboarding.*`, `store.prune` and `config.setModel` while the Project is not onboarded [ADR-0049] |

## Event catalog

Every Event carries `seq` (gap-free, starting at 1), `type`, `v` (the schema version of that type, starting at 1), `ts` (ISO-8601 UTC), and the payload below [ADR-0031]. The reducer must accept every `v` ever written [ADR-0031].

| `type` | Payload |
|---|---|
| `onboarding.started` | `runId` |
| `onboarding.proposed` | `runId, proposal` (the proposal with its evidence and flags, [runners.md](runners.md#onboarding-proposal)) |
| `onboarding.failed` | `runId, reason: unable \| invalid-proposal \| crashed \| timeout \| hung, detail?, errors?` |
| `onboarding.stopped` | `runId` |
| `onboarding.confirmed` | `via: proposal \| manual \| file, config?` (the written config, absent for `file`) |
| `plan.submitted` | `planId, slug, plan` (the full parsed Plan), `sourcePath?` |
| `plan.approved` / `plan.returned` / `plan.abandoned` / `plan.completed` | `planId`, plus `notes` or `reason` where the Command required one |
| `phase.startDeferred` | `phaseId, reason, nextAttemptAt` |
| `phase.started` | `phaseId, branch, baseSha, docsTask` |
| `phase.pushed` | `phaseId, sha` |
| `phase.prOpened` | `phaseId, url, number` |
| `phase.prOpenFailed` | `phaseId, compareUrl, detail` |
| `phase.prStateObserved` | `phaseId, state: OPEN \| CLOSED \| MERGED` (recorded only on change) |
| `phase.prReopened` | `phaseId` |
| `phase.merged` | `phaseId, via: forge \| manual` |
| `task.transitioned` | `taskId, from, to, cause, blockReason?` |
| `task.budgetUsed` | `taskId, budget: review \| test \| infra, count` |
| `task.budgetReset` | `taskId, budgets[], by: retry \| replan` |
| `task.pauseChanged` | `taskId, paused, by: developer \| board` |
| `task.worktreeCreated` / `task.worktreeRemoved` | `taskId, path, branch` |
| `task.committed` | `taskId, sha, by: engine \| developer` |
| `task.findingAdded` | `taskId, finding` |
| `task.findingsClosed` | `taskId, findingIds[], byVerdictSeq` |
| `task.riskRaised` | `taskId, flags[], reason, byRunId` |
| `task.revised` | `taskId, revision, definition` (replan) |
| `task.split` | `taskId, newTasks[], rewiredDependents[]` |
| `task.forceApproved` | `taskId, reason` |
| `task.takenOver` / `task.handedBack` | `taskId` |
| `run.started` | `runId, taskId?, sessionKind?, kind: coder \| docs \| reviewer \| planner \| onboarding \| tests \| setup \| merge \| probe, role, adapter?, model?, resumeOf?` |
| `run.sessionStarted` | `runId, sessionId` |
| `run.finished` | `runId, outcome: completed \| failed \| crashed \| timeout \| hung \| rate-limited \| interrupted \| stopped, exitCode?, detail?, resetAt?` |
| `verdict.recorded` | `runId, taskId, verdict` (the full Verdict, kept forever) |
| `verdict.malformed` | `runId, taskId, errors[], raw?` |
| `merge.conflicted` | `taskId, files[]` |
| `board.paused` / `board.resumed` | none |
| `ratelimit.paused` | `adapter, resetAt?, nextCheckAt` |
| `ratelimit.lifted` | `adapter` |
| `watchdog.corrected` | `taskId, violation, action` |
| `config.changed` | `source: file \| local \| command, changes` |
| `config.rejected` | `source, errors[]` (config errors, as in [config.md](config.md#validation)) |
| `store.pruned` | `runIds[]` |
| `planning.started` **(v1.2)** | `sessionId, brief` |
| `planning.replied` **(v1.2)** | `sessionId, text` |
| `planning.plannerReplied` **(v1.2)** | `sessionId, runId, message` (the structured reply) |
| `planning.closed` **(v1.2)** | `sessionId, outcome: drafted \| discarded` |
| `planner.adviceRecorded` **(v1.2)** | `taskId, adviceId, advice` |

Sources: [ADR-0007] [ADR-0013] [ADR-0014] [ADR-0015] [ADR-0016] [ADR-0019] [ADR-0020] [ADR-0021] [ADR-0023] [ADR-0025] [ADR-0029] [ADR-0031] [ADR-0033] [ADR-0010] [ADR-0049].

Transcripts and live Run output are **never** Events [ADR-0007].
