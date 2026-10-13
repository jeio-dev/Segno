# An empty derived Plan slug falls back to `plan`

A valid Plan title may contain no ASCII letters or digits, so the slug rule can produce an empty string. Use `plan` in that case, then apply the existing Project-history collision rule (`-2`, `-3`, …). This keeps such titles valid while giving their Plans usable branch names.

## Considered Options

- **Reject titles without ASCII letters or digits.** This would unnecessarily restrict valid Plan titles, including titles in other languages.
