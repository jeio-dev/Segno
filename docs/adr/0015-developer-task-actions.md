# What each developer action on a Task does

- **Approve** (`held` → `merging`) and **Send back** (`held` → `coding`, notes required) use no budget, because it's the developer's call, not the Reviewer's.
- **Diff-line notes** are stored as blocking Findings with `source: developer` and go to the Coder on its next pass.
- **Pause and Resume** toggle the flag.
- **Stop and retry** reruns the current step without using any budget.
- **Take over** is allowed from any state except waiting, done and superseded.
- **Hand back** first commits any uncommitted work.
- **Open worktree** is a local convenience, not a Command.

From `blocked`:

- **Retry** resets only the exhausted budget and keeps the worktree. After review-limit or test-limit, the Task returns to `coding`. After infra-limit, verdict-invalid or setup-failed, the step that failed runs again.
- **Replan** replaces the definition with a new revision (same id and dependencies), resets every budget, recreates the worktree and returns to `ready`.
- **Split** supersedes the Task with two or more new Tasks, and its dependents depend on all of them.
- **Force-approve** (reason required, from `blocked` for review-limit or verdict-invalid, or from `reviewing`) skips review but not the merge-queue re-test.

Every reset is recorded, so the log shows how many chances a Task really had.

## Considered Options

- **Force-approve merges even with failing tests.** That would break the guarantee that the Phase branch is green (ADR-0005). To land code that doesn't pass, the developer takes over.

## Note

Merge conflicts never block a Task directly: they go back to the Coder (ADR-0005), and a resolution that keeps failing is blocked by the review or test limit. So `merge-conflict` is not a Block reason.
