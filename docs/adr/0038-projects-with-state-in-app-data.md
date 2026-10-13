# One app holds many Projects, and their state lives in the app's data directory

A Project is a git repo added to Segno, with its own Plans, board, Event log and settings, and at most one active Plan. One running app holds any number of Projects. Each Project's Event log, Run directories, local settings and Task worktrees live under the app's data directory (for example `~/.local/share/Segno/projects/<id>/` on Linux), not in a `.segno/` directory inside the repo. Segno writes nothing into the repo except its branches and commits, and the committed `segno.config.json` when the developer confirms it (ADR-0039). This supersedes the `.segno/` layout in ADR-0033 (its branch names and retention stay), moves the default worktree root of ADR-0009 under the Project's directory, and moves ADR-0025's local config layer into the app's per-Project settings. Removing a Project from the app asks whether to delete its data.

## Considered Options

- **Keep `.segno/` in each repo.** It ties state to one app instance per repo, needs a `.gitignore` edit in every repo, and is the reason ADR-0009 had to move worktrees out anyway.
