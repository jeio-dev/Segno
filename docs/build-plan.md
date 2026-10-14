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
| B1 | Workspace and Plan file | done | [#6](https://github.com/jeio-dev/Segno/pull/6) |
| B2 | Event log and reducer | done | [#7](https://github.com/jeio-dev/Segno/pull/7) |
| B3 | Engine host, app shell and Projects | done | [#8](https://github.com/jeio-dev/Segno/pull/8) |
| B3.1 | Adding a Project without a config | done | [#11](https://github.com/jeio-dev/Segno/pull/11) |
| B4 | Happy-path Task with a fake Adapter | done | [#12](https://github.com/jeio-dev/Segno/pull/12) |
| B5 | Claude Code Adapter | done | [#13](https://github.com/jeio-dev/Segno/pull/13) |
| B6 | Failure paths | done | [#14](https://github.com/jeio-dev/Segno/pull/14) |
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
- **Toolchain.** ESM only (`module: nodenext`), `tsc --build` with project references, Vitest, Biome, tsdown to bundle `cli`, electron-vite for `app` and `ui` (from B3), and electron-builder for releases (B10). `better-sqlite3` ships N-API prebuilds that load in both Node and Electron, so it isn't rebuilt (B3). `engines.node` is `>=22`.
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

**B2 implementation decisions, agreed with the developer:**

- `openEngine({ dbPath, clock? })` exposes `handle(command)`, `readEvents(since?)`, a projected `state` getter, and async `close()` that drains queued Commands. Plan ids are UUIDs. The Event envelope is `{ seq, type, v, ts, payload }`.
- State is `{ lastSeq, plans, awaiting }`. Plans retain their definition, slug, lifecycle state, notes or reason, and Phase states in submission order. Awaiting-you items use the API-spec shape.
- The clock port is `{ now(): Date }`, defaulting to real UTC time. The runtime Command schema covers B2's four Plan Commands; later build phases extend it.
- An empty derived Plan slug uses `plan`, then the existing collision rule [ADR-0045].

**Verification:** implementation and local code review are complete. `pnpm check:b2` passes on Node 22.23.3 and 24.21.0 with 122 tests (49 at S2/S3), plus the S3 exit script that prints the Event log. Frozen-lockfile installation passes. The PR's GitHub Actions matrix runs the same check on Node 22 and 24; both jobs must be green before merge. B2 introduces the initial v1 Event declarations and changes no existing Event shape.

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

**B3 implementation decisions, agreed with the developer:**

- New spec decisions: `projects.rename` [ADR-0046]; config error shape and codes, `unavailable` reasons and the `config` query's shape [ADR-0047]; the app data directory, `SEGNO_APP_DATA` and `<appData>/chromium/` [ADR-0048].
- **Project models are read-only in B3.** Settings shows each Role's effective model and its source from the `config` query; editing arrives with `config.setModel` in B8.
- **Host protocol.** `startHost({ appData, adapters, clock?, ghBinary? })` returns `{ connect(port), close() }`. Requests are `{ id, call, args }`; responses are `{ id, result }` or `{ id, error }`; a stream sends `{ id, item }` and is cancelled with `{ id, cancel: true }`. The schemas and a browser-safe `createHostClient(port)` live in `core`, and S6 drives the host through that client over a real `MessageChannel`. `subscribe` registers, acknowledges and replays in one tick, so nothing is missed or duplicated.
- **Commands at the boundary.** The host checks only that a Command is an object with a string `type` (otherwise `bad-request`). The Engine rejects v1.2 Commands `unsupported-in-version` before any payload validation; v1 Commands not built yet stay `bad-request`.
- **Detection** [ADR-0039]: the package manager comes from the root lockfile, then `packageManager` in `package.json`, then npm if a `package.json` exists. The test command is `<pm> test` when a `test` script exists, otherwise blank, and **Add** stays disabled until it's filled. The setup command is set only with a lockfile (`pnpm install --frozen-lockfile`, `yarn install --immutable` with `.yarnrc.yml` or `--frozen-lockfile` without, `npm ci`, `bun install --frozen-lockfile`). The remote is `origin`, else the first remote. The base branch comes from `refs/remotes/<remote>/HEAD`, then `main` or `master` on the remote, then the current branch. Models are planner `opus`, coder `sonnet`, coder-docs `haiku`, reviewer `opus`. The Coder's `allow` is `Bash(<pm> *)`. Keys left at their defaults are omitted from the written file.
- **`allow` validation** [ADR-0004] is `validateAllow` in `adapter-claude-code`. An entry must be `Tool` or `Tool(specifier)`. A Bash rule is refused when its glob (with `:*` read as ` *`) can match any always-denied git command with or without arguments, so bare `Bash` and `Bash(*)` are refused. An entry naming a bypass mode is refused. Indirection such as `Bash(sh -c *)` isn't analyzed; the Adapter's deny list enforces at run time (B5).
- **`projects.add`** writes `segno.config.json` only when it's missing, after validating the reviewed settings (`bad-request` otherwise), and never overwrites an existing file. A repo with an invalid committed file is still added and shows as `unavailable`. `projects.locate` also refuses a repo that's already another Project, and only an `unavailable` Project can be located.
- **Board in B3:** `{ plan, phase }`, where `phase` stays `null` until B4 starts Phases. While a Plan awaits approval the board's empty state links to its Plan review instead of offering submission.
- **App.** Electron 44.7.0 (Node 24.21.0), electron-vite 5.0.0 with Vite 7.3.7, React 19.3.0, Playwright 1.64.0 and the three `@fontsource` families at 5.3.0, pinned exactly. The window is sandboxed with context isolation; the preload exposes only the dialogs and the host port, which reaches the page as a window message. The built window has a strict Content Security Policy. Until B8's tray, closing the window quits the app.
- **S9** launches the built app with a temporary `SEGNO_APP_DATA`. Dialogs are replaced in the main process through Playwright, and the host's pid comes from `app.getAppMetrics()`. The app has no test-only code paths.

**Verification:** `pnpm check:b3` passes on Node 24.21.0: 164 Vitest tests, including 36 at S6; the B2 exit script; and 8 S9 journeys against the built app. CI runs it on Node 24 under xvfb. Local and cloud code reviews are complete, and their accepted findings are fixed.

## B3.1: Adding a Project without a config

A follow-up to B3, raised after using it: typing a test command before a Project could be added was too much friction [ADR-0049]. Branch `build/b3.1-not-onboarded`.

**Implements:** [gui.md § Adding a Project](spec/gui.md#adding-a-project) and [§ Onboarding](spec/gui.md#onboarding) except the onboarding Run and `onboarding-review`; the `not-onboarded` status and the `projects.inspect` and `projects.add(path, models?)` changes in [api.md](spec/api.md#app-level-calls); the `config` query's `pending` and the `onboarding` query; [engine.md § Onboarding](spec/engine.md#onboarding) for `onboarding.confirm` (`via: manual`), `via: file` at Engine start, and the `not-onboarded` rejection; [config.md § Pending config](spec/config.md#pending-config); the `missing-file` rule. [ADR-0039] [ADR-0047] [ADR-0049].

**Delivers:**
- `host`:
  - the models-only `projects.add`
  - `pending.json`
  - the `not-onboarded` status and the Project's Engine running in it
- `engine`:
  - `onboarding.confirm` writing `segno.config.json` from the form plus the pending models
  - `onboarding.confirmed`
  - the `not-onboarded` rejection
- `ui`:
  - the Add dialog with three model fields
  - the not-onboarded board, showing only **Set up manually** until B5
  - the B3 settings form, moved behind Set up manually and prefilled by the B3 detection
- The B3 detection is unchanged, except that a blank test command now only disables the form's **Save**.

**Seams:** S6, S9.

**Exit check (`pnpm check:b3.1`):**
- **S6:**
  - `projects.add` with models on a repo with no config gives `not-onboarded`, with `pending.json` written and the repo untouched.
  - `plan.submit` is rejected `not-onboarded`.
  - `onboarding.confirm` with an invalid config is rejected `validation` and writes nothing.
  - A valid one writes `segno.config.json` with the pending models, deletes `pending.json` and makes the Project `running`.
  - A config placed in the repo before the Engine starts records `onboarding.confirmed { via: file }`.
  - A Project whose config disappears after a Plan was submitted is `unavailable` with `missing-file`.
- **S9:**
  - Adding a temp repo with no config shows only the model fields. **Add** lands on the not-onboarded board.
  - **Set up manually** shows the detected settings, and **Save** writes `segno.config.json` without committing it, so the commit hint shows.
  - The B3 S9 journeys still pass, with the add journey going through Set up manually.

**Interim state:** **Onboard project** isn't shown until B5, so `onboarding.start` and `onboarding.stop` stay `bad-request`.

**Docs:** the README's "adding a Project" says how to add a Project and set it up by hand.

**B3.1 implementation notes:**
- Missing pending config is recreated with the Add defaults only when the Project is not onboarded [ADR-0050]. Existing pending config is validated.
- `projects.add` still requires models when the repo has no config; an existing config ignores that argument. `projects.inspect` returns `source: models` and the default models, or `source: file` with its validation result. Detection is returned by the `onboarding` query.
- An existing valid config records `onboarding.confirmed { via: file }` on a new Project. Confirmation is per transition into onboarded, not once per Project: if config disappears before any Plan and the Project becomes not onboarded again, restoring the file records another confirmation at startup. Ordinary restarts do not repeat confirmation. Existing Plan history needs no retrospective confirmation. Manual confirmation keeps the Engine and its subscriptions alive.
- Model editing (`config.setModel`), file watching and pruning remain in B8. The onboarding Run and its start/stop Commands remain in B5.

**Verification:** `pnpm check:b3.1` passes on Node 24.21.0: 174 Vitest tests (46 at S6), the B2 exit scenario, and 9 S9 journeys against the built app. Code review is complete. CI passed on [#11](https://github.com/jeio-dev/Segno/pull/11).


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

**B4 implementation notes:**
- A Task holds the run slot from `coding` through `merging` [ADR-0051], so with one slot each Task is worked end to end and, in a linear flow, the merge re-test is skipped. The merge queue is still enforced: only the earliest Task to enter `merging` runs its merge step.
- The re-test is skipped exactly when the merge finds nothing to merge, which is when the Phase branch hasn't moved since the Task branch was cut or last merged. No Event records the cut point.
- The app registers the fake Adapter only when `SEGNO_FAKE_ADAPTER=1`, which S9 sets. Without it, Tasks stay `ready` until B5 wires the real Adapter.
- Not yet handled, each left for its build phase: a high-risk approve, a reject or a malformed Verdict leaves the Task in `reviewing` (B6); a failed Run, test or setup, a merge conflict, a Run that can't start and a git failure while processing an outcome record `run.finished` (`failed` or `crashed`) and leave the Task where it is (B6); nothing is recovered when an Engine reopens, so a restart mid-Plan leaves it stopped (B8). A Phase branch that can't be cut after a successful fetch is logged and the Phase stays `starting`. Agent Runs get a placeholder prompt and no `outputSchema` until B5.
- Task ids are unique only within a Plan, so a Task id means the newest Plan's Task, and `merged.diff` is kept per Plan at `tasks/<plan-slug>/<task-id>/` [ADR-0052]. A Plan slug also avoids `segno/<slug>/*` branches left in the repo by an earlier Event log [ADR-0053].
- `runOutput` replays what a live Run has printed so far before streaming the rest.
- `plan.abandon` cleans up worktrees on a best-effort basis after its Events are recorded; a failure is logged, and B8's startup cleanup removes the leftovers.
- Approval now records the first Phase as `starting` in State. Phases, Tasks and Runs are derived from the existing Events; `plan_id` is now filled for every Event about a Plan's Phases, Tasks or Runs. No Event shape changed.
- `phaseEvents` now also returns the Phase's Task and Run Events, which carry only a Task or Run id.

**Verification:** `pnpm check:b4` passes on Node 24.21.0: 201 Vitest tests (13 at S4, 7 new at S3 and 7 new at S6), the B2 exit scenario, and 11 S9 journeys against the built app. Code review is complete; its findings are fixed, two of them through ADR-0052 and ADR-0053.

## B5: Claude Code Adapter

**Implements:** [runners.md § Claude Code Adapter (v1)](spec/runners.md#claude-code-adapter-v1), [§ Permission profiles](spec/runners.md#permission-profiles), [§ Run context](spec/runners.md#run-context) (first-pass Coder, Reviewer and Docs prompts, `probe`), [§ Verdict schema](spec/runners.md#verdict-schema), [§ Adapter interface](spec/runners.md#adapter-interface) capability gating; [config.md § Validation](spec/config.md#validation) Adapter checks, shown in the add-project flow; onboarding: [engine.md § Onboarding](spec/engine.md#onboarding) in full, [runners.md](spec/runners.md) the `onboarding` Run kind, its profile, context and [§ Onboarding proposal](spec/runners.md#onboarding-proposal), and the Coder's self-test line, plus [gui.md § Onboarding](spec/gui.md#onboarding) and `onboarding-review`; usage reporting in the `board` query and the board's subscription usage control. [ADR-0004] [ADR-0016] (schema only) [ADR-0017] [ADR-0018] [ADR-0021] (classification only) [ADR-0024] [ADR-0030] [ADR-0049].

**Delivers:**
- `adapter-claude-code`: `detect()`, the flag mapping re-checked against the installed Claude Code (2.1.296 at planning time), stream parsing, classification, `stop()`.
- Recorded fixtures for every classification, and `pnpm test:live` to re-record them.
- Built-in prompt templates, including the Docs task's, and `prompt.md` written before every agent Run.
- The app wires the real Adapter into `startHost`.
- Onboarding: the Engine's onboarding Run, Events and scratch worktree; the onboarding prompt and proposal schema; **Onboard project**, the live output, **Stop onboarding**, **Retry onboarding** and the `onboarding-review` item with Confirm and Edit.

**Seams:** S5, S6, S9, plus live.

**Exit check (`pnpm check:b5`):** Replayed fixtures classify `completed`, `failed`, `crashed` and `rate-limited` (with and without `resetAt`) correctly, and the replay stub's argv matches the runners.md flag table.
- **S6, onboarding with the fake Adapter:**
  - A valid proposal → `onboarding-review` → `onboarding.confirm` writes the config.
  - `unable` and `invalid-proposal` record `onboarding.failed`.
  - `onboarding.stop` records `onboarding.stopped`.
  - Every outcome removes the scratch worktree, and none uses a budget.
- **S9:** Onboard project with the fake Adapter shows the review with its flags, and Confirm makes the Project `running`.
**Live (`pnpm check:b5:live`, developer-triggered, uses the developer's Claude subscription):** in a throwaway repo added as a Project, a one-Task Plan reaches `done` with the real `claude`. `prompt.md` contains exactly the Run-context ingredients. In a second throwaway repo with a passing `test` script, **Onboard project** proposes that script with its exit code and duration, and Confirm writes it. Fixtures are re-recorded against the installed version.

**Note:** if the installed Claude Code's flags differ from runners.md, the difference is raised and recorded as an ADR before the mapping changes.

**B5 implementation notes:**
- Claude Code 2.1.299 has every flag in the runners.md table. The fixtures were recorded with it, and `detect()` reports `usage` from 2.1.299 on. Usage comes from the stream's `rate_limit_event`: the window the CLI names as binding, else the fullest, as a percentage with `limit: 100`. A rejected status (unless the CLI carries on with overage), or a synthetic `rate_limit` error message, makes the Run `rate-limited`, unless the Run still completed without error.
- The rate-limited fixtures are derived from the failed recording, since a usage limit can't be hit on demand (`tests/fixtures/README.md`). `pnpm test:live` re-records every fixture through the Adapter's transcript tee.
- Every agent Run's `systemPrompt` is empty, so `prompt.md` holds the whole context. The Reviewer gets the Verdict schema as its `outputSchema`, and the diff range is the merge-base with the Phase branch. Only a Verdict that matches the schema is recorded; until B6 repairs malformed ones, the Task stays in `reviewing`. The Docs task's range starts at the Phase's base commit.
- A probe Run has no tools: the Adapter passes `--tools ""` for `kind: probe` [ADR-0054]. B5 adds the probe's context (`probeSpec`); B8 starts probe Runs.
- The always-denied git operations are prefix rules in Claude Code, so under the onboarding profile's unrestricted shell they're best effort [ADR-0055].
- Runs keep `--setting-sources project` so Claude Code reads the repo's `CLAUDE.md`. The repo's `.claude/settings.json` allow rules come with it, so the Adapter denies every one the Run doesn't already allow [ADR-0056].
- `stop()` keeps its SIGKILL escalation until the Run's whole process group has gone, so a tool process that ignores SIGTERM can't outlive claude.
- Claude Code can't resolve the draft 2020-12 `$schema` key that the generated output schemas declare, so the Adapter drops it from `--json-schema`. A Run that ends without a result carries claude's stderr as its detail [ADR-0057].
- Every agent Run's context lists the shell commands its profile allows and asks for one per call, since Claude Code refuses a joined command whole and agents then stop using the shell [ADR-0058].
- Claude Code has no Glob or Grep tool, so the Coder and Reviewer profiles add `ls *`, `grep *`, `git ls-files *` and `git grep *` [ADR-0059].
- The live Plan scenario seeds a `CHANGELOG.md` for the Docs task. Since B5 neither retries a Run nor sends work back, it fails at once, with the Run's detail or the Reviewer's answer, when a Run doesn't complete or a Reviewer doesn't approve. The onboarding scenario likewise shows the failure instead of waiting.
- The CLI enforces one object schema, so the onboarding output schema it gets puts both kinds in one object. The Engine then validates against the strict `proposal | unable` union.
- `onboarding.proposed` records the proposal as a whole `segno.config.json`: the agent's values, the pending models, `coderAllow` as `roles.coder.allow`, the reasons' pointers moved to match, and the `ref` and `sha` the checks ran on. **Confirm** sends `proposal.config`, and **Edit** prefills the manual form with it.
- An onboarding Run that ends `failed` is recorded with its own outcome, and `onboarding.failed { reason: crashed }` with the CLI's message. A rate-limited one records only `run.finished { rate-limited }` and returns onboarding to `idle`, until B8 pauses and reruns it. Timeouts and `hung` are B6.
- **Stop onboarding** also ends an onboarding Run left without an outcome by a restart. A scratch worktree left behind is removed when the next onboarding starts.
- `onboarding.start` is rejected `invalid-transition` while a proposal awaits review, so the `onboarding-review` item is resolved only by `onboarding.confirm` or a config that appears by itself.
- A Role whose Adapter isn't installed or lacks a capability is an `adapter` config error at `/roles/<role>/adapter`, both in `projects.inspect` and at Engine start.
- Subscription usage is held in memory by the host, app-wide per Adapter, and returned by the `board` query. The window reads it from there, because it derives the rest of the board from Events.
- No existing Event's shape changed. `onboarding.started`, `onboarding.proposed`, `onboarding.failed` and `onboarding.stopped` are new Event types. State gains `onboarding`, and Awaiting-you items gain the `onboarding-review` kind with a `runId`.
- The replay stub now installs its SIGTERM handler before printing, and `expect.poll` waits up to 10 s, since whole Task flows on real git can take longer than the 1 s default under a full parallel run.

**Verification:** `pnpm check:b5` passes on Node 24.21.0: 241 Vitest tests (26 at S5, 14 new at S6), the B2 exit scenario, and 14 S9 journeys against the built app (3 new). Code review is complete, and its findings are fixed, recorded as ADR-0055 and ADR-0056, or deferred: a claude process that outlives a crashed host is B8's restart recovery. The developer ran the live check, `pnpm check:b5:live`, against Claude Code 2.1.299. It passes: the fixtures were re-recorded, the one-Task Plan reached `done`, and onboarding proposed and confirmed the test script. The runs before that pass led to ADR-0057, ADR-0058 and ADR-0059.

## B6: Failure paths

**Implements:** [engine.md § Automatic transitions](spec/engine.md#automatic-transitions) failure rows (test failure, reject, malformed Verdict, merge re-test failure, merge conflict, infra failure) and the budget rule; [§ Blocked Tasks and their dependents](spec/engine.md#blocked-tasks-and-their-dependents); [§ Findings](spec/engine.md#findings); [§ Verdict handling](spec/engine.md#verdict-handling) with repair; [§ Infra failures](spec/engine.md#infra-failures) with backoff; `held` with `task.approve` and `task.sendBack`; the `merge-hold` and `blocked` Awaiting-you items. [runners.md § Timeouts](spec/runners.md#timeouts), [§ Run context](spec/runners.md#run-context) later Coder passes (blocking Findings, test log tail, conflicting files) and re-review. [gui.md](spec/gui.md): the Blocked column, Block reason, budget and wait-reason badges, the high-risk badge, the drawer's Review tab, and the Approve and Send back actions with their Awaiting-you items. [ADR-0005] [ADR-0011] [ADR-0014] [ADR-0015] [ADR-0016] [ADR-0019] [ADR-0024] [ADR-0028] [ADR-0029].

**Seams:** S2, S3, S9.

**Exit check (`pnpm check:b6`):**
- **S3 matrix**, with the `board` State showing the expected Block reason and budgets at each step:
  - 2 rejects → `review-limit`
  - 2 failing test runs → `test-limit`
  - 3 malformed Verdicts, repaired by resume → `verdict-invalid`
  - 3 crashes, with retries after 30 s / 2 min and immediate blocking on the third failure → `infra-limit` [ADR-0060]
  - 3 failed setup Runs → `setup-failed`
  - a Coder timeout and an idle timeout count as infra failures
  - a high-risk Task (from the Plan, or raised by a Verdict) → `held` → `task.approve` lands it
  - `task.sendBack` returns it to `coding`
  - a merge conflict → `coding` with the files listed
  - a dependent of a Blocked Task stays `waiting` with its wait reason
- **S9:** a `held` Task is approved from Awaiting you and reaches Done. A Blocked card shows its Block reason and budgets.


**B6 implementation notes:**
- Follow-up verification of all ten PR #14 review comments is recorded in [the review dispositions](reviews/pr-14.md). Confirmed start, conflict-context, git-lock and Send back preparation failures are fixed in the PR follow-up; the full local `pnpm check:b6` passes for those fixes with 283 Vitest tests, the B2 exit scenario and 17 S9 journeys.
- Infra retries wait 30 seconds after failure 1 and 2 minutes after failure 2. Failure 3 blocks immediately [ADR-0060]. Budgets are whole-life counts; a valid Verdict closes earlier Findings and records its own Findings and risk.
- Every agent event resets the idle deadline. Agent timeouts await `stop()` before processing the outcome. Script and merge timeouts stop their process groups; scripts escalate when SIGTERM is ignored. Onboarding timeouts remove the scratch worktree and use no Task budget.
- High-risk approvals enter `held`. Approve and Send back resolve the Awaiting-you item, and scheduling preserves the single slot even when several holds are resolved together.
- Rejected reviews, failed tests and merge conflicts supply the next Coder or Docs pass with the relevant blocking Findings, last 200 test-log lines and full log path, or conflicting files. Re-review includes recorded risk and open blocking Findings. Repairs resume when supported and preserve the Shell section; otherwise they start a fresh review.
- A conflict resolution that matches the previous HEAD still finishes its pending merge commit. A timed-out merge can retry a pending clean merge commit. Git failures while creating a worktree or preparing a retry also consume infra budget.
- The board exposes budgets, Block reasons, dependency waits and risk flags. The Review tab lists valid and malformed Verdicts, checklists, docs checks, Findings and raised risk. Both the drawer and Awaiting you offer Approve and Send back.
- The B5 live harness now allows review send-backs and infra retries, and checks Verdict decisions explicitly. It stops with details on `blocked` or `held`; B6 has no live check.
- No existing Event shape changed. The reducer and board gain the read-model fields needed for Findings, risk and malformed review history. Restart recovery, developer Commands other than Approve / Send back, and Phase PRs remain B8, B7 and B9 respectively.

**Verification:** `pnpm check:b6` passes on Node 24.21.0: the workspace build and Biome, 278 Vitest tests, the B2 exit scenario, and 17 S9 journeys against the built app. Code review against the B6 plan, specs, ADRs and repository standards is complete; its findings are fixed and covered at S2, S3 or S9. B6 has no live check. CI also passes ([run 38641006741](https://github.com/jeio-dev/Segno/actions/runs/38641006741), attempt 2) on the implementation commit `115fbc9`, and [PR #14](https://github.com/jeio-dev/Segno/pull/14) is open. Attempt 1 hit the five-second timeout in an existing happy-path Engine test; rerunning the same commit passed the full check.

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
| B3 | `config.rejected` | `errors` are config errors (`{ file, path, line?, column?, code, message }`) instead of Plan file validation errors [ADR-0047]. No such Event had been written |
| B3.1 | `config.rejected` | The shared config-error shape also accepts `pending.json` as `file` [ADR-0049] [ADR-0050]. No such Event has been written; `onboarding.confirmed` is a new Event type |
