# Output schemas reach Claude Code without their `$schema` key

The Verdict and onboarding output schemas are generated from their Zod schemas, and they declare `"$schema": "https://json-schema.org/draft/2020-12/schema"`. Claude Code 2.1.299 checks `--json-schema` with a validator that doesn't know that dialect. It refuses the flag (`no schema with key or ref "https://json-schema.org/draft/2020-12/schema"`) and exits 1 before printing anything, so every Reviewer and onboarding Run crashed. A probe against 2.1.299 showed that the same schema without the key is accepted.

The Claude Code Adapter removes the top-level `$schema` key when it builds `--json-schema`. The keywords the schemas use mean the same in either dialect, so the schema Claude Code enforces is the one the Engine validates against. Core keeps generating standard schemas, and other Adapters get them unchanged.

A Run that ends without a result now carries claude's stderr as its detail, because a refused command line is reported only there.

## Considered Options

- **Generate draft-07 schemas in core** (`z.toJSONSchema(…, { target: "draft-7" })`). It ties core's output to one CLI's validator, and whether Claude Code resolves that dialect's URI wasn't checked.
