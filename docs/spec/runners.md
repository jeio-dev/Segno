# Runners

This covers how Segno executes Runs: agent Runs through Adapters, and script Runs for tests, setup, merges and rate-limit probes.

## Run kinds

| `kind` | Role | Executed by | Output kept |
|---|---|---|---|
| `coder` | Coder | Adapter | `prompt.md`, `transcript.jsonl` |
| `docs` | Coder, with `docsModel` | Adapter | `prompt.md`, `transcript.jsonl` |
| `reviewer` | Reviewer | Adapter | `prompt.md`, `transcript.jsonl`, `verdict.json` |
| `onboarding` | Planner | Adapter | `prompt.md`, `transcript.jsonl`, `proposal.json` [ADR-0049] |
| `planner` **(v1.2)** | Planner | Adapter | `prompt.md`, `transcript.jsonl` |
| `tests` | Tests | shell | `output.log` |
| `setup` | none (infrastructure) | shell | `output.log` |
| `merge` | none (infrastructure) | git | `output.log` |
| `probe` | none (rate-limit check) | Adapter | `transcript.jsonl` |

Sources: [glossary] [ADR-0018] [ADR-0021] [ADR-0029] [ADR-0033] [ADR-0010] [ADR-0049].

## Adapter interface

An Adapter is a built-in module, one per agent CLI. There is no plugin loading [ADR-0017] [glossary].

```ts
interface AgentAdapter {
  id: "claude-code" | "codex" | "opencode";          // v1: "claude-code" only
  detect(): Promise<{ installed: boolean; version?: string; binary?: string }>;
  capabilities: {
    resume: boolean;            // can continue an earlier session by id
    structuredOutput: boolean;  // can enforce a JSON Schema on the final answer
    toolAllowlist: boolean;     // can enforce a PermissionProfile without prompting
    usage: boolean;             // reports subscription usage and its reset time
  };
  start(spec: RunSpec): RunHandle;
}

type RunSpec = {
  runId: string;
  kind: "coder" | "docs" | "reviewer" | "onboarding" | "planner" | "probe";
  model: string;                 // passed through verbatim
  cwd: string;                   // the Task's worktree (scratch worktree for onboarding; repo root for planner and probe)
  prompt: string;                // built by the Engine (see Run context)
  systemPrompt: string;          // built by the Engine
  permissions: PermissionProfile;
  outputSchema?: JSONSchema;     // set for reviewer, onboarding and planner
  resumeSessionId?: string;
  env: Record<string, string>;   // includes the SEGNO_* variables
  transcriptPath: string;        // the Adapter tees raw CLI output here
};

interface RunHandle {
  events: AsyncIterable<RunEvent>;
  result: Promise<RunResult>;
  stop(): Promise<void>;         // idempotent; resolves once the process has exited
}

type RunEvent =
  | { type: "started"; sessionId: string }
  | { type: "activity"; summary: string }   // any sign of progress; resets the idle timer
  | { type: "output"; text: string }        // human-readable chunk for the live Run stream
  | { type: "usage"; used: number; limit?: number; resetAt?: string }
  | { type: "rateLimited"; resetAt?: string };

type RunResult =
  | { kind: "completed"; sessionId: string; finalText: string; structured?: unknown }
  | { kind: "failed" | "crashed"; detail: string; exitCode?: number }
  | { kind: "rate-limited"; resetAt?: string; detail: string };
```

Sources: [ADR-0017] [ADR-0021] [ADR-0024].

**Contract rules** [ADR-0017]:

- The Adapter is the **only** code that parses a CLI's output. It classifies every Run as `completed`, `failed`, `crashed` or `rate-limited`. The Engine never matches on CLI text.
- The Adapter never builds context or prompts. It maps the `RunSpec` to CLI flags.
- The Engine owns every timeout and calls `stop()` itself. The Adapter enforces none.
- `structured` is set only when the CLI produced output for an `outputSchema`. The Engine still validates it ([engine.md](engine.md#verdict-handling)).
- **Capability gating happens at config validation.** A Role whose Adapter lacks a capability that Role needs is refused [ADR-0017]:

  | Role | Requires |
  |---|---|
  | Coder | `toolAllowlist` |
  | Reviewer | `toolAllowlist`, `structuredOutput` |
  | Planner | `toolAllowlist`, `structuredOutput` |

  `resume` is optional. Without it, interruption resumes and Verdict repairs start a fresh session [ADR-0016] [ADR-0020].

## Permission profiles

Every agent Run gets an explicit allowlist. **Anything outside it is denied automatically, never prompted for**, so a headless Run can never wait on a person [ADR-0004].

```ts
type PermissionProfile = {
  read: true;                    // read and search files under cwd
  edit: boolean;                 // create and edit files, only under cwd
  shell: string[];               // allowed command patterns
  network: boolean;              // web fetch and search, curl and wget
  mcp: false;                    // no MCP servers in any Role
  extraAllow: string[];          // from config roles.<role>.allow (Adapter-native syntax)
};
```

### Default profiles

| | Planner | Coder (and Docs task) | Reviewer |
|---|---|---|---|
| `read` | yes | yes | yes |
| `edit` | no | yes, worktree only | no |
| `shell` | `git log *`, `git show *`, `git diff *`, and the search commands | `tests.command`, `setup.command`, `git status *`, `git diff *`, `git log *`, `git show *`, `git add *`, `git commit *`, and the search commands | `git log *`, `git show *`, `git diff *`, and the search commands |
| `network` | no | no | no |
| `mcp` | none | none | none |

The search commands are `ls *`, `grep *`, `git ls-files *` and `git grep *`. Claude Code has no Glob or Grep tool, so agents list and search files through these, and none of them can write a file or start another program [ADR-0059].

Sources: [ADR-0004] [ADR-0059].

**Onboarding profile.** The `onboarding` Run gets the broadest profile in Segno, used only on the developer's request and before any Plan exists [ADR-0049]:
- `read: true`
- `edit: true`, scratch worktree only
- `shell: ["*"]`, every command except the always-denied ones below
- `network: true`
- `mcp: false`

`roles.planner.allow` doesn't apply to it.

**Always denied, for every Role, and not liftable by config** [ADR-0004]:

```
git push, git checkout, git switch, git merge, git rebase, git reset, git branch, git worktree
```

They're enforced by the agent CLI's prefix-matching permission rules, which hold for every profile with an explicit shell allowlist. Under the onboarding profile, whose shell is unrestricted, they're best effort: another spelling of the same command, such as `git -C . push`, isn't matched [ADR-0055].

Network access (web fetch and search tools, `curl`, `wget`) is denied unless the Role's `allow` adds it [ADR-0004] [ADR-0025]. Config can only *add* entries. It can never remove an always-denied entry or turn on any bypass mode [ADR-0004].

The developer's personal agent settings never contribute permissions to a Run, and the repo's own `.claude/settings.json` grants are denied unless the profile already allows them [ADR-0004] [ADR-0056].

## Claude Code Adapter (v1)

It maps a `RunSpec` onto `claude -p` (verified against Claude Code 2.1.299) [ADR-0017] [ADR-0004]:

| RunSpec | Flag |
|---|---|
| headless | `-p <prompt>` |
| event stream | `--output-format stream-json --verbose` |
| `model` | `--model <model>` |
| `systemPrompt` | `--append-system-prompt <text>` |
| new session | `--session-id <uuid>` (the `sessionId` reported in `started`) |
| `resumeSessionId` | `--resume <id>` |
| permissions | `--permission-mode dontAsk --permission-prompts none`, plus `--allowedTools` (profile and `extraAllow`) and `--disallowedTools` (the always-denied set, plus network tools unless allowed) |
| settings isolation | `--setting-sources project`, so user and local settings are not loaded and the repo's `CLAUDE.md` is [ADR-0004] [ADR-0024] |
| the repo's permission grants | every `permissions.allow` entry in the repo's `.claude/settings.json` that the Run doesn't already allow, exactly or by its bare tool name, is added to `--disallowedTools` [ADR-0056] |
| `mcp: false` | `--strict-mcp-config` with no `--mcp-config` |
| `outputSchema` | `--json-schema <schema>`, without its top-level `$schema` key, which Claude Code can't resolve [ADR-0057] |
| `kind: probe` | `--tools ""`: no tools at all, whatever the profile allows [ADR-0054] |

Capabilities: `resume`, `structuredOutput` and `toolAllowlist` are all true. `usage` is true only if the installed version's stream reports usage, as detected by `detect()` [ADR-0017] [ADR-0021].

- **Classifying results.** A `result` message without an error is `completed`. A usage-limit or rate-limit signal in the stream is `rate-limited`, with `resetAt` when the CLI provides one. A non-zero exit or an error result is `failed`. Death by signal or a truncated stream is `crashed`, with claude's stderr as its detail when it printed any [ADR-0017] [ADR-0021] [ADR-0057].
- **Test fixtures.** The Adapter must be tested against recorded real outputs for each classification.
- **Repo instructions.** The repo's own `CLAUDE.md` and similar files are read by Claude Code itself as usual. Segno doesn't copy them into prompts [ADR-0024].

## Verdict schema

The Reviewer's structured output. It's passed as `outputSchema` and also requested in the prompt [ADR-0016] [glossary].

```json
{
  "schemaVersion": 1,
  "decision": "approve | reject",
  "summary": "string, ≥1 char: one paragraph for the card and the Phase PR",
  "acceptance": [ { "index": 0, "met": true, "note": "string" } ],
  "docs": { "needed": true, "satisfied": true, "note": "string" },
  "findings": [
    { "severity": "blocking | advisory", "file": "string?", "line": "int≥1?", "body": "string, ≥1 char" }
  ],
  "risk": [ { "flag": "migration | auth | payments | data-deletion | security | other", "reason": "string, ≥1 char" } ]
}
```

- `findings` may be empty, and `risk` is optional. Unknown keys are rejected [ADR-0016].
- Consistency rules and malformed handling are in [engine.md](engine.md#verdict-handling) [ADR-0016].
- The Verdict is written to `verdict.json` exactly as received, and recorded in full in `verdict.recorded` [ADR-0033].

## Onboarding proposal

The `onboarding` Run's structured output [ADR-0049]:

```json
{
  "kind": "proposal",
  "config": { "tests": { "command": "string", "timeoutMin": 15 }, "setup": { "command": "string" }, "baseBranch": "string", "remote": "string", "coderAllow": ["string"] },
  "reasons": { "<JSON pointer into config>": "string" },
  "checks": [ { "command": "string", "purpose": "setup | tests | typecheck | build | lint", "exitCode": 0, "durationSec": 12, "failing": ["string"] } ],
  "flags": ["no-checks", "fails-on-base"]
}
```

or `{ "kind": "unable", "explanation": "string" }`.

- **Optional fields.** `setup`, `remote`, `timeoutMin`, `coderAllow`, `flags` and `failing` are optional. Unknown keys are rejected.
- **The check order.** The test command is the strongest check found, in this order: tests, then typecheck, then build, then lint. It's never a weaker check chosen because the stronger one fails.
- **`no-checks`** means none was found, and `tests.command` is `"true"`.
- **`fails-on-base`** means the chosen check exited non-zero on the base branch. `failing` names what failed.
- **`timeoutMin`** is the suite's measured duration with headroom.
- **`coderAllow`** becomes `roles.coder.allow`. It holds what the Coder needs to run the checks itself, and is validated like any `allow` entry.
- **Who adds what.** The Engine adds the pending config's models and the ref the checks ran on. It validates the result as `segno.config.json`. Any failure records `onboarding.failed { reason: invalid-proposal }` ([engine.md](engine.md#onboarding)).

## Planner output schemas (v1.2)

**Planning turn** [ADR-0010]:

```json
{ "kind": "message", "text": "string", "questions": [ { "id": "string", "text": "string", "recommendation": "string?" } ] }
```

or

```json
{ "kind": "plan", "plan": { "...": "a complete Plan in the plan-format.md schema" } }
```

**Blocked audit (Ask Planner)** [ADR-0010]:

```json
{ "analysis": "string", "recommendation": "retry | replan | split | take-over", "fragment": "YAML string, present for replan or split" }
```

A `plan` or `fragment` is validated exactly as a submitted Plan file or fragment is. Malformed Planner output is repaired using the infra rules [ADR-0010] [ADR-0016].

## Script Runs

Each runs in the Task's worktree, through the user's shell (`sh -c` on POSIX), with the [Run environment](#run-environment) [ADR-0029].

| Kind | Command | Success | Failure means |
|---|---|---|---|
| `tests` | `tests.command` | exit code 0, and **only** the exit code counts | test failure (test budget). A timeout is also a test failure [brief §Decided] [ADR-0019] |
| `setup` | `setup.command` (skipped if unset) | exit code 0 | infra failure. Exhausting the budget blocks with `setup-failed` [ADR-0029] |
| `merge` | merge the Phase branch tip into the Task branch, non-interactively | clean merge commit, or nothing to merge | a conflict → `coding` with the conflicting files. Any other git error is an infra failure [ADR-0005] |

- **Setup runs** after a worktree is created, and after a `merge` Run brings in changes to any lockfile (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `bun.lockb`) [ADR-0029].
- **A test failure's log tail** (the last 200 lines) goes to the next Coder Run, together with the full log's path [ADR-0024].

## Run environment

Every Run, agent or script, gets these environment variables [ADR-0029]:

| Variable | Value |
|---|---|
| `SEGNO` | `1` |
| `SEGNO_TASK_ID` | the Task id (absent for onboarding, planner and probe Runs) |
| `SEGNO_RUN_ID` | the Run id |
| `SEGNO_SLOT` | `0 … concurrency-1`: the run slot the Task holds |

Isolation beyond `SEGNO_SLOT` (ports, databases) is the repo's responsibility [ADR-0029].

## Commits

- The Coder is told to commit its work. After every Coder or Docs Run, the Engine commits anything left uncommitted with the message `segno: uncommitted changes (<run-id>)`. Tests and review therefore always see a clean, committed HEAD [ADR-0029].
- Hand back commits leftovers as `segno: developer changes` [ADR-0015].
- Every Segno-made commit uses the developer's git identity and has the trailer `Segno-Task: <task-id>` [ADR-0029].

## Timeouts

| Run kind | Wall-clock default | Config key | Idle timeout |
|---|---|---|---|
| `coder`, `docs` | 45 min | `roles.coder.timeoutMin` | `idleTimeoutMin` (10) |
| `reviewer` | 15 min | `roles.reviewer.timeoutMin` | `idleTimeoutMin` (10) |
| `planner`, `onboarding` | 20 min | `roles.planner.timeoutMin` | `idleTimeoutMin` (10) |
| `tests` | 15 min | `tests.timeoutMin` | none |
| `setup`, `merge` | the same as `tests.timeoutMin` | none | none |

Sources: [ADR-0019].

- **Idle** means no `RunEvent` of any type for that long. A wall-clock timeout or idle timeout of an agent Run is recorded as `timeout` or `hung`, and counts as an infra failure [ADR-0019].
- A `tests` timeout is a test failure. A `setup` or `merge` timeout is an infra failure [ADR-0019] [ADR-0029].

## Run context

The Engine builds every prompt from fixed ingredients and writes it to `prompt.md` before the Run starts. "Each session gets only the context its task needs" [brief §Principles] [ADR-0024].

| Run | Includes | Never includes |
|---|---|---|
| `coder` (first pass) | Plan title and summary (≤ 1 paragraph); Phase title; the Task's `title`, `description`, `acceptance` and `context` hints; the definition of done (meet every acceptance criterion; update docs for any behavior you change; run `tests.command` before you finish and fix what fails; commit your work); `tests.command`; the shell commands its profile allows, to run one at a time [ADR-0049] [ADR-0058] | other Tasks' definitions, earlier transcripts, advisory Findings |
| `coder` (later passes) | all of the above, plus whichever applies: open blocking Findings (Reviewer and developer); the last 200 lines of the failing test log and its path; the conflicting files | same |
| `reviewer` | the Task's `title`, `description`, `acceptance` and risk; the diff range `<merge-base>..HEAD`; the fact that tests passed; the previous Verdict's blocking Findings on a re-review; the Verdict schema; the instruction to check docs for changed behavior; the shell commands its profile allows, to run one at a time [ADR-0058] | Coder transcripts, other Tasks |
| `docs` | Phase title and Plan summary; each `done` Task's title and final Verdict summary; advisory Findings from the Phase; the Phase diff range against `baseBranch`; the Phase `docs` block; `docs.changelog`; the shell commands its profile allows, to run one at a time [ADR-0058] | transcripts |
| `onboarding` | the detected settings as a starting guess to verify; the check order and the rule never to weaken a failing suite; the instruction to run the setup command and the chosen check and report their exit codes and durations; the proposal schema | anything about Plans or Tasks |
| `planner` **(v1.2)** | Planning session: the brief and the thread so far (through session resume), plus the Plan schema. Ask Planner: the Task definition, its Verdicts, the last 200 lines of its last test log, the Block reason and the fragment schema | Coder transcripts |
| `probe` | a minimal fixed prompt, with no tools [ADR-0054] | anything else |

Sources: [ADR-0024] [ADR-0010] [ADR-0021] [ADR-0049] [ADR-0058] [brief §Principles].

- **Fresh sessions.** Every agent Run starts a new session, except an interruption resume [ADR-0020], a Verdict repair [ADR-0016], and later turns of a Planning session [ADR-0010].
- **Built-in templates.** Prompt templates are built in. Overriding them is **(later)** [ADR-0030].

## Transcripts and live output

- **Raw output.** Adapters tee raw CLI output to `transcript.jsonl`, and script Runs write `output.log` [brief §Principles] [ADR-0033].
- **Live view.** `output` events (and script output lines) feed the per-Run live stream ([api.md](api.md#live-run-output)). They are never Events [ADR-0007].
