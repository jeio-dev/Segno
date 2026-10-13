---
status: superseded by ADR-0037
---

# The local server requires a per-start token and checks Host and Origin

The server binds to 127.0.0.1 only. Even so, any web page the developer visits can reach it through cross-site requests or DNS rebinding, and its commands include force-approve and merge, while its responses contain source code. Every request therefore needs a token created at each start (a Bearer header for the CLI, or an HttpOnly SameSite=Strict cookie set through a one-time URL for the GUI) and a Host of 127.0.0.1 or localhost on the configured port. POSTs also need a matching Origin or the Bearer token. The token file `.segno/server.json` also serves as the single-instance lock.

## Considered Options

- **No auth, because it's only localhost.** That is exactly the setup cross-site requests and DNS rebinding attacks exploit.
