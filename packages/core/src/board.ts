import { agentRunKinds as agentKinds } from "./events.js";
import { holdsSlot, type State } from "./project.js";
import type { Board, BoardTask, Usage } from "./protocol.js";

/**
 * The board of the active Plan's active or awaiting-merge Phase, derived from
 * State. The host's `board` query and the GUI share it [ADR-0007] [ADR-0028].
 */
export function boardOf(
  state: State,
  { concurrency, usage }: { concurrency: number; usage?: Usage | undefined },
): Board {
  const usageOf = usage ? { usage } : {};
  const plan = state.plans.find(({ state }) => state === "active");
  const phase = plan?.phases.find(
    ({ state }) => state === "active" || state === "awaiting-merge",
  );
  const liveAgentRuns = state.runs.filter(
    ({ kind, outcome }) => !outcome && agentKinds.includes(kind),
  ).length;
  if (!plan || !phase?.branch)
    return {
      plan: plan ? planOf(plan) : null,
      phase: null,
      tasks: [],
      mergeQueue: [],
      sessions: { live: liveAgentRuns, concurrency, startedInPhase: 0 },
      ...usageOf,
    };
  const definition = plan.definition.phases.find(({ id }) => id === phase.id);
  const tasks = state.tasks
    .filter(({ planId, phaseId }) => planId === plan.id && phaseId === phase.id)
    .sort((a, b) => a.order - b.order);
  const mergeQueue = tasks
    .filter(({ state }) => state === "merging")
    .sort((a, b) => (a.mergingSince ?? 0) - (b.mergingSince ?? 0))
    .map(({ id }) => id);
  const slotsFull = tasks.some(({ state }) => holdsSlot(state));
  const ids = new Set(tasks.map(({ id }) => id));
  return {
    plan: planOf(plan),
    phase: {
      id: phase.id,
      title: definition?.title ?? phase.id,
      state: phase.state as "active" | "awaiting-merge",
      branch: phase.branch,
    },
    tasks: tasks
      .filter(({ state }) => state !== "superseded")
      .map((task): BoardTask => {
        const run = state.runs.findLast(
          ({ taskId, outcome }) => taskId === task.id && !outcome,
        );
        const waitReason = waitReasonOf(task.id);
        return {
          id: task.id,
          title: task.definition.title,
          state: task.state,
          paused: task.paused,
          budgets: task.budgets,
          ...(task.blockReason ? { blockReason: task.blockReason } : {}),
          ...(waitReason ? { waitReason } : {}),
          highRisk: task.highRisk,
          ...(run
            ? { run: { id: run.id, kind: run.kind, role: run.role } }
            : {}),
          ...(task.state === "merging" && mergeQueue[0] !== task.id
            ? { queuedToMerge: true }
            : {}),
        };
      }),
    mergeQueue,
    sessions: {
      live: liveAgentRuns,
      concurrency,
      startedInPhase: state.runs.filter(
        ({ kind, taskId }) =>
          agentKinds.includes(kind) && taskId !== undefined && ids.has(taskId),
      ).length,
    },
    ...usageOf,
  };

  function waitReasonOf(taskId: string) {
    const task = tasks.find(({ id }) => id === taskId);
    if (task?.state === "waiting") {
      const pending = (task.definition.dependsOn ?? [])
        .map((id) => tasks.find((other) => other.id === id))
        .filter((other) => other && other.state !== "done");
      const blocked = pending.find((other) => other?.state === "blocked");
      if (blocked) return `waiting on blocked ${blocked.id}`;
      if (pending[0]) return `needs ${pending[0].id}`;
    }
    if (task?.state === "ready" && slotsFull) return "slots full";
    return undefined;
  }
}

function planOf(plan: State["plans"][number]) {
  return {
    id: plan.id,
    slug: plan.slug,
    title: plan.definition.title,
    state: "active" as const,
  };
}
