# Segno

Segno is a local app that drives a small team of AI agents through a software development cycle while the developer supervises. This glossary fixes the words used across the spec, code and UI.

## Planning

**Plan**:
The developer-approved scope for one feature, expressed as an ordered list of Phases. A repo has at most one active Plan.
_Avoid_: project, roadmap, epic

**Plan file**:
A YAML document in Segno's published format that describes a Plan for submission. It is input only: once submitted, the Plan lives in the event log and the file has no further effect.
_Avoid_: calling the file "the plan"; plan spec, manifest

**Planning session**:
A turn-based conversation between the developer and the Planner that ends in a drafted Plan. Each developer message starts one Planner Run. At most one exists per repo, and only while no Plan is active.
_Avoid_: planning chat (in names), brainstorm, draft

**Phase**:
One ordered slice of a Plan: a task graph that ends in a docs task and is delivered as a single pull request to the base branch. Phases run strictly one after another.
_Avoid_: milestone, sprint, stage

**Phase branch**:
The git branch a Phase's finished tasks merge into, cut from the base branch when the Phase starts.
_Avoid_: feature branch, integration branch

**Base branch**:
The branch Phase branches are cut from and Phase pull requests target, usually `main`.
_Avoid_: trunk, target branch

**Phase PR**:
The single pull request from a Phase branch to the Base branch, opened by Segno when the Phase's last Task is done and merged only by the developer.
_Avoid_: release PR, merge request (except for non-GitHub forges)

**Forge**:
The code-hosting service where Phase PRs are opened and merges are detected, reached through Segno's forge adapter. v1 supports GitHub.
_Avoid_: remote (that's the git remote), host, provider

**Awaiting you**:
The queue of everything that needs the developer: Plans to approve, Merge holds, Blocked Tasks and Phase PRs ready to merge. Nothing else asks for attention.
_Avoid_: inbox, notifications, todo

## Work

**Task**:
One unit of work in a Phase, with a description, dependencies and risk flags, driven by Segno from ready to done. Every engine, event, API and CLI name uses "task".
_Avoid_: card (outside the GUI), ticket, job, story

**Acceptance criteria**:
The explicit, checkable statements a Task must satisfy, written in the Plan file and judged by the Reviewer.
_Avoid_: definition of done (that also includes docs), requirements

**Risk flag**:
A label from a fixed set (migration, auth, payments, data-deletion, security, other), with a required reason, that marks a Task as high-risk.
_Avoid_: risk level, severity

**High-risk task**:
A Task carrying at least one Risk flag. It is never merged without the developer's explicit approval.
_Avoid_: sensitive task, critical task

**Merge hold**:
The wait between a High-risk task passing review and tests and the developer approving its merge. It is shown in Awaiting you.
_Avoid_: gate, freeze

**Card**:
The board's visual representation of exactly one Task. Used only in GUI copy.
_Avoid_: using "card" for the Task itself in the plan file, engine, events, API or CLI

**Docs task**:
The Task Segno adds automatically to close every Phase. It depends on all the Phase's other Tasks, updates the README and guides, and writes changelog entries.
_Avoid_: docs card, release task

## Task lifecycle

**Blocked**:
The state of a Task Segno will not advance without the developer, entered when a retry budget is exhausted or a failure can't be recovered automatically. It always carries a Block reason.
_Avoid_: failed, stuck, errored

**Block reason**:
The recorded cause of a Task entering Blocked: review-limit, test-limit, infra-limit, verdict-invalid or setup-failed.
_Avoid_: error, failure message

**Take over**:
The developer claiming a Task's worktree to work on it by hand, which suspends the agents for that Task.
_Avoid_: manual mode, eject

**Hand back**:
The developer returning a taken-over Task to Segno. The Task re-enters at testing, so the developer's changes pass tests and review like any other.
_Avoid_: release, return

**Retry**:
The developer granting a Blocked Task a fresh copy of the budget it exhausted, keeping its worktree.
_Avoid_: rerun, restart

**Replan**:
Replacing a Task's definition with a new revision, under the same id and dependencies, and restarting it from a fresh worktree with full budgets.
_Avoid_: edit, rewrite

**Split**:
Superseding one Task with two or more new Tasks. Anything that depended on the original now depends on all of them.
_Avoid_: break down, decompose

**Force-approve**:
The developer skipping review for a Task, with a required, recorded reason. The merge queue still re-tests it.
_Avoid_: override, skip review

**Pause**:
A flag that stops a Task's live process and holds it in its current state. The interrupted step reruns from the start on resume, without using any budget. Pause all and a rate-limit pause set it on every Task.
_Avoid_: suspend, freeze

**Rate-limit pause**:
A Pause that Segno applies to every agent Run of one Adapter when that Adapter reports a usage limit. It lifts automatically at the reset time and never uses any budget.
_Avoid_: throttle, cooldown, backoff

**Superseded**:
The terminal state of a Task replaced by a split or replan.
_Avoid_: cancelled, deleted, archived

## Review

**Verdict**:
The Reviewer's structured judgement on a Task's diff: approve or reject, with acceptance results, a docs check, Findings and any newly raised Risk flags. Verdicts are kept forever.
_Avoid_: review result, score, feedback

**Finding**:
One specific issue in a Verdict, or a developer's note on a diff line, that is either blocking (it must be fixed before approval) or advisory (it never blocks).
_Avoid_: comment, issue, nit

## Retry budgets

**Review budget**:
The number of rejected Verdicts a Task may receive before it is Blocked: 2.
_Avoid_: review retries, attempts

**Test budget**:
The number of failed test runs a Task may have before it is Blocked: 2.
_Avoid_: test retries

**Infra budget**:
A separate, small allowance for failures of the tooling rather than the work, such as timeouts, crashes, dropped connections and malformed Verdicts: 3 per Task over its whole life. Using it never touches the Review or Test budget.
_Avoid_: infra retries, error budget

## Execution

**Run**:
One execution of one step for a Task: an agent CLI session (coding, reviewing, planning) or one test script execution. Each Run has its own transcript or log.
_Avoid_: job, attempt, session (a Run may resume an agent session, but they are not the same thing)

**Adapter**:
Segno's built-in translator for one agent CLI. It starts Runs, normalizes the CLI's output into Segno's events, and classifies how each Run ended.
_Avoid_: driver, provider, plugin, integration

**Merge queue**:
The single-file line of approved Tasks waiting to land on the Phase branch. Each one has the latest Phase branch merged in and is re-tested before it lands.
_Avoid_: merge train, landing queue

**Watchdog**:
The engine's periodic check that every non-terminal Task has a live Run or a visible reason it is waiting. It corrects and records any violation it finds.
_Avoid_: health check, reaper

**Session meter**:
The board's count of live agent Runs against the concurrency limit, next to the number of agent sessions started in the active Phase.
_Avoid_: usage meter (that's subscription usage), cost meter

## Roles

**Role**:
One of the four kinds of participant that work a Task: Planner, Coder, Reviewer, Tests. Each agent Role has its own configurable model and tool permissions. The developer appears on the board as "you", not as a Role.
_Avoid_: agent type, persona

**Planner**:
The agent Role that agrees scope with the developer, writes Plans, and helps audit Blocked Tasks.
_Avoid_: architect, PM

**Coder**:
The agent Role that changes code in a Task's worktree, in a fresh session per Run. It also works the Docs task, with its own model setting.
_Avoid_: developer (that's the human), implementer, worker

**Reviewer**:
The agent Role that inspects a Task's diff and returns a Verdict.
_Avoid_: critic, judge, QA

**Tests**:
The Role that runs the repo's test command as a script, judged only by its exit code. It is not an agent.
_Avoid_: tester, QA agent

## Engine

**Engine**:
The single component that decides every state change. It is the only writer of the Event log.
_Avoid_: orchestrator (allowed in prose, not in names), scheduler, server

**Command**:
A request from the developer (via GUI or CLI), or a Run's outcome, asking the Engine for a change. The Engine either accepts it and appends Events, or rejects it with a reason and writes nothing.
_Avoid_: action, request, mutation

**Event**:
One immutable, sequence-numbered record in the Event log describing something that happened. All board state is derived from Events.
_Avoid_: message, log entry, activity

**Event log**:
The append-only record of every Event for a repo, kept forever. It is the source of truth for board state, crash recovery and replay.
_Avoid_: history (that is the GUI's view of archived Phases), audit log, journal
