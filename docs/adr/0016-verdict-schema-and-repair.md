# Verdict schema, engine-enforced consistency and malformed-verdict repair

A Verdict is `{ schemaVersion, decision: approve|reject, summary, acceptance[] (one entry per criterion), docs { needed, satisfied }, findings[] { severity: blocking|advisory, file?, line?, body }, risk[]? }`. The Engine checks consistency rather than trusting the Reviewer. An approve must have every criterion met, docs satisfied or not needed, and no blocking Findings. A reject must have at least one blocking Finding or unmet criterion. A Reviewer-raised risk makes the Task high-risk for good. A missing, unparseable, schema-invalid or inconsistent Verdict is malformed. It is never read as approve or reject. Segno asks the same session once to repair it (or runs a fresh review if the Adapter can't resume), and every repair or rerun uses the Infra budget. Once that's exhausted, the Task is blocked with `verdict-invalid`.

## Considered Options

- **Treat malformed as reject.** It uses the Coder's chances for a tooling fault.
- **Block on the first malformed Verdict.** It interrupts the developer for something a repair usually fixes.
