# Hono for the local server

The server only serves a JSON command and query API, Server-Sent Events and the built GUI to one local user, so throughput doesn't matter. We chose Hono (on `@hono/node-server`) because its typed client gives both the CLI and the GUI end-to-end types from the same route definitions and zod schemas, with no codegen. It also has a built-in SSE helper.

## Considered Options

- **Fastify.** More mature on Node and has a larger plugin ecosystem. SSE needs a plugin or raw reply handling, typed clients need extra setup, and its throughput advantage is irrelevant here.
