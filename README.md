# Segno

Segno is a local desktop app that drives AI agents through a software development cycle while the developer supervises. One app holds many Projects; each Plan is an ordered list of Phases that end in pull requests.

**v1 is unreleased.** The workspace and Plan file library are implemented, together with offline Plan validation. The desktop app and Engine are still being built.

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

## Development checks

```sh
pnpm check:b1
```

This builds all eight packages and the standalone CLI bundle, runs Biome and the S1/S7 tests, checks the committed schema against fixtures, and validates every invalid Plan fixture through the copied bundle from a temporary directory outside git. CI runs it on Node 22 and 24. The six packages outside `plan-format` and `cli` are empty shells in B1.

Run `pnpm schema:generate` after changing structural rules, and review the resulting schema diff. [The build plan](docs/build-plan.md) describes the remaining work.
