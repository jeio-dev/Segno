import type { Plan } from "@segno/plan-format";
import type { Event, PhaseStatus, PlanStatus } from "./events.js";

export interface PlanState {
  id: string;
  slug: string;
  definition: Plan;
  sourcePath?: string;
  state: PlanStatus;
  submittedAt: string;
  phases: { id: string; state: PhaseStatus }[];
  notes?: string;
  reason?: string;
}

export interface AwaitingItem {
  id: number;
  kind: "plan-approval";
  planId: string;
  phaseId?: string;
  taskId?: string;
  title: string;
  createdAt: string;
}

export interface State {
  lastSeq: number;
  plans: PlanState[];
  awaiting: AwaitingItem[];
}

/** Pure replay shared by the Engine and, from B3, its clients. */
export function project(events: readonly Event[]): State {
  const state: State = { lastSeq: 0, plans: [], awaiting: [] };
  for (const event of events) {
    state.lastSeq = event.seq;
    if (event.type === "plan.submitted") {
      const { planId, slug, plan, sourcePath } = event.payload;
      state.plans.push({
        id: planId,
        slug,
        // Plan definitions are JSON data; keep client edits out of source Events.
        definition: JSON.parse(JSON.stringify(plan)) as Plan,
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
    } else if (
      event.type === "plan.approved" ||
      event.type === "plan.returned" ||
      event.type === "plan.abandoned"
    ) {
      const plan = state.plans.find(({ id }) => id === event.payload.planId);
      if (!plan) throw new Error(`Unknown Plan ${event.payload.planId}.`);
      if (event.type === "plan.approved") plan.state = "active";
      else if (event.type === "plan.returned") {
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
    }
  }
  return state;
}
