# A probe Run has no tools

A rate-limit probe (ADR-0021) only finds out whether the subscription answers again, so it gets a minimal fixed prompt and no tools at all. A permission profile can't say that, because every profile reads files (ADR-0004), and the Claude Code flag table had no row for it. The Adapter therefore gives a Run of kind `probe` no tools, whatever its profile allows. Claude Code does this with `--tools ""`, which disables every built-in tool. The profile is still mapped as usual, which is harmless with no tools available.

This amends ADR-0004, as one more exception to a Run's profile, and ADR-0021, as to how a probe runs.

## Considered Options

- **A profile that can turn reading off.** Every other Run reads, and a probe is the only exception, so widening the profile type for one Run kind spreads the change to every Adapter's mapping.
- **Leave the probe with the read-only profile.** A probe that can read files and run tools isn't minimal, and could use more of a nearly exhausted limit.
