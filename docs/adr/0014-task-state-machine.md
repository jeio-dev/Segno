# Task state machine: 11 states, with pause as a flag

A Task is in exactly one of `waiting`, `ready`, `coding`, `testing`, `reviewing`, `held`, `merging`, `done`, `blocked`, `taken-over` or `superseded`. The main loop is ready → coding → testing → reviewing → merging → done (ADR-0003). A failing test or a rejection returns to coding. A high-risk approval goes to `held` and waits for the developer. Every entry into `blocked` records a Block reason. Pause is a flag, not a state: the Task keeps its state, its live Run is stopped, and the interrupted step reruns from the start on resume without using any budget. Hand back re-enters at `testing`, so the developer's changes are tested and reviewed like any other.

## Considered Options

- **Paused as a state.** A paused Task would then have to remember which state to return to, which doubles the transitions.
- **Hand back straight to merging.** The developer's code would merge without passing tests or review.
