import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  agentRunKinds,
  boardOf,
  HostError,
  type Queries,
  type QueryName,
  queryParamsSchemas,
  resolveConfig,
} from "@segno/core";
import { diffAgainstPhase } from "@segno/engine";
import { exportPlan } from "@segno/plan-format";
import { detectConfig } from "./detect.js";
import { git } from "./git.js";
import type { RunningProject } from "./projects.js";

type Results = { [Q in QueryName]: Queries[Q]["result"] };

/** Reads one query's derived state from a Project's Engine [ADR-0022]. */
export async function runQuery(
  { engine, path, dir, config, local, pending }: RunningProject,
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
  const findTask = (taskId: string) => {
    // Ids are unique only within a Plan; this is the newest Plan's Task.
    const task = state.tasks.findLast(({ id }) => id === taskId);
    if (!task) throw new HostError("not-found", `Unknown Task ${taskId}.`);
    return task;
  };
  const findRun = (runId: string) => {
    const run = state.runs.find(({ id }) => id === runId);
    if (!run) throw new HostError("not-found", `Unknown Run ${runId}.`);
    return run;
  };
  /** A Run's stored file; its directory is gone once pruned [ADR-0033]. */
  const runFile = async (runId: string, file: string) => {
    const runDir = join(dir, "runs", runId);
    if (!existsSync(runDir))
      throw new HostError("pruned", `Run ${runId}'s files were pruned.`);
    const path = join(runDir, file);
    return existsSync(path) ? readFile(path, "utf8") : "";
  };
  switch (name as QueryName) {
    case "board":
      return boardOf(state, {
        concurrency: config?.concurrency ?? 1,
      }) satisfies Results["board"];
    case "task": {
      const { runIds, ...task } = findTask(
        (params as { taskId: string }).taskId,
      );
      return {
        ...task,
        runs: state.runs.filter(({ id }) => runIds.includes(id)),
      } satisfies Results["task"];
    }
    case "taskDiff": {
      const task = findTask((params as { taskId: string }).taskId);
      const plan = state.plans.find(({ id }) => id === task.planId);
      const phase = plan?.phases.find(({ id }) => id === task.phaseId);
      if (task.worktree && phase?.branch)
        return {
          diff: await diffAgainstPhase(path, {
            phase: phase.branch,
            head: task.worktree.branch,
          }),
        };
      const merged = join(
        dir,
        "tasks",
        plan?.slug ?? "",
        task.id,
        "merged.diff",
      );
      return { diff: existsSync(merged) ? await readFile(merged, "utf8") : "" };
    }
    case "run":
      return findRun((params as { runId: string }).runId);
    case "runTranscript": {
      const run = findRun((params as { runId: string }).runId);
      return runFile(
        run.id,
        agentRunKinds.includes(run.kind) ? "transcript.jsonl" : "output.log",
      );
    }
    case "runPrompt": {
      const run = findRun((params as { runId: string }).runId);
      // The probe's minimal fixed prompt isn't stored.
      if (!agentRunKinds.includes(run.kind) || run.kind === "probe")
        throw new HostError("not-found", `A ${run.kind} Run has no prompt.`);
      return runFile(run.id, "prompt.md");
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
      // Task and Run Events carry only their Task or Run id.
      const tasks = new Set(
        state.tasks
          .filter((task) => task.planId === plan.id && task.phaseId === phaseId)
          .map(({ id }) => id),
      );
      const runs = new Set(
        state.runs
          .filter(({ taskId }) => taskId !== undefined && tasks.has(taskId))
          .map(({ id }) => id),
      );
      return engine.readEvents().filter(({ payload }) => {
        const scoped = payload as {
          planId?: string;
          phaseId?: string;
          taskId?: string;
          runId?: string;
        };
        return (
          scoped.phaseId === phaseId ||
          scoped.planId === plan.id ||
          (scoped.taskId !== undefined && tasks.has(scoped.taskId)) ||
          (scoped.runId !== undefined && runs.has(scoped.runId))
        );
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
