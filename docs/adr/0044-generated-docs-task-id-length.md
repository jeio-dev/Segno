# Generated Docs task ids may be longer than authored ids

Phase ids and authored Task ids remain capped at 48 characters [ADR-0011]. A generated Docs task keeps the required `<phase-id>-docs` id, so its id may be up to 53 characters. This resolves the conflict between the authored slug limit and the automatic Docs task definition without shortening valid Phase ids or changing generated ids.

## Considered Options

- **Cap Phase ids at 43 characters.** That would reject Phase ids already allowed by the Plan file contract.
- **Truncate generated Docs ids.** That would break their specified derivation and could create collisions.
