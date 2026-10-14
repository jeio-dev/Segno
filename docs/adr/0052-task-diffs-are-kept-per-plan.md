# Task diffs are kept per Plan

Task ids are unique only within a Plan (ADR-0011), and later Plans reuse them: a Plan resubmitted after an abandon keeps its ids, and two Plans with the same Phase id both get its Docs task. A Task's diff is kept forever, so it lives at `tasks/<plan-slug>/<task-id>/merged.diff` rather than `tasks/<task-id>/merged.diff` (ADR-0033). Plan slugs are unique within a Project, and the path matches the Task branch `segno/<plan-slug>/<phase-id>--<task-id>`. A Task id in a Command or query means the Task of the newest Plan that has it, which is the active Plan's while one is active.

## Considered Options

- **Key by Plan id.** Also unique, but an opaque UUID where the slug already names the Plan on every branch.
- **Task ids unique across the Project.** A revised Plan would have to rename every Task, and every Phase id could be used only once.
