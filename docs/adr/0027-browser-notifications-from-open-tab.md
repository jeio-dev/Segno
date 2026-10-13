---
status: superseded by ADR-0041
---

# Notifications come from an open GUI tab, never from the server

Awaiting-you notifications use the browser Notifications API in an open GUI tab, triggered by new Events on the SSE stream. Each new item fires once, keyed by Event sequence and deduplicated across tabs with a BroadcastChannel and a notification tag. Nothing fires for items already present at load, or while the tab is focused. Permission is requested only from an explicit control. A notification shows the item kind, Task id and title, never code. A title count, a favicon dot and `segno watch`'s terminal bell cover the case when notifications are off.

## Considered Options

- **OS-level notifications from the server.** They work with no tab open, but need native helpers that behave differently on macOS, Linux and WSL. Deferred.
