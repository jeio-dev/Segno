# Phases run sequentially and wait for the previous phase's merge

A Plan is an ordered list of Phases. Each Phase gets its own phase branch, docs task and pull request. The next Phase starts only after the previous Phase's pull request is merged into the base branch, and its phase branch is cut from the updated base. Segno therefore never builds on code the developer hasn't accepted, and never has to rebase a stack of PRs.

## Considered Options

- **One Plan is one Phase.** Simpler, but then "Phase" has no meaning of its own, and multi-step work needs a chain of separate Plans.
- **Stacked Phases.** Phase N+1 branches from Phase N's branch before the merge. Faster, but review changes on Phase N force rebases on everything after it.
