# The always-denied git operations are best effort under the onboarding profile

The always-denied git operations (ADR-0004) are enforced by the agent CLI's own permission rules, which match a command by its prefix: Claude Code gets `Bash(git push *)` and so on. That holds for every profile with an explicit shell allowlist, because a command that doesn't start with an allowed prefix is denied anyway. The onboarding profile (ADR-0049) allows every shell command, so other spellings of the same operation, such as `git -C . push`, `/usr/bin/git reset` or `sh -c "git branch -D main"`, match no deny rule and run. The scratch worktree shares the repo's refs, so such a command can change the real repo.

Under the onboarding profile, the always-denied list is therefore best effort. That risk is the one ADR-0049 accepted for its unrestricted shell: the Run happens only on the developer's request, before any Plan exists, in a throwaway worktree, and its result is confirmed by hand. Segno adds no further patterns, since any finite list leaves other spellings open and would suggest a guarantee that doesn't exist.

This amends ADR-0004 and ADR-0049.

## Considered Options

- **More deny patterns** (`Bash(git -C *)`, `Bash(git -c *)`, full paths). They block some spellings, leave `sh -c` and aliases open, and also block harmless reads.
- **Onboard in a separate throwaway clone with no push remote,** so the Run can't reach the repo's refs. That's stronger, but it changes the scratch worktree that ADR-0049 and the storage layout define, for a one-time step the developer already supervises.
