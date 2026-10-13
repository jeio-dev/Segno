# Projects run concurrently, and a rate limit pauses an Adapter app-wide

Each Project runs its active Plan independently, with concurrency fixed at 1 per Project in v1 (ADR-0030's rule, now per Project). Agent subscriptions are per developer, not per repo, so a Rate-limit pause (ADR-0021) applies to that Adapter's agent Runs in every Project, and lifts or probes once for all of them. Test and other script Runs keep running everywhere.

## Considered Options

- **Only one Project runs agents at a time.** Simpler, but a long Phase in one repo would block every other.
