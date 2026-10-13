---
description: Start a session that builds one build phase (B1–B10) of docs/build-plan.md
argument-hint: "<N>, the build phase number, e.g. 2"
---

Read docs/handoff.md first, then docs/build-plan.md (§ Rules, § Workspace,
§ Seams, § Docs per PR, and § B$ARGUMENTS), then every spec section and ADR that
§ B$ARGUMENTS lists under "Implements".

This session builds B$ARGUMENTS only. Nothing from later build phases.

Rules:
- Don't reopen anything decided in the brief, the ADRs or the build plan.
  If the work exposes a real spec gap, stop, raise it with me, and record a
  new ADR plus the matching spec edit in the same PR. Never patch it silently.
- Check the handoff's branch preconditions first (is the previous PR merged?),
  then work on build/b$ARGUMENTS-<slug> cut from main.
- Use the tdd skill: test-first, in vertical slices, only at the seams
  § B$ARGUMENTS names. Ask me before testing at any other seam.
- Use the grilling skill for any choice the plan doesn't settle: one question
  at a time, with a recommendation.
- Done means `pnpm check:b$ARGUMENTS` passes and CI is green. If § B$ARGUMENTS
  lists a live check, tell me when it's ready and I'll run it myself.
- Before opening the PR, run code-review. The PR includes the docs updates
  from § Docs per PR, B$ARGUMENTS's Status row set to done, and any Event shape
  changes logged per ADR-0035.

Commit and push only when I ask. Start by confirming the branch preconditions
and listing the slices you plan to build, in order.
