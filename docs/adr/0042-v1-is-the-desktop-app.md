# v1 is the desktop app on Linux and macOS, and the CLI only validates Plans

v1 ships the desktop app (ADR-0037) on Linux and macOS, with the full Engine, the Claude Code Adapter, the GitHub forge, adding Projects (ADR-0039) and the board GUI. Planning inside Segno (Planning sessions and Ask Planner) stays v1.2. On Windows, v1 runs through WSLg; a native Windows build, which would have to reach repos, `git` and agent CLIs inside WSL, is later. Every Plan, Task and board action is taken in the app. The `segno` CLI is reduced to `segno plan validate <file>`, which works offline anywhere, needs no repo or config, and ships inside the app with an action that installs the command onto PATH. A CLI that scripts the running app is later. This supersedes ADR-0026 and ADR-0030.

## Considered Options

- **Keep the headless core with the CLI as v1's only interface (ADR-0030), and the GUI in v1.1.** The app is the product now, and the core is still built and tested before the UI depends on it.
- **Keep the full CLI as a client of the app.** It needs a network or socket API in v1 for a second interface nobody has asked for yet.
