---
name: build-phase
description: Build one Segno build phase (B1–B10) from docs/build-plan.md when the user invokes build-phase or asks to build a specific phase.
---

Read [the shared build-phase command](../../../.claude/commands/build-phase.md)
and follow its workflow.

Use the phase number supplied by the user wherever the command says
`$ARGUMENTS`. If no phase number was supplied, ask for it before starting.

Resolve referenced skills through Codex skill discovery and read their
instructions. Preserve the command's specific rules when using those skills.
Report any unavailable required skill before the step that needs it.

The command's `code-review` step refers to Claude's native review capability,
not an additional repository skill. In Codex, perform the equivalent code
review before opening the PR: review the phase's changes against its build
plan, specs, ADRs, and repository standards. Codex's native `/review` command
or `codex review` can provide a dedicated review. Do not require installation
of a `code-review` skill.
