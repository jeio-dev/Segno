# API

The local HTTP server started by `segno serve`. It is built on Hono [ADR-0006]. The CLI (v1) and the GUI (v1.1) are both thin clients, typed from the same route definitions and zod schemas [ADR-0006] [ADR-0022].

## Binding and lifecycle

- **Address.** It listens on `127.0.0.1` only, with no option to bind elsewhere [ADR-0008].
- **Port.** The port comes from `port` in `config.local.json` (default `4747`). If the port is taken, `serve` fails with an error naming the port. It never picks another [ADR-0008] [ADR-0025].
- **Single instance.** It's enforced through `.segno/server.json` ([store.md](store.md#segno-layout)) [ADR-0008].
- **Static files.** The same server serves the built GUI at `/` **(v1.1)** [brief §Decided].

## Authentication and request checks

Every request is checked in this order [ADR-0008]:

| Check | Rule | Failure |
|---|---|---|
| Host | the `Host` header is `127.0.0.1:<port>` or `localhost:<port>` | `421`, `{ code: "bad-host" }` |
| Credential | `Authorization: Bearer <token>` matches `server.json`'s token, **or** the `segno_session` cookie is valid | `401`, `{ code: "unauthorized" }` |
| Origin (POST only) | if the request authenticated with the cookie: an `Origin` header is present and equals `http://127.0.0.1:<port>` or `http://localhost:<port>` | `403`, `{ code: "bad-origin" }` |

**Token.** A new random token, at least 32 bytes, is generated on every `serve` start and written to `server.json` (mode 0600). Restarting invalidates every earlier token and cookie [ADR-0008].

**GUI login (v1.1).**

- `GET /auth?t=<token>` with a valid token sets `segno_session` (`HttpOnly; SameSite=Strict; Path=/`) and redirects `302` to `/`.
- An invalid token gets `401` and sets no cookie.
- The `/auth` route is exempt only from the Credential check [ADR-0008].

GETs and both SSE streams require credentials too, because diffs and transcripts contain source code [ADR-0008].

## Commands

`POST /api/commands` with a JSON body holding one Command (the full list is in [engine.md](engine.md#commands)) [ADR-0022].

```ts
// 200 – accepted
{ ok: true, events: number[] }                      // seq of every Event appended
// 200 – rejected by the Engine (nothing appended)
{ ok: false, code: RejectionCode, message: string, errors?: ValidationError[] }
```

- The HTTP status is `200` for every well-formed request, whether accepted or rejected. `400` is used only when the body isn't JSON or has no recognizable `type` (`{ code: "bad-request" }`) [ADR-0022].
- `RejectionCode` values are listed in [engine.md](engine.md#rejection-codes). `errors` is present for `validation` and uses the shape in [plan-format.md](plan-format.md#validation).
- Commands are processed in arrival order (see [engine.md](engine.md#processing-model)).

## Queries

All are `GET` and return JSON [ADR-0022].

| Path | Returns |
|---|---|
| `/api/board` | the active Plan and its active or awaiting-merge Phase: Phase state; Tasks with state, pause flag, budgets used, Block reason, wait reason, high-risk flag and current Run; merge-queue order; board and rate-limit pause state; session meter; usage, if reported. `null` Plan when none is active |
| `/api/awaiting` | the Awaiting-you items: `{ id, kind, planId, phaseId?, taskId?, title, createdAt }[]`, oldest first |
| `/api/tasks/:id` | the full Task: current definition and revisions, state history, Runs, Verdicts, Findings (open and closed), risk, budgets |
| `/api/tasks/:id/diff` | a unified diff of the Task branch against its merge-base with the Phase branch, plus the open diff-line Findings anchored to it. Once the worktree is deleted, the diff recorded at merge time |
| `/api/runs/:id` | Run metadata (kind, Role, model, timing, outcome) |
| `/api/runs/:id/transcript` | `transcript.jsonl` or `output.log` as stored, or `410 { code: "pruned" }` |
| `/api/runs/:id/prompt` | `prompt.md`, or `410 { code: "pruned" }` |
| `/api/plans` | every Plan in the repo with its state (History) |
| `/api/plans/:id` | the Plan as currently derived |
| `/api/plans/:id/export` | the Plan as YAML (`text/yaml`), in the export form of [plan-format.md](plan-format.md#export) |
| `/api/phases` | archived Phases (History): `{ id, planId, title, state, prUrl?, startedAt, mergedAt? }[]` |
| `/api/phases/:id/events` | every Event belonging to that Phase, for replay |
| `/api/config` | the effective config, its source per key (`file`, `local`, `default`), and the latest `config.rejected` warning if one is unresolved |
| `/api/health` | `{ version, pid, startedAt }` (used by the CLI's server check) |

Unknown ids return `404 { code: "not-found" }`.

Sources: [ADR-0022] [ADR-0007] [ADR-0025] [ADR-0033] [ADR-0012] [brief §The GUI].

## Local actions

`POST /api/tasks/:id/open-worktree` runs the configured `editor` command (from `config.local.json`, with `{path}` replaced by the worktree path) on the server's machine. It isn't a Command and writes no Event [ADR-0015] [ADR-0025]. It returns `204`, or `{ code: "no-worktree" }` with `409`, or `{ code: "no-editor" }` with `409` when `editor` is unset. It is subject to the same auth and Origin checks as Commands.

## Event stream

`GET /api/stream`, as Server-Sent Events [brief §Decided] [ADR-0007].

- Every appended Event is sent as one SSE message: `id: <seq>`, `event: <type>`, `data: <the Event as JSON>`.
- A client that reconnects with `Last-Event-ID: <seq>`, or `?since=<seq>`, first receives every Event after that seq, in order, then the live tail, with no gaps or duplicates.
- With neither, the stream starts with the live tail only. Clients load state from `/api/board` or by replay, then attach with `since`.
- Heartbeat: a comment line (`: ping`) every 15 s.
- Clients derive state with the Engine's reducer, from the shared package [ADR-0007].

## Live Run output

`GET /api/runs/:id/stream`, as SSE [ADR-0007].

- While the Run is live, its `output` text and script output lines are sent as `event: output`, `data: { text }`. When it ends, `event: end` with `data: { outcome }` is sent and the stream closes.
- For a finished Run, the stream sends `end` immediately. Clients read the stored transcript instead.
- This output is never written to the Event log.

## Error format

Every non-2xx response has the body `{ code: string, message: string }` [ADR-0022].

| Status | `code` |
|---|---|
| 400 | `bad-request` |
| 401 | `unauthorized` |
| 403 | `bad-origin` |
| 404 | `not-found` |
| 409 | `no-worktree`, `no-editor` |
| 410 | `pruned` |
| 421 | `bad-host` |
| 500 | `internal` (the details go to `server.log`, never to the client) |
