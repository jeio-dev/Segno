# One command endpoint and plain query endpoints

Every change goes through `POST /api/commands` with a zod discriminated union of Commands. It returns `{ ok: true, events }` or `{ ok: false, code, message }`, and a rejected Command writes nothing. Reads are plain GETs (board, awaiting, tasks, diff, runs, phases, config). Domain Events stream over one SSE endpoint (ADR-0007), and live Run output streams over a separate per-Run SSE endpoint. The CLI and GUI are both thin clients of this API.

## Considered Options

- **A REST endpoint per action.** That would put the Command vocabulary in two places, the routes and the Engine.
