# Task worktrees live outside the repo

Task worktrees go under an XDG data directory (`~/.local/share/segno/worktrees/<repo>-<hash>/<task-id>`, configurable with `worktreeRoot`), not inside the repo's gitignored `.segno/`. Inside the repo, tools that scan the whole tree (`tsc`, test runners, linters, file watchers) would pick up a copy of the code for every live task. Everything else Segno stores stays in `.segno/`.
