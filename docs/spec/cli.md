# CLI

`segno` is the CLI. In v1 it is the **only** interface [ADR-0030]. It is a thin client of the running server, and it never reads or writes the Event log directly, because the Engine is the only writer [brief §Decided] [ADR-0026].

## Conventions

- **Repo discovery.** The repo is the git top-level of the current directory. Every command except `init` requires a `segno.config.json` there [ADR-0026].
- **Finding the server.** The CLI reads `.segno/server.json`, checks `/api/health`, and sends `Authorization: Bearer <token>` [ADR-0008].
- **Offline commands.** Only `init`, `serve` and `plan validate` work without a running server [ADR-0026].
- **Read commands** accept `--json`, which prints the API's JSON unchanged [ADR-0026].
- **Commands that need notes or a reason** take them as `--notes <text>` or `--reason <text>`, or from `--notes-file <path>` or `--reason-file <path>`. A blank value is a usage error, caught before sending [ADR-0015] [ADR-0026].
- **Implicit targets.** Where only one target can exist (the Plan awaiting approval, the active Plan, the Phase awaiting merge), the id may be left out [ADR-0013].

### Exit codes

| Code | Meaning |
|---|---|
| `0` | success |
| `1` | Command rejected by the Engine. Prints `<code>: <message>`, plus validation errors if present |
| `2` | usage error, or a local validation error (bad arguments, invalid YAML in `plan validate` or fragments) |
| `3` | server not running: `server.json` is missing, its pid is dead, or health fails. Prints "Segno isn't running in this repo. Start it with `segno serve`." |

Sources: [ADR-0026].

## Commands

### Setup and server

| Command | Behavior | Source |
|---|---|---|
| `segno init [--yes] [--force]` | Detects agent CLIs (each Adapter's `detect()`; v1 can *use* only Claude Code, and other CLIs it finds are listed as "not yet supported"), the package manager (from the lockfile), the test command (`scripts.test` in `package.json`, run through the detected package manager), the setup command (the package manager's frozen-lockfile install) and the base branch (the remote's default branch, falling back to the current branch). Asks for the base branch and a model per Role (planner, coder, coder-docs, reviewer), showing the detected or default value. `--yes` accepts every default without asking. Writes `segno.config.json`, creates `.segno/`, and adds `.segno/` to `.gitignore`. Adds `Bash(<package-manager> *)` to the Coder's `allow`. Warns if `gh` is missing or not logged in. Refuses (exit 2) if `segno.config.json` exists, unless `--force` | [brief §User journey] [ADR-0025] [ADR-0029] [ADR-0023] [ADR-0004] |
| `segno serve [--no-open]` | Starts the Engine and server in the foreground. Recovers from the Event log, then prints the URL. From v1.1 it opens the GUI through a one-time auth URL unless `--no-open`. Ctrl-C or SIGTERM stops live Runs cleanly. Exit 2 if another instance is running or the port is taken | [brief §User journey] [ADR-0008] [ADR-0020] |
| `segno open` **(v1.1)** | Opens the GUI with a fresh one-time auth URL, or prints it when no browser can be opened | [ADR-0008] |

### Observing

| Command | Behavior | Source |
|---|---|---|
| `segno status` | Shows the Plan and Phase (title, state, branch, PR link); Task states grouped by column, with budgets, Block and wait reasons; board and rate-limit pause; session meter; the Awaiting-you count | [ADR-0026] [ADR-0028] |
| `segno awaiting` | Lists Awaiting-you items (kind, target id, title, age) and, for each, the command that resolves it | [ADR-0026] |
| `segno watch` | Streams Events as readable lines (`--json`: one Event per line). Rings the terminal bell (`\a`) once for each new Awaiting-you item. Reconnects with `Last-Event-ID` after a drop | [ADR-0026] [ADR-0027] [ADR-0007] |

### Plan

| Command | Command sent / behavior | Source |
|---|---|---|
| `segno plan validate <file>` | Offline validation. Prints every error with `file:line:column  code  message`. Exit 0 if valid, 2 if not | [ADR-0002] |
| `segno plan submit <file>` | `plan.submit`. Prints the plan id and "awaiting approval" | [ADR-0012] |
| `segno plan approve [<plan-id>]` | `plan.approve` | [ADR-0013] |
| `segno plan send-back [<plan-id>] --notes <text>` | `plan.sendBack` | [ADR-0013] |
| `segno plan abandon [<plan-id>] --reason <text>` | `plan.abandon`, after confirmation (`--yes` skips it) | [ADR-0013] |
| `segno plan export [--out <file>]` | Writes the active Plan as YAML to stdout or `<file>` | [ADR-0012] |

### Task

| Command | Command sent / behavior | Source |
|---|---|---|
| `segno task show <id>` | Definition, state, budgets, risk, open Findings, Runs, latest Verdict | [ADR-0026] |
| `segno task diff <id>` | Prints the Task's diff | [ADR-0026] |
| `segno task logs <id> [--run <run-id>] [--follow]` | Prints the latest (or the given) Run's transcript or output. `--follow` attaches to the live Run stream until it ends | [ADR-0026] [ADR-0007] |
| `segno task approve <id>` | `task.approve` | [ADR-0015] |
| `segno task send-back <id> --notes <text>` | `task.sendBack` | [ADR-0015] |
| `segno task note <id> --file <path> --line <n> --text <text>` | `task.note` | [ADR-0015] |
| `segno task pause <id>` / `resume <id>` | `task.pause` / `task.resume` | [ADR-0014] |
| `segno task stop-retry <id>` | `task.stopRetry` | [ADR-0015] |
| `segno task retry <id> [--note <text>]` | `task.retry` | [ADR-0015] |
| `segno task replan <id> --file <fragment.yaml>` | Validates the fragment locally (exit 2 on errors), then sends `task.replan` | [ADR-0015] |
| `segno task split <id> --file <fragment.yaml>` | Validates the fragment locally, then sends `task.split` | [ADR-0015] |
| `segno task force-approve <id> --reason <text>` | `task.forceApprove` | [ADR-0015] |
| `segno task take-over <id>` | `task.takeOver`, then prints the worktree path | [ADR-0015] |
| `segno task hand-back <id>` | `task.handBack` | [ADR-0015] |
| `segno task open <id>` | Runs the configured `editor` on the worktree path locally. No Command is sent. Exit 2 if there's no worktree or no editor | [ADR-0015] [ADR-0025] |

### Board, phase, config, store

| Command | Command sent / behavior | Source |
|---|---|---|
| `segno pause` / `segno resume` | `board.pause` / `board.resume` | [brief §The GUI] [ADR-0026] |
| `segno phase merged [<phase-id>]` | `phase.confirmMerged`. For when the forge can't be read | [ADR-0023] |
| `segno phase reopen-pr [<phase-id>]` | `phase.reopenPr` | [ADR-0023] |
| `segno model <role> <model>` | `config.setModel`, with role `planner`, `coder`, `coder-docs` or `reviewer`. Writes `config.local.json` only | [ADR-0025] |
| `segno prune [--older-than <days>]` | `store.prune` | [ADR-0033] |

### Planning (v1.2)

| Command | Command sent | Source |
|---|---|---|
| `segno plan new --brief <text>` | `planning.start`, then prints the Planner's reply as it arrives | [ADR-0010] |
| `segno plan reply --text <text>` | `planning.reply` | [ADR-0010] |
| `segno plan draft` | `planning.draftNow` | [ADR-0010] |
| `segno task ask-planner <id> [--text <q>]` | `task.askPlanner` | [ADR-0010] |

Before v1.2, these exit 1 with `unsupported-in-version` [ADR-0030].
