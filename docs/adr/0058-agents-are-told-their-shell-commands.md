# Agents are told the shell commands they may run, one at a time

In the first live B5 run, the Coder, the Reviewer and the Docs task each opened with one chained command, such as `pwd && git status && git log … && ls -la && xxd hello.txt`. Claude Code checks every part of a joined command against the allowlist and refuses the whole command if any part isn't listed. Each agent took that one refusal to mean "Bash is denied in this session" and stopped using the shell. The Coder didn't commit, the Reviewers reviewed without the diff, and the Docs task changed nothing.

Every agent Run's context now ends with a **Shell** section, before its closing instructions. It lists the commands its profile allows (the Role's `shell` entries and its `allow` entries of the form `Bash(…)`), says that `*` stands for any arguments, and asks for one command per call, never joined with `&&`, `||`, `;`, `|` or `$(…)`. It also says that a refused command doesn't turn the shell off. The onboarding Run, whose shell is unrestricted, and the probe, which has no tools, don't get it.

The allowlists of ADR-0004 are unchanged. This amends ADR-0024: the Coder, Reviewer and Docs contexts gain one ingredient.

## Considered Options

- **Widen the profiles with harmless commands** such as `pwd`, `echo`, `cat` and `head`, so typical chains pass. It reopens ADR-0004's profiles, and an agent can always chain in a command no list foresaw.
