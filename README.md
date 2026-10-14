# Segno

Segno is a local desktop app that drives AI agents through a software development cycle while the developer supervises. One app holds many Projects; each Plan is an ordered list of Phases that end in pull requests.

**v1 is unreleased.** The workspace, Plan file library, offline Plan validation, the Engine's persisted Plan lifecycle, the Engine host and the desktop app shell are implemented: you can add Projects, set them up manually, and submit, review and approve Plans. Phases and Tasks don't run yet; an approved Plan's first Phase stays pending.

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
- Choose **Set up manually** to review the detected package manager, test and setup commands, base branch and Coder permissions. **Save** becomes available once the required fields are filled and writes `segno.config.json` with the chosen models (Docs uses `haiku`). Segno never commits the file: the Project shows a hint until it is on `<remote>/<baseBranch>`.
- Submit a Plan after saving the config. Agent-assisted onboarding arrives in B5.
- A missing or logged-out `gh` is a warning, not a refusal.

Settings holds the app's editor command and theme, and each Project's name, effective models (read-only for now) and **Remove project**, which can also delete the Project's Segno data. The repo itself is never touched.

### Submit and approve a Plan

With no Plan active, **Submit Plan file…** (or drop a `.yaml` or `.yml` file on the board) submits a Plan file. An invalid file lists every error as `line:column  code  message`. A valid one appears in **Awaiting you** and as the Project's count in the sidebar. **Review plan** shows every Phase and Task, with dependencies and Risk flags; **Approve** makes the Plan active, while **Send back** (notes required) and **Abandon** (reason required) close it. **Export Plan…** saves the active Plan as YAML.

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

`@segno/core` declares every v1 Event with its version and exposes the shared `project(events)` reducer. Its State contains `lastSeq`, Plans in submission order, and the Awaiting-you queue. B2 projects Plan lifecycle Events; later build phases add Task and Run behavior. It also exports zod schemas for the four Plan Commands, `onboarding.confirm`, and their results and rejection codes.

`@segno/engine` exposes `openEngine({ dbPath, clock?, isOnboarded?, configStore? })`. The host supplies the readiness check and config store for onboarding. The directory containing `dbPath` must already exist. `clock` is an optional `{ now(): Date }` port, defaulting to real time.

- `handle(command)` processes Commands in arrival order and returns `{ ok: true, events: number[] }` or `{ ok: false, code, message, errors? }`. Invalid payloads and Plan files append nothing; an unrecognizable Command type rejects the Promise with `BadRequestError` (`code: "bad-request"`).
- `readEvents(since?)` returns Events after a sequence number, in order. Events use `{ seq, type, v, ts, payload }`.
- `state` returns the State projected from the log. Submission creates a `plan-approval` item. Approval, send back and abandon clear it; send back retains notes and abandon retains its reason. Approval leaves all Phases `pending` until B4.
- `close()` drains queued Commands and closes SQLite. Further Commands are refused.

The Engine records the parsed Plan in SQLite; editing its source file cannot change it. Events have gap-free sequences and are appended in one transaction per accepted Command. Opening a database replays its log, and an unknown Event type or version stops startup with an error naming it. Slugs remain unique across the Project's entire Plan history; an empty derived slug uses `plan` ([ADR-0045](docs/adr/0045-empty-plan-slug-fallback.md)).

## Engine host

`@segno/host` exposes `startHost({ appData, adapters, clock?, ghBinary? })`, the composition root that the app runs in an Electron `utilityProcess`. It loads the Project registry, starts one Engine per Project that can run, and serves the [host protocol](docs/spec/api.md) over any message port: `command`, `query` (`board`, `awaiting`, `plans`, `plan`, `planExport`, `phases`, `phaseEvents`, `config`, `onboarding`), `subscribe` with replay from `since`, the `projects.*` calls and `settings.*`. `@segno/core` exports the protocol schemas and `createHostClient(port)`, which the window and the tests use. A Project that can't run (missing folder, not a repo, invalid config, unreadable Event log) is reported `unavailable` with its reason while the others keep running ([ADR-0047](docs/adr/0047-config-errors-and-project-availability.md)).

A Project without config and without any submitted Plan is `not-onboarded`: its Engine runs, its models live in `pending.json`, and Plan Commands are rejected `not-onboarded`. Manual confirmation validates and writes the config through the host config store and records `onboarding.confirmed`. A valid config supplied before startup records `via: file`. If config disappears after a Plan was submitted, the Project is unavailable; before any Plan, missing pending config is recreated with the Add defaults ([ADR-0050](docs/adr/0050-recover-missing-pending-config.md)).

## Development checks

```sh
pnpm check:b3.1
```

This chains `pnpm check:b3`: `pnpm check:b2` (the build, Biome, every Vitest suite including the S6 host tests, and the B2 exit scenario), then builds the app and drives it end to end with Playwright (S9) on temporary repos and a temporary app data directory. S9 needs a display; CI runs it under `xvfb-run` on Node 24. `pnpm test:e2e` reruns only S9 against the last app build.

`pnpm check:b1`, `pnpm check:b2` and `pnpm check:b3` remain available for the earlier exit checks.

Run `pnpm schema:generate` after changing structural rules, and review the resulting schema diff. [The build plan](docs/build-plan.md) describes the remaining work.
