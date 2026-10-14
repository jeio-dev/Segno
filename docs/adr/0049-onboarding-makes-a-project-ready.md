---
status: accepted, amended by ADR-0055
---

# Onboarding, not a settings form, makes a Project ready

Adding a Project without a `segno.config.json` used to show the detected settings and keep **Add** disabled until a test command was typed. That is the wrong job to give a beginner. Now **Add** asks only for a model per agent Role (Planner, Coder, Reviewer) and lands on the board. The models are kept as the Project's pending config in its app data directory.

**Not onboarded.** A Project with no `segno.config.json` and no Plan ever submitted is _not onboarded_. Its board offers **Onboard project** and **Set up manually**, and `plan.submit` is rejected `not-onboarded`. A config that disappears after a Plan has existed still makes the Project `unavailable` with `missing-file`, because work is in flight. Telling these two apart needs the Event log, so a missing file is classified only after the log has been replayed, and an unreadable log reports `unreadable-log` first.

**The onboarding Run.** **Onboard project** starts one Planner Run in a scratch worktree of the base branch. The Run's job:
- Find the strongest check the repo has: tests, else typecheck, else build, else lint.
- Find the setup command.
- Run both and propose a config backed by what it ran.

The Run's profile:
- It may edit only the scratch worktree, which is thrown away afterwards.
- It may run any shell command except the always-denied ones.
- It has network on, to install dependencies.

It never weakens a failing suite. A suite that fails on the base branch is still proposed, with a flag. A repo with no check at all gets the placeholder `true`, which the developer must explicitly acknowledge.

**Confirming.** The proposal becomes an `onboarding-review` Awaiting-you item, and nothing is written until the developer confirms it. **Confirm** writes `segno.config.json`, uncommitted, as ADR-0039 did. **Edit** opens the old settings form, prefilled with the proposal. That form also stays as **Set up manually**, prefilled by the same detection, for when onboarding fails or isn't wanted.

**Recording and failure.** Onboarding is Engine Commands and Events like every other Run, so it replays and survives restarts. A failure records its reason and offers **Retry onboarding**, and there's no budget. A repo that already has `segno.config.json` is added as it is, with no onboarding.

This amends ADR-0039 (the add flow), ADR-0004 (one more permission profile) and ADR-0047 (a third Project status).

## Considered Options

- **Drop the test command, and let the Coder run the tests and report the result.** This was rejected for three reasons:
  - The Coder would be grading its own work, and agents do report green after skipping or deleting a failing test. The Tests step is judged only by an exit code Segno observes (ADR-0003).
  - The merge queue re-tests every approved Task on the combined code with no Coder involved (ADR-0005).
  - Hand back re-enters at testing, and Force-approve still re-tests.

  Instead, onboarding fills in the command, and the Coder is told to run the tests itself before it finishes, so the independent check rarely sends a Task back.
- **Let onboarding change the repo** (add a test script or AGENTS.md on a branch or PR). That means more machinery for a one-time step. Repo changes are what Plans are for, and the no-checks placeholder lets a first Plan add the tests.
- **The Coder Role onboards.** The Planner fits better: exploring a repo and proposing how to work in it is planning. It also gives the Planner a v1 job, which justifies asking for its model at Add.

## Consequences

- **The broadest permissions in Segno.** The onboarding Run has unrestricted shell with network, more than any other profile. It runs only on the developer's request, in a throwaway worktree, before any Plan exists, and its result is confirmed by hand.
- **`roles.planner` stays optional in v1.** Onboarding always writes it from the pending config.
- **Two build phases.** The not-onboarded state, the models-only Add and Set up manually don't need an agent and ship before the onboarding Run itself, which needs the Claude Code Adapter.
