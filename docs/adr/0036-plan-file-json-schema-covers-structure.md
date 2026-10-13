# The Plan file JSON Schema covers structure; Segno also checks cross-references

The committed Plan file JSON Schema [ADR-0002] [ADR-0034] checks structure only: types, required fields, unknown keys (so a task with `generated` is rejected too), slug patterns and lengths, minimum counts, risk flag values and `schemaVersion`. Standard JSON Schema can't compare one value in a document with another. So the rules that do (`duplicate-id`, `unknown-dependency`, `cross-phase-dependency`, `dependency-cycle` and `reserved-id`) are checked only by Segno's validator, and a file that breaks only those rules passes the JSON Schema. Drift is still caught: the schema must accept the valid example and every fixture that fails only a cross-reference rule, which are listed by name, and it must reject every structural fixture.

## Considered Options

- **Keep calling the JSON Schema "equivalent".** It can't be true, and writers would trust a schema pass that Segno later rejects.
- **Encode the cross-reference rules with non-standard keywords** (such as `$data` or custom ones). Most validators ignore them, so writers would get different answers depending on their tool.
