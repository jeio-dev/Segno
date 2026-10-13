import { z } from "zod";
import type { GraphTask } from "./graph.js";
import { cycles } from "./graph.js";
import type { Plan, Task } from "./schema.js";
import { taskSchema } from "./schema.js";
import { readSource } from "./source.js";
import type { ValidationError } from "./types.js";

export interface FragmentContext {
  kind: "replan" | "split";
  plan: Plan;
  taskId: string;
  idHistory: readonly string[];
}

export type FragmentResult =
  | { valid: true; tasks: Task[] }
  | { valid: false; errors: ValidationError[] };

export function validateFragment(
  source: string,
  context: FragmentContext,
): FragmentResult {
  const input = readSource(source);
  if (input.errors.length)
    return { valid: false, errors: input.sortedErrors() };
  const schema =
    context.kind === "replan"
      ? taskSchema.omit({ dependsOn: true })
      : z.array(taskSchema);
  const parsed = schema.safeParse(input.data);
  if (
    context.kind === "split" &&
    Array.isArray(input.data) &&
    input.data.length < 2
  ) {
    input.report([], "too-few-tasks", "A split needs at least two Tasks.");
  }
  if (!parsed.success) {
    input.reportIssues(parsed.error.issues, (path) =>
      context.kind === "replan"
        ? path.length === 0
        : path.length === 1 && typeof path[0] === "number",
    );
  }

  if (
    context.kind === "replan" &&
    typeof input.data === "object" &&
    input.data !== null &&
    "id" in input.data &&
    typeof input.data.id === "string" &&
    input.data.id !== context.taskId
  ) {
    input.report(
      ["id"],
      "id-mismatch",
      `Replan id must remain ${context.taskId}.`,
    );
  }
  const rawTasks =
    context.kind === "split" && Array.isArray(input.data)
      ? input.data
      : [input.data];
  for (const [index, task] of rawTasks.entries()) {
    if (typeof task !== "object" || task === null) continue;
    const base = context.kind === "split" ? [index] : [];
    for (const { values, path } of [
      {
        values: "dependsOn" in task ? task.dependsOn : undefined,
        path: [...base, "dependsOn"],
      },
      {
        values:
          "risk" in task &&
          typeof task.risk === "object" &&
          task.risk !== null &&
          "flags" in task.risk
            ? task.risk.flags
            : undefined,
        path: [...base, "risk", "flags"],
      },
    ]) {
      if (!Array.isArray(values)) continue;
      const seen = new Set<string>();
      for (const [valueIndex, value] of values.entries()) {
        if (typeof value !== "string") continue;
        if (seen.has(value))
          input.report(
            [...path, valueIndex],
            "schema",
            `Duplicate array entry: ${value}.`,
          );
        seen.add(value);
      }
    }
  }
  if (context.kind === "split" && Array.isArray(input.data)) {
    const history = new Set(context.idHistory);
    const seen = new Set<string>();
    const docsIds = new Set(
      context.plan.phases.map((phase) => `${phase.id}-docs`),
    );
    for (const [index, task] of input.data.entries()) {
      if (
        typeof task !== "object" ||
        task === null ||
        typeof task.id !== "string"
      )
        continue;
      if (docsIds.has(task.id))
        input.report(
          [index, "id"],
          "reserved-id",
          `Task id ${task.id} is reserved for a Docs task.`,
        );
      if (history.has(task.id))
        input.report(
          [index, "id"],
          "id-reused",
          `Task id ${task.id} has already existed in this Plan.`,
        );
      if (seen.has(task.id))
        input.report(
          [index, "id"],
          "duplicate-id",
          `Repeated Task id: ${task.id}.`,
        );
      seen.add(task.id);
    }
    const available = new Set(
      context.plan.phases.flatMap((phase) =>
        phase.tasks
          .filter((task) => task.id !== context.taskId)
          .map((task) => task.id),
      ),
    );
    const target = context.plan.phases.find((phase) =>
      phase.tasks.some((task) => task.id === context.taskId),
    );
    if (!target)
      throw new Error("Fragment context must name a current authored Task.");
    const local = new Set(
      target.tasks
        .filter((task) => task.id !== context.taskId)
        .map((task) => task.id),
    );
    for (const id of seen) available.add(id);
    for (const id of seen) local.add(id);
    for (const [index, task] of input.data.entries()) {
      if (
        typeof task !== "object" ||
        task === null ||
        !Array.isArray(task.dependsOn)
      )
        continue;
      for (const [dependencyIndex, dependency] of task.dependsOn.entries()) {
        if (typeof dependency === "string" && docsIds.has(dependency)) {
          input.report(
            [index, "dependsOn", dependencyIndex],
            "reserved-id",
            `Dependency ${dependency} is a Docs task.`,
          );
        } else if (
          typeof dependency === "string" &&
          !available.has(dependency)
        ) {
          input.report(
            [index, "dependsOn", dependencyIndex],
            "unknown-dependency",
            `Unknown Task dependency: ${dependency}.`,
          );
        } else if (typeof dependency === "string" && !local.has(dependency)) {
          input.report(
            [index, "dependsOn", dependencyIndex],
            "cross-phase-dependency",
            `Dependency ${dependency} belongs to another Phase.`,
          );
        }
      }
    }
    const graphTasks: GraphTask[] = input.data.flatMap((task, index) => {
      if (
        typeof task !== "object" ||
        task === null ||
        typeof task.id !== "string"
      )
        return [];
      return [
        {
          id: task.id,
          dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn : [],
          path: [index],
        },
      ];
    });
    for (const task of target.tasks) {
      if (task.id === context.taskId) continue;
      graphTasks.push({
        id: task.id,
        dependsOn: [
          ...new Set(
            (task.dependsOn ?? []).flatMap((id) =>
              id === context.taskId ? [...seen] : [id],
            ),
          ),
        ],
        path: [],
      });
    }
    for (const cycle of cycles(graphTasks)) {
      input.report(
        cycle.path,
        "dependency-cycle",
        `Dependency cycle among Tasks: ${cycle.ids.join(", ")}.`,
      );
    }
  }
  if (input.errors.length || !parsed.success)
    return { valid: false, errors: input.sortedErrors() };
  return {
    valid: true,
    tasks: Array.isArray(parsed.data) ? parsed.data : [parsed.data],
  };
}
