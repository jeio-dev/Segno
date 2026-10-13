# Handoff: from design to a phased build plan

**Next session's job:** turn [`spec/`](spec/README.md) into a phased build plan for Segno. It's still a planning session, so write no application code.

## Where things stand

- **The design session is finished.** Skills were installed, the developer was grilled (34 rounds, every answer accepted), and the spec is written.
- **No code exists yet.** The repo holds only `4cae570 Initial commit`.
- **Nothing from the design session is committed.** `.claude/` and `docs/` are untracked on `main`. Commit only when the developer asks, and on a branch.
- **Remote:** `origin` → github.com/jeio-dev/segno. `gh` 2.101 is installed and logged in.
- **Claude Code 2.1.296 is installed.** Every headless flag the Adapter depends on was checked against it. The mapping is in [`spec/runners.md`](spec/runners.md).

## Read in this order

1. [`product-brief.md`](product-brief.md): the original description. Its **Decided** list is closed, so don't reopen it.
2. [`glossary.md`](glossary.md): use these terms exactly, and avoid the words each entry tells you to avoid. Two pairs that are easy to mix up:
   - Task vs. Card
   - Block reason vs. wait reason
3. [`spec/README.md`](spec/README.md): the citation rule, the **v1 cut line**, and the order of what's out of v1 (v1.1 GUI, v1.2 planning, later).
4. The area specs: `plan-format`, `engine`, `store`, `runners`, `api`, `cli`, `config`, then `gui` (v1.1).
5. [`adr/`](adr/) 0001–0033, where you need the reasoning behind a rule. [ADR-0030](adr/0030-v1-cut-line.md) is the scope contract.

## Constraints the build plan has to respect

- **Release scope.**
  - v1 is the headless core with the CLI as its only interface, and `concurrency` fixed at 1.
  - The GUI is v1.1, and planning inside Segno is v1.2 [ADR-0030].
  - Until a release ships, its Commands return `unsupported-in-version`.
- **Traceability.** Every spec rule cites the brief, an ADR or the glossary. A build task that needs a rule with no source has found a spec gap. Raise it with the developer, then add an ADR. Don't decide it silently in the plan.
- **State.** The Engine is the only writer. The CLI and the GUI both derive state with the Engine's own reducer from a shared package [ADR-0007], so the reducer and the Event catalog ([`spec/engine.md`](spec/engine.md)) underpin everything else.
- **Event versioning** [ADR-0031]. Stored Events are never rewritten. Plan for upcasters from the first schema onward.
- **Testing.** The developer installed the `tdd` skill. Each phase should name its observable behaviors, which become its integration tests.
  - The Adapter needs a fake agent CLI so Engine tests never call a real model.
  - git and `gh` need temporary repos or fakes.
- **Dogfooding.** Segno's own build process mirrors its product: phases, one PR per phase into `main`, and a docs card at the end of each phase. It's worth asking whether the build plan should be written as a Segno Plan file ([`spec/plan-format.md`](spec/plan-format.md)) so it can later run on Segno itself.

## Not yet reviewed by the developer

These choices went into the spec while it was being written. They were reported at the end of the design session, and the developer hasn't commented on them yet. Treat them as settled unless the developer raises them, but don't be surprised if they do.

- **Retry rules.** `merge-conflict` was removed as a Block reason, and Retry after an infra-type block reruns the failed step [ADR-0015].
- **Plan file.** Exported plans mark the Docs task `generated: true`, which is rejected on submit. Ids are 1–48 characters, and plan slugs are capped at 40.
- **Storage.** `.segno/tasks/<id>/merged.diff` is kept forever [ADR-0033].
- **Two additions:** `segno phase reopen-pr` and `POST /api/tasks/:id/open-worktree`.
- **Dark theme.** The dark `prefers-color-scheme` block in [`design-tokens.css`](design-tokens.css) was filled in from the `[data-theme="dark"]` values.

## Open questions for the next session

- **Where the build plan lives.** For example `docs/build-plan.md`, or one file per phase under `docs/build/`. Ask the developer.
- **How to phase the work.** One possible split:
  - workspace scaffold
  - plan format and validator
  - Event log and reducer
  - Engine state machines with a fake Adapter
  - script Runs and worktrees
  - Claude Code Adapter
  - server and SSE
  - CLI
  - forge
  - recovery and the Watchdog

  This is only a starting point. The developer decides.
- **How large a phase is.** Each one should end in a mergeable PR with its own docs update, the way the product works.

## Suggested skills

- **`tdd`**: shape each phase's tasks as behaviors under test, and plan the fakes (agent CLI, `gh`, git repos).
- **`grilling`**: put phasing and sequencing decisions to the developer one at a time, with a recommendation each time.
- **`domain-modeling`**: if a spec gap needs a new ADR or glossary term. ADRs go in `docs/adr/NNNN-short-title.md`, and the glossary is `docs/glossary.md`. This copy is patched to use that path.
- **`grill-with-docs`**: covers grilling and domain-modeling together, if the plan turns into another design round.
- **Not to run:** `handoff`, which only the developer can start. Don't install anything else from mattpocock/skills, and don't run its setup or issue-tracker skills (the original brief's instruction).
