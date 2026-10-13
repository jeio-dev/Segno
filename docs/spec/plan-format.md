# Plan file format

The Plan file is Segno's public contract. A person, Segno's own Planner, or any other tool can write one [brief §Starting point] [ADR-0002]. This document is the normative definition. A JSON Schema of its structure ships with Segno, so writers can validate a Plan without running Segno [ADR-0002]. The schema can't check rules that compare one value with another, so `duplicate-id`, `unknown-dependency`, `cross-phase-dependency`, `dependency-cycle` and `reserved-id` are checked only by Segno [ADR-0036].

## Encoding

- The file is YAML 1.2, UTF-8. The extension is `.yaml` or `.yml` [ADR-0002].
- Multi-paragraph text fields hold Markdown, written as YAML block scalars (`|`) [ADR-0002].
- The file is **input only**. Once it's submitted, the Plan lives in the Event log, and later edits to the file have no effect [ADR-0012].

## Schema (version 1)

```yaml
schemaVersion: 1                # required, integer, must be 1
title: OAuth login              # required, non-empty string, used to derive the plan slug
summary: |                      # required, Markdown: why this Plan exists
  ...
phases:                         # required, ≥ 1 item, executed in order
  - id: oauth-core              # required, slug
    title: Core OAuth flow      # required, non-empty string
    docs: |                     # optional, Markdown: extra instructions for this Phase's Docs task
      Update docs/guides/auth.md.
    tasks:                      # required, ≥ 1 authored item
      - id: token-store         # required, slug
        title: Persist OAuth tokens        # required, non-empty string
        description: |                     # required, Markdown
          ...
        acceptance:                        # required, ≥ 1 non-empty string
          - Tokens are encrypted at rest
        dependsOn: [user-model]            # optional, Task ids in the SAME Phase
        context:                           # optional, path or glob hints for the Coder
          - src/auth/**
        risk:                              # optional; presence makes the Task high-risk
          flags: [migration]               # required if risk is present, ≥ 1, unique
          reason: |                        # required if risk is present, non-empty
            Adds a NOT NULL column to users.
```

Sources: fields [ADR-0011]; Acceptance criteria [glossary]; Risk flags [ADR-0011] [glossary]; ordered Phases [ADR-0001].

### Field rules

| Field | Rule | Source |
|---|---|---|
| slug (`phases[].id`, authored `tasks[].id`) | matches `^[a-z0-9]+(-[a-z0-9]+)*$`, 1–48 characters | [ADR-0011] [ADR-0044] |
| `phases[].id` | unique within the Plan | [ADR-0011] |
| `tasks[].id` | unique across the **whole Plan**, never reused, including by a later split or replan | [ADR-0011] |
| `tasks[].id` | must not end in `-docs` if that would equal `<phase-id>-docs` for any Phase | [ADR-0011] |
| `dependsOn` | every id names an authored Task **in the same Phase**, contains no duplicates, and doesn't name the Task itself | [ADR-0011] |
| `dependsOn` | the dependency graph inside each Phase is acyclic | [ADR-0011] |
| `dependsOn` | must not name a Docs task | [ADR-0011] |
| `acceptance` | ≥ 1 item, each a non-empty string. Order matters, because Verdicts refer to criteria by index | [ADR-0011] [ADR-0016] |
| `risk.flags` | each item is one of `migration`, `auth`, `payments`, `data-deletion`, `security`, `other` | [ADR-0011] |
| `risk.reason` | non-empty | [ADR-0011] |
| unknown keys | rejected at every level | [ADR-0002] |

### The automatic Docs task

Segno adds one Docs task to every Phase. Plan authors never write it [ADR-0011] [glossary].

| Property | Value |
|---|---|
| `id` | `<phase-id>-docs` |
| `title` | `Docs and changelog` |
| `description` | built in, extended by the Phase's `docs` block if there is one |
| `acceptance` | built in: README and guides reflect the Phase's behavior changes; changelog entries exist for user-visible changes |
| `dependsOn` | every other non-superseded Task in the Phase, kept up to date through splits [ADR-0015] |
| `risk` | none, unless a Reviewer raises one [ADR-0016] |
| Role | Coder, using `roles.coder.docsModel` [ADR-0018] |

Generated Docs task ids may be up to 53 characters: a Phase id of up to 48 characters plus `-docs`. The 48-character Task-id limit applies to authored Tasks [ADR-0044].

Exporting a Plan writes Docs tasks out with `generated: true`. Submitting a file that contains a task with `generated: true` is rejected, so export is lossless for reading, and a Plan can't be resubmitted with its Docs tasks already in it [ADR-0011] [ADR-0012].

## Validation

Validation is the same everywhere it happens: `segno plan validate` (offline), the `plan.submit` Command, and the fragment checks below [ADR-0002] [ADR-0012] [ADR-0042].

A validation result is either valid or a list of errors. Each error has:

```ts
{ path: string;        // JSON-pointer-like, e.g. "/phases/0/tasks/2/dependsOn/0"
  line?: number;       // 1-based line in the source YAML when one can be found
  column?: number;
  code: ValidationCode;
  message: string }
```

| `code` | Meaning |
|---|---|
| `yaml-syntax` | not parseable YAML |
| `schema` | wrong type, missing required field, unknown key, or value out of range |
| `schema-version` | `schemaVersion` missing or unsupported |
| `duplicate-id` | Phase or Task id repeated |
| `unknown-dependency` | `dependsOn` names no Task in the same Phase |
| `cross-phase-dependency` | `dependsOn` names a Task in a different Phase |
| `dependency-cycle` | the cycle's ids are listed in `message` |
| `reserved-id` | a Task uses `<phase-id>-docs`, or depends on a Docs task |
| `generated-task` | contains a task with `generated: true` |

Every error in the file is reported, not only the first. A Plan with any error is rejected as a whole and never becomes a Plan [ADR-0013].

## Fragments: replan and split

Replan and split take new Task definitions written in the same schema [ADR-0015]. In v1 the developer provides them. From v1.2, the Planner can draft them through Ask Planner [ADR-0030].

**Replan fragment.** One Task object. Its `id` must equal the Task being replanned. It must not contain `dependsOn`: dependencies are kept unchanged, and including the key is a `schema` error. The fields it may change are `title`, `description`, `acceptance`, `context` and `risk` [ADR-0015].

**Split fragment.** A YAML list of 2 or more Task objects [ADR-0015].

- Every id must be new across the Plan's whole history [ADR-0011].
- `dependsOn` may name existing non-superseded Tasks in the same Phase, or other Tasks in the same fragment. The combined graph must stay acyclic.
- The original Task's own dependencies are **not** inherited automatically. The fragment states them.
- Every Task that depended on the original Task now depends on **all** of the new Tasks [ADR-0015].

Fragments are validated with the same codes as above, plus:

| `code` | Meaning |
|---|---|
| `id-mismatch` | the replan fragment's `id` isn't the Task being replanned |
| `id-reused` | a split id has existed in this Plan before |
| `too-few-tasks` | the split fragment has fewer than 2 Tasks |

## Export

**Export Plan** in the app (the `planExport` query, [api.md](api.md#queries)) writes the active Plan in its current form (after replans and splits) in this schema [ADR-0012]:

- Superseded Tasks are left out.
- Docs tasks are written with `generated: true`.
- Risk flags raised by Reviewers are merged into each Task's `risk`. The flags are combined, and the Reviewer's reasons are appended to the `reason`.
