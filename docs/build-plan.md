# Segno v1 build plan

This is the order in which v1 gets built. v1 is defined in [spec/README.md § v1 cut line](spec/README.md#v1-cut-line) and [ADR-0030]: the headless core with the CLI as its only interface, `concurrency` fixed at 1, the Claude Code Adapter only, and the GitHub forge through `gh`. Anything marked **(v1.1)**, **(v1.2)** or **(later)** in the spec is out, except that the v1 server answers those Commands with `unsupported-in-version`.

> **"Build phase" is not "Phase".** A build phase (`B1`…`B10`) is a step in building Segno. It has nothing to do with the domain term *Phase* in [glossary.md](glossary.md), which is a slice of a Segno Plan. This document always writes "build phase" in full, or uses the id.

## Rules

- **The spec and ADRs are settled.** This plan only orders and slices them. If a build phase exposes a real gap, it's raised with the developer and recorded as a new ADR, together with the matching spec edit, in the same PR. It is never patched silently in code or in this plan.
- **One build phase is one mergeable PR**, on a branch `build/bN-<slug>` cut from `main`. The developer merges it.
- **Every PR ships its docs** ([Docs per PR](#docs-per-pr)).
- **Tests are written test-first, only at the agreed seams** ([Seams](#seams)), in vertical slices (see `.claude/skills/tdd`).
- **A build phase is done when its exit check passes:** `pnpm check:bN` exits 0, plus the live check where one is listed.
- **Event shapes may change until the first release** [ADR-0035]. Every change to an existing Event's shape is logged in [Event shape changes](#event-shape-changes), and local `.segno/segno.db` files are deleted, not migrated. The catalog freezes in B10.

## Status

| Id | Build phase | Status | PR |
|---|---|---|---|
| B1 | Workspace and Plan file | not started | |
| B2 | Event log and reducer | not started | |
| B3 | Server and CLI skeleton | not started | |
| B4 | Happy-path Task with a fake Adapter | not started | |
| B5 | Claude Code Adapter | not started | |
| B6 | Failure paths | not started | |
| B7 | Developer Task Commands | not started | |
| B8 | Resilience | not started | |
| B9 | GitHub forge and multi-Phase | not started | |
| B10 | `segno init` and v1 release | not started | |

## Workspace

A pnpm workspace [brief §Decided], built as one monorepo and shipped as one bundled `segno` package [ADR-0034]:

```
package.json            private workspace root; packageManager pins pnpm (corepack)
pnpm-workspace.yaml     packages: ["packages/*"]
tsconfig.base.json
biome.json
vitest.config.ts        one project per package
examples/               example Plan files and invalid fixtures
schemas/                committed JSON Schemas (Plan file, config) [ADR-0002] [ADR-0025] [ADR-0034]
packages/
  plan-format/          browser-safe: YAML parse, validate, fragments, export, JSON Schema
  core/                 browser-safe: Event catalog, reducer, Command and rejection schemas,
                        Verdict schema, config schemas, AgentAdapter and RunSpec types
  engine/               Node: Engine loop, SQLite Event log, timers, Watchdog, budgets, Run
                        context and prompts, script Runs, git and worktrees, gh forge
                        (+ @segno/engine/testing: fake Adapter, fake clock, temp repos)
  adapter-claude-code/  Node: claude -p mapping, stream parsing, classification, fixtures
  server/               Hono app and SSE; exports AppType and startServer(deps)
  cli/                  the segno bin: typed Hono client, offline plan validate, init, serve
```

- **Boundaries enforced by the compiler.** `core` and `plan-format` build with `lib: ["ES2023"]` and no `@types/node`, so the reducer stays usable by the v1.1 GUI [ADR-0007]. The Engine depends only on the `AgentAdapter` interface in `core` [ADR-0017]. `startServer(deps)` is the composition root: `segno serve` passes the real Adapters, and tests pass fakes.
- **Toolchain.** ESM only (`module: nodenext`), `tsc --build` with project references, Vitest, Biome, and tsdown to bundle `cli` into `segno` with `better-sqlite3` external [ADR-0034]. `engines.node` is `>=22`.
- **CI.** GitHub Actions on every PR, on Node 22 and 24: install, `tsc --build`, Biome, Vitest. Real-git tests run in CI. Real `claude` and `gh` never do.
- **Exit-check harness.** One root script per build phase, `pnpm check:bN`, runs that build phase's exit scenario. Live checks are `pnpm check:bN:live`, and the developer triggers them.

## Seams

Tests sit only at these seams. Mocks appear only at system boundaries: the agent CLI, the clock and `gh`. Git, SQLite and the shell run for real, in temp dirs. Expected values are literals from the spec, never recomputed by the code under test.

| Id | Seam | Driven through | Catches | Misses |
|---|---|---|---|---|
| S1 | Plan file API (`plan-format`) | `parsePlan`, `validateFragment`, `exportPlan`; every fixture also checked against the committed JSON Schema | every validation code with line and column; export round-trip; drift between zod rules and the JSON Schema | how the Engine uses a Plan |
| S2 | Reducer (`core`) | `project(events) → State` over hand-written Event sequences | derivation of board, Awaiting you, budgets and wait reasons | whether the Engine emits the right Events |
| S3 | Engine (`engine`), the main seam | `engine.handle(command)` plus injected ports (fake AgentAdapter, fake clock, fake Forge), observed through appended Events and derived State. Real git (temp repo plus bare remote), real `sh -c`, real SQLite on a temp file | every Plan, Phase and Task table row; budgets; merge queue; Verdict repair; recovery by reopening the DB | real `claude` and `gh`; HTTP and CLI |
| S4 | Git module (`engine`) | its own functions against temp repos | conflicts, dirty trees, stale worktrees, lockfile-change detection, commit trailers | when the Engine calls it |
| S5 | Claude Code Adapter | `adapter.start(spec)` with `binary` pointed at a replay stub that records argv and replays recorded `stream-json`, exit codes and signals | flag mapping, the four classifications, `resetAt`, `RunEvent`s, `stop()` | real CLI drift, covered by the opt-in live contract test `pnpm test:live` |
| S6 | HTTP API (`server`) | the in-process Hono app (`app.request`, typed client) on a real Engine and a fake Adapter | host, token and origin checks; 200-with-rejection; query shapes; SSE replay with `Last-Event-ID`; `410 pruned` | CLI rendering and exit codes |
| S7 | CLI (`cli`, the built bundle) | the `segno` binary as a subprocess, against a server started with `startServer({ adapters: [fake], clock })` | arguments, exit codes 0/1/2/3, output, server discovery, `watch` bell and reconnect | Engine logic (S3 owns it) |
| S8 | gh Forge module (`engine`) | the forge functions with `gh` pointed at a replay stub | PR creation and body, PR state parsing, missing or logged-out `gh` | real GitHub behavior, covered by the B9 live check |

## Docs per PR

Every build phase's PR updates, as relevant:

1. **`docs/build-plan.md`:** its row in [Status](#status) (`done` and the PR link), any notes, and every Event shape change [ADR-0035].
2. **`README.md`:** created in B1. Each build phase adds the `segno` commands that now work. Until B10 it says plainly that v1 is unreleased.
3. **`CHANGELOG.md`:** created in B1 in Keep a Changelog format, with entries under `Unreleased`. B10 turns them into `1.0.0`.
4. **Spec and ADRs:** changed only through a new ADR plus the matching spec edit, after asking the developer.

---

## B1: Workspace and Plan file

**Implements:** [plan-format.md](spec/plan-format.md) in full (schema, field rules, automatic Docs task definition, validation, fragments, export, as a library); [cli.md § Conventions](spec/cli.md#conventions) (repo discovery, exit codes 0 and 2) and `segno plan validate`. [ADR-0002] [ADR-0011] [ADR-0012] [ADR-0030] [ADR-0034].

**Delivers:**
- The workspace, toolchain, CI and the six packages.
- `plan-format`: parsing with line and column, every validation code, replan and split fragment checks (given the Plan's id history), export with `generated: true` Docs tasks.
- `schemas/plan-file.v1.json`, equivalent to the zod rules.
- `examples/` with a valid two-Phase Plan and at least one invalid fixture per validation code.
- `segno plan validate <file>`, offline. Other subcommands are a usage error (exit 2) until they exist.
- `pnpm pack` of the `segno` bundle.

**Seams:** S1, S7 (offline).

**Exit check (`pnpm check:b1`):** The packed tarball is installed into a temp prefix. `segno plan validate examples/two-phase.yaml` exits 0. Each `examples/invalid-*.yaml` exits 2 and prints every error as `file:line:column  code  message`. The committed JSON Schema accepts and rejects exactly the same fixture set. CI is green on Node 22 and 24.

**Docs:** creates `README.md` (what Segno is, installing from a tarball, `plan validate`) and `CHANGELOG.md`.

## B2: Event log and reducer

**Implements:** [engine.md § Processing model](spec/engine.md#processing-model), [§ Plan lifecycle](spec/engine.md#plan-lifecycle) (submit, approve, send back, abandon; slug derivation), [§ Commands](spec/engine.md#commands) for the Plan Commands, [§ Rejection codes](spec/engine.md#rejection-codes), [§ Event catalog](spec/engine.md#event-catalog) (all v1 types declared); [store.md § The Event log](spec/store.md#the-event-log) and the `.segno/` directory. [ADR-0007] [ADR-0012] [ADR-0013] [ADR-0022] [ADR-0031] [ADR-0033] [ADR-0035].

**Delivers:**
- `core`: Event types with `v`, the reducer and derived State (Plans and the Awaiting-you queue so far), Command and rejection schemas.
- `engine`: the SQLite Event log (gap-free `seq`, one transaction per Command), single-writer processing in arrival order, and the Plan lifecycle Commands.
- Replay on open; an unknown `type` or `v` stops startup and names it.

**Seams:** S2, S3.

**Exit check (`pnpm check:b2`):** An S3 script that prints the Event log. Submit → `plan.submitted` plus a `plan-approval` item. A second submit is rejected `plan-exists`. An invalid file is rejected `validation` with errors and appends nothing. Send back, abandon and approve each reach their state. Closing and reopening the DB gives an identical projected State. An unknown `type`/`v` in the log stops startup and names it.

**Interim state:** approving a Plan makes it `active`, but its first Phase stays `pending` until B4. There's no interface yet; B3 adds it.

## B3: Server and CLI skeleton

**Implements:** [api.md](spec/api.md) binding and lifecycle, authentication and request checks (token; the cookie and `/auth` are v1.1), [§ Commands](spec/api.md#commands), the queries `/api/board` (Plan and Phase level), `/api/awaiting`, `/api/plans`, `/api/plans/:id`, `/api/plans/:id/export`, `/api/phases`, `/api/phases/:id/events`, `/api/config`, `/api/health`, [§ Event stream](spec/api.md#event-stream), [§ Error format](spec/api.md#error-format); `unsupported-in-version` for v1.1 and v1.2 Commands. [store.md § `.segno/` layout](spec/store.md#segno-layout) (`server.json` lock, `server.log`). [config.md](spec/config.md) both files and § Validation (Adapter checks come in B5). [cli.md](spec/cli.md): finding the server, exit codes 1 and 3, `--json`, implicit targets, `serve`, `plan submit/approve/send-back/abandon/export`, `status`, `awaiting`, `watch`, and the v1.2 planning commands exiting 1. [ADR-0004] (config `allow` validation) [ADR-0006] [ADR-0007] [ADR-0008] [ADR-0025] [ADR-0026] [ADR-0027] [ADR-0028] [ADR-0030].

**Delivers:**
- `server`: Hono app, `AppType`, `startServer(deps)`, SSE with replay from `Last-Event-ID` or `?since`, and a 15 s heartbeat.
- `cli`: the typed client, the commands above, and `watch` with one `\a` per new Awaiting-you item.

**Seams:** S6, S7.

**Exit check (`pnpm check:b3`):** Through the harness server: `plan submit` prints the id. `awaiting` lists `plan-approval` with the command that resolves it. A background `watch` rings `\a` exactly once. `plan approve`, then `status` shows the Plan `active`. A restart gives an identical `status`. A second `serve` exits 2 naming the pid. A bad `Host` gets 421. With no server, the CLI exits 3. `segno plan new` exits 1 `unsupported-in-version`. A dropped `watch` reconnects with no gaps or duplicates.

**Docs:** README gains `serve`, the `plan` commands, `status`, `awaiting` and `watch`.

## B4: Happy-path Task with a fake Adapter

**Implements:** [engine.md § Phase lifecycle](spec/engine.md#phase-lifecycle) rows `pending` → `starting` → `active` (fetch, Phase branch cut, Docs task added, deferred start on fetch failure); [§ Automatic transitions](spec/engine.md#automatic-transitions) success rows from `waiting` to `done`; the merge queue and the skipped re-test; [§ Scheduling](spec/engine.md#automatic-transitions); `plan.abandon` effects on worktrees and Task branches. [store.md § Worktrees](spec/store.md#worktrees), [§ Branches](spec/store.md#branches), `runs/` and `tasks/<id>/merged.diff`. [runners.md § Run kinds](spec/runners.md#run-kinds) (`tests`, `setup`, `merge`), [§ Adapter interface](spec/runners.md#adapter-interface) (types only), [§ Script Runs](spec/runners.md#script-runs), [§ Run environment](spec/runners.md#run-environment), [§ Commits](spec/runners.md#commits), [§ Transcripts and live output](spec/runners.md#transcripts-and-live-output). [api.md](spec/api.md) Task and Run queries and [§ Live Run output](spec/api.md#live-run-output). [cli.md](spec/cli.md) `task show`, `task diff`, `task logs [--follow]`, and the session meter in `status`. [ADR-0001] [ADR-0003] [ADR-0005] [ADR-0009] [ADR-0011] [ADR-0014] [ADR-0017] [ADR-0018] [ADR-0029] [ADR-0033].

**Delivers:**
- The git module (worktrees outside the repo, Task branches, merge with lockfile detection, commits with the `Segno-Task:` trailer).
- Script Runs with the `SEGNO_*` environment, and auto-commit after Coder and Docs Runs.
- The fake Adapter, fake clock and temp-repo fixtures at `@segno/engine/testing`.
- Agent Runs get a minimal placeholder prompt until B5.

**Seams:** S3, S4, S7.

**Exit check (`pnpm check:b4`):** On a temp repo with a bare remote, a Plan with Tasks `a` and `b` (`b` depends on `a`) and a fake Coder that writes files reaches every Task `done`, including `<phase-id>-docs`. The Phase branch has moved only by fast-forward. Every Segno commit carries `Segno-Task:`. Worktrees and Task branches are gone, and `merged.diff` is kept. `task logs --follow` streams live output. An unreachable remote gives `phase.startDeferred`, which the fake clock retries at +5 min.

**Interim state:** the Phase stays `active` with every Task `done`. `awaiting-merge`, push and the Phase PR come in B9.

## B5: Claude Code Adapter

**Implements:** [runners.md § Claude Code Adapter (v1)](spec/runners.md#claude-code-adapter-v1), [§ Permission profiles](spec/runners.md#permission-profiles), [§ Run context](spec/runners.md#run-context) (first-pass Coder, Reviewer and Docs prompts, `probe`), [§ Verdict schema](spec/runners.md#verdict-schema), [§ Adapter interface](spec/runners.md#adapter-interface) capability gating; [config.md § Validation](spec/config.md#validation) Adapter checks; usage reporting in `/api/board` and `status`. [ADR-0004] [ADR-0016] (schema only) [ADR-0017] [ADR-0018] [ADR-0021] (classification only) [ADR-0024] [ADR-0030].

**Delivers:**
- `adapter-claude-code`: `detect()`, the flag mapping re-checked against the installed Claude Code (2.1.296 at planning time), stream parsing, classification, `stop()`.
- Recorded fixtures for every classification, and `pnpm test:live` to re-record them.
- Built-in prompt templates, including the Docs task's, and `prompt.md` written before every agent Run.
- `segno serve` wires the real Adapter.

**Seams:** S5, plus live.

**Exit check (`pnpm check:b5`):** Replayed fixtures classify `completed`, `failed`, `crashed` and `rate-limited` (with and without `resetAt`) correctly, and the replay stub's argv matches the runners.md flag table.
**Live (`pnpm check:b5:live`, developer-triggered, uses the developer's Claude subscription):** in a throwaway repo, a one-Task Plan reaches `done` with the real `claude`. `prompt.md` contains exactly the Run-context ingredients. Fixtures are re-recorded against the installed version.

**Note:** if the installed Claude Code's flags differ from runners.md, the difference is raised and recorded as an ADR before the mapping changes.

## B6: Failure paths

**Implements:** [engine.md § Automatic transitions](spec/engine.md#automatic-transitions) failure rows (test failure, reject, malformed Verdict, merge re-test failure, merge conflict, infra failure) and the budget rule; [§ Blocked Tasks and their dependents](spec/engine.md#blocked-tasks-and-their-dependents); [§ Findings](spec/engine.md#findings); [§ Verdict handling](spec/engine.md#verdict-handling) with repair; [§ Infra failures](spec/engine.md#infra-failures) with backoff; `held` with `task.approve` and `task.sendBack`; the `merge-hold` and `blocked` Awaiting-you items. [runners.md § Timeouts](spec/runners.md#timeouts), [§ Run context](spec/runners.md#run-context) later Coder passes (blocking Findings, test log tail, conflicting files) and re-review. [cli.md](spec/cli.md) `task approve`, `task send-back`. [ADR-0005] [ADR-0011] [ADR-0014] [ADR-0015] [ADR-0016] [ADR-0019] [ADR-0024] [ADR-0029].

**Seams:** S2, S3, S7.

**Exit check (`pnpm check:b6`):** A scenario matrix where `segno status` shows the expected Block reason and budgets at each step: 2 rejects → `review-limit`; 2 failing test runs → `test-limit`; 3 malformed Verdicts, repaired by resume → `verdict-invalid`; 3 crashes, backed off 30 s / 2 min / 5 min → `infra-limit`; 3 failed setup Runs → `setup-failed`; a Coder timeout and an idle timeout count as infra failures; a high-risk Task (from the Plan, or raised by a Verdict) → `held` → `task approve` lands it; `task send-back` returns it to `coding`; a merge conflict → `coding` with the files listed; a dependent of a Blocked Task stays `waiting` with its wait reason.

## B7: Developer Task Commands

**Implements:** [engine.md § Developer Commands on a Task](spec/engine.md#developer-commands-on-a-task) not covered in B6: `task.note`, `task.pause`/`task.resume`, `task.stopRetry`, `task.takeOver`/`task.handBack`, `task.retry`, `task.replan`, `task.split`, `task.forceApprove`; diff-line Findings in `/api/tasks/:id/diff`; [api.md § Local actions](spec/api.md#local-actions). [cli.md](spec/cli.md) the matching `task` commands, local fragment validation, and `task open`. [ADR-0011] [ADR-0014] [ADR-0015] [ADR-0025].

**Seams:** S2, S3, S7.

**Exit check (`pnpm check:b7`):** From Blocked Tasks set up as in B6: `retry` resets only the exhausted budget and its note becomes a blocking Finding. `replan` gives a new revision, full budgets and a fresh worktree from the Phase branch tip. `split` supersedes the original and re-points dependents and the Docs task at every new Task. Invalid fragments exit 2 locally. `force-approve` requires a reason, skips `held`, and still re-tests. `take-over`/`hand-back` commits leftovers as `segno: developer changes` and re-enters at `testing`. `note` appears in the next Coder prompt. `pause`/`resume` and `stop-retry` rerun the step with no budget used. `task open` runs the configured `editor`, or exits 2.

## B8: Resilience

**Implements:** [engine.md § Pause, pause all and rate limits](spec/engine.md#pause-pause-all-and-rate-limits), [§ Watchdog](spec/engine.md#watchdog), [§ Startup recovery and shutdown](spec/engine.md#startup-recovery-and-shutdown); [store.md § Retention](spec/store.md#retention), [§ Recovery guarantees](spec/store.md#recovery-guarantees) (including stale git cleanup); [config.md § Changes while running](spec/config.md#changes-while-running) and `config.setModel`. [cli.md](spec/cli.md) `pause`, `resume`, `model`, `prune`; "transcript pruned" in `task logs` and `410` in the API. [ADR-0014] [ADR-0020] [ADR-0021] [ADR-0025] [ADR-0033].

**Seams:** S3, S7.

**Exit check (`pnpm check:b8`):** Killing the server with `kill -9` mid-`coding` and restarting: the Run is `interrupted`, the step reruns with no budget used, and the Coder resumes its session. A dead Run process → `watchdog.corrected` plus an infra failure. SIGTERM records live Runs `interrupted` and exits cleanly. A `rate-limited` outcome pauses that Adapter's agent Runs while test Runs continue; it lifts at `resetAt + 60 s`, or probes at 5, 15 and 30 min, then hourly. `segno pause`/`resume` keep individually paused Tasks paused. A bad config edit → `config.rejected` and the old config stays; a good edit → `config.changed` for the next Run. `segno model` writes only `config.local.json`. `segno prune --older-than 0` → "transcript pruned", Verdicts intact. `concurrency: 2` is rejected.

## B9: GitHub forge and multi-Phase

**Implements:** [engine.md § Phase lifecycle](spec/engine.md#phase-lifecycle) rows from `active` onward, [§ Phase PR](spec/engine.md#phase-pr) (body, `pr-manual` fallback, merge detection every 60 s), Plan `complete`; the `pr-ready`, `pr-manual` and `pr-closed` Awaiting-you items. [cli.md](spec/cli.md) `phase merged`, `phase reopen-pr`, and the PR link in `status`. [ADR-0001] [ADR-0013] [ADR-0023] [ADR-0029].

**Seams:** S3 (fake Forge), S7, S8, plus live.

**Exit check (`pnpm check:b9`):** With the replay-stub `gh`: Phase 1 done → branch pushed to the bare remote, PR opened with every required body section, `pr-ready`. The stub reports `MERGED` → Phase 2 starts from the remote base. No `gh` → `pr-manual` → `segno phase merged`. `CLOSED` → `pr-closed` → `segno phase reopen-pr`. The Plan ends `complete`.
**Live (`pnpm check:b9:live`, developer-triggered):** the same flow with the real `gh` against the sandbox GitHub repo, using the fake Adapter so it costs no agent time.

## B10: `segno init` and v1 release

**Implements:** [cli.md](spec/cli.md) `segno init [--yes] [--force]`; [ADR-0034] bundling and publishing; [ADR-0035] catalog freeze; [spec/README.md § v1 cut line](spec/README.md#v1-cut-line) as the acceptance list. [ADR-0004] [ADR-0023] [ADR-0025] [ADR-0029] [ADR-0030] [ADR-0031].

**Seams:** S7, plus live.

**Exit check (`pnpm check:b10`):** `segno init --yes` on pnpm and npm fixture repos writes the expected config, the `.gitignore` entry and the Coder's `Bash(<pm> *)`. A second run exits 2, and `--force` overwrites. It warns when `gh` is missing or logged out. The tarball's only runtime dependency is `better-sqlite3`, and it installs on Node 22 and 24.
**Live, the v1 acceptance run (`pnpm check:b10:live`, developer-triggered):** from the tarball, with the real `claude` and `gh` on the sandbox repo, a two-Phase Plan → two Phase PRs that the developer merges → Plan `complete`.

**Release steps, in order:** freeze the Event catalog [ADR-0035]; `CHANGELOG.md` `Unreleased` → `1.0.0`; `npm publish`, only on the developer's explicit go [ADR-0034].

**Docs:** adds `docs/guides/plan-file.md` and `docs/guides/cli.md`, and rewrites the README for installing from npm.

---

## Developer prerequisites

| Needed by | What |
|---|---|
| B5, B10 live checks | the developer's Claude subscription, with `claude` logged in |
| B9, B10 live checks | a sandbox GitHub repo (e.g. `jeio-dev/segno-sandbox`) and `gh` logged in. Creating the repo is outward-facing, so the developer does it or explicitly asks for it |
| B10 release | an npm account that owns the `segno` name (unclaimed at planning time) |

## Event shape changes

Changes to an existing Event's shape before the first release [ADR-0035]. Delete local `.segno/segno.db` files after pulling any of these.

| Build phase | Event `type` | Change |
|---|---|---|
| | | |
