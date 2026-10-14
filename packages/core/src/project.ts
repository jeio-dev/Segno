import type { Plan, Task } from "@segno/plan-format";
import type {
  BlockReason,
  Budget,
  Event,
  Finding,
  PhaseStatus,
  PlanStatus,
  RunKind,
  RunOutcome,
  TaskStatus,
  Verdict,
} from "./events.js";
import type {
  OnboardingFailureReason,
  OnboardingProposal,
} from "./onboarding.js";

export interface PhaseState {
  id: string;
  state: PhaseStatus;
  branch?: string;
  baseSha?: string;
  startedAt?: string;
  /** The latest deferred start, while the Phase is still starting. */
  deferred?: { reason: string; nextAttemptAt: string };
}

export interface PlanState {
  id: string;
  slug: string;
  definition: Plan;
  sourcePath?: string;
  state: PlanStatus;
  submittedAt: string;
  phases: PhaseState[];
  notes?: string;
  reason?: string;
}

export interface TaskState {
  id: string;
  planId: string;
  phaseId: string;
  definition: Task;
  /** Scheduling position within the Phase; the Docs task comes last. */
  order: number;
  state: TaskStatus;
  paused: boolean;
  budgets: Record<Budget, number>;
  blockReason?: BlockReason;
  highRisk: boolean;
  risk: { flag: string; reason: string }[];
  findings: (Finding & { open: boolean })[];
  worktree?: { path: string; branch: string };
  /** The seq at which the Task last entered merging: its merge-queue place. */
  mergingSince?: number;
  history: {
    seq: number;
    ts: string;
    from: TaskStatus;
    to: TaskStatus;
    cause: string;
  }[];
  runIds: string[];
  malformedVerdicts: {
    seq: number;
    runId: string;
    errors: unknown[];
    raw?: string;
  }[];
  verdicts: { seq: number; runId: string; verdict: Verdict }[];
}

export interface RunState {
  id: string;
  /** The seq of its run.started. */
  seq: number;
  taskId?: string;
  kind: RunKind;
  role: string;
  adapter?: string;
  model?: string;
  sessionId?: string;
  startedAt: string;
  finishedAt?: string;
  outcome?: RunOutcome;
  exitCode?: number;
  detail?: string;
}

export interface AwaitingItem {
  id: number;
  kind: "plan-approval" | "onboarding-review" | "blocked" | "merge-hold";
  /** Set for every item about a Plan. */
  planId?: string;
  phaseId?: string;
  taskId?: string;
  /** The onboarding Run whose proposal awaits review. */
  runId?: string;
  title: string;
  createdAt: string;
}

/** Where onboarding stands (api.md, the `onboarding` query) [ADR-0049]. */
export interface OnboardingState {
  state: "idle" | "running" | "proposed" | "failed" | "done";
  runId?: string;
  proposal?: OnboardingProposal;
  failure?: {
    reason: OnboardingFailureReason;
    detail?: string;
    errors?: unknown[];
  };
}

export interface State {
  lastSeq: number;
  plans: PlanState[];
  tasks: TaskState[];
  runs: RunState[];
  awaiting: AwaitingItem[];
  onboarding: OnboardingState;
}

/** The Task states that hold a run slot [ADR-0051]. */
export function holdsSlot(state: TaskStatus) {
  return (
    state === "coding" ||
    state === "testing" ||
    state === "reviewing" ||
    state === "merging"
  );
}

/** Plan definitions are JSON data; keep client edits out of source Events. */
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Pure replay shared by the Engine and, from B3, its clients. */
export function project(events: readonly Event[]): State {
  const state: State = {
    lastSeq: 0,
    plans: [],
    tasks: [],
    runs: [],
    awaiting: [],
    onboarding: { state: "idle" },
  };
  const planOf = (planId: string) => {
    const plan = state.plans.find(({ id }) => id === planId);
    if (!plan) throw new Error(`Unknown Plan ${planId}.`);
    return plan;
  };
  const phaseOf = (phaseId: string) => {
    for (const plan of state.plans) {
      const phase = plan.phases.find(({ id }) => id === phaseId);
      if (phase && plan.state === "active") return { plan, phase };
    }
    throw new Error(`Unknown Phase ${phaseId}.`);
  };
  const taskOf = (taskId: string) => {
    // Ids are unique only within a Plan; Events concern the newest Plan's Task.
    const task = state.tasks.findLast(({ id }) => id === taskId);
    if (!task) throw new Error(`Unknown Task ${taskId}.`);
    return task;
  };
  const runOf = (runId: string) => {
    const run = state.runs.find(({ id }) => id === runId);
    if (!run) throw new Error(`Unknown Run ${runId}.`);
    return run;
  };
  for (const event of events) {
    state.lastSeq = event.seq;
    switch (event.type) {
      case "onboarding.started":
        state.onboarding = { state: "running", runId: event.payload.runId };
        break;
      case "onboarding.proposed":
        state.onboarding = {
          state: "proposed",
          runId: event.payload.runId,
          proposal: copy(event.payload.proposal),
        };
        state.awaiting.push({
          id: event.seq,
          kind: "onboarding-review",
          runId: event.payload.runId,
          title: "Review the onboarding proposal",
          createdAt: event.ts,
        });
        break;
      case "onboarding.failed": {
        const { runId, reason, detail, errors } = event.payload;
        state.onboarding = {
          state: "failed",
          runId,
          failure: {
            reason,
            ...(detail === undefined ? {} : { detail }),
            ...(errors === undefined ? {} : { errors: copy(errors) }),
          },
        };
        break;
      }
      case "onboarding.stopped":
        state.onboarding = { state: "idle" };
        break;
      case "onboarding.confirmed":
        state.onboarding = { state: "done" };
        state.awaiting = state.awaiting.filter(
          ({ kind }) => kind !== "onboarding-review",
        );
        break;
      case "plan.submitted": {
        const { planId, slug, plan, sourcePath } = event.payload;
        state.plans.push({
          id: planId,
          slug,
          definition: copy(plan),
          ...(sourcePath === undefined ? {} : { sourcePath }),
          state: "awaiting-approval",
          submittedAt: event.ts,
          phases: plan.phases.map(({ id }) => ({ id, state: "pending" })),
        });
        state.awaiting.push({
          id: event.seq,
          kind: "plan-approval",
          planId,
          title: plan.title,
          createdAt: event.ts,
        });
        break;
      }
      case "plan.approved":
      case "plan.returned":
      case "plan.abandoned": {
        const plan = planOf(event.payload.planId);
        if (event.type === "plan.approved") {
          plan.state = "active";
          const first = plan.phases[0];
          if (first) first.state = "starting";
        } else if (event.type === "plan.returned") {
          plan.state = "returned";
          plan.notes = event.payload.notes;
        } else {
          plan.state = "abandoned";
          plan.reason = event.payload.reason;
          for (const phase of plan.phases) phase.state = "abandoned";
        }
        state.awaiting = state.awaiting.filter(
          ({ planId }) => planId !== plan.id,
        );
        break;
      }
      case "phase.startDeferred": {
        const { phase } = phaseOf(event.payload.phaseId);
        phase.deferred = {
          reason: event.payload.reason,
          nextAttemptAt: event.payload.nextAttemptAt,
        };
        break;
      }
      case "phase.started": {
        const { phaseId, branch, baseSha, docsTask } = event.payload;
        const { plan, phase } = phaseOf(phaseId);
        phase.state = "active";
        phase.branch = branch;
        phase.baseSha = baseSha;
        phase.startedAt = event.ts;
        delete phase.deferred;
        const definition = plan.definition.phases.find(
          ({ id }) => id === phaseId,
        );
        for (const [order, task] of [
          ...(definition?.tasks ?? []),
          docsTask,
        ].entries())
          state.tasks.push({
            id: task.id,
            planId: plan.id,
            phaseId,
            definition: copy(task),
            order,
            state: task.dependsOn?.length ? "waiting" : "ready",
            paused: false,
            budgets: { review: 0, test: 0, infra: 0 },
            highRisk: Boolean(task.risk),
            risk:
              task.risk?.flags.map((flag) => ({
                flag,
                reason: task.risk?.reason ?? "",
              })) ?? [],
            findings: [],
            history: [],
            runIds: [],
            verdicts: [],
            malformedVerdicts: [],
          });
        break;
      }
      case "task.transitioned": {
        const { taskId, from, to, cause, blockReason } = event.payload;
        const task = taskOf(taskId);
        task.state = to;
        if (blockReason) task.blockReason = blockReason;
        else delete task.blockReason;
        if (to === "merging") task.mergingSince = event.seq;
        else delete task.mergingSince;
        state.awaiting = state.awaiting.filter(
          (item) => item.planId !== task.planId || item.taskId !== task.id,
        );
        if (to === "blocked" || to === "held")
          state.awaiting.push({
            id: event.seq,
            kind: to === "held" ? "merge-hold" : "blocked",
            planId: task.planId,
            phaseId: task.phaseId,
            taskId: task.id,
            title: task.definition.title,
            createdAt: event.ts,
          });
        task.history.push({ seq: event.seq, ts: event.ts, from, to, cause });
        break;
      }
      case "task.riskRaised": {
        const task = taskOf(event.payload.taskId);
        task.highRisk = true;
        task.risk.push(
          ...event.payload.flags.map((flag) => ({
            flag,
            reason: event.payload.reason,
          })),
        );
        break;
      }
      case "task.findingAdded":
        taskOf(event.payload.taskId).findings.push({
          ...copy(event.payload.finding),
          open: true,
        });
        break;
      case "task.findingsClosed":
        for (const finding of taskOf(event.payload.taskId).findings)
          if (event.payload.findingIds.includes(finding.id))
            finding.open = false;
        break;
      case "task.budgetUsed":
        taskOf(event.payload.taskId).budgets[event.payload.budget] =
          event.payload.count;
        break;
      case "task.worktreeCreated":
        taskOf(event.payload.taskId).worktree = {
          path: event.payload.path,
          branch: event.payload.branch,
        };
        break;
      case "task.worktreeRemoved":
        delete taskOf(event.payload.taskId).worktree;
        break;
      case "run.started": {
        const { runId, taskId, kind, role, adapter, model } = event.payload;
        state.runs.push({
          id: runId,
          seq: event.seq,
          ...(taskId === undefined ? {} : { taskId }),
          kind,
          role,
          ...(adapter === undefined ? {} : { adapter }),
          ...(model === undefined ? {} : { model }),
          startedAt: event.ts,
        });
        if (taskId !== undefined) taskOf(taskId).runIds.push(runId);
        break;
      }
      case "run.sessionStarted":
        runOf(event.payload.runId).sessionId = event.payload.sessionId;
        break;
      case "run.finished": {
        const { runId, outcome, exitCode, detail } = event.payload;
        const run = runOf(runId);
        run.finishedAt = event.ts;
        run.outcome = outcome;
        if (exitCode !== undefined) run.exitCode = exitCode;
        if (detail !== undefined) run.detail = detail;
        // A rate-limited onboarding Run records no failure (B8 pauses it).
        if (outcome === "rate-limited" && state.onboarding.runId === runId)
          state.onboarding = { state: "idle" };
        break;
      }
      case "verdict.malformed": {
        const { runId, errors, raw } = event.payload;
        taskOf(event.payload.taskId).malformedVerdicts.push({
          seq: event.seq,
          runId,
          errors: copy(errors),
          ...(raw === undefined ? {} : { raw }),
        });
        break;
      }
      case "verdict.recorded":
        taskOf(event.payload.taskId).verdicts.push({
          seq: event.seq,
          runId: event.payload.runId,
          verdict: copy(event.payload.verdict),
        });
        break;
    }
  }
  return state;
}
