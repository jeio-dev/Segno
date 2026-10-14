# Segno

Segno is a local desktop app that drives AI agents through a software development cycle while the developer supervises. One app holds many Projects; each Plan is an ordered list of Phases that end in pull requests.

**v1 is unreleased.** The workspace, Plan file library, offline Plan validation, the Engine's persisted Plan lifecycle, the Engine host, the desktop app shell and the Claude Code Adapter are implemented. You can add Projects, onboard them with an agent or set them up by hand, and submit, review and approve Plans. An approved Plan's first Phase runs its Tasks with Claude Code, through code, tests, review and the merge queue, onto the Phase branch. Failure paths (B6), pushing the Phase branch and opening its PR (B9), and recovery after a restart and the rate-limit pause (B8) are not built yet.

## Run the app from a checkout

Development requires Node 24 (the Node that Electron 44 bundles) and Corepack. On Linux, Electron also needs a desktop session (WSLg works) and `libasound2t64`.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` builds the workspace and starts the app with live reload for the window. Segno keeps its state in `${XDG_DATA_HOME:-~/.local/share}/Segno` on Linux and `~/Library/Application Support/Segno` on macOS. Set `SEGNO_APP_DATA` to use another directory, for example a throwaway one while trying things out ([ADR-0048](docs/adr/0048-app-data-directory-location.md)).

### Add a Project

**Add project** → **Choose folder…** and pick a git repo's top-level folder. It needs a remote and can only be added once.

- If the repo has a `segno.config.json`, its validation result is shown and **Add** registers the repo as it is. A Project whose config is invalid shows as unavailable, with every error, until you fix the file and use **Locate…**.
- Otherwise **Add** asks only for Planner, Coder and Reviewer models (defaults: `opus`, `sonnet`, `opus`). The models stay in app data, and the repo is untouched. The board shows **Not onboarded**.
- Choose **Onboard project** to have the Planner find the repo's strongest check (tests, then typecheck, build or lint) and its setup command, run them in a scratch worktree of the base branch, and propose a config. The board streams the Run's output, and **Stop onboarding** ends it. The proposal appears in **Awaiting you**: its review shows each value with the agent's reason, every command it ran with exit code and duration, the ref it ran on, and the **No checks found** and **Fails on the base branch** flags. **Confirm** writes it, and **Edit** opens the manual form prefilled with it. A failed onboarding shows its reason and **Retry onboarding**. The scratch worktree is always deleted, and nothing is written until you confirm.
- Choose **Set up manually** to review the detected package manager, test and setup commands, base branch and Coder permissions. **Save** becomes available once the required fields are filled and writes `segno.config.json` with the chosen models (Docs uses `haiku`). Segno never commits the file: the Project shows a hint until it is on `<remote>/<baseBranch>`.
- Submit a Plan after the config is written.
- A Role whose Adapter isn't installed, or lacks a capability the Role needs, is a config error. Claude Code must be installed and logged in.
- A missing or logged-out `gh` is a warning, not a refusal.

Settings holds the app's editor command and theme, and each Project's name, effective models (read-only for now) and **Remove project**, which can also delete the Project's Segno data. The repo itself is never touched.

### Submit and approve a Plan

With no Plan active, **Submit Plan file…** (or drop a `.yaml` or `.yml` file on the board) submits a Plan file. An invalid file lists every error as `line:column  code  message`. A valid one appears in **Awaiting you** and as the Project's count in the sidebar. **Review plan** shows every Phase and Task, with dependencies and Risk flags; **Approve** makes the Plan active, while **Send back** (notes required) and **Abandon** (reason required) close it. **Export Plan…** saves the active Plan as YAML.

### Watch a Plan run

Approving a Plan fetches the remote and cuts the first Phase branch, `segno/<plan-slug>/<phase-id>`, from `<remote>/<baseBranch>`; the local branch is never used. If the remote is unreachable, the board says so and the start is retried every 5 minutes. Segno adds the Phase's Docs task, `<phase-id>-docs`, which depends on every other Task.

The board shows the Phase's Tasks in seven columns: Queued, Coding, Testing, Review, Merge, Blocked and Done. There is one run slot: a Task holds it from Coding through Merge, so Tasks are worked one at a time in Plan order, with the Docs task last ([ADR-0051](docs/adr/0051-a-task-holds-its-run-slot-until-it-leaves-the-loop.md)). Each Task gets its own worktree under the Project's app data directory (or `worktreeRoot`) on the branch `segno/<plan-slug>/<phase-id>--<task-id>`. Its setup command, the Coder, `tests.command` and the Reviewer run there with `SEGNO`, `SEGNO_TASK_ID`, `SEGNO_RUN_ID` and `SEGNO_SLOT` set. Anything the Coder leaves uncommitted is committed as `segno: uncommitted changes (<run-id>)`, and every Segno commit carries a `Segno-Task:` trailer. An approved Task merges the Phase branch in, is re-tested if the Phase branch moved, and lands by fast-forward; its worktree and Task branch are then deleted, and its diff is kept in app data. The Phase stays active once every Task is done.

Selecting a card opens its drawer: the Task's definition, and **Diff**, **Tests** and **Transcript** tabs. A live Run's output streams into its terminal panel. The header's session meter shows live agent Runs against the run slot, and agent sessions started in this Phase. Subscription usage is shown when Claude Code reports it (2.1.299 and later): used out of 100 and the reset time, or only the last known reset time. It's never estimated.

Agent Runs use `claude -p` with an explicit allowlist and your Claude subscription, and never prompt ([ADR-0004](docs/adr/0004-allowlist-permissions-auto-deny.md)). Each gets a prompt built only from its Run context, kept as `prompt.md` and shown by the `runPrompt` query: the Coder gets the Plan and Phase titles, its Task, the definition of done and `tests.command`; the Reviewer gets the Task, its diff range and the Verdict schema; the Docs task gets the Phase's done Tasks with their Verdict summaries, advisory Findings, the Phase diff range, the Phase `docs` block and the changelog path.

For a demo without using your subscription, start the app with the fake agent, which writes `<task-id>.txt`, approves every review and proposes `npm test` when onboarding. Use a throwaway repo, since its commits land on `segno/*` branches:

```sh
SEGNO_FAKE_ADAPTER=1 SEGNO_APP_DATA=$(mktemp -d) pnpm dev
```

A failed or rejected step leaves its Task where it is until B6 handles failures. Restarting the app while a Plan is running leaves it where it stopped until B8 adds recovery.

## Run Plan validation from a checkout

The workspace pins pnpm through `packageManager`; the built CLI still targets Node 22.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
node packages/cli/dist/index.mjs plan validate examples/two-phase.yaml
```

The command works from any directory, requires no git repo or Segno config, and accepts `.yaml` and `.yml` files. Success is silent and exits 0. Bad arguments, unreadable files and invalid Plans exit 2. Validation errors go to stderr as `file:line:column  code  message`; unavailable locations are printed as `?`.

Plan files use UTF-8 and YAML 1.2 core types. Ordinary anchors and aliases work; unsupported version directives and unresolved tags are rejected.

## Plan file library

`@segno/plan-format` is browser-safe and exposes:

- `parsePlan(source)`: `{ valid: true, plan }` or `{ valid: false, errors }`. A valid input contains only authored Tasks.
- `validateFragment(source, { kind, plan, taskId, idHistory })`: `{ valid: true, tasks }` or `{ valid: false, errors }`. `kind` is `replan` or `split`; `plan` is the valid current Plan with non-superseded authored Tasks, and `taskId` names the Task being replaced. `idHistory` includes every Task id ever used. Validation checks the graph after a split without changing the Plan.
- `exportPlan(plan, { supersededTaskIds?, reviewerRisks? })`: YAML for the current Plan. Export omits superseded Tasks, adds or preserves each Phase's generated Docs task, and merges Reviewer risks supplied as arrays keyed by Task id. Exported Docs tasks cannot be resubmitted.

The normative contract is [Plan file format](docs/spec/plan-format.md). [The committed JSON Schema](schemas/plan-file.v1.json) covers structural rules; Segno also checks id uniqueness, reserved ids and dependency references and cycles. [The two-Phase example](examples/two-phase.yaml) is valid input. `examples/invalid-*.yaml` demonstrate every Plan validation code; `examples/fragments/` contains the additional fragment-code fixtures.

## Event log and Plan lifecycle

`@segno/core` declares every v1 Event with its version and exposes the shared `project(events)` reducer. Its State contains `lastSeq`, Plans with their Phases in submission order, the active Phase's Tasks, Runs, and the Awaiting-you queue. `boardOf(state, { concurrency })` derives the board that both the `board` query and the window show. Core also declares the Agent Adapter interface (`AgentAdapter`, `RunSpec`, `RunHandle`); the Engine depends on nothing else from an Adapter. It also exports zod schemas for the four Plan Commands, the three onboarding Commands, and their results and rejection codes, plus the Verdict and onboarding proposal schemas with the JSON Schemas Runs get as `outputSchema`.

`@segno/engine` exposes `openEngine({ dbPath, clock?, isOnboarded?, configStore?, workspace?, onError? })`. The host supplies the readiness check and config store for onboarding, and a `workspace` (`{ repo, projectDir, config(), adapters }`) to work Plans in; without one, Plans are only recorded. The directory containing `dbPath` must already exist. `clock` is an optional `{ now(): Date, setTimer?(at, fire) }` port, defaulting to real time.

- `handle(command)` processes Commands in arrival order and returns `{ ok: true, events: number[] }` or `{ ok: false, code, message, errors? }`. Invalid payloads and Plan files append nothing; an unrecognizable Command type rejects the Promise with `BadRequestError` (`code: "bad-request"`).
- `readEvents(since?)` returns Events after a sequence number, in order. Events use `{ seq, type, v, ts, payload }`.
- `state` returns the State projected from the log. Submission creates a `plan-approval` item. Approval, send back and abandon clear it; send back retains notes and abandon retains its reason. Approval starts the first Phase. Abandoning an active Plan stops its live Run, supersedes every unfinished Task and deletes their worktrees and Task branches; Phase branches are kept.
- `watchRun(runId, listener)` streams a live Run's output, then its `end`.
- `idle()` resolves once nothing is queued or running.
- `close()` drains queued Commands, stops live Runs and closes SQLite. Further Commands are refused.

`@segno/engine/testing` provides the fake Adapter (`fakeAdapter`, with `writesFiles`, `approves`, `proposes`, `proposesFromRepo` and `runsUntilStopped` scripts, and `run.event()` for usage), `fakeClock` and `tempRepos` for tests.

`@segno/adapter-claude-code` exports `claudeCodeAdapter({ binary?, stopGraceMs? })`. It maps a `RunSpec` onto `claude -p --output-format stream-json`, tees the raw output to `transcript.jsonl`, and classifies each Run as `completed`, `failed`, `crashed` or `rate-limited`. `stop()` sends SIGTERM to the Run's process group, then SIGKILL after the grace period.

The Engine records the parsed Plan in SQLite; editing its source file cannot change it. Events have gap-free sequences and are appended in one transaction per accepted Command. Opening a database replays its log, and an unknown Event type or version stops startup with an error naming it. Slugs remain unique across the Project's entire Plan history; an empty derived slug uses `plan` ([ADR-0045](docs/adr/0045-empty-plan-slug-fallback.md)).

## Engine host

`@segno/host` exposes `startHost({ appData, adapters, clock?, ghBinary? })`, the composition root that the app runs in an Electron `utilityProcess`. It loads the Project registry, starts one Engine per Project that can run, and serves the [host protocol](docs/spec/api.md) over any message port: `command`, `query` (`board`, `awaiting`, `task`, `taskDiff`, `run`, `runTranscript`, `runPrompt`, `plans`, `plan`, `planExport`, `phases`, `phaseEvents`, `config`, `onboarding`), `subscribe` with replay from `since`, `runOutput` for a Run's live output, the `projects.*` calls and `settings.*`. `@segno/core` exports the protocol schemas and `createHostClient(port)`, which the window and the tests use. A Project that can't run (missing folder, not a repo, invalid config, unreadable Event log) is reported `unavailable` with its reason while the others keep running ([ADR-0047](docs/adr/0047-config-errors-and-project-availability.md)).

A Project without config and without any submitted Plan is `not-onboarded`: its Engine runs, its models live in `pending.json`, and Plan Commands are rejected `not-onboarded`. `onboarding.start` runs the Planner in `worktrees/_onboarding/` and records `onboarding.proposed`, `onboarding.failed` or, after `onboarding.stop`, `onboarding.stopped`. Confirmation validates and writes the config through the host config store and records `onboarding.confirmed` (`via: proposal` while a review is open, else `manual`). A valid config supplied before startup records `via: file`. If config disappears after a Plan was submitted, the Project is unavailable; before any Plan, missing pending config is recreated with the Add defaults ([ADR-0050](docs/adr/0050-recover-missing-pending-config.md)).

## Development checks

```sh
pnpm check:b5
```

This chains `pnpm check:b4`, `pnpm check:b3.1` and `pnpm check:b3`: `pnpm check:b2` (the build, Biome, every Vitest suite including the S3 Engine, S4 git and S6 host tests on real git repos with bare remotes, and the B2 exit scenario), then builds the app and drives it end to end with Playwright (S9) on temporary repos, a temporary app data directory and the fake Adapter. S9 needs a display; CI runs it under `xvfb-run` on Node 24. `pnpm test:e2e` reruns only S9 against the last app build.

The S5 Adapter tests replay recorded Claude Code output through a stub `claude`. `pnpm test:live` re-records those fixtures with your installed `claude` and subscription, and `pnpm check:b5:live` also runs a one-Task Plan and an onboarding in throwaway repos with the real `claude`. Neither runs in CI.

`pnpm check:b1` through `pnpm check:b4` remain available for the earlier exit checks.

Run `pnpm schema:generate` after changing structural rules, and review the resulting schema diff. [The build plan](docs/build-plan.md) describes the remaining work.
