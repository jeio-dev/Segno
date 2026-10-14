# A Task holds its run slot until it leaves the loop

A Task takes a run slot when it leaves `ready` for `coding`, and keeps it through `testing`, `reviewing` and `merging`. It gives the slot back when it becomes `done`, `held`, `blocked`, `taken-over` or `superseded`. So with one slot, a Task is worked end to end before the next one starts. In a linear flow the Phase branch hasn't moved since the Task branch was cut, and the merge re-test is skipped (ADR-0005). The merge queue fills only when a Task re-enters `merging` from a state that doesn't hold a slot, such as `held` after `task.approve`. `SEGNO_SLOT` is the slot the Task holds, so every Run in the loop sees the same value (ADR-0029).

## Considered Options

- **A slot is held only while a Run is live.** Tasks would interleave between steps, so even at concurrency 1 a Coder's work would wait behind other Tasks' test and review Runs, and `SEGNO_SLOT` would change between a Task's Runs.
