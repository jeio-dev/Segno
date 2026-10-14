import {
  HostError,
  type Queries,
  type QueryName,
  queryParamsSchemas,
  resolveConfig,
} from "@segno/core";
import { exportPlan } from "@segno/plan-format";
import { detectConfig } from "./detect.js";
import { git } from "./git.js";
import type { RunningProject } from "./projects.js";

type Results = { [Q in QueryName]: Queries[Q]["result"] };

/** Reads one query's derived state from a Project's Engine [ADR-0022]. */
export async function runQuery(
  { engine, path, config, local, pending }: RunningProject,
  name: string,
  params: unknown,
): Promise<Results[QueryName]> {
  if (!Object.hasOwn(queryParamsSchemas, name))
    throw new HostError("bad-request", `Unknown query ${name}.`);
  if (!queryParamsSchemas[name as QueryName].safeParse(params).success)
    throw new HostError("bad-request", `Invalid params for ${name}.`);
  const state = engine.state;
  const findPlan = (planId: string) => {
    const plan = state.plans.find(({ id }) => id === planId);
    if (!plan) throw new HostError("not-found", `Unknown Plan ${planId}.`);
    return plan;
  };
  switch (name as QueryName) {
    case "board": {
      const plan = state.plans.find(({ state }) => state === "active");
      return {
        plan: plan
          ? {
              id: plan.id,
              slug: plan.slug,
              title: plan.definition.title,
              state: "active",
            }
          : null,
        // No Phase starts before B4, so none is active or awaiting merge.
        phase: null,
      } satisfies Results["board"];
    }
    case "awaiting":
      return state.awaiting;
    case "plans":
      return state.plans.map((plan) => ({
        id: plan.id,
        slug: plan.slug,
        title: plan.definition.title,
        state: plan.state,
        submittedAt: plan.submittedAt,
      }));
    case "plan":
      return findPlan((params as { planId: string }).planId);
    case "planExport":
      return exportPlan(
        findPlan((params as { planId: string }).planId).definition,
      );
    case "phases":
      // Archived Phases are those that started; none does before B4.
      return [];
    case "phaseEvents": {
      const { phaseId } = params as { phaseId: string };
      const plan = state.plans.find(({ phases }) =>
        phases.some(({ id }) => id === phaseId),
      );
      if (!plan) throw new HostError("not-found", `Unknown Phase ${phaseId}.`);
      return engine.readEvents().filter(({ payload }) => {
        const scoped = payload as { planId?: string; phaseId?: string };
        return scoped.phaseId === phaseId || scoped.planId === plan.id;
      });
    }
    case "onboarding":
      return {
        state: config ? "done" : "idle",
        detected: await detectConfig(path),
      };
    case "config": {
      if (!config)
        return {
          effective: null,
          sources: {},
          rejected: null,
          committed: false,
          pending,
        };
      const { effective, sources } = resolveConfig(config, local);
      const committed =
        (await git(
          path,
          "cat-file",
          "-e",
          `refs/remotes/${effective.remote}/${effective.baseBranch}:segno.config.json`,
        )) !== undefined;
      // config.rejected is first recorded in B8.
      return { effective, sources, rejected: null, committed, pending: null };
    }
  }
}
