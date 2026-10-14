# Plan slugs avoid existing Segno branches

A Plan slug was unique only within the Project's Event log (ADR-0033). A repo removed and added again starts a new Event log but keeps its `segno/<slug>/…` branches, so its next Plan could get a slug whose Phase branch already exists, and cutting the branch would fail. A slug is therefore also taken when the repo has a local branch `segno/<slug>/*`, or a remote-tracking ref `<remote>/segno/<slug>/*` as last fetched. The usual `-2`, `-3` suffix applies, and `plan.submitted` records the chosen slug. Phase and Task branches share the `segno/<slug>/` prefix, so neither can collide.

## Considered Options

- **Defer the Phase start with a `branch-exists` reason** until the developer deletes the branch. It asks the developer to clean up after Segno.
- **Reuse the existing branch.** It may hold another Plan's work.
