import type { GraphTask } from "./graph.js";
import { cycles } from "./graph.js";
import type { Plan } from "./schema.js";
import { planSchema } from "./schema.js";
import { readSource } from "./source.js";
import type { ValidationResult } from "./types.js";

export function parsePlan(source: string): ValidationResult<Plan> {
  const input = readSource(source);
  if (input.errors.length)
    return { valid: false, errors: input.sortedErrors() };
  const { data: plan, report, errors } = input;
  if (
    typeof plan !== "object" ||
    plan === null ||
    !("schemaVersion" in plan) ||
    plan.schemaVersion !== 1
  ) {
    report(["schemaVersion"], "schema-version", "schemaVersion must be 1.");
  }
  const parsed = planSchema.safeParse(plan);
  if (!parsed.success) {
    input.reportIssues(
      parsed.error.issues,
      (path) =>
        path.length === 4 && path[0] === "phases" && path[2] === "tasks",
      true,
    );
  }

  if (
    typeof plan === "object" &&
    plan !== null &&
    "phases" in plan &&
    Array.isArray(plan.phases)
  ) {
    const phaseIds = new Set<string>();
    const taskIds = new Set<string>();
    const taskPhases = new Map<string, Set<number>>();
    const docsIds = new Set<string>(
      plan.phases.flatMap((phase) =>
        typeof phase?.id === "string" ? [`${phase.id}-docs`] : [],
      ),
    );
    for (const [phaseIndex, phase] of plan.phases.entries()) {
      if (typeof phase !== "object" || phase === null) continue;
      if (typeof phase.id === "string") {
        if (phaseIds.has(phase.id))
          report(
            ["phases", phaseIndex, "id"],
            "duplicate-id",
            `Repeated Phase id: ${phase.id}.`,
          );
        phaseIds.add(phase.id);
      }
      if (!Array.isArray(phase.tasks)) continue;
      for (const [taskIndex, task] of phase.tasks.entries()) {
        if (
          typeof task !== "object" ||
          task === null ||
          typeof task.id !== "string"
        )
          continue;
        if (docsIds.has(task.id))
          report(
            ["phases", phaseIndex, "tasks", taskIndex, "id"],
            "reserved-id",
            `Task id ${task.id} is reserved for a Docs task.`,
          );
        if (taskIds.has(task.id))
          report(
            ["phases", phaseIndex, "tasks", taskIndex, "id"],
            "duplicate-id",
            `Repeated Task id: ${task.id}.`,
          );
        taskIds.add(task.id);
        const owners = taskPhases.get(task.id) ?? new Set<number>();
        owners.add(phaseIndex);
        taskPhases.set(task.id, owners);
      }
    }
    for (const [phaseIndex, phase] of plan.phases.entries()) {
      if (
        typeof phase !== "object" ||
        phase === null ||
        !Array.isArray(phase.tasks)
      )
        continue;
      const graphTasks: GraphTask[] = [];
      for (const [taskIndex, task] of phase.tasks.entries()) {
        if (typeof task !== "object" || task === null) continue;
        if (typeof task.id === "string") {
          graphTasks.push({
            id: task.id,
            dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn : [],
            path: ["phases", phaseIndex, "tasks", taskIndex],
          });
        }
        const arrays = [
          {
            values: task.dependsOn,
            path: ["phases", phaseIndex, "tasks", taskIndex, "dependsOn"],
          },
          {
            values: task.risk?.flags,
            path: ["phases", phaseIndex, "tasks", taskIndex, "risk", "flags"],
          },
        ];
        for (const { values, path } of arrays) {
          if (!Array.isArray(values)) continue;
          const seen = new Set<string>();
          for (const [index, value] of values.entries()) {
            if (typeof value !== "string") continue;
            if (seen.has(value))
              report(
                [...path, index],
                "schema",
                `Duplicate array entry: ${value}.`,
              );
            seen.add(value);
          }
        }
        if (!Array.isArray(task.dependsOn)) continue;
        for (const [dependencyIndex, dependency] of task.dependsOn.entries()) {
          if (typeof dependency === "string" && docsIds.has(dependency)) {
            report(
              [
                "phases",
                phaseIndex,
                "tasks",
                taskIndex,
                "dependsOn",
                dependencyIndex,
              ],
              "reserved-id",
              `Dependency ${dependency} is a Docs task.`,
            );
          } else if (
            typeof dependency === "string" &&
            !taskIds.has(dependency)
          ) {
            report(
              [
                "phases",
                phaseIndex,
                "tasks",
                taskIndex,
                "dependsOn",
                dependencyIndex,
              ],
              "unknown-dependency",
              `Unknown Task dependency: ${dependency}.`,
            );
          } else if (
            typeof dependency === "string" &&
            !taskPhases.get(dependency)?.has(phaseIndex)
          ) {
            report(
              [
                "phases",
                phaseIndex,
                "tasks",
                taskIndex,
                "dependsOn",
                dependencyIndex,
              ],
              "cross-phase-dependency",
              `Dependency ${dependency} belongs to another Phase.`,
            );
          }
        }
      }
      for (const cycle of cycles(graphTasks)) {
        report(
          cycle.path,
          "dependency-cycle",
          `Dependency cycle among Tasks: ${cycle.ids.join(", ")}.`,
        );
      }
    }
  }
  if (errors.length || !parsed.success)
    return { valid: false, errors: input.sortedErrors() };
  return { valid: true, plan: parsed.data };
}
