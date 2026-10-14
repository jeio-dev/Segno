---
status: accepted, amended by ADR-0049
---

# Adding a Project replaces `segno init`

A Project is added by picking a folder in the app. The folder must be a git top-level with a remote, and not a repo already added; otherwise it's refused with the reason. So one Project is one repo, and ADR-0013's "one Plan per repo" holds per Project. If `segno.config.json` exists, it's validated and used. Otherwise the detection that `segno init` did runs (package manager, test and setup commands, base branch, a model per Role, and `Bash(<package-manager> *)` in the Coder's allow-list), the developer reviews and edits the result, and the file is written on confirm. Segno never commits it: a hint stays on the Project until the file is on the base branch. A missing or logged-out `gh` is a warning, not a refusal (ADR-0023). The committed file stays the team's shared config (ADR-0025). This supersedes `init` in ADR-0026.
