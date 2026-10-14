# Agents list and search files with four read-only shell commands

`read: true` means an agent can read and search the files under its cwd. Claude Code 2.1.299 has no Glob or Grep tool: its init message lists `Read`, `Edit`, `Write` and `Bash`, and a call to Glob is answered with "find files with `find` via the Bash tool instead". No default profile allowed `find` or `grep`, so a Coder couldn't list or search files at all, and a Reviewer had only `ls *`.

Every profile with `read: true` and an explicit shell allowlist now also allows `ls *`, `grep *`, `git ls-files *` and `git grep *`. None of them can write a file or start another program, so the Reviewer and the Planner stay read-only. Between them they list and search both tracked files and new ones. They're part of the Role profiles, not added by the Adapter, so the Shell section of the Run context lists them (ADR-0058).

This amends ADR-0004.

## Considered Options

- **Allow `find`.** It is what Claude Code suggests, but `-delete` and `-exec` let it delete files and run any program, and prefix rules can't reliably block those options.
- **Have the Claude Code Adapter add search commands whenever `read: true`.** The gap is specific to Claude Code, but the Run context wouldn't list commands the profile doesn't hold, and `find` would still be the obvious command to add.
