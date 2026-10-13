# Clients derive state from Events with the Engine's own reducer

The SSE stream carries raw domain Events, each with its sequence number as the SSE id, not board snapshots. The GUI and CLI derive state with the same reducer the Engine uses, from a shared package, and History replay uses it too. Live view, restart recovery and replay therefore can't disagree, and a reconnect resumes from `Last-Event-ID` without gaps. Live Run output (transcripts, test logs) streams separately and never enters the Event log.

## Considered Options

- **Push derived snapshots or patches.** Clients would be simpler, but it creates a second state-derivation path that replay would also need, and the two could drift.
