---
status: superseded by ADR-0039 and ADR-0042
---

# CLI command set and exit codes

The CLI is a thin client of the running server. Only `init`, `serve` and `plan validate` work without one. It covers:

- setup: init, serve, open
- observation: status, awaiting, watch
- the Plan lifecycle: validate, submit, approve, send-back, abandon, export
- every Task action, including diff-line notes and replan or split from YAML fragments
- board pause and resume, a manual phase-merged confirmation, per-Role model changes and pruning

Read commands take `--json`. The exit codes are 0 OK, 1 Command rejected by the Engine, 2 usage or validation error, and 3 server not running.
