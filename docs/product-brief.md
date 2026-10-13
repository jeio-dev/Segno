# Segno: product brief

This is the original product description and the decisions that came with it, copied verbatim from the design kickoff on 2026-10-12. The only change is that the visual identity's CSS block now lives in `docs/design-tokens.css`. Spec rules cite it as `[brief §<section>]`. Don't edit it to match later decisions. Those live in `docs/adr/`.

---

## Decided

- TypeScript throughout, as a pnpm workspace.
- A local Node server plus a browser GUI built with React and Vite. No Electron or Tauri. Live updates go to the GUI over Server-Sent Events (SSE).
- SQLite (better-sqlite3) holds an append-only event log. Board state is derived from it.
- The engine is the only writer. The GUI, CLI and agents send commands or output, and the engine validates every transition.
- Agents run as headless CLIs, Claude Code first. Each task gets its own git worktree, deleted when its card is done.
- Retry caps: 2 rejected reviews, 2 failed test runs, and a separate infra retry budget.
- Tests run as a script; only the exit code counts.
- Tasks merge to a phase branch. Each phase ends with a docs card, and gets one PR to main, which the developer merges.
- One active plan per repo.
- Transcripts are stored as files and can be pruned. Events and verdicts are kept forever.
- The visual identity, as specified below.

---

# Segno

Segno is a local app that runs a software development cycle with a small team of AI agents while the developer supervises. You settle a feature with a planning agent. Segno splits it into tasks and drives each task through coding, review and testing until it is done or needs a human decision.

It runs on the developer's own machine. `segno serve` starts one process that does the work and shows it on a live board in the browser. A CLI talks to the same process.

## Who it's for

Solo developers and small teams who already code with AI agents (Claude Code, Codex, OpenCode) and want structure around them: enforced task order, small focused sessions, review limits, and a clear record of what happened. Segno runs the agent CLIs and subscriptions people already have. It does not replace them.

## How it works

Four roles share one board.
- The **Planner** agrees on scope with the developer and writes a task graph with explicit dependencies, flagging high-risk tasks such as migrations, auth, payments, or anything that deletes data.
- A **Coder** takes one ready task in a fresh session and its own git worktree. Independent tasks run in parallel.
- A **Reviewer** returns a structured verdict on each task.
- **Tests** run as a script, and only the exit code matters.

Each role's model is configurable, so expensive models go where judgment matters.

Each task gets two rejected reviews and two failed test runs. A failed test goes straight back to the Coder with the log attached. After either limit, the card moves to **Blocked**, where the developer and the Planner audit it, then replan, split or take it over.

Finished tasks merge into a phase branch, never into main. Every phase ends with a docs card that depends on all the other tasks. It updates the README and guides, and writes changelog entries; a cheap model is enough for the changelog. When the phase completes, Segno opens one pull request to main, and the developer merges it. One plan runs per repo at a time.

## Principles

- Code runs the process and agents do the work. Agents and the GUI never move cards. The orchestrator decides every transition from agent output and from the developer's commands.
- Every loop has an end. Retry limits route stuck work to a human instead of burning sessions. Infrastructure failures (timeouts, crashes, dropped connections) have their own small retry budget and never use up review or test attempts.
- Nothing waits silently. Every card either has a live process or a visible reason it is waiting. Rate limits pause the whole board until the reset time; they don't fail tasks. On restart, interrupted runs resume where they were.
- Each session gets only the context its task needs.
- Docs ship with code. Each task's definition of done includes docs for any behavior it changes, and the Reviewer checks it.
- Everything is recorded. An append-only event log drives the board and makes crash recovery and full replay possible. Transcripts, diffs and findings are kept for every task.

## Where the developer steps in

An **Awaiting you** queue collects everything that needs a person, so the developer never has to watch the board:
- plans to approve or send back with notes
- flagged high-risk tasks the Reviewer has approved, held before merge
- Blocked cards to audit
- finished phases with a pull request ready

A browser notification fires when something new lands there.

## The GUI

The GUI is for watching and stepping in. It does not do the work.

- **The board** shows only the active phase, with retry counters on each card, a pulsing dot on running cards, a session meter, and subscription usage with its reset time. Done collapses after the five newest cards.
- **A card drawer** has Diff, Review, Tests and Transcript tabs. The developer can attach notes to diff lines, which go back to the Coder as blocking findings.
- **Card actions** depend on state: approve, send back, pause, stop and retry, replan, split, force-approve with a required reason, take over and hand back, and open the worktree in an editor.
- **Global controls** are pause all and model settings per role.
- **History** lists archived phases, each read-only and replayable from the event log.

The GUI never offers dragging cards between columns, typing into a running agent, or editing files. Take over and Open worktree cover hands-on work.

## User journey

1. `segno init` in a repo detects the installed agent CLIs and the test command, sets the model per role and the base branch, and writes `segno.config.json` (committed) and `.segno/` (gitignored).
2. `segno serve` starts the engine and opens the board on localhost.
3. **New plan** produces a plan, which the developer approves from Awaiting you. Approval creates the phase branch.
4. Cards run on their own. The developer steps in only when Awaiting you calls.
5. When the phase completes, a pull request to main is opened, and the developer checks out the branch, tests it and merges.
6. Stopping and restarting at any time is safe, because the event log restores the board exactly.

## Housekeeping

A task's worktree is deleted once its card is done. Transcripts are stored as files and can be pruned after 30 days. Events and verdicts are kept forever.

## What it is not

It is not a hosted service, an IDE, or a chat app, and it is not tied to one AI provider. It does not decide scope or settle audits; those stay with the developer.

## Visual identity

The look is a calm, cool workspace: blue-grey neutrals, one cobalt accent, and semantic colors used only for status. It has light and dark themes.

Typography:
- **Bricolage Grotesque** (600/800) for the wordmark and headings only.
- **IBM Plex Sans** (400/500/600) for interface text.
- **JetBrains Mono** for anything machine-like: task IDs, branch names, counters, commands and logs.

The tokens are in `docs/design-tokens.css`.

Usage rules:
- **Accent** marks primary buttons, the selected card and task IDs, nothing else.
- **Status colors** appear only on badges, verdicts, exit codes and run-state pills. Badges are mono 10.5px semibold on the matching soft tint.
- **Role colors** appear only as small dots and labels showing who holds a card. The dot pulses while the card is running.
- **The Blocked column** gets the blocked background with a dashed outline in the bad color.
- **Transcripts and test output** render in dark terminal panels in both themes.
- **Card moves** animate smoothly with the move easing and duration, and all motion turns off under reduced-motion settings.
- **Controls** are at least 40px tall.

## Starting point (proposed v1, confirm during grilling)

The first version reads a plan file in Segno's own documented format: tasks, their descriptions, dependencies and risk flags. Any person or tool can write one. It runs one plan end to end with Claude Code, one task at a time. The board comes next, then planning inside Segno itself.
