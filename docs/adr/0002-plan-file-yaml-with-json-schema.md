# The plan file is YAML validated by a published JSON Schema

The plan file is Segno's public contract: people, Segno's own Planner and third-party tools all write it. We chose YAML with a versioned JSON Schema (`schemaVersion`) so any writer can validate a plan before Segno sees it, and Segno can reject a bad plan with errors that point at the line. Multi-paragraph task descriptions use YAML block scalars.

## Considered Options

- **Markdown with conventions** (a heading per task, YAML metadata blocks). Nicer to read, but it can't be validated precisely, and a stray heading silently changes the structure.
- **JSON.** Strict, but painful to write long prose in by hand.
