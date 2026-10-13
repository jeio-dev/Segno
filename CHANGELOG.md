# Changelog

All notable changes to Segno are documented here, following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

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
