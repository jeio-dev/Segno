# Configuration

A Project's effective config is its committed file overlaid with its local settings [ADR-0025]. App settings, which apply to every Project, are separate [ADR-0038].

| File | Committed | Holds |
|---|---|---|
| `segno.config.json` (repo root) | yes | repo and team settings [brief §User journey] |
| `projects/<id>/pending.json` (app data directory) | no | the models chosen at Add, until the Project is onboarded [ADR-0049] |
| `projects/<id>/local.json` (app data directory) | no | per-machine settings and per-Role model overrides for one Project [ADR-0025] [ADR-0038] |
| `settings.json` (app data directory) | no | app settings [ADR-0038] [ADR-0041] |

## `segno.config.json`

```jsonc
{
  "schemaVersion": 1,
  "baseBranch": "main",
  "remote": "origin",
  "forge": "github",
  "tests":   { "command": "pnpm test", "timeoutMin": 15 },
  "setup":   { "command": "pnpm install --frozen-lockfile" },
  "roles": {
    "planner":  { "adapter": "claude-code", "model": "opus",   "timeoutMin": 20, "allow": [] },
    "coder":    { "adapter": "claude-code", "model": "sonnet", "docsModel": "haiku", "timeoutMin": 45, "allow": ["Bash(pnpm *)"] },
    "reviewer": { "adapter": "claude-code", "model": "opus",   "timeoutMin": 15, "allow": [] }
  },
  "idleTimeoutMin": 10,
  "concurrency": 1,
  "docs":      { "changelog": "CHANGELOG.md" },
  "retention": { "runDays": 30 }
}
```

| Key | Type | Required | Default | Rule | Source |
|---|---|---|---|---|---|
| `schemaVersion` | int | yes | none | must be `1` | [ADR-0025] |
| `baseBranch` | string | yes | none | an existing branch on `remote`. Phase branches are cut from it and Phase PRs target it | [brief §User journey] [ADR-0029] |
| `remote` | string | no | `"origin"` | an existing git remote | [ADR-0023] [ADR-0029] |
| `forge` | `"github"` | no | `"github"` | v1 supports only `github` | [ADR-0023] [ADR-0030] |
| `tests.command` | string | yes | none | non-empty, run through the shell | [brief §Decided] [ADR-0029] |
| `tests.timeoutMin` | int | no | `15` | 1–1440 | [ADR-0019] |
| `setup.command` | string | no | unset (no setup) | non-empty when present | [ADR-0029] |
| `roles.<role>` | object | yes for `coder` and `reviewer`. `planner` is required from v1.2, and onboarding always writes it [ADR-0049] | none | `<role>` ∈ `planner`, `coder`, `reviewer` | [glossary] [ADR-0030] |
| `roles.<role>.adapter` | string | yes | none | a known Adapter id that's installed (v1: `claude-code`) and has every capability the Role needs ([runners.md](runners.md#adapter-interface)) | [ADR-0017] |
| `roles.<role>.model` | string | yes | none | non-empty, passed to the Adapter verbatim | [brief §How it works] [ADR-0017] |
| `roles.coder.docsModel` | string | no | the Coder's `model` | the model for the Docs task | [ADR-0018] |
| `roles.<role>.timeoutMin` | int | no | planner 20, coder 45, reviewer 15 | 1–1440 | [ADR-0019] |
| `roles.<role>.allow` | string[] | no | `[]` | entries are **added** to the Role's allowlist, in the Adapter's own syntax. Any entry matching an always-denied operation, or asking for a bypass mode, is a validation error | [ADR-0004] |
| `idleTimeoutMin` | int | no | `10` | 1–1440 | [ADR-0019] |
| `concurrency` | int | no | `1` | **v1: must be `1`.** Later: ≥ 1 | [ADR-0030] |
| `docs.changelog` | string | no | `"CHANGELOG.md"` | repo-relative path | [ADR-0024] |
| `retention.runDays` | int | no | `30` | ≥ 0, where `0` means never prune | [brief §Housekeeping] [ADR-0033] |

The review (2), test (2) and infra (3) caps are **not** configurable, and there are no keys for them [ADR-0019].

## Pending config

`projects/<id>/pending.json` in the app data directory exists only while a Project is not onboarded. **Add** writes it, and `onboarding.confirmed` deletes it. It's written only through the app [ADR-0049].

```jsonc
{
  "roles": { "planner": { "model": "opus" }, "coder": { "model": "sonnet", "docsModel": "haiku" }, "reviewer": { "model": "opus" } }
}
```

- **Missing pending config.** When a not-onboarded Project has no `pending.json`, create it with the Add defaults: Planner `opus`, Coder `sonnet`, Reviewer `opus`, and Docs `haiku`. An existing pending config is validated, not replaced [ADR-0050].
- **Every key is required,** and each value is a non-empty string. Validation is the same as for the other files.
- **Its models go into the config.** `onboarding.confirm` writes them into `segno.config.json` as `roles.<role>.model` and `roles.coder.docsModel`, with `adapter: "claude-code"`. They become the team's committed models.
- **The onboarding Run** uses its Planner model, overridden by `local.json` as usual.

## Per-Project local settings

`projects/<id>/local.json` in the app data directory ([store.md](store.md#app-data-directory)). Every key is optional. It's written only through the app [ADR-0025] [ADR-0038].

```jsonc
{
  "worktreeRoot": "/home/me/worktrees",
  "roles": { "coder": { "model": "opus" }, "coder-docs": { "model": "haiku" } }
}
```

| Key | Type | Default | Rule | Source |
|---|---|---|---|---|
| `worktreeRoot` | string | unset (worktrees go under the Project's directory) | an absolute path outside the repo | [ADR-0009] [ADR-0038] |
| `roles.<role>.model` | string | none | `<role>` ∈ `planner`, `coder`, `coder-docs`, `reviewer`. Overrides that Role's model (`coder-docs` overrides `roles.coder.docsModel`) | [ADR-0025] |

Only `roles.<role>.model` may override a committed key. Any other committed key in the local settings is a validation error [ADR-0025].

## App settings

`settings.json` in the app data directory. Every key is optional. It's written only through the app [ADR-0038].

```jsonc
{
  "editor": "code {path}",
  "notifications": true,
  "theme": "system",
  "launchAtLogin": false
}
```

| Key | Type | Default | Rule | Source |
|---|---|---|---|---|
| `editor` | string | unset | a command line containing `{path}`, which is replaced by the worktree path | [ADR-0015] |
| `notifications` | bool | `true` | `false` turns native notifications off | [ADR-0041] |
| `theme` | `"system"` \| `"light"` \| `"dark"` | `"system"` | | [ADR-0032] [ADR-0037] |
| `launchAtLogin` | bool | `false` | starts Segno, in the tray, when the developer logs in | [ADR-0041] |

## Validation

- **Every file is validated strictly** against a zod schema, and an equivalent JSON Schema of `segno.config.json` is published. Unknown keys and out-of-range values are errors [ADR-0025].
- **Every error is reported** as `{ file, path, line?, column?, code, message }`, where `file` is `segno.config.json`, `local.json` or `pending.json`, `path` is a JSON pointer, and line and column come from the JSON source when one is available [ADR-0047]:

| `code` | Meaning |
|---|---|
| `json-syntax` | the file isn't valid JSON |
| `schema-version` | `schemaVersion` is missing or isn't `1` |
| `schema` | wrong type, missing field, unknown key or out-of-range value, including `concurrency` other than `1` and any committed key other than `roles.<role>.model` in the local settings |
| `denied-permission` | an `allow` entry matches an always-denied operation or asks for a bypass mode [ADR-0004] |
| `unknown-remote` | `remote` isn't a git remote of the repo |
| `unknown-branch` | `baseBranch` isn't a branch on `remote`, checked against the local remote-tracking ref |
| `missing-file` | an added Project's repo has no `segno.config.json` after a Plan has been submitted. Before that, the Project is not onboarded instead ([engine.md](engine.md#onboarding)) [ADR-0049] |
| `adapter` | a Role's Adapter isn't installed or lacks a capability the Role needs |

- **Invalid app settings** (`settings.json`) aren't reported per Project. The host logs them to `host.log` and uses the defaults [ADR-0047].
- **When a Project's Engine starts,** an invalid effective config keeps it from starting. The Project is `unavailable`, listing every error, and the other Projects keep running ([gui.md](gui.md#projects)) [ADR-0025] [ADR-0038].
- **Adapter checks.** Each Role's Adapter is checked at validation time: installed (`detect()`) and capable. A failure is a validation error that names the Role and the missing capability [ADR-0017].

## Changes while running

- **`segno.config.json` is watched** in the repo's working tree. Local settings change only through the app [ADR-0025] [ADR-0038].
- **A valid change** is recorded as `config.changed { source, changes }` and applies to **Runs started after it**. Live Runs are unaffected [ADR-0025].
- **An invalid change is ignored.** The previous effective config stays in force, `config.rejected { source, errors }` is recorded, and the warning shows until a valid version of that file is saved [ADR-0025].
- **`config.setModel`** (the GUI's model settings) writes only the Project's `local.json`. It never touches `segno.config.json`, so changing a model never dirties the working tree [ADR-0025] [ADR-0038]. While the Project is not onboarded, it writes the pending config instead, because there are no committed models to override yet [ADR-0049].
- **Changes that need a restart.** `worktreeRoot` takes effect the next time the Project's Engine starts. A change to it is recorded with a "takes effect on restart" note [ADR-0025].
- **App settings** apply immediately and write no Event [ADR-0038].
