# Claude Code fixtures

Recorded `claude -p --output-format stream-json --verbose` output that S5 replays through a stub `claude` (`../replay.ts`). `fixtures.json` names the Claude Code version they were recorded with, and how each recorded process ended.

| Fixture | Recorded as | Classifies as |
|---|---|---|
| `completed.jsonl` | haiku reads `README.md` and replies with its first word | `completed` |
| `completed-structured.jsonl` | the same, with `--json-schema` | `completed` with `structured` |
| `failed.jsonl` | an unknown model: a synthetic `model_not_found` message, an error result, exit 1 | `failed` |
| `crashed.jsonl` | SIGKILL after the first assistant message, so there is no result | `crashed` |
| `rate-limited.jsonl` | **derived** from `failed.jsonl` | `rate-limited` with `resetAt` |
| `rate-limited-no-reset.jsonl` | **derived** from `failed.jsonl` | `rate-limited` without `resetAt` |

**Derived fixtures.** A usage limit can't be hit on demand. `deriveRateLimited` in `../replay.ts` makes the two rate-limited fixtures from the failed recording: a rejected `rate_limit_event`, and the CLI's synthetic `rate_limit` message and error result, with status 429. The reset time is fixed at 2026-10-14T17:00:00Z, so the S5 literals hold across re-recordings.

**Sanitizing.** `sanitize` drops the init keys that describe the recording machine (plugins, skills, agents and similar), and replaces the repo path, the home directory and the session id. The stub puts back the session id it was started with.

**Re-recording.** `pnpm test:live` records every fixture again with the installed `claude`, on the developer's subscription, through the Adapter's own transcript tee. It then checks that each one replays to its classification and runs the S5 tests. Review the diff before committing it. CI never runs it.
