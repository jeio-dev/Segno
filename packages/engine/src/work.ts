import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  type AgentAdapter,
  type EffectiveConfig,
  type EventPayloads,
  type EventType,
  holdsSlot,
  type PhaseState,
  type PlanState,
  type RunOutcome,
  type RunOutputItem,
  type RunResult,
  type RunState,
  type State,
  type TaskState,
  type TaskStatus,
  type Verdict,
} from "@segno/core";
import { permissionsFor, placeholderPrompt } from "./context.js";
import {
  commitLeftovers,
  createTaskWorktree,
  diffAgainstPhase,
  fastForward,
  type MergeResult,
  mergePhaseInto,
  removeTaskWorktree,
} from "./git.js";
import { runScript, type ScriptResult } from "./script.js";

export type Draft = {
  [T in EventType]: { type: T; payload: EventPayloads[T] };
}[EventType];

export interface LiveRun {
  stop(): Promise<void>;
  listeners: Set<(item: RunOutputItem) => void>;
  /** Everything output so far, replayed to a listener that joins late. */
  output: string[];
}

interface WorkDeps {
  repo: string;
  projectDir: string;
  config(): EffectiveConfig;
  adapters: readonly AgentAdapter[];
  readState(): State;
  emit(drafts: readonly Draft[], planId?: string): number[];
  /** Queues an input behind the current one. */
  internal(work: () => Promise<unknown>): void;
  live: Map<string, LiveRun>;
  onError(error: unknown): void;
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** A Run whose run.started is ready to append, and how to start it after. */
interface PreparedRun {
  started: Draft;
  launch(): void;
}

/** The context every Task step works in. */
interface Scope {
  plan: PlanState;
  phase: PhaseState & { branch: string };
  task: TaskState;
}

/** In v1 there is one run slot [ADR-0030]. */
const slot = "0";

/** The Task loop of the active Phase: scheduling, Runs and merging. */
export function openWork(deps: WorkDeps) {
  const { repo, projectDir, readState, emit, internal, live } = deps;

  function transition(task: TaskState, to: TaskStatus, cause: string): Draft {
    return {
      type: "task.transitioned",
      payload: { taskId: task.id, from: task.state, to, cause },
    };
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
    const run = live.get(runId);
    if (item.kind === "output") run?.output.push(item.text);
    for (const listener of run?.listeners ?? [])
      try {
        listener(item);
      } catch {}
  }

  function isDocs({ phase, task }: Scope) {
    return task.id === `${phase.id}-docs`;
  }

  function adapterFor(role: "coder" | "reviewer") {
    const id = deps.config().roles[role].adapter;
    return deps.adapters.find((adapter) => adapter.id === id);
  }

  function prepareAgentRun(
    scope: Scope,
    kind: "coder" | "docs" | "reviewer",
  ): PreparedRun {
    const config = deps.config();
    const role = kind === "reviewer" ? "reviewer" : "coder";
    const adapter = adapterFor(role);
    if (!adapter) throw new Error(`No ${role} Adapter is available.`);
    const coder = config.roles.coder;
    const model =
      kind === "docs"
        ? (coder.docsModel ?? coder.model)
        : config.roles[role].model;
    const runId = randomUUID();
    const dir = runDir(runId);
    const prompt = placeholderPrompt(kind, scope.task.definition);
    const worktree = scope.task.worktree;
    if (!worktree) throw new Error(`Task ${scope.task.id} has no worktree.`);
    return {
      started: {
        type: "run.started",
        payload: {
          runId,
          taskId: scope.task.id,
          kind,
          role,
          adapter: adapter.id,
          model,
        },
      },
      launch() {
        // prompt.md is exactly what the Run was given [ADR-0033].
        writeFileSync(join(dir, "prompt.md"), prompt);
        const handle = adapter.start({
          runId,
          kind,
          model,
          cwd: worktree.path,
          prompt,
          systemPrompt: "",
          permissions: permissionsFor(kind, config),
          env: env(runId, scope.task.id),
          transcriptPath: join(dir, "transcript.jsonl"),
        });
        live.set(runId, {
          stop: () => handle.stop(),
          listeners: new Set(),
          output: [],
        });
        const drained = (async () => {
          for await (const event of handle.events) {
            if (event.type === "started")
              internal(async () => recordSession(runId, event.sessionId));
            else if (event.type === "output")
              send(runId, { kind: "output", text: event.text });
          }
        })().catch(() => {});
        void Promise.all([
          handle.result.catch(
            (error): RunResult => ({
              kind: "crashed",
              detail: error instanceof Error ? error.message : String(error),
            }),
          ),
          drained,
        ]).then(([result]) =>
          internal(() => settle(runId, () => finishAgentRun(runId, result))),
        );
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
        live.set(runId, {
          stop: script.stop,
          listeners: new Set(),
          output: [],
        });
        void script.result.then((result) =>
          internal(() => settle(runId, () => finishScriptRun(runId, result))),
        );
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
        live.set(runId, {
          stop: async () => {},
          listeners: new Set(),
          output: [],
        });
        const lines: string[] = [];
        const say = (text: string) => {
          lines.push(text);
          send(runId, { kind: "output", text });
        };
        say(`Merging ${scope.phase.branch} into ${worktree.branch}\n`);
        void mergePhaseInto(worktree.path, {
          phase: scope.phase.branch,
          taskId: scope.task.id,
          message: `segno: merge ${scope.phase.branch}`,
        })
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
            // The outcome counts even if its log can't be written.
            await writeFile(join(dir, "output.log"), lines.join("")).catch(
              () => {},
            );
            internal(() => settle(runId, () => finishMergeRun(runId, result)));
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
        // A Run that can't start still gets its outcome (B6 handles crashes).
        const { runId } = run.started.payload as { runId: string };
        commit(planId, [
          finished(runId, "crashed", { detail: describe(error) }),
        ]);
        ended(runId, "crashed");
      }
  }

  /**
   * Processes a Run's outcome. If that fails (a git error, say), the Run is
   * recorded `failed` so it never stays live; B6 makes it an infra failure.
   */
  async function settle(runId: string, finish: () => Promise<void>) {
    try {
      await finish();
    } catch (error) {
      const scope = scopeOf(runId);
      if (scope)
        commit(scope.plan.id, [
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
    return { run, task, plan, phase: { ...phase, branch: phase.branch } };
  }

  /** Ends the live stream once the Run's outcome is recorded. */
  function ended(runId: string, outcome: RunOutcome) {
    send(runId, { kind: "end", outcome });
    live.delete(runId);
  }

  async function recordSession(runId: string, sessionId: string) {
    const scope = scopeOf(runId);
    if (!scope) return;
    commit(scope.plan.id, [
      { type: "run.sessionStarted", payload: { runId, sessionId } },
    ]);
  }

  async function finishAgentRun(runId: string, result: RunResult) {
    const scope = scopeOf(runId);
    if (!scope) return ended(runId, "stopped");
    const { plan, task, run } = scope;
    if (result.kind !== "completed") {
      // Failure paths are B6 and rate limits B8; the Task waits here until then.
      const outcome = result.kind;
      commit(plan.id, [finished(runId, outcome, { detail: result.detail })]);
      return ended(runId, outcome);
    }
    if (run.kind === "reviewer") {
      const verdict = result.structured as Verdict | undefined;
      const approved = verdict?.decision === "approve" && !task.highRisk;
      // Rejections, malformed Verdicts and held Tasks are B6.
      commit(plan.id, [
        finished(runId, "completed"),
        ...(verdict?.decision === "approve"
          ? [
              {
                type: "verdict.recorded",
                payload: { runId, taskId: task.id, verdict },
              } satisfies Draft,
            ]
          : []),
        ...(approved ? [transition(task, "merging", "review-approved")] : []),
      ]);
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
    if (result.exitCode !== 0) {
      // Test failures and failed setup Runs are B6.
      const detail = result.error ?? result.signal;
      commit(plan.id, [
        finished(runId, "failed", { ...exit, ...(detail ? { detail } : {}) }),
      ]);
      return ended(runId, "failed");
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
            : prepareAgentRun(scope, isDocs(scope) ? "docs" : "coder"),
        ],
      );
    } else if (task.state === "merging") await land(scope, [done]);
    else
      commit(
        plan.id,
        [done, transition(task, "reviewing", "tests-passed")],
        [prepareAgentRun(scope, "reviewer")],
      );
    ended(runId, "completed");
  }

  async function finishMergeRun(
    runId: string,
    result: MergeResult | { kind: "error"; detail: string },
  ) {
    const scope = scopeOf(runId);
    if (!scope) return ended(runId, "stopped");
    if (result.kind === "conflict" || result.kind === "error") {
      // Conflicts and git failures are B6.
      const detail =
        result.kind === "error"
          ? result.detail
          : `Conflicts in ${result.files.join(", ")}.`;
      commit(scope.plan.id, [finished(runId, "failed", { detail })]);
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
    // Only one Task is in the merge step at a time, in arrival order [ADR-0005].
    const [head] = tasks
      .filter(({ state }) => state === "merging")
      .sort((a, b) => (a.mergingSince ?? 0) - (b.mergingSince ?? 0));
    if (
      head &&
      !state.runs.some(
        ({ taskId, seq }) =>
          taskId === head.id && seq > (head.mergingSince ?? 0),
      )
    ) {
      commit(plan.id, [], [prepareMergeRun({ plan, phase, task: head })]);
      return true;
    }
    if (tasks.some(({ state }) => holdsSlot(state))) return false;
    const next = tasks.find(
      ({ state, paused }) => state === "ready" && !paused,
    );
    if (!next || !adapterFor("coder")) return false;
    await startTask({ plan, phase, task: next });
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
          : prepareAgentRun(started, isDocs(started) ? "docs" : "coder"),
      ],
    );
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

  return { step, abandon };
}
