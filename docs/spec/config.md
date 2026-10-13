# Configuration

There are two files. The effective config is the committed file overlaid with the local one [ADR-0025].

| File | Committed | Holds |
|---|---|---|
| `segno.config.json` (repo root) | yes | repo and team settings [brief §User journey] |
| `.segno/config.local.json` | no (gitignored) | per-machine settings and per-Role model overrides [ADR-0025] |

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
| `roles.<role>` | object | yes for `coder` and `reviewer`. `planner` is required from v1.2 | none | `<role>` ∈ `planner`, `coder`, `reviewer` | [glossary] [ADR-0030] |
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

## `.segno/config.local.json`

Every key is optional.

```jsonc
{
  "port": 4747,
  "editor": "code {path}",
  "worktreeRoot": "/home/me/.local/share/segno/worktrees",
  "notifications": true,
  "roles": { "coder": { "model": "opus" }, "coder-docs": { "model": "haiku" } }
}
```

| Key | Type | Default | Rule | Source |
|---|---|---|---|---|
| `port` | int | `4747` | 1024–65535 | [ADR-0008] |
| `editor` | string | unset | a command line containing `{path}`, which is replaced by the worktree path | [ADR-0015] |
| `worktreeRoot` | string | `${XDG_DATA_HOME:-~/.local/share}/segno/worktrees` | an absolute path outside the repo | [ADR-0009] |
| `notifications` | bool | `true` | `false` disables browser notifications | [ADR-0027] |
| `roles.<role>.model` | string | none | `<role>` ∈ `planner`, `coder`, `coder-docs`, `reviewer`. Overrides that Role's model (`coder-docs` overrides `roles.coder.docsModel`) | [ADR-0025] |

Only `roles.<role>.model` may override a committed key. Any other committed key in the local file is a validation error [ADR-0025].

## Validation

- **Both files are validated strictly** against a zod schema, and an equivalent JSON Schema is published. Unknown keys and out-of-range values are errors [ADR-0025].
- **At `serve` startup,** an invalid effective config stops startup, listing every error [ADR-0025].
- **Adapter checks.** Each Role's Adapter is checked at validation time: installed (`detect()`) and capable. A failure is a validation error that names the Role and the missing capability [ADR-0017].

## Changes while running

- **Both files are watched** [ADR-0025].
- **A valid change** is recorded as `config.changed { source, changes }` and applies to **Runs started after it**. Live Runs are unaffected [ADR-0025].
- **An invalid change is ignored.** The previous effective config stays in force, `config.rejected { source, errors }` is recorded, and the warning shows until a valid version of that file is saved [ADR-0025].
- **`config.setModel`** (GUI model settings, or `segno model`) writes only `.segno/config.local.json`. It never touches `segno.config.json`, so changing a model never dirties the working tree [ADR-0025].
- **Changes that need a restart.** `port` and `worktreeRoot` take effect at the next `serve`. A change to either is recorded with a "takes effect on restart" note [ADR-0025].
