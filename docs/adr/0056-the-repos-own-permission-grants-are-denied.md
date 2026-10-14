# The repo's own permission grants are denied unless the Run allows them

A Run loads Claude Code's project settings (`--setting-sources project`), because that same source is what loads the repo's `CLAUDE.md`, which Claude Code reads as usual (ADR-0024). It also loads the repo's `.claude/settings.json` permission rules, and `--allowedTools` adds to them rather than replacing them. A committed allow rule could therefore widen a Role's profile: a Reviewer could run `node` and write files although its profile says `edit: false`. That breaks the explicit allowlist of ADR-0004.

Before each Run, the Adapter reads the repo's `.claude/settings.json`. Every `permissions.allow` entry the Run doesn't already allow, exactly or by its bare tool name, goes onto `--disallowedTools`. In Claude Code a deny rule beats an allow rule, so the RunSpec alone decides what a Run may do. A repo without that file, or with one that can't be parsed, adds nothing.

The cost: a repo grant that's broader than a Role's own entry also blocks that entry. For example, a repo-granted `Bash(npm *)` blocks a Coder's `Bash(npm test)`, and a bare `Edit` blocks the Coder's `Edit(./**)`. This fails visibly, on the safe side, and the fix is to put the same entry in `roles.<role>.allow`. The repo's hooks still run, as they do for anyone using Claude Code in that repo.

This amends ADR-0004.

## Considered Options

- **Load no settings files** (`--setting-sources ""`). The allowlist is exact and hooks are off, but Claude Code then doesn't read the repo's `CLAUDE.md` either, as a probe against 2.1.299 showed. Passing `CLAUDE.md` in another way means copying it into the prompt, which ADR-0024 rules out and which loses its `@imports`.
- **Rely on workspace trust.** Claude Code ignores project allow rules in a folder that hasn't been trusted, and Segno's worktrees live in app data. Whether that holds depends on where the developer happened to grant trust.
