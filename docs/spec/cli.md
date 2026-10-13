# CLI

`segno` is a command that ships inside the desktop app. In v1 it does one thing: validate a Plan file offline. Every Plan, Task and board action is taken in the app [ADR-0042].

## Conventions

- **No repo needed.** `segno plan validate` validates the path it's given. It works in any directory, needs no git repo and no `segno.config.json`, and never contacts the running app [ADR-0042].
- **Runtime.** The command runs the app's bundled CLI on the app's own runtime, so it needs no separate Node install [ADR-0042] [ADR-0043].

### Exit codes

| Code | Meaning |
|---|---|
| `0` | success |
| `2` | usage error, or a validation error (bad arguments, an unknown subcommand, a missing file, or an invalid Plan file) |

Sources: [ADR-0026] [ADR-0042].

## Commands

| Command | Behavior | Source |
|---|---|---|
| `segno plan validate <file>` | Offline validation ([plan-format.md](plan-format.md#validation)). Prints every error as `file:line:column  code  message`. Exit 0 if valid, 2 if not | [ADR-0002] [ADR-0042] |

## Installing

**Install the `segno` command** in the app's settings (`cli.install`, [api.md](api.md#app-level-calls)) writes a small `segno` launcher onto PATH that runs the installed app's bundled CLI: `/usr/local/bin/segno` on macOS, asking for permission when needed, and `~/.local/bin/segno` on Linux. Running it again replaces the launcher. Updating the app updates the command, because the launcher runs whatever app is installed [ADR-0042] [ADR-0043].

## Later: a scripting CLI

A CLI that scripts the running app (submitting and approving Plans, Task actions, status and watching) is **(later)** [ADR-0042]. It will start from the command set and exit codes in ADR-0026, adapted to address a Project, and will need a local socket on the Engine host [ADR-0037].
