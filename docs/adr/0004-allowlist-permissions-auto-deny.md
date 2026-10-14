---
status: accepted, amended by ADR-0049, ADR-0054, ADR-0055 and ADR-0056
---

# Headless runs use per-role allowlists, and anything else is denied without a prompt

Every agent Run gets an explicit, per-role tool allowlist. Anything outside it is denied automatically instead of prompting, so a headless Run can never hang waiting on a person. Git branch operations (push, checkout, switch, merge, rebase, reset, branch, worktree) are always denied because the engine owns branches. Network and MCP are off by default. The developer's personal agent settings are not loaded, so they can't widen a Run's permissions. `segno.config.json` may add allow entries per role, but it can never lift the always-denied set or turn on bypass mode. A role refuses an Adapter that can't enforce an allowlist.

## Considered Options

- **Bypass all permission checks inside the worktree.** Simpler and never denies anything, but nothing would stop an agent pushing, reaching the network or writing outside its worktree.
- **Prompt the developer.** Breaks unattended runs. That is the failure this decision exists to prevent.
