import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  type AgentAdapter,
  type BlockReason,
  type EffectiveConfig,
  type EventPayloads,
  type EventType,
  type Finding,
  holdsSlot,
  type PhaseState,
  type PlanState,
  type RunOutcome,
  type RunOutputItem,
  type RunState,
  type State,
  type TaskState,
  type TaskStatus,
  type Verdict,
  verdictJsonSchema,
  verdictSchema,
} from "@segno/core";
import {
  coderPrompt,
  docsPrompt,
  permissionsFor,
  repairPrompt,
  reviewerPrompt,
} from "./context.js";
import {
  commitLeftovers,
  createTaskWorktree,
  diffAgainstPhase,
  fastForward,
  git,
  type MergeResult,
  mergePhaseInto,
  removeTaskWorktree,
} from "./git.js";
import {
  type AgentResult,
  ended as endLive,
  type LimitEvent,
  type LiveRuns,
  launchAgentRun,
  send as sendLive,
} from "./live.js";
import { runScript, type ScriptResult } from "./script.js";

/** Unpersisted drafts; the emitter resolves Verdict references atomically. */
export type Draft = {
  [T in EventType]: {
    type: T;
    payload: T extends "task.findingsClosed"
      ? Omit<EventPayloads[T], "byVerdictSeq"> & { byVerdictRunId: string }
      : EventPayloads[T];
  };
}[EventType];

interface WorkDeps {
  now(): Date;
  setTimer(at: Date, fire: () => void): () => void;
  repo: string;
  projectDir: string;
  config(): EffectiveConfig;
  adapters: readonly AgentAdapter[];
  readState(): State;
  emit(drafts: readonly Draft[], planId?: string): number[];
  /** Queues an input behind the current one. */
  internal(work: () => Promise<unknown>): void;
  live: LiveRuns;
  onLimit(adapter: AgentAdapter, event: LimitEvent): void;
  onError(error: unknown): void;
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** A Run whose run.started is ready to append, and how to start it after. */
interface Repair {
  errors: unknown[];
  runId: string;
  sessionId?: string;
}

interface PreparedRun {
  started: Draft;
  launch(): void;
}

/** The context every Task step works in. */
interface Scope {
  state: State;
  testFailure?: string;
  conflicts?: string[];
  plan: PlanState;
  phase: PhaseState & { branch: string };
  task: TaskState;
}

/** In v1 there is one run slot [ADR-0030]. */
const slot = "0";

/** The Task loop of the active Phase: scheduling, Runs and merging. */
export function openWork(deps: WorkDeps) {
  const { repo, projectDir, readState, emit, internal, live } = deps;

  const timers = new Set<() => void>();
  const preparationRetries = new Set<string>();

  function transition(
    task: TaskState,
    to: TaskStatus,
    cause: string,
    blockReason?: BlockReason,
  ): Draft {
    return {
      type: "task.transitioned",
      payload: {
        taskId: task.id,
        from: task.state,
        to,
        cause,
        ...(blockReason ? { blockReason } : {}),
      },
    };
  }

  function openBlocking(task: TaskState) {
    return task.findings.filter(
      (finding) => finding.open && finding.severity === "blocking",
    );
  }

  function toFinding(
    finding: Verdict["findings"][number],
    runId: string,
  ): Finding {
    return {
      severity: finding.severity,
      body: finding.body,
      ...(finding.file === undefined ? {} : { file: finding.file }),
      ...(finding.line === undefined ? {} : { line: finding.line }),
      id: randomUUID(),
      source: "reviewer",
      createdInRun: runId,
    };
  }

  /** Setup and merge share the test timeout (runners.md § Timeouts). */
  function deadline(expire: () => void) {
    return deps.setTimer(
      new Date(
        deps.now().getTime() + (deps.config().tests.timeoutMin ?? 15) * 60_000,
      ),
      expire,
    );
  }

  function runDir(runId: string) {
    const dir = join(projectDir, "runs", runId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  function env(runId: string, taskId: string) {
    return {
      SEGNO: "1",
      SEGNO_TASK_ID: taskId,
      SEGNO_RUN_ID: runId,
      SEGNO_SLOT: slot,
    };
  }

  function send(runId: string, item: RunOutputItem) {
    sendLive(live, runId, item);
  }

  function isDocs({ phase, task }: Scope) {
    return task.id === `${phase.id}-docs`;
  }

  function adapterFor(role: "coder" | "reviewer") {
    const id = deps.config().roles[role].adapter;
    return deps.adapters.find((adapter) => adapter.id === id);
  }

  /** The Run context for an agent Run, built from fixed ingredients [ADR-0024]. */
  async function contextFor(
    { state, plan, phase, task }: Scope,
    kind: "coder" | "docs" | "reviewer",
    cwd: string,
  ) {
    const config = deps.config();
    const permissions = permissionsFor(kind, config);
    const definition = plan.definition.phases.find(({ id }) => id === phase.id);
    if (!definition)
      throw new Error(`Plan ${plan.id} has no Phase ${phase.id}.`);
    if (kind === "reviewer") {
      const base = await git(cwd, "merge-base", phase.branch, "HEAD");
      return {
        prompt: reviewerPrompt({
          task: task.definition,
          base,
          schema: verdictJsonSchema,
          risk: task.risk,
          findings: openBlocking(task),
          permissions,
        }),
        outputSchema: verdictJsonSchema,
      };
    }
    if (kind === "coder")
      return {
        prompt: coderPrompt({
          plan: plan.definition,
          phase: definition,
          task: task.definition,
          testsCommand: config.tests.command,
          findings: openBlocking(task),
          permissions,
        }),
      };
    if (!phase.baseSha) throw new Error(`Phase ${phase.id} has no base.`);
    const done = state.tasks
      .filter(
        (other) =>
          other.planId === plan.id &&
          other.phaseId === phase.id &&
          other.id !== task.id &&
          other.state === "done",
      )
      .sort((a, b) => a.order - b.order);
    return {
      prompt: docsPrompt({
        plan: plan.definition,
        phase: definition,
        done: done.map(({ definition, verdicts }) => ({
          title: definition.title,
          summary: verdicts.at(-1)?.verdict.summary,
        })),
        advisory: done.flatMap(({ verdicts }) =>
          verdicts.flatMap(({ verdict }) =>
            verdict.findings.filter(({ severity }) => severity === "advisory"),
          ),
        ),
        base: phase.baseSha,
        baseBranch: config.baseBranch,
        changelog: config.docs.changelog,
        findings: openBlocking(task),
        permissions,
      }),
    };
  }

  async function prepareAgentRun(
    scope: Scope,
    kind: "coder" | "docs" | "reviewer",
    repair?: Repair,
  ): Promise<PreparedRun> {
    const config = deps.config();
    const role = kind === "reviewer" ? "reviewer" : "coder";
    const adapter = adapterFor(role);
    if (!adapter) throw new Error(`No ${role} Adapter is available.`);
    const coder = config.roles.coder;
    const model =
      kind === "docs"
        ? (coder.docsModel ?? coder.model)
        : config.roles[role].model;
    const worktree = scope.task.worktree;
    if (!worktree) throw new Error(`Task ${scope.task.id} has no worktree.`);
    const context = await contextFor(scope, kind, worktree.path);
    if (kind !== "reviewer") {
      const tests = scope.state.runs.findLast(
        (run) => scope.task.runIds.includes(run.id) && run.kind === "tests",
      );
      const failed =
        scope.testFailure ??
        (tests?.outcome === "failed" || tests?.outcome === "timeout"
          ? tests.id
          : undefined);
      if (failed) {
        const path = join(projectDir, "runs", failed, "output.log");
        const log = await readFile(path, "utf8").catch(
          () => "Log unavailable.",
        );
        const tail = log.replace(/\n$/, "").split("\n").slice(-200).join("\n");
        context.prompt += `\n## Failing test log\n\nFull log: ${path}\n\n${tail}\n`;
      }
    }
    const conflicts =
      scope.conflicts ??
      (kind !== "reviewer" &&
      scope.task.history.at(-1)?.cause === "merge-conflict"
        ? (await git(worktree.path, "diff", "--name-only", "--diff-filter=U"))
            .split("\n")
            .filter(Boolean)
        : []);
    if (conflicts.length)
      context.prompt += `\n## Conflicting files\n\n${conflicts.join("\n")}\n`;
    const resume = repair && adapter.capabilities.resume && repair.sessionId;
    const prompt = repair
      ? `${resume ? "" : context.prompt}${repairPrompt(repair.errors, permissionsFor(kind, config))}`
      : context.prompt;
    const outputSchema = context.outputSchema;
    const runId = randomUUID();
    const dir = runDir(runId);
    return {
      started: {
        type: "run.started",
        payload: {
          runId,
          taskId: scope.task.id,
          kind,
          role,
          adapter: adapter.id,
          ...(resume ? { resumeOf: repair.runId } : {}),
          model,
        },
      },
      launch() {
        launchAgentRun({
          adapter,
          deadlines: {
            now: deps.now,
            setTimer: deps.setTimer,
            wallMs:
              (config.roles[role].timeoutMin ?? (role === "coder" ? 45 : 15)) *
              60_000,
            idleMs: (config.idleTimeoutMin ?? 10) * 60_000,
          },
          spec: {
            runId,
            kind,
            model,
            cwd: worktree.path,
            prompt,
            ...(resume ? { resumeSessionId: resume } : {}),
            // The whole context is in prompt.md, so the record is exact [ADR-0033].
            systemPrompt: "",
            permissions: permissionsFor(kind, config),
            ...(outputSchema ? { outputSchema } : {}),
            env: env(runId, scope.task.id),
            transcriptPath: join(dir, "transcript.jsonl"),
          },
          live,
          onSession: (sessionId) =>
            internal(async () => recordSession(runId, sessionId)),
          onLimit: (event) => deps.onLimit(adapter, event),
          onResult: (result) =>
            internal(() => settle(runId, () => finishAgentRun(runId, result))),
        });
      },
    };
  }

  function prepareScriptRun(
    scope: Scope,
    kind: "tests" | "setup",
    command: string,
  ): PreparedRun {
    const runId = randomUUID();
    const dir = runDir(runId);
    const worktree = scope.task.worktree;
    if (!worktree) throw new Error(`Task ${scope.task.id} has no worktree.`);
    return {
      started: {
        type: "run.started",
        payload: {
          runId,
          taskId: scope.task.id,
          kind,
          role: kind === "tests" ? "tests" : "none",
        },
      },
      launch() {
        const script = runScript({
          command,
          cwd: worktree.path,
          env: env(runId, scope.task.id),
          logPath: join(dir, "output.log"),
          onOutput: (text) => send(runId, { kind: "output", text }),
        });
        let timeout = false;
        const cancel = deadline(() => {
          timeout = true;
          void script.stop();
        });
        live.set(runId, {
          stop: async () => {
            cancel();
            await script.stop();
          },
          listeners: new Set(),
          output: [],
        });
        void script.result.then(async (result) => {
          if (timeout) await script.stop();
          cancel();
          internal(() =>
            settle(runId, () => finishScriptRun(runId, { ...result, timeout })),
          );
        });
      },
    };
  }

  function prepareMergeRun(scope: Scope): PreparedRun {
    const runId = randomUUID();
    const dir = runDir(runId);
    const worktree = scope.task.worktree;
    if (!worktree) throw new Error(`Task ${scope.task.id} has no worktree.`);
    return {
      started: {
        type: "run.started",
        payload: { runId, taskId: scope.task.id, kind: "merge", role: "none" },
      },
      launch() {
        const controller = new AbortController();
        let timeout = false;
        const cancel = deadline(() => {
          timeout = true;
          controller.abort();
        });
        let settled: Promise<unknown>;
        live.set(runId, {
          stop: async () => {
            cancel();
            controller.abort();
            await settled;
          },
          listeners: new Set(),
          output: [],
        });
        const lines: string[] = [];
        const say = (text: string) => {
          lines.push(text);
          send(runId, { kind: "output", text });
        };
        say(`Merging ${scope.phase.branch} into ${worktree.branch}\n`);
        settled = mergePhaseInto(
          worktree.path,
          {
            phase: scope.phase.branch,
            taskId: scope.task.id,
            message: `segno: merge ${scope.phase.branch}`,
          },
          controller.signal,
        )
          .then(
            (result): MergeResult | { kind: "error"; detail: string } => {
              if (result.kind === "up-to-date") say("Already up to date.\n");
              else if (result.kind === "merged")
                say(`Merged as ${result.sha}.\n`);
              else say(`Conflicts in ${result.files.join(", ")}.\n`);
              return result;
            },
            (error) => {
              const detail = describe(error);
              say(`${detail}\n`);
              return { kind: "error" as const, detail };
            },
          )
          .then(async (result) => {
            cancel();
            // The outcome counts even if its log can't be written.
            await writeFile(join(dir, "output.log"), lines.join("")).catch(
              () => {},
            );
            internal(() =>
              settle(runId, () => finishMergeRun(runId, result, timeout)),
            );
          });
      },
    };
  }

  /** Appends one step's Events, then starts the Runs they record. */
  function commit(planId: string, drafts: Draft[], runs: PreparedRun[] = []) {
    emit([...drafts, ...runs.map(({ started }) => started)], planId);
    for (const run of runs)
      try {
        run.launch();
      } catch (error) {
        // A Run that cannot start still consumes infra budget.
        const { runId } = run.started.payload as { runId: string };
        const scope = scopeOf(runId);
        if (scope)
          infraFailure(scope, [
            finished(runId, "crashed", { detail: describe(error) }),
          ]);
        ended(runId, "crashed");
      }
  }

  /**
   * Processes a Run's outcome. If that fails (a git error, say), the Run is
   * recorded `failed` and consumes infra budget.
   */
  async function settle(runId: string, finish: () => Promise<void>) {
    try {
      await finish();
    } catch (error) {
      const scope = scopeOf(runId);
      if (scope)
        infraFailure(scope, [
          finished(runId, "failed", { detail: describe(error) }),
        ]);
      ended(runId, scope ? "failed" : "stopped");
      deps.onError(error);
    }
  }

  function finished(
    runId: string,
    outcome: RunOutcome,
    extra: { exitCode?: number; detail?: string } = {},
  ): Draft {
    return { type: "run.finished", payload: { runId, outcome, ...extra } };
  }

  /** The Run, its Task and Phase, unless the Run was already settled. */
  function scopeOf(runId: string): (Scope & { run: RunState }) | undefined {
    const state = readState();
    const run = state.runs.find(({ id }) => id === runId);
    if (!run || run.outcome) return undefined;
    const task = state.tasks.findLast(({ id }) => id === run.taskId);
    const plan = state.plans.find(({ id }) => id === task?.planId);
    const phase = plan?.phases.find(({ id }) => id === task?.phaseId);
    if (!task || !plan || !phase?.branch) return undefined;
    return {
      state,
      run,
      task,
      plan,
      phase: { ...phase, branch: phase.branch },
    };
  }

  /** Ends the live stream once the Run's outcome is recorded. */
  function ended(runId: string, outcome: RunOutcome) {
    endLive(live, runId, outcome);
  }

  async function recordSession(runId: string, sessionId: string) {
    const scope = scopeOf(runId);
    if (!scope) return;
    commit(scope.plan.id, [
      { type: "run.sessionStarted", payload: { runId, sessionId } },
    ]);
  }

  function infraFailure(
    scope: Scope & { run?: RunState },
    drafts: Draft[],
    reason: BlockReason = "infra-limit",
    repair?: Repair,
  ) {
    const { task, plan, run } = scope;
    const count = task.budgets.infra + 1;
    drafts.push({
      type: "task.budgetUsed",
      payload: { taskId: task.id, budget: "infra", count },
    });
    if (count >= 3)
      drafts.push(transition(task, "blocked", "infra-exhausted", reason));
    commit(plan.id, drafts);
    if (count >= 3) return;
    const key = `${plan.id}/${task.id}`;
    if (!run) preparationRetries.add(key);
    const cancel = deps.setTimer(
      new Date(deps.now().getTime() + (count === 1 ? 30_000 : 120_000)),
      () => {
        timers.delete(cancel);
        preparationRetries.delete(key);
        internal(async () => {
          const state = readState();
          const current = state.tasks.find(
            (other) => other.planId === plan.id && other.id === task.id,
          );
          if (!current || current.state !== task.state || current.paused)
            return;
          if (!run) return; // drive() retries preparation once its timer is due.
          const next = { ...scope, state, task: current };
          try {
            const prepared =
              run.kind === "tests" || run.kind === "setup"
                ? prepareScriptRun(
                    next,
                    run.kind,
                    run.kind === "tests"
                      ? deps.config().tests.command
                      : (deps.config().setup?.command ?? "true"),
                  )
                : run.kind === "merge"
                  ? prepareMergeRun(next)
                  : await prepareAgentRun(
                      next,
                      run.kind === "reviewer"
                        ? "reviewer"
                        : isDocs(next)
                          ? "docs"
                          : "coder",
                      repair,
                    );
            commit(plan.id, [], [prepared]);
          } catch (error) {
            infraFailure(next, [], "infra-limit", repair);
            deps.onError(error);
          }
        });
      },
    );
    timers.add(cancel);
  }

  async function finishAgentRun(runId: string, result: AgentResult) {
    const scope = scopeOf(runId);
    if (!scope) return ended(runId, "stopped");
    const { plan, task, run } = scope;
    if (result.kind !== "completed") {
      const outcome = result.kind;
      const drafts = [finished(runId, outcome, { detail: result.detail })];
      if (outcome === "rate-limited") commit(plan.id, drafts);
      else infraFailure(scope, drafts);
      return ended(runId, outcome);
    }
    if (run.kind === "reviewer") {
      if (result.structured !== undefined)
        await writeFile(
          join(runDir(runId), "verdict.json"),
          `${JSON.stringify(result.structured, null, 2)}\n`,
        );
      // Schema and semantic consistency are both required [ADR-0016].
      const parsed = verdictSchema.safeParse(result.structured);
      const verdict: Verdict | undefined = parsed.success
        ? parsed.data
        : undefined;
      const errors: unknown[] = parsed.success ? [] : [...parsed.error.issues];
      if (verdict) {
        if (
          verdict.acceptance.length !== task.definition.acceptance.length ||
          task.definition.acceptance.some(
            (_, index) =>
              verdict.acceptance.filter((entry) => entry.index === index)
                .length !== 1,
          )
        )
          errors.push(
            "acceptance must contain exactly one entry for each criterion index",
          );
        const unmet = verdict.acceptance.some(({ met }) => !met);
        const blocking = verdict.findings.some(
          ({ severity }) => severity === "blocking",
        );
        if (
          verdict.decision === "approve" &&
          (unmet ||
            blocking ||
            (verdict.docs.needed && !verdict.docs.satisfied))
        )
          errors.push(
            "approve requires all criteria met, docs satisfied and no blocking Findings",
          );
        if (verdict.decision === "reject" && !unmet && !blocking)
          errors.push(
            "reject requires an unmet criterion or a blocking Finding",
          );
      }
      if (!verdict || errors.length) {
        infraFailure(
          scope,
          [
            finished(runId, "completed"),
            {
              type: "verdict.malformed",
              payload: {
                runId,
                taskId: task.id,
                errors,
                raw: JSON.stringify(result.structured) ?? result.finalText,
              },
            },
          ],
          "verdict-invalid",
          {
            errors,
            runId,
            ...(run.sessionId ? { sessionId: run.sessionId } : {}),
          },
        );
        return ended(runId, "completed");
      }
      const drafts: Draft[] = [
        finished(runId, "completed"),
        {
          type: "verdict.recorded",
          payload: { runId, taskId: task.id, verdict },
        },
      ];
      for (const risk of verdict.risk ?? [])
        drafts.push({
          type: "task.riskRaised",
          payload: {
            taskId: task.id,
            flags: [risk.flag],
            reason: risk.reason,
            byRunId: runId,
          },
        });
      const open = task.findings.filter(({ open }) => open);
      if (open.length)
        drafts.push({
          type: "task.findingsClosed",
          payload: {
            taskId: task.id,
            findingIds: open.map(({ id }) => id),
            byVerdictRunId: runId,
          },
        });
      const findings = verdict.findings.map((finding) =>
        toFinding(finding, runId),
      );
      for (const finding of findings)
        drafts.push({
          type: "task.findingAdded",
          payload: { taskId: task.id, finding },
        });
      if (verdict.decision === "reject") {
        const count = task.budgets.review + 1;
        drafts.push(
          {
            type: "task.budgetUsed",
            payload: { taskId: task.id, budget: "review", count },
          },
          count >= 2
            ? transition(task, "blocked", "review-rejected", "review-limit")
            : transition(task, "coding", "review-rejected"),
        );
        const next = {
          ...scope,
          task: {
            ...task,
            findings: findings.map((finding) => ({ ...finding, open: true })),
          },
        };
        commit(
          plan.id,
          drafts,
          count >= 2
            ? []
            : [await prepareAgentRun(next, isDocs(scope) ? "docs" : "coder")],
        );
      } else {
        drafts.push(
          transition(
            task,
            task.highRisk || verdict.risk?.length ? "held" : "merging",
            "review-approved",
          ),
        );
        commit(plan.id, drafts);
      }
      return ended(runId, "completed");
    }
    // Coder and Docs Runs: anything uncommitted is committed first [ADR-0029].
    const worktree = task.worktree;
    if (!worktree) throw new Error(`Task ${task.id} has no worktree.`);
    const sha = await commitLeftovers(worktree.path, {
      message: `segno: uncommitted changes (${runId})`,
      taskId: task.id,
    });
    commit(
      plan.id,
      [
        finished(runId, "completed"),
        ...(sha
          ? [
              {
                type: "task.committed",
                payload: { taskId: task.id, sha, by: "engine" },
              } satisfies Draft,
            ]
          : []),
        transition(task, "testing", "coder-completed"),
      ],
      [prepareScriptRun(scope, "tests", deps.config().tests.command)],
    );
    ended(runId, "completed");
  }

  async function finishScriptRun(runId: string, result: ScriptResult) {
    const scope = scopeOf(runId);
    if (!scope) return ended(runId, "stopped");
    const { plan, task, run } = scope;
    const exit =
      result.exitCode === undefined ? {} : { exitCode: result.exitCode };
    const outcome = result.timeout ? "timeout" : "failed";
    if (result.timeout || result.exitCode !== 0) {
      if (run.kind === "tests") {
        const count = task.budgets.test + 1;
        commit(
          plan.id,
          [
            finished(runId, outcome, exit),
            {
              type: "task.budgetUsed",
              payload: { taskId: task.id, budget: "test", count },
            },
            count >= 2
              ? transition(task, "blocked", "tests-failed", "test-limit")
              : transition(task, "coding", "tests-failed"),
          ],
          count >= 2
            ? []
            : [
                await prepareAgentRun(
                  { ...scope, testFailure: runId },
                  isDocs(scope) ? "docs" : "coder",
                ),
              ],
        );
        return ended(runId, outcome);
      }
      // Failed setup Runs consume infra budget [ADR-0029].
      const detail = result.error ?? result.signal;
      infraFailure(
        scope,
        [finished(runId, outcome, { ...exit, ...(detail ? { detail } : {}) })],
        "setup-failed",
      );
      return ended(runId, outcome);
    }
    const done = finished(runId, "completed", exit);
    if (run.kind === "setup") {
      // Setup comes before the first Coder Run, or before a merge re-test.
      commit(
        plan.id,
        [done],
        [
          task.state === "merging"
            ? prepareScriptRun(scope, "tests", deps.config().tests.command)
            : await prepareAgentRun(scope, isDocs(scope) ? "docs" : "coder"),
        ],
      );
    } else if (task.state === "merging") await land(scope, [done]);
    else
      commit(
        plan.id,
        [done, transition(task, "reviewing", "tests-passed")],
        [await prepareAgentRun(scope, "reviewer")],
      );
    ended(runId, "completed");
  }

  async function finishMergeRun(
    runId: string,
    result: MergeResult | { kind: "error"; detail: string },
    timeout = false,
  ) {
    const scope = scopeOf(runId);
    if (!scope) return ended(runId, "stopped");
    if (timeout) {
      infraFailure(scope, [
        finished(runId, "timeout", { detail: "Merge wall-clock timeout" }),
      ]);
      return ended(runId, "timeout");
    }
    if (result.kind === "conflict") {
      commit(
        scope.plan.id,
        [
          finished(runId, "failed", {
            detail: `Conflicts in ${result.files.join(", ")}.`,
          }),
          {
            type: "merge.conflicted",
            payload: { taskId: scope.task.id, files: result.files },
          },
          transition(scope.task, "coding", "merge-conflict"),
        ],
        [
          await prepareAgentRun(
            { ...scope, conflicts: result.files },
            isDocs(scope) ? "docs" : "coder",
          ),
        ],
      );
      return ended(runId, "failed");
    }
    if (result.kind === "error") {
      infraFailure(scope, [
        finished(runId, "failed", { detail: result.detail }),
      ]);
      return ended(runId, "failed");
    }
    const done = finished(runId, "completed");
    const { setup, tests } = deps.config();
    // The re-test is skipped when the Phase branch hasn't moved [ADR-0005].
    if (result.kind === "up-to-date") await land(scope, [done]);
    else
      commit(
        scope.plan.id,
        [done],
        [
          result.lockfileChanged && setup
            ? prepareScriptRun(scope, "setup", setup.command)
            : prepareScriptRun(scope, "tests", tests.command),
        ],
      );
    ended(runId, "completed");
  }

  /** Fast-forwards the Phase branch to the Task and cleans up [ADR-0005]. */
  async function land({ plan, phase, task }: Scope, prefix: Draft[]) {
    const worktree = task.worktree;
    if (!worktree) throw new Error(`Task ${task.id} has no worktree.`);
    const diff = await diffAgainstPhase(repo, {
      phase: phase.branch,
      head: worktree.branch,
    });
    // Task ids are unique only within a Plan [ADR-0052].
    const tasksDir = join(projectDir, "tasks", plan.slug, task.id);
    await mkdir(tasksDir, { recursive: true });
    await writeFile(join(tasksDir, "merged.diff"), diff);
    await fastForward(repo, { branch: phase.branch, to: worktree.branch });
    await removeTaskWorktree(repo, worktree);
    commit(plan.id, [
      ...prefix,
      transition(task, "done", "merged"),
      {
        type: "task.worktreeRemoved",
        payload: { taskId: task.id, ...worktree },
      },
    ]);
  }

  function worktreePath(taskId: string) {
    const root = deps.config().worktreeRoot;
    return root
      ? join(root, basename(projectDir), taskId)
      : join(projectDir, "worktrees", taskId);
  }

  /** Takes the next step in an active Phase; returns whether it took one. */
  async function step(
    plan: PlanState,
    phase: PhaseState & { branch: string },
  ): Promise<boolean> {
    const state = readState();
    const tasks = state.tasks
      .filter(
        ({ phaseId, planId }) => planId === plan.id && phaseId === phase.id,
      )
      .sort((a, b) => a.order - b.order);
    const unblocked = tasks.filter(
      (task) =>
        task.state === "waiting" &&
        (task.definition.dependsOn ?? []).every(
          (dependency) =>
            tasks.find(({ id }) => id === dependency)?.state === "done",
        ),
    );
    if (unblocked.length) {
      commit(
        plan.id,
        unblocked.map((task) => transition(task, "ready", "dependencies-done")),
      );
      return true;
    }
    const sentBacks = tasks.filter(
      (task) =>
        task.state === "coding" &&
        task.history.at(-1)?.cause === "developer-sent-back" &&
        !state.runs.some(
          (run) =>
            run.taskId === task.id && run.seq > (task.history.at(-1)?.seq ?? 0),
        ),
    );
    const sentBack = sentBacks[0];
    const activeStep = tasks.some(
      (task) =>
        ["coding", "testing", "reviewing"].includes(task.state) &&
        !sentBacks.includes(task),
    );
    const merging = tasks.some(
      (task) =>
        task.state === "merging" &&
        state.runs.some(
          (run) =>
            task.runIds.includes(run.id) && run.seq > (task.mergingSince ?? 0),
        ),
    );
    if (sentBack && !live.size && !activeStep && !merging) {
      const scope = { state, plan, phase, task: sentBack };
      if (preparationRetries.has(`${plan.id}/${sentBack.id}`)) return false;
      try {
        commit(
          plan.id,
          [],
          [await prepareAgentRun(scope, isDocs(scope) ? "docs" : "coder")],
        );
      } catch (error) {
        infraFailure(scope, []);
        deps.onError(error);
      }
      return true;
    }
    // Only one Task is in the merge step at a time, in arrival order [ADR-0005].
    const [head] = tasks
      .filter(({ state }) => state === "merging")
      .sort((a, b) => (a.mergingSince ?? 0) - (b.mergingSince ?? 0));
    if (
      head &&
      !activeStep &&
      !live.size &&
      !state.runs.some(
        ({ taskId, seq }) =>
          taskId === head.id && seq > (head.mergingSince ?? 0),
      )
    ) {
      commit(
        plan.id,
        [],
        [prepareMergeRun({ state, plan, phase, task: head })],
      );
      return true;
    }
    if (tasks.some(({ state }) => holdsSlot(state))) return false;
    const next = tasks.find(
      ({ state, paused }) => state === "ready" && !paused,
    );
    if (!next || !adapterFor("coder")) return false;
    if (preparationRetries.has(`${plan.id}/${next.id}`)) return false;
    const scope = { state, plan, phase, task: next };
    try {
      await startTask(scope);
    } catch (error) {
      infraFailure(scope, []);
      deps.onError(error);
    }
    return true;
  }

  /** ready → coding: worktree first, then setup if configured [ADR-0029]. */
  async function startTask(scope: Scope) {
    const { plan, phase, task } = scope;
    const path = worktreePath(task.id);
    const branch = `segno/${plan.slug}/${phase.id}--${task.id}`;
    await mkdir(dirname(path), { recursive: true });
    await createTaskWorktree(repo, { path, branch, from: phase.branch });
    const started: Scope = {
      ...scope,
      task: { ...task, worktree: { path, branch } },
    };
    try {
      const setup = deps.config().setup;
      commit(
        plan.id,
        [
          {
            type: "task.worktreeCreated",
            payload: { taskId: task.id, path, branch },
          },
          transition(task, "coding", "slot-free"),
        ],
        [
          setup
            ? prepareScriptRun(started, "setup", setup.command)
            : await prepareAgentRun(
                started,
                isDocs(started) ? "docs" : "coder",
              ),
        ],
      );
    } catch (error) {
      // No Run has started. Roll back the worktree this start created so a
      // retry can create it again and abandon cannot miss an unrecorded one.
      await removeTaskWorktree(repo, { path, branch });
      throw error;
    }
  }

  /**
   * The Events that end a Plan's unfinished Tasks, and the cleanup to run once
   * they're appended: live Runs stopped, worktrees and Task branches deleted.
   */
  function abandon(planId: string) {
    const state = readState();
    const tasks = state.tasks
      .filter(
        (task) =>
          task.planId === planId &&
          task.state !== "done" &&
          task.state !== "superseded",
      )
      .sort((a, b) => a.order - b.order);
    const liveRuns = state.runs.filter(
      ({ taskId, outcome }) =>
        !outcome && tasks.some(({ id }) => id === taskId),
    );
    const drafts = tasks.flatMap((task): Draft[] => [
      ...liveRuns
        .filter(({ taskId }) => taskId === task.id)
        .map(({ id }) => finished(id, "stopped")),
      transition(task, "superseded", "plan-abandoned"),
      ...(task.worktree
        ? [
            {
              type: "task.worktreeRemoved",
              payload: { taskId: task.id, ...task.worktree },
            } satisfies Draft,
          ]
        : []),
    ]);
    return {
      drafts,
      /** Best effort: the abandon is recorded, and B8 removes stale leftovers. */
      async cleanup() {
        const results = await Promise.allSettled(
          liveRuns.map(({ id }) => live.get(id)?.stop()),
        );
        for (const { worktree } of tasks)
          if (worktree)
            results.push(
              ...(await Promise.allSettled([
                removeTaskWorktree(repo, worktree),
              ])),
            );
        for (const result of results)
          if (result.status === "rejected") deps.onError(result.reason);
      },
    };
  }

  return {
    step,
    abandon,
    close() {
      for (const cancel of timers) cancel();
      timers.clear();
    },
  };
}
