---
status: accepted, amended by ADR-0058
---

# Each Run gets a fixed, minimal context built by the Engine

The Engine builds every prompt from fixed ingredients and records it as `prompt.md`.

- **The Coder** gets the Plan title and summary, the Phase title, the Task definition, the definition of done and the test command. On later passes it also gets the open blocking Findings, the last 200 lines of the failing test log, or the conflicting files.
- **The Reviewer** gets the Task definition and risk, the diff range, the fact that tests passed, the previous blocking Findings and the Verdict schema.
- **The Docs task** gets the Phase summary, each done Task's title and Verdict summary, advisory Findings, the Phase diff range, the Phase `docs` block and the changelog path.

No Run ever gets other Tasks' descriptions or earlier transcripts. Every agent Run starts a fresh session, except an interruption resume (ADR-0020) or a Verdict repair (ADR-0016). Repo instruction files are read by the CLI itself, not copied in. Prompt templates are built in.
