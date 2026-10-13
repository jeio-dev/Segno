# Segno

Segno is a local desktop app that drives AI agents through a software development cycle while the developer supervises. One app holds many Projects; each Plan is an ordered list of Phases that end in pull requests.

**v1 is unreleased.** The workspace, Plan file library, offline Plan validation, and the Engine's persisted Plan lifecycle are implemented. The desktop app and Task execution are still being built.

## Run Plan validation from a checkout

Development requires Node 22.18+ or 24.11+ and Corepack. The workspace pins pnpm through `packageManager`; the built CLI targets Node 22.

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

`@segno/core` declares every v1 Event with its version and exposes the shared `project(events)` reducer. Its State contains `lastSeq`, Plans in submission order, and the Awaiting-you queue. B2 projects Plan lifecycle Events; later build phases add Task and Run behavior. It also exports zod schemas for the four Plan Commands and their results and rejection codes.

`@segno/engine` exposes `openEngine({ dbPath, clock? })`. The directory containing `dbPath` must already exist. `clock` is an optional `{ now(): Date }` port, defaulting to real time.

- `handle(command)` processes Commands in arrival order and returns `{ ok: true, events: number[] }` or `{ ok: false, code, message, errors? }`. Invalid payloads and Plan files append nothing; an unrecognizable Command type rejects the Promise with `BadRequestError` (`code: "bad-request"`).
- `readEvents(since?)` returns Events after a sequence number, in order. Events use `{ seq, type, v, ts, payload }`.
- `state` returns the State projected from the log. Submission creates a `plan-approval` item. Approval, send back and abandon clear it; send back retains notes and abandon retains its reason. Approval leaves all Phases `pending` until B4.
- `close()` drains queued Commands and closes SQLite. Further Commands are refused.

The Engine records the parsed Plan in SQLite; editing its source file cannot change it. Events have gap-free sequences and are appended in one transaction per accepted Command. Opening a database replays its log, and an unknown Event type or version stops startup with an error naming it. Slugs remain unique across the Project's entire Plan history; an empty derived slug uses `plan` ([ADR-0045](docs/adr/0045-empty-plan-slug-fallback.md)).

## Development checks

```sh
pnpm check:b2
```

This builds all eight packages and the standalone CLI bundle, runs Biome and the S1/S2/S3/S7 tests, and runs the B2 exit scenario against a temporary SQLite database, printing its Event log. It also retains B1's schema and CLI fixture checks from a temporary directory outside git. CI runs it on Node 22 and 24. `adapter-claude-code`, `host`, `app` and `ui` remain empty shells.

`pnpm check:b1` runs the build, lint and current workspace test suite without the B2 exit script.

Run `pnpm schema:generate` after changing structural rules, and review the resulting schema diff. [The build plan](docs/build-plan.md) describes the remaining work.
