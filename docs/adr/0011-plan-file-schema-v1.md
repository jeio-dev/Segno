# Plan file schema v1: tasks, risk flags and the automatic docs task

A Plan file has `schemaVersion`, `title`, `summary` and `phases[]`. Each Phase has an `id`, a `title`, an optional `docs` block and `tasks[]`. Each Task has `id`, `title`, `description` (markdown), `acceptance` (one or more criteria), optional `dependsOn` (Task ids in the same Phase only), optional `context` path/glob hints and optional `risk`. Ids are author-chosen slugs, unique across the Plan and never reused, including after a split. A Plan needs at least one Phase, and every Phase needs at least one authored Task. Cycles, unknown ids and cross-Phase dependencies reject the whole Plan.

`risk` is `{ flags: [...], reason }`. The flags come from a fixed set (migration, auth, payments, data-deletion, security, other), and a reason is always required. Any flag makes the Task high-risk, and there is a single tier. Segno adds every Phase's Docs task itself, with id `<phase-id>-docs`, depending on all other Tasks in the Phase. A Plan that declares that id or depends on it is rejected.

## Considered Options

- **Dependencies across Phases.** Unnecessary, because Phases already run in order (ADR-0001).
- **Risk levels or free-form tags.** They can't be badged or filtered reliably.
- **An authored Docs task.** Every author would have to restate a fixed rule correctly, which only creates ways to get it wrong.
