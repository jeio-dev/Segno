# Changelog

All notable changes to Segno are documented here, following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

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
