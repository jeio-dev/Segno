---
status: accepted, amended by ADR-0038 and ADR-0039
---

# A committed config plus a gitignored local override

`segno.config.json` (committed) holds the repo and team settings: base branch, remote, forge, the test and setup commands, per-Role Adapter, model, timeout and allow-list additions, the idle timeout, concurrency, the changelog path and retention. `.segno/config.local.json` (gitignored) holds per-machine settings (port, editor, worktree root, notifications) and per-Role model overrides. The effective config is the committed file overlaid with the local one. Both are validated strictly, with unknown keys rejected. Both files are watched: valid changes apply to subsequent Runs and are recorded as `config.changed`, while invalid edits are ignored with a visible warning. Model changes from the GUI or CLI write only the local file, so they never dirty the working tree.
