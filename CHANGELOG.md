# Changelog

All notable changes to Segno are documented here, following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- The Claude Code Adapter: `claude -p` with stream-json, an explicit allowlist and no prompts, user settings and MCP servers left out, classification of every Run as completed, failed, crashed or rate-limited, and `stop()` for the whole process group. It's tested against recorded fixtures, and `pnpm test:live` re-records them. A probe Run has no tools (ADR-0054), the always-denied git operations are best effort under the onboarding profile (ADR-0055), and the repo's own `.claude/settings.json` grants are denied unless a Run already allows them (ADR-0056), and output schemas are passed without their `$schema` key, which Claude Code can't resolve (ADR-0057). The app now uses it by default.
- Run context: every agent Run's prompt is built from fixed ingredients and kept as `prompt.md`, and lists the shell commands the Run may use, one at a time (ADR-0058). Coders and Reviewers can list and search files with `ls`, `grep`, `git ls-files` and `git grep` (ADR-0059). The Reviewer's output schema is the Verdict schema.
- Onboarding: **Onboard project** runs the Planner in a scratch worktree to find and run the repo's checks and propose a config, with live output, **Stop onboarding**, **Retry onboarding**, and an `onboarding-review` with each value's reason, the commands run, the flags, **Confirm** and **Edit**.
- Config validation refuses a Role whose Adapter isn't installed or lacks a capability it needs.
- Subscription usage in the `board` query and the board header, only as Claude Code reports it.
- `pnpm check:b5` and the developer-run `pnpm check:b5:live`; CI now runs `pnpm check:b5`.

- Phases start when a Plan is approved: the remote is fetched and the Phase branch cut from `<remote>/<baseBranch>`, with the Docs task added. An unreachable remote defers the start and retries every 5 minutes.
- Tasks run on the happy path: one Task per run slot, in Plan order, through setup, the Coder, `tests.command`, the Reviewer and the merge queue, each in its own worktree outside the repo with the `SEGNO_*` environment (ADR-0051). Leftover Coder changes are committed, every Segno commit has a `Segno-Task:` trailer, and the Phase branch moves only by fast-forward. Worktrees and Task branches are deleted once a Task is done, and its merged diff is kept.
- Abandoning an active Plan stops its Run, supersedes unfinished Tasks and deletes their worktrees and Task branches.
- The board's seven columns with cards, Role dots and the session meter; the card drawer with Diff, Tests and Transcript tabs and live Run output.
- The `task`, `taskDiff`, `run`, `runTranscript` and `runPrompt` queries, Task and Run fields on `board`, and the `runOutput` stream.
- The Agent Adapter interface types, and `@segno/engine/testing` with a fake Adapter, a fake clock and temp-repo fixtures. `SEGNO_FAKE_ADAPTER=1` runs the app with the fake Adapter until the Claude Code Adapter arrives.
- Task diffs are kept per Plan, as Task ids are unique only within a Plan (ADR-0052), and Plan slugs avoid `segno/*` branches already in the repo (ADR-0053).
- `pnpm check:b4`, with S3, S4, S6 and S9 coverage; CI now runs this exit check.

- Models-only Project addition: Projects without config start as **Not onboarded**, with their chosen models stored in app data. **Set up manually** shows detected settings and saves an uncommitted config (ADR-0049).
- Manual and file-based onboarding confirmation, pending config queries, and the `not-onboarded` Plan rejection. Missing pending config is recovered with the Add defaults before any Plan exists (ADR-0050).
- `pnpm check:b3.1`, with S6 onboarding coverage and S9 manual setup journeys; CI now runs this exit check.

- Desktop app shell on Electron 44: one window, single-instance lock, a sandboxed preload, and supervision of the Engine host (restart once, then **Restart Engine**).
- Engine host running one Engine per Project, with the IPC protocol, Event streams that replay from a sequence number, and per-Project queries for the board, Awaiting you, Plans, Plan export, Phases and config.
- Projects: a sidebar with Awaiting-you counts, adding a repo with models or its committed `segno.config.json`, unavailable Projects with their reason and every config error, **Locate…**, **Remove project** and renaming (ADR-0046).
- Strict validation of `segno.config.json` and local settings with located errors, including always-denied `allow` entries and offline remote and base-branch checks (ADR-0047).
- Plan submission from a file picker or by drag and drop, Plan review with approve, send back and abandon, and **Export Plan…**.
- App settings for the editor command and the light, dark or system theme, with bundled fonts.
- `SEGNO_APP_DATA` to choose the app data directory (ADR-0048).
- v1.2 Commands are answered `unsupported-in-version`.
- S6 host tests and S9 end-to-end journeys; CI runs `pnpm check:b3` on Node 24 under xvfb.
- Versioned v1 Event catalog, browser-safe Plan reducer and derived Awaiting-you queue.
- Plan Command and rejection schemas, and an Engine API for submission, approval, send back and abandonment.
- SQLite Event persistence with gap-free sequences, atomic Command writes, ordered processing and replay on open; startup refuses unknown Event types or versions.
- Plan slugs unique across Project history, with `plan` as the fallback for titles that produce an empty slug (ADR-0045).
- B2 exit check printing a real SQLite Event log, plus reducer and Engine tests at S2/S3; CI now runs `pnpm check:b2`.
- Eight-package pnpm workspace with TypeScript project references, Biome, Vitest and CI on Node 22 and 24.
- Browser-safe Plan file parsing and validation with source locations and all validation codes.
- Replan and split fragment validation using the current Plan and its Task-id history.
- Plan export with generated Docs tasks, superseded Task omission and merged Reviewer risks.
- Structural JSON Schema and valid and invalid Plan file examples.
- Standalone offline `segno plan validate <file>` bundle, needing no repo or config.
