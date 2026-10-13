---
status: accepted, amended by ADR-0043
---

# Event versioning starts at the first published release

ADR-0031 still applies in full, but only from Segno's first published release [ADR-0034]. Until then, no user has an Event log, so Event shapes may change in place at `v: 1`, and every local `.segno/segno.db` (test repos, dogfooding) is disposable. A change to an existing Event's shape before the release is called out in its pull request and in the build plan, and local logs are deleted rather than migrated. The catalog freezes as part of the release, and from then on a shape change means a new `v`, never a rewrite [ADR-0031]. This avoids building and keeping reducer branches for versions that only ever existed during development.

## Considered Options

- **Apply ADR-0031 from the first merged Event log code.** Strict, but every shape change made during the build would leave a permanent reducer branch for data no user has.
- **Also store a catalog fingerprint in the database and refuse mismatched logs before release.** Safer than relying on notes, but it's machinery that's only useful until the release.
