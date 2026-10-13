# Changelog

All notable changes to Segno are documented here, following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Eight-package pnpm workspace with TypeScript project references, Biome, Vitest and CI on Node 22 and 24.
- Browser-safe Plan file parsing and validation with source locations and all validation codes.
- Replan and split fragment validation using the current Plan and its Task-id history.
- Plan export with generated Docs tasks, superseded Task omission and merged Reviewer risks.
- Structural JSON Schema and valid and invalid Plan file examples.
- Standalone offline `segno plan validate <file>` bundle, needing no repo or config.
