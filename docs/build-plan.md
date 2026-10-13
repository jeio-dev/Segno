# Segno v1 build plan

This is the order in which v1 gets built. v1 is defined in [spec/README.md § v1 cut line](spec/README.md#v1-cut-line) and [ADR-0042]: the desktop app on Linux and macOS, holding many Projects, with `concurrency` fixed at 1 per Project, the Claude Code Adapter only, and the GitHub forge through `gh`. Anything marked **(v1.2)** or **(later)** in the spec is out, except that the v1 Engine answers v1.2 Commands with `unsupported-in-version`.

> **"Build phase" is not "Phase".** A build phase (`B1`…`B10`) is a step in building Segno. It has nothing to do with the domain term *Phase* in [glossary.md](glossary.md), which is a slice of a Segno Plan. This document always writes "build phase" in full, or uses the id.

## Rules

- **The spec and ADRs are settled.** This plan only orders and slices them. If a build phase exposes a real gap, it's raised with the developer and recorded as a new ADR, together with the matching spec edit, in the same PR. It is never patched silently in code or in this plan.
- **One build phase is one mergeable PR**, on a branch `build/bN-<slug>` cut from `main`. The developer merges it.
- **Every PR ships its docs** ([Docs per PR](#docs-per-pr)).
- **Tests are written test-first, only at the agreed seams** ([Seams](#seams)), in vertical slices (see `.claude/skills/tdd`).
- **A build phase is done when its exit check passes:** `pnpm check:bN` exits 0, plus the live check where one is listed.
- **From B3 on, every build phase ships its Engine behavior together with its GUI surface**, so each one can be shown working in the app.
- **Event shapes may change until the first release** [ADR-0035] [ADR-0043]. Every change to an existing Event's shape is logged in [Event shape changes](#event-shape-changes), and local Event logs (`projects/<id>/segno.db` in the app data directory) are deleted, not migrated. The catalog freezes in B10.

## Status

| Id | Build phase | Status | PR |
|---|---|---|---|
| B1 | Workspace and Plan file | done | |
| B2 | Event log and reducer | not started | |
| B3 | Engine host, app shell and Projects | not started | |
| B4 | Happy-path Task with a fake Adapter | not started | |
| B5 | Claude Code Adapter | not started | |
| B6 | Failure paths | not started | |
| B7 | Developer Task Commands | not started | |
| B8 | Resilience, tray and notifications | not started | |
| B9 | GitHub forge and multi-Phase | not started | |
| B10 | Packaging and v1 release | not started | |

## Workspace

A pnpm workspace [brief §Decided], built as one monorepo and shipped as one desktop app [ADR-0037] [ADR-0043]:

```
package.json            private workspace root; packageManager pins pnpm (corepack)
pnpm-workspace.yaml     packages: ["packages/*"]
tsconfig.base.json
biome.json
vitest.config.ts        one project per package
examples/               example Plan files and invalid fixtures
schemas/                committed JSON Schemas (Plan file, config) [ADR-0002] [ADR-0025] [ADR-0036]
packages/
  plan-format/          browser-safe: YAML parse, validate, fragments, export, JSON Schema
  core/                 browser-safe: Event catalog, reducer, Command and rejection schemas,
                        host protocol schemas, Verdict schema, config schemas,
                        AgentAdapter and RunSpec types
  engine/               Node: Engine loop, SQLite Event log, timers, Watchdog, budgets, Run
                        context and prompts, script Runs, git and worktrees, gh forge
                        (+ @segno/engine/testing: fake Adapter, fake clock, temp repos)
  adapter-claude-code/  Node: claude -p mapping, stream parsing, classification, fixtures
  host/                 Node: the Engine host. Project registry, one Engine per Project,
                        the shared rate-limit pause, the IPC protocol; exports startHost(deps)
  cli/                  the segno command: offline plan validate
  app/                  Electron main and preload: window, single-instance lock, host
                        supervision, tray, notifications, dialogs, updater
  ui/                   React and Vite renderer: Projects, board, drawer, Awaiting you,
                        History, settings
```

- **Boundaries enforced by the compiler.** `core` and `plan-format` build with `lib: ["ES2023"]`, and `ui` with `lib: ["ES2023", "DOM"]`, all without `@types/node`, so the reducer and the renderer stay free of Node [ADR-0007] [ADR-0037]. The Engine depends only on the `AgentAdapter` interface in `core` [ADR-0017]. `startHost(deps)` is the composition root: the app passes the real Adapters, and tests pass fakes.
- **Toolchain.** ESM only (`module: nodenext`), `tsc --build` with project references, Vitest, Biome, tsdown to bundle `cli`, electron-vite for `app` and `ui` (from B3), and electron-builder for releases (B10). `better-sqlite3` is rebuilt for Electron's Node. `engines.node` is `>=22`.
- **CI.** GitHub Actions on every PR: install, `tsc --build`, Biome, Vitest. On Node 22 and 24 until B3, then on the Node major that the chosen Electron bundles. From B3, S9 runs under xvfb on Linux. Real-git tests run in CI. Real `claude` and `gh` never do.
- **Exit-check harness.** One root script per build phase, `pnpm check:bN`, runs that build phase's exit scenario. Live checks are `pnpm check:bN:live`, and the developer triggers them.

## Seams

Tests sit only at these seams. Mocks appear only at system boundaries: the agent CLI, the clock, `gh`, and the OS dialogs, tray and notifications. Git, SQLite and the shell run for real, in temp dirs. Expected values are literals from the spec, never recomputed by the code under test.

| Id | Seam | Driven through | Catches | Misses |
|---|---|---|---|---|
| S1 | Plan file API (`plan-format`) | `parsePlan`, `validateFragment`, `exportPlan`; every fixture also checked against the committed JSON Schema | every validation code with line and column; export round-trip; drift between the zod structural rules and the JSON Schema [ADR-0036] | how the Engine uses a Plan |
| S2 | Reducer (`core`) | `project(events) → State` over hand-written Event sequences | derivation of board, Awaiting you, budgets and wait reasons | whether the Engine emits the right Events |
| S3 | Engine (`engine`), the main seam | `engine.handle(command)` plus injected ports (fake AgentAdapter, fake clock, fake Forge), observed through appended Events and derived State. Real git (temp repo plus bare remote), real `sh -c`, real SQLite on a temp file | every Plan, Phase and Task table row; budgets; merge queue; Verdict repair; recovery by reopening the DB | real `claude` and `gh`; the host and the GUI |
| S4 | Git module (`engine`) | its own functions against temp repos | conflicts, dirty trees, stale worktrees, lockfile-change detection, commit trailers | when the Engine calls it |
| S5 | Claude Code Adapter | `adapter.start(spec)` with `binary` pointed at a replay stub that records argv and replays recorded `stream-json`, exit codes and signals | flag mapping, the four classifications, `resetAt`, `RunEvent`s, `stop()` | real CLI drift, covered by the opt-in live contract test `pnpm test:live` |
| S6 | Engine host protocol (`host`) | `startHost({ adapters: [fake], clock, appData })` in plain Node, without Electron, driven through its protocol calls, with real Engines | Command and query shapes; rejection results; Event-stream replay with `since`; the Project registry and app-level calls; `unavailable` Projects; the app-wide rate-limit pause; `pruned` | the window, IPC wiring and OS integration |
| S7 | CLI (`cli`, the built bundle) | the `segno` command as a subprocess | arguments, exit codes 0 and 2, output | everything else |
| S8 | gh Forge module (`engine`) | the forge functions with `gh` pointed at a replay stub | PR creation and body, PR state parsing, missing or logged-out `gh` | real GitHub behavior, covered by the B9 live check |
| S9 | The app, end to end | Playwright's Electron driver on the built app, with a temp app data dir, temp repos and the fake Adapter, under xvfb in CI. A few journeys per build phase, never Engine logic | the window wiring: IPC, the preload bridge, dialogs, host supervision, what each journey shows and sends | Engine logic (S3 owns it); native notifications and the tray, checked by hand in the B8 live check |

## Docs per PR

Every build phase's PR updates, as relevant:

1. **`docs/build-plan.md`:** its row in [Status](#status) (`done` and the PR link), any notes, and every Event shape change [ADR-0035].
2. **`README.md`:** created in B1. Each build phase adds what now works. Until B10 it says plainly that v1 is unreleased.
3. **`CHANGELOG.md`:** created in B1 in Keep a Changelog format, with entries under `Unreleased`. B10 turns them into `1.0.0`.
4. **Spec and ADRs:** changed only through a new ADR plus the matching spec edit, after asking the developer.

---

## B1: Workspace and Plan file

**Implements:** [plan-format.md](spec/plan-format.md) in full (schema, field rules, automatic Docs task definition, validation, fragments, export, as a library); [cli.md](spec/cli.md) § Conventions, § Exit codes and § Commands (`segno plan validate`). § Installing comes in B10. [ADR-0002] [ADR-0011] [ADR-0012] [ADR-0036] [ADR-0042] [ADR-0044].

**Delivers:**
- The workspace, toolchain, CI and the eight packages. `core`, `engine`, `adapter-claude-code`, `host`, `app` and `ui` stay empty shells, with no Electron or React dependencies until B3.
- `plan-format`: parsing with line and column, every validation code, replan and split fragment checks (given the Plan's id history), export with `generated: true` Docs tasks.
- `schemas/plan-file.v1.json`, covering the structural rules [ADR-0036].
- `examples/` with a valid two-Phase Plan and at least one invalid fixture per validation code.
- `segno plan validate <file>` as a built bundle, offline, needing no repo or config. Any other subcommand is a usage error (exit 2).

**Seams:** S1, S7.

**Exit check (`pnpm check:b1`):** The workspace builds, and the built `segno` bundle runs as a subprocess from a temp directory outside any git repo. `segno plan validate examples/two-phase.yaml` exits 0. Each `examples/invalid-*.yaml` exits 2 and prints every error as `file:line:column  code  message`. An unknown subcommand exits 2. The committed JSON Schema accepts `two-phase.yaml` and each named cross-reference fixture, and rejects every other invalid fixture [ADR-0036]. CI is green on Node 22 and 24.

**Docs:** creates `README.md` (what Segno is, that v1 is unreleased, and running `plan validate` from a built checkout) and `CHANGELOG.md`.

**B1 implementation decisions, agreed with the developer:**
- Plan parsing returns `{ valid: true, plan }` or `{ valid: false, errors }`; expected input failures do not throw. Successful input contains authored Tasks only.
- Blank titles, acceptance criteria and risk reasons are invalid. Summary, description and Phase docs have no additional non-empty constraint.
- Value errors point to values, unknown keys to keys, and missing fields to their containing object. Errors without a source location omit it; the CLI prints `?`.
- A syntax-invalid document reports all YAML syntax errors before structural validation. Parseable documents report structural and inspectable reference errors together, in source order.
- Duplicate dependency entries use `schema`; self-dependencies use `dependency-cycle`. Each separate cyclic group produces one error listing its ids.
- Fragment validation returns Task definitions without applying changes. Its context is the valid current authored Plan, the original Task id and the Plan's complete Task-id history. A split checks the graph after dependent rewiring.
- Export takes optional superseded Task ids and Reviewer risks by Task id. It preserves current Docs definitions, marks them generated, and rebuilds Docs dependencies. Risk flags retain authored order, append Reviewer flags in supplied order and deduplicate; reasons are separated by blank lines.
- Built-in Docs description: “Update the README and guides to reflect this Phase's behavior changes, and add changelog entries for user-visible changes.” Its criteria are “README and guides reflect the Phase's behavior changes” and “Changelog entries exist for user-visible changes”. Phase docs are appended after a blank line.
- Generated Docs ids may be 53 characters [ADR-0044]. The committed structural schema uses Draft 2020-12.
- CLI success is silent. Diagnostics, read errors and usage go to stderr. The CLI accepts `.yaml` and `.yml` only.
- Decoding uses YAML 1.2 core types. Unsupported version directives, unresolved tags and aliases use `yaml-syntax`; ordinary anchors and aliases are allowed. Malformed UTF-8 bytes are CLI read errors.
- Dependencies are pinned exactly. `skipLibCheck` skips third-party declarations because Zod references `URL`; Segno source retains the agreed browser and Node compiler boundaries.

**Verification:** implementation and code review are complete. `pnpm check:b1` passes on Node 22.23.3 and 24.21.0 with 73 tests at S1 and S7, including every Plan fixture through a copied standalone CLI bundle outside git. Frozen-lockfile installation passes. The PR's GitHub Actions matrix runs the same check on Node 22 and 24; both jobs must be green before merge.

## B2: Event log and reducer

**Implements:** [engine.md § Processing model](spec/engine.md#processing-model), [§ Plan lifecycle](spec/engine.md#plan-lifecycle) (submit, approve, send back, abandon; slug derivation), [§ Commands](spec/engine.md#commands) for the Plan Commands, [§ Rejection codes](spec/engine.md#rejection-codes), [§ Event catalog](spec/engine.md#event-catalog) (all v1 types declared); [store.md § The Event log](spec/store.md#the-event-log). [ADR-0007] [ADR-0012] [ADR-0013] [ADR-0022] [ADR-0031] [ADR-0035].

**Delivers:**
- `core`: Event types with `v`, the reducer and derived State (Plans and the Awaiting-you queue so far), Command and rejection schemas.
- `engine`: the SQLite Event log at a given path (gap-free `seq`, one transaction per Command), single-writer processing in arrival order, and the Plan lifecycle Commands.
- Replay on open; an unknown `type` or `v` stops startup and names it.

**Seams:** S2, S3.

**Exit check (`pnpm check:b2`):** An S3 script that prints the Event log. Submit → `plan.submitted` plus a `plan-approval` item. A second submit is rejected `plan-exists`. An invalid file is rejected `validation` with errors and appends nothing. Send back, abandon and approve each reach their state. Closing and reopening the DB gives an identical projected State. An unknown `type`/`v` in the log stops startup and names it.

**Interim state:** approving a Plan makes it `active`, but its first Phase stays `pending` until B4. There's no interface yet; B3 adds it.

## B3: Engine host, app shell and Projects

**Implements:** [api.md](spec/api.md) in full, except the Task and Run queries, `runOutput` and `openWorktree` (B4 and B7) and `cli.install` (B10); the `board` query at Plan and Phase level. [store.md § App data directory](spec/store.md#app-data-directory). [config.md](spec/config.md): all three files and § Validation (Adapter checks come in B5). [engine.md](spec/engine.md) `unsupported-in-version` for v1.2 Commands, and § Startup recovery and shutdown for startup per Project. [gui.md](spec/gui.md): § Screens, § Projects, § Adding a Project, § Board (empty state, submitting a Plan, header and Export Plan), § Awaiting you for `plan-approval` with Plan review, § Settings (App: editor and theme; Project: name, models and Remove project), § Connection state, § Visual rules. [ADR-0004] (config `allow` validation) [ADR-0007] [ADR-0022] [ADR-0025] [ADR-0032] [ADR-0037] [ADR-0038] [ADR-0039] [ADR-0042].

**Delivers:**
- `host`: `startHost(deps)`, the Project registry, one Engine per Project, the protocol calls above, and Event streams with replay from `since`.
- `app`: the Electron window, the preload bridge, the single-instance lock, and host supervision (restart once, then **Restart Engine**).
- `ui`: the Projects sidebar, the add-project flow with detection, the board shell, Plan submit (picker and drop), Plan review and approval, Export Plan, and settings.
- CI pinned to the Electron Node major, with S9 under xvfb.

**Seams:** S6, S9.

**Exit check (`pnpm check:b3`):**
- **S6:**
  - Two Projects in one host. Submitting in A creates `plan-approval` in A only.
  - `subscribe` with `since` replays with no gaps or duplicates.
  - An unknown `projectId` gets `unknown-project`.
  - A Project with an invalid committed config is `unavailable` with every error, while the other keeps running.
  - Restarting the host gives identical `board` and `awaiting` results.
  - A v1.2 Command is rejected `unsupported-in-version`.
- **S9:**
  - Adding a temp repo with no config shows the detected settings. **Add** writes `segno.config.json` without committing it, and the commit hint shows.
  - Adding a folder that isn't a repo shows `not-a-repo`.
  - Submitting `examples/two-phase.yaml` shows `plan-approval` in the panel and the sidebar count. Approving shows the Plan `active`.
  - Killing the host process, the app restarts it and the board is unchanged.
  - A second launch focuses the existing window.

**Interim state:** an approved Plan's first Phase stays `pending` until B4.

**Docs:** README gains running the app from a checkout, adding a Project, and submitting and approving a Plan.

## B4: Happy-path Task with a fake Adapter

**Implements:** [engine.md § Phase lifecycle](spec/engine.md#phase-lifecycle) rows `pending` → `starting` → `active` (fetch, Phase branch cut, Docs task added, deferred start on fetch failure); [§ Automatic transitions](spec/engine.md#automatic-transitions) success rows from `waiting` to `done`; the merge queue and the skipped re-test; [§ Scheduling](spec/engine.md#automatic-transitions); `plan.abandon` effects on worktrees and Task branches. [store.md § Worktrees](spec/store.md#worktrees), [§ Branches](spec/store.md#branches), `runs/` and `tasks/<id>/merged.diff`. [runners.md § Run kinds](spec/runners.md#run-kinds) (`tests`, `setup`, `merge`), [§ Adapter interface](spec/runners.md#adapter-interface) (types only), [§ Script Runs](spec/runners.md#script-runs), [§ Run environment](spec/runners.md#run-environment), [§ Commits](spec/runners.md#commits), [§ Transcripts and live output](spec/runners.md#transcripts-and-live-output). [api.md](spec/api.md) the `task`, `taskDiff`, `run`, `runTranscript` and `runPrompt` queries and [§ Live Run output](spec/api.md#live-run-output). [gui.md](spec/gui.md) § Board columns and cards (happy-path states), the session meter, and § Card drawer (Diff, Tests and Transcript tabs). [ADR-0001] [ADR-0003] [ADR-0005] [ADR-0009] [ADR-0011] [ADR-0014] [ADR-0017] [ADR-0018] [ADR-0028] [ADR-0029] [ADR-0033] [ADR-0038].

**Delivers:**
- The git module (worktrees outside the repo, Task branches, merge with lockfile detection, commits with the `Segno-Task:` trailer).
- Script Runs with the `SEGNO_*` environment, and auto-commit after Coder and Docs Runs.
- The fake Adapter, fake clock and temp-repo fixtures at `@segno/engine/testing`.
- Agent Runs get a minimal placeholder prompt until B5.
- The board's columns and cards, and the drawer with live output.

**Seams:** S3, S4, S6, S9.

**Exit check (`pnpm check:b4`):**
- **S3:** on a temp repo with a bare remote, a Plan with Tasks `a` and `b` (`b` depends on `a`) and a fake Coder that writes files reaches every Task `done`, including `<phase-id>-docs`.
  - The Phase branch has moved only by fast-forward, and every Segno commit carries `Segno-Task:`.
  - Worktrees (under the Project's directory) and Task branches are gone, and `merged.diff` is kept.
  - An unreachable remote gives `phase.startDeferred`, which the fake clock retries at +5 min.
- **S6:** `runOutput` streams live output, then `end`.
- **S9:** the same Plan's cards move to Done on the board, and the drawer's Transcript tab streams a live Run.

**Interim state:** the Phase stays `active` with every Task `done`. `awaiting-merge`, push and the Phase PR come in B9.

## B5: Claude Code Adapter

**Implements:** [runners.md § Claude Code Adapter (v1)](spec/runners.md#claude-code-adapter-v1), [§ Permission profiles](spec/runners.md#permission-profiles), [§ Run context](spec/runners.md#run-context) (first-pass Coder, Reviewer and Docs prompts, `probe`), [§ Verdict schema](spec/runners.md#verdict-schema), [§ Adapter interface](spec/runners.md#adapter-interface) capability gating; [config.md § Validation](spec/config.md#validation) Adapter checks, shown in the add-project flow; usage reporting in the `board` query and the board's subscription usage control. [ADR-0004] [ADR-0016] (schema only) [ADR-0017] [ADR-0018] [ADR-0021] (classification only) [ADR-0024] [ADR-0030].

**Delivers:**
- `adapter-claude-code`: `detect()`, the flag mapping re-checked against the installed Claude Code (2.1.296 at planning time), stream parsing, classification, `stop()`.
- Recorded fixtures for every classification, and `pnpm test:live` to re-record them.
- Built-in prompt templates, including the Docs task's, and `prompt.md` written before every agent Run.
- The app wires the real Adapter into `startHost`.

**Seams:** S5, plus live.

**Exit check (`pnpm check:b5`):** Replayed fixtures classify `completed`, `failed`, `crashed` and `rate-limited` (with and without `resetAt`) correctly, and the replay stub's argv matches the runners.md flag table.
**Live (`pnpm check:b5:live`, developer-triggered, uses the developer's Claude subscription):** in a throwaway repo added as a Project, a one-Task Plan reaches `done` with the real `claude`. `prompt.md` contains exactly the Run-context ingredients. Fixtures are re-recorded against the installed version.

**Note:** if the installed Claude Code's flags differ from runners.md, the difference is raised and recorded as an ADR before the mapping changes.

## B6: Failure paths

**Implements:** [engine.md § Automatic transitions](spec/engine.md#automatic-transitions) failure rows (test failure, reject, malformed Verdict, merge re-test failure, merge conflict, infra failure) and the budget rule; [§ Blocked Tasks and their dependents](spec/engine.md#blocked-tasks-and-their-dependents); [§ Findings](spec/engine.md#findings); [§ Verdict handling](spec/engine.md#verdict-handling) with repair; [§ Infra failures](spec/engine.md#infra-failures) with backoff; `held` with `task.approve` and `task.sendBack`; the `merge-hold` and `blocked` Awaiting-you items. [runners.md § Timeouts](spec/runners.md#timeouts), [§ Run context](spec/runners.md#run-context) later Coder passes (blocking Findings, test log tail, conflicting files) and re-review. [gui.md](spec/gui.md): the Blocked column, Block reason, budget and wait-reason badges, the high-risk badge, the drawer's Review tab, and the Approve and Send back actions with their Awaiting-you items. [ADR-0005] [ADR-0011] [ADR-0014] [ADR-0015] [ADR-0016] [ADR-0019] [ADR-0024] [ADR-0028] [ADR-0029].

**Seams:** S2, S3, S9.

**Exit check (`pnpm check:b6`):**
- **S3 matrix**, with the `board` State showing the expected Block reason and budgets at each step:
  - 2 rejects → `review-limit`
  - 2 failing test runs → `test-limit`
  - 3 malformed Verdicts, repaired by resume → `verdict-invalid`
  - 3 crashes, backed off 30 s / 2 min / 5 min → `infra-limit`
  - 3 failed setup Runs → `setup-failed`
  - a Coder timeout and an idle timeout count as infra failures
  - a high-risk Task (from the Plan, or raised by a Verdict) → `held` → `task.approve` lands it
  - `task.sendBack` returns it to `coding`
  - a merge conflict → `coding` with the files listed
  - a dependent of a Blocked Task stays `waiting` with its wait reason
- **S9:** a `held` Task is approved from Awaiting you and reaches Done. A Blocked card shows its Block reason and budgets.

## B7: Developer Task Commands

**Implements:** [engine.md § Developer Commands on a Task](spec/engine.md#developer-commands-on-a-task) not covered in B6: `task.note`, `task.pause`/`task.resume`, `task.stopRetry`, `task.takeOver`/`task.handBack`, `task.retry`, `task.replan`, `task.split`, `task.forceApprove`; diff-line Findings in the `taskDiff` query; [api.md § Local actions](spec/api.md#local-actions). [gui.md](spec/gui.md) § Card actions, diff-line notes, and fragment validation before sending. [ADR-0011] [ADR-0014] [ADR-0015] [ADR-0025].

**Seams:** S2, S3, S9.

**Exit check (`pnpm check:b7`):**
- **S3,** from Blocked Tasks set up as in B6:
  - `retry` resets only the exhausted budget, and its note becomes a blocking Finding.
  - `replan` gives a new revision, full budgets and a fresh worktree from the Phase branch tip.
  - `split` supersedes the original and re-points dependents and the Docs task at every new Task.
  - `force-approve` requires a reason, skips `held`, and still re-tests.
  - `take-over`/`hand-back` commits leftovers as `segno: developer changes` and re-enters at `testing`.
  - `note` appears in the next Coder prompt.
  - `pause`/`resume` and `stop-retry` rerun the step with no budget used.
- **S9:**
  - An invalid split fragment shows its errors and sends nothing.
  - A diff-line note shows as an open blocking Finding.
  - **Open worktree** runs the configured editor (a recording stub), or shows `no-editor`.

## B8: Resilience, tray and notifications

**Implements:** [engine.md § Pause, pause all and rate limits](spec/engine.md#pause-pause-all-and-rate-limits) (including the pause shared by every Project), [§ Watchdog](spec/engine.md#watchdog), [§ Startup recovery and shutdown](spec/engine.md#startup-recovery-and-shutdown); [store.md § Retention](spec/store.md#retention), [§ Recovery guarantees](spec/store.md#recovery-guarantees) (including stale git cleanup); [config.md § Changes while running](spec/config.md#changes-while-running) and `config.setModel`. [gui.md](spec/gui.md): Pause all / Resume all, the rate-limit banner, the config warning, § Tray and notifications, § Settings (notifications, start at login, Prune runs now), and "transcript pruned". [ADR-0014] [ADR-0020] [ADR-0021] [ADR-0025] [ADR-0033] [ADR-0040] [ADR-0041].

**Seams:** S3, S6, S9, plus live.

**Exit check (`pnpm check:b8`):**
- **S6:**
  - Killing the host with `kill -9` mid-`coding` and restarting: the Run is `interrupted`, the step reruns with no budget used, and the Coder resumes its session.
  - A dead Run process → `watchdog.corrected` plus an infra failure.
  - With two Projects, a `rate-limited` outcome in A records `ratelimit.paused` in both logs and stops both Projects' agent Runs, while test Runs continue. It lifts in both at `resetAt + 60 s`, or probes from A at 5, 15 and 30 min, then hourly.
  - A shutdown records live Runs `interrupted`.
  - A bad config edit → `config.rejected`, and the old config stays. A good edit → `config.changed` for the next Run.
  - `config.setModel` writes only the Project's `local.json`.
  - `store.prune { olderThanDays: 0 }` → `pruned` from `runTranscript`, with Verdicts intact.
  - `concurrency: 2` is rejected.
- **S3:** pause all and resume all keep individually paused Tasks paused.
- **S9:**
  - Closing the window keeps a Run going, and reopening shows it.
  - **Quit** with a live Run asks for confirmation, then records it `interrupted`.
  - A new Awaiting-you item reaches the notification port once, and not while the window is focused.

**Live (`pnpm check:b8:live`, developer-triggered):** on Linux (and macOS when available), by hand: the tray icon shows the total count, a native notification appears for a new item and its click opens it, and start at login works.

## B9: GitHub forge and multi-Phase

**Implements:** [engine.md § Phase lifecycle](spec/engine.md#phase-lifecycle) rows from `active` onward, [§ Phase PR](spec/engine.md#phase-pr) (body, `pr-manual` fallback, merge detection every 60 s), Plan `complete`; the `pr-ready`, `pr-manual` and `pr-closed` Awaiting-you items. [gui.md](spec/gui.md) the PR link in the header, those items' actions (Confirm merged, Reopen PR, Abandon plan), and § History with replay. [ADR-0001] [ADR-0013] [ADR-0023] [ADR-0029].

**Seams:** S3 (fake Forge), S8, S9, plus live.

**Exit check (`pnpm check:b9`):**
- **S3 and S8,** with the replay-stub `gh`:
  - Phase 1 done → the branch is pushed to the bare remote, and a PR is opened with every required body section, then `pr-ready`.
  - The stub reports `MERGED` → Phase 2 starts from the remote base.
  - No `gh` → `pr-manual` → `phase.confirmMerged`.
  - `CLOSED` → `pr-closed` → `phase.reopenPr`.
  - The Plan ends `complete`.
- **S9:** **Confirm merged** on a `pr-manual` item starts the next Phase. History replays the finished Phase.

**Live (`pnpm check:b9:live`, developer-triggered):** the same flow with the real `gh` against the sandbox GitHub repo, using the fake Adapter so it costs no agent time.

## B10: Packaging and v1 release

**Implements:** [cli.md § Installing](spec/cli.md#installing) and `cli.install`; [ADR-0043] packaging, signing, auto-update and publishing; [ADR-0035] catalog freeze; [spec/README.md § v1 cut line](spec/README.md#v1-cut-line) as the acceptance list. [ADR-0030] [ADR-0031] [ADR-0042] [ADR-0043].

**Seams:** S7, S9, plus live.

**Exit check (`pnpm check:b10`):**
- electron-builder produces the AppImage and .deb on Linux, and CI produces the .dmg on a macOS runner.
- S9 passes against the packaged Linux app.
- `cli.install` writes the launcher into a temp PATH directory, and `segno plan validate` runs through it.
- The updater's feed points at the repo's GitHub Releases.

**Live, the v1 acceptance run (`pnpm check:b10:live`, developer-triggered):**
- From the packaged app, with the real `claude` and `gh` on the sandbox repo, a two-Phase Plan → two Phase PRs that the developer merges → Plan `complete`.
- The macOS build passes Gatekeeper.
- Auto-update moves the app from one prerelease to a newer one, both published only on the developer's go.

**Release steps, in order:** freeze the Event catalog [ADR-0035]; `CHANGELOG.md` `Unreleased` → `1.0.0`; publish the GitHub Release, only on the developer's explicit go [ADR-0043].

**Docs:** adds `docs/guides/plan-file.md` and `docs/guides/app.md`, and rewrites the README for installing from GitHub Releases.

---

## Developer prerequisites

| Needed by | What |
|---|---|
| B5, B10 live checks | the developer's Claude subscription, with `claude` logged in |
| B8 live check | a Linux desktop session (WSLg works); a Mac for the macOS part when available |
| B9, B10 live checks | a sandbox GitHub repo (e.g. `jeio-dev/segno-sandbox`) and `gh` logged in. Creating the repo is outward-facing, so the developer does it or explicitly asks for it |
| B10 | an Apple Developer Program membership, with its signing certificate and notarization credentials stored as GitHub Actions secrets [ADR-0043] |
| B10 release | the developer's explicit go to publish each GitHub Release, prereleases included [ADR-0043] |

## Event shape changes

Changes to an existing Event's shape before the first release [ADR-0035]. Delete local Event logs (`projects/<id>/segno.db` in the app data directory) after pulling any of these.

| Build phase | Event `type` | Change |
|---|---|---|
| | | |
