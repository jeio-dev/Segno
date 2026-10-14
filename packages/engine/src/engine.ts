import { randomUUID } from "node:crypto";
import {
  type AgentAdapter,
  type CommandResult,
  type ConfigError,
  commandSchema,
  type EffectiveConfig,
  type Event,
  laterCommandTypes,
  type PhaseState,
  type PlanState,
  project,
  type RunOutputItem,
  type SegnoConfig,
} from "@segno/core";
import { docsTask, parsePlan } from "@segno/plan-format";
import { openEventLog } from "./event-log.js";
import {
  cutPhaseBranch,
  fetchRemote,
  GitError,
  slugsWithBranches,
} from "./git.js";
import type { LimitEvent, LiveRuns } from "./live.js";
import { type OnboardingContext, openOnboarding } from "./onboarding.js";
import { type Draft, openWork } from "./work.js";

export interface Clock {
  now(): Date;
  /** Calls `fire` at `at`; returns a cancel function. Defaults to setTimeout. */
  setTimer?(at: Date, fire: () => void): () => void;
}
/** Where and with what the Engine works a Plan; absent, Plans are only recorded. */
export interface Workspace {
  /** The Project's repo top-level. */
  repo: string;
  /** `projects/<id>/` in the app data directory. */
  projectDir: string;
  /** The current effective config. */
  config(): EffectiveConfig;
  adapters: readonly AgentAdapter[];
  /** What an onboarding Run needs, while the Project isn't onboarded. */
  onboarding?(): Promise<OnboardingContext>;
}
export interface ConfigStore {
  prepareOnboarding(
    config: unknown,
  ): Promise<{ config?: SegnoConfig; errors: ConfigError[] }>;
  writeOnboarding(config: SegnoConfig): Promise<void>;
  discardPending(): Promise<void>;
  reload(): Promise<void>;
}
export interface EngineOptions {
  dbPath: string;
  clock?: Clock;
  isOnboarded?: () => boolean;
  configStore?: ConfigStore;
  workspace?: Workspace;
  /** Reports a failure of internal work, which has no caller to reject. */
  onError?: (error: unknown) => void;
  /** Usage and rate-limit signals from agent Runs, as Adapters report them. */
  onLimit?: (adapter: AgentAdapter, event: LimitEvent) => void;
}

/** A deferred Phase start is retried this long after the failed fetch [ADR-0029]. */
const startRetryMs = 5 * 60_000;

/** An unknown Run, task, Plan or Phase id. */
export class NotFoundError extends Error {
  readonly code = "not-found";
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class BadRequestError extends Error {
  readonly code = "bad-request";
  constructor() {
    super("The Command has no recognizable type.");
    this.name = "BadRequestError";
  }
}

export function openEngine({
  dbPath,
  clock = { now: () => new Date() },
  isOnboarded = () => true,
  configStore,
  workspace,
  onError = () => {},
  onLimit = () => {},
}: EngineOptions) {
  const setTimer =
    clock.setTimer?.bind(clock) ??
    ((at: Date, fire: () => void) => {
      const timer = setTimeout(fire, Math.max(0, at.getTime() - Date.now()));
      return () => clearTimeout(timer);
    });
  const log = openEventLog(dbPath);
  try {
    project(log.readEvents());
  } catch (error) {
    log.close();
    throw error;
  }
  const listeners = new Set<(event: Event) => void>();
  let tail: Promise<void> = Promise.resolve();
  let closed = false;
  let closing: Promise<void> | undefined;
  let queued = 0;
  let idleWaiters: (() => void)[] = [];
  let cancelStartRetry: (() => void) | undefined;
  const live: LiveRuns = new Map();
  const work =
    workspace &&
    openWork({
      ...workspace,
      now: () => clock.now(),
      setTimer,
      readState: () => project(log.readEvents()),
      emit,
      // A Run outcome is processed, then the Plan moves on from it.
      internal: (job) =>
        internal(async () => {
          await job();
          await drive();
        }),
      live,
      onLimit,
      onError,
    });
  const onboardingContext = workspace?.onboarding;
  const onboarding =
    workspace &&
    configStore &&
    onboardingContext &&
    openOnboarding({
      now: () => clock.now(),
      setTimer,
      repo: workspace.repo,
      projectDir: workspace.projectDir,
      adapters: workspace.adapters,
      context: onboardingContext,
      prepare: (config) => configStore.prepareOnboarding(config),
      readState: () => project(log.readEvents()),
      emit,
      internal: (job) => internal(job),
      live,
      onLimit,
      onError,
    });
  return {
    get state() {
      return project(readEvents());
    },
    readEvents,
    /** Startup reconciliation for a valid file, before the host exposes this Engine. */
    async acceptConfigFile(wasNotOnboarded = false) {
      if (!configStore || !isOnboarded()) return;
      const events = readEvents();
      await configStore.discardPending();
      if (
        !wasNotOnboarded &&
        events.some(
          (event) =>
            event.type === "onboarding.confirmed" ||
            event.type === "plan.submitted",
        )
      )
        return;
      append({
        seq: (events.at(-1)?.seq ?? 0) + 1,
        type: "onboarding.confirmed",
        v: 1,
        ts: clock.now().toISOString(),
        payload: { via: "file" },
      });
    },
    /**
     * Streams a Run's live output to `listener`, then its `end`. A finished
     * Run's `end` comes at once. Returns a function that stops listening.
     */
    watchRun(runId: string, listener: (item: RunOutputItem) => void) {
      const running = live.get(runId);
      if (running) {
        for (const text of running.output) listener({ kind: "output", text });
        running.listeners.add(listener);
        return () => running.listeners.delete(listener);
      }
      const run = project(readEvents()).runs.find(({ id }) => id === runId);
      if (!run) throw new NotFoundError(`Unknown Run ${runId}.`);
      // Started but not yet launched, or finished: either way nothing is live.
      listener({ kind: "end", outcome: run.outcome ?? "interrupted" });
      return () => {};
    },
    /** Calls `listener` with every Event appended from now on, in seq order. */
    onAppend(listener: (event: Event) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    handle(input: unknown): Promise<CommandResult> {
      if (closed) return Promise.reject(closedError());
      // Capture nested config values before the caller can edit a queued Command.
      const received = structuredClone(input);
      return enqueue(async () => {
        const outcome = await processCommand(received);
        // Queued before this input settles, so idle() also waits for it.
        if (outcome.ok) internal(drive);
        return outcome;
      });
    },
    /** Resolves once no Command, Run outcome or Engine step is pending. */
    idle(): Promise<void> {
      if (!queued && !live.size) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
    close(): Promise<void> {
      closed = true;
      cancelStartRetry?.();
      work?.close();
      // The last queued input may start a Run, so live Runs are stopped after
      // the queue drains. Recording them as interrupted is B8.
      closing ??= tail
        .then(() => Promise.all([...live.values()].map((run) => run.stop())))
        .then(() => {
          work?.close();
          log.close();
        });
      return closing;
    },
  };

  /** Processes inputs one at a time, in arrival order [ADR-0022]. */
  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    queued++;
    const result = tail.then(work);
    tail = result.then(
      () => {},
      () => {},
    );
    const settle = () => {
      if (--queued || live.size) return;
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const resolve of waiters) resolve();
    };
    result.then(settle, settle);
    return result;
  }

  /** Queues the Engine's own work, which has no caller to reject. */
  function internal(work: () => Promise<unknown>) {
    if (closed) return;
    enqueue(work).catch(onError);
  }

  /** Appends one input's Events in one transaction; returns their seqs. */
  function emit(drafts: readonly Draft[], planId?: string): number[] {
    if (!drafts.length) return [];
    const first = log.lastSeq() + 1;
    const ts = clock.now().toISOString();
    const events = drafts.map(
      (draft, index) => ({ ...draft, seq: first + index, v: 1, ts }) as Event,
    );
    log.append(events, planId);
    for (const event of events) notify(event);
    return events.map(({ seq }) => seq);
  }

  /** Moves the active Plan on as far as it can go without waiting. */
  async function drive() {
    if (!workspace || closed || !isOnboarded()) return;
    while (!closed && (await step(workspace)));
  }

  /** Takes the next automatic step, if any; returns whether one was taken. */
  async function step(workspace: Workspace): Promise<boolean> {
    const state = project(log.readEvents());
    const plan = state.plans.find(({ state }) => state === "active");
    const phase = plan?.phases.find(
      ({ state }) => state === "starting" || state === "active",
    );
    if (!plan || !phase) return false;
    if (phase.state === "starting") return startPhase(workspace, plan, phase);
    if (!work || !phase.branch) return false;
    return work.step(plan, { ...phase, branch: phase.branch });
  }

  /** Fetches, then cuts the Phase branch, or defers the start [ADR-0029]. */
  async function startPhase(
    { repo, config }: Workspace,
    plan: PlanState,
    phase: PhaseState,
  ) {
    const due = phase.deferred && new Date(phase.deferred.nextAttemptAt);
    if (due && due > clock.now()) {
      retryStartAt(due);
      return false;
    }
    const { remote, baseBranch } = config();
    const branch = `segno/${plan.slug}/${phase.id}`;
    try {
      await fetchRemote(repo, remote);
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      const nextAttemptAt = new Date(clock.now().getTime() + startRetryMs);
      emit(
        [
          {
            type: "phase.startDeferred",
            payload: {
              phaseId: phase.id,
              reason: "remote-unreachable",
              nextAttemptAt: nextAttemptAt.toISOString(),
            },
          },
        ],
        plan.id,
      );
      retryStartAt(nextAttemptAt);
      return false;
    }
    // The local branch is never used as a fallback.
    const baseSha = await cutPhaseBranch(repo, { branch, remote, baseBranch });
    const definition = plan.definition.phases.find(({ id }) => id === phase.id);
    if (!definition) throw new Error(`Unknown Phase ${phase.id}.`);
    emit(
      [
        {
          type: "phase.started",
          payload: {
            phaseId: phase.id,
            branch,
            baseSha,
            docsTask: docsTask(definition),
          },
        },
      ],
      plan.id,
    );
    return true;
  }

  function retryStartAt(at: Date) {
    cancelStartRetry?.();
    cancelStartRetry = setTimer(at, () => {
      cancelStartRetry = undefined;
      internal(drive);
    });
  }

  function closedError() {
    return new Error("The Engine is closed.");
  }

  function append(event: Event) {
    log.append([event]);
    notify(event);
  }

  function notify(event: Event) {
    // The Event is committed; a failing listener must not fail the Command.
    for (const listener of listeners)
      try {
        listener(event);
      } catch {}
  }

  function readEvents(since?: number) {
    if (closed) throw closedError();
    return log.readEvents(since);
  }

  async function processCommand(input: unknown): Promise<CommandResult> {
    const type = (input as { type?: unknown } | null)?.type;
    const later = (laterCommandTypes as readonly unknown[]).includes(type);
    const recognized =
      commandSchema.options.some(
        (option) => option.shape.type.value === type,
      ) || later;
    const onboardingCommand =
      typeof type === "string" && type.startsWith("onboarding.");
    if (recognized && !onboardingCommand && !isOnboarded())
      return {
        ok: false,
        code: "not-onboarded",
        message: "Set up the Project before submitting or managing Plans.",
      };
    if (later) {
      return {
        ok: false,
        code: "unsupported-in-version",
        message: `${String(type)} is a v1.2 Command; this Engine is v1.`,
      };
    }
    if (
      typeof input !== "object" ||
      input === null ||
      !("type" in input) ||
      !recognized
    ) {
      throw new BadRequestError();
    }
    if (input.type === "plan.sendBack" || input.type === "task.sendBack") {
      const notes = "notes" in input ? input.notes : undefined;
      if (notes === undefined || (typeof notes === "string" && !notes.trim())) {
        return {
          ok: false,
          code: "notes-required",
          message: "Non-blank notes are required.",
        };
      }
    }
    if (input.type === "plan.abandon") {
      const reason = "reason" in input ? input.reason : undefined;
      if (
        reason === undefined ||
        (typeof reason === "string" && !reason.trim())
      ) {
        return {
          ok: false,
          code: "reason-required",
          message: "A non-blank reason is required.",
        };
      }
    }
    const validated = commandSchema.safeParse(input);
    if (!validated.success) {
      return {
        ok: false,
        code: "validation",
        message: "The Command payload is invalid.",
        errors: validated.error.issues.flatMap((issue) => {
          const paths =
            issue.code === "unrecognized_keys"
              ? issue.keys.map((key) => [...issue.path, key])
              : [issue.path];
          return paths.map((path) => ({
            code: "schema" as const,
            path: path.length
              ? `/${path.map((part) => String(part).replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`
              : "",
            message:
              issue.code === "unrecognized_keys"
                ? `Unrecognized key: ${JSON.stringify(path.at(-1))}`
                : issue.message,
          }));
        }),
      };
    }
    const command = validated.data;
    const state = project(log.readEvents());
    if (
      command.type === "onboarding.start" ||
      command.type === "onboarding.stop" ||
      command.type === "onboarding.confirm"
    ) {
      if (isOnboarded() || !configStore)
        return {
          ok: false,
          code: "invalid-transition",
          message: "The Project is already onboarded.",
        };
      if (command.type !== "onboarding.confirm") {
        if (!onboarding) throw new Error("This Engine can't run onboarding.");
        return command.type === "onboarding.start"
          ? onboarding.start()
          : onboarding.stop();
      }
      if (state.onboarding.state === "running")
        return {
          ok: false,
          code: "invalid-transition",
          message: "An onboarding Run is live.",
        };
      const prepared = await configStore.prepareOnboarding(command.config);
      if (!prepared.config || prepared.errors.length)
        return {
          ok: false,
          code: "validation",
          message: "The config is invalid.",
          errors: prepared.errors,
        };
      await configStore.writeOnboarding(prepared.config);
      const seq = state.lastSeq + 1;
      append({
        seq,
        type: "onboarding.confirmed",
        v: 1,
        ts: clock.now().toISOString(),
        payload: {
          // An open review means the proposal is what's being confirmed.
          via: state.awaiting.some(({ kind }) => kind === "onboarding-review")
            ? "proposal"
            : "manual",
          config: prepared.config,
        },
      });
      await configStore.reload();
      return { ok: true, events: [seq] };
    }
    if (command.type === "task.approve" || command.type === "task.sendBack") {
      const task = state.tasks.findLast(({ id }) => id === command.taskId);
      if (!task)
        return {
          ok: false,
          code: "not-found",
          message: `Unknown Task ${command.taskId}.`,
        };
      if (task.state !== "held")
        return {
          ok: false,
          code: "invalid-transition",
          message: `${command.type} requires a held Task.`,
        };
      const drafts: Draft[] = [];
      if (command.type === "task.sendBack")
        drafts.push({
          type: "task.findingAdded",
          payload: {
            taskId: task.id,
            finding: {
              id: randomUUID(),
              source: "developer",
              severity: "blocking",
              body: command.notes,
            },
          },
        });
      drafts.push({
        type: "task.transitioned",
        payload: {
          taskId: task.id,
          from: "held",
          to: command.type === "task.approve" ? "merging" : "coding",
          cause:
            command.type === "task.approve"
              ? "developer-approved"
              : "developer-sent-back",
        },
      });
      return { ok: true, events: emit(drafts, task.planId) };
    }
    if (command.type !== "plan.submit") {
      const plan = state.plans.find(({ id }) => id === command.planId);
      if (!plan) {
        return {
          ok: false,
          code: "not-found",
          message: `Unknown Plan ${command.planId}.`,
        };
      }
      if (
        plan.state !== "awaiting-approval" &&
        !(command.type === "plan.abandon" && plan.state === "active")
      ) {
        return {
          ok: false,
          code: "invalid-transition",
          message: `${command.type} is not allowed from ${plan.state}.`,
        };
      }
    }
    if (command.type === "plan.approve") {
      append({
        seq: state.lastSeq + 1,
        type: "plan.approved",
        v: 1,
        ts: clock.now().toISOString(),
        payload: { planId: command.planId },
      });
      return { ok: true, events: [state.lastSeq + 1] };
    }
    if (command.type === "plan.sendBack") {
      append({
        seq: state.lastSeq + 1,
        type: "plan.returned",
        v: 1,
        ts: clock.now().toISOString(),
        payload: { planId: command.planId, notes: command.notes },
      });
      return { ok: true, events: [state.lastSeq + 1] };
    }
    if (command.type === "plan.abandon") {
      // Every unfinished Task is superseded and its worktree deleted [ADR-0013].
      const ending = work?.abandon(command.planId);
      const events = emit(
        [
          {
            type: "plan.abandoned",
            payload: { planId: command.planId, reason: command.reason },
          },
          ...(ending?.drafts ?? []),
        ],
        command.planId,
      );
      await ending?.cleanup();
      return { ok: true, events };
    }
    if (
      state.plans.some(
        ({ state }) => state === "awaiting-approval" || state === "active",
      )
    ) {
      return {
        ok: false,
        code: "plan-exists",
        message: "A Plan is awaiting approval or active.",
      };
    }
    const parsed = parsePlan(command.yaml);
    if (!parsed.valid)
      return {
        ok: false,
        code: "validation",
        message: "The Plan file is invalid.",
        errors: parsed.errors,
      };
    const seq = state.lastSeq + 1;
    const stem =
      parsed.plan.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 40)
        .replace(/^-|-$/g, "") || "plan";
    // Taken by any Plan in this log, or by branches an earlier log left [ADR-0053].
    const used = new Set(state.plans.map(({ slug }) => slug));
    if (workspace)
      for (const slug of await slugsWithBranches(
        workspace.repo,
        workspace.config().remote,
      ))
        used.add(slug);
    let slug = stem;
    for (let suffix = 2; used.has(slug); suffix++) slug = `${stem}-${suffix}`;
    append({
      seq,
      type: "plan.submitted",
      v: 1,
      ts: clock.now().toISOString(),
      payload: {
        planId: randomUUID(),
        slug,
        plan: parsed.plan,
        ...(command.sourcePath === undefined
          ? {}
          : { sourcePath: command.sourcePath }),
      },
    });
    return { ok: true, events: [seq] };
  }
}
export type Engine = ReturnType<typeof openEngine>;
