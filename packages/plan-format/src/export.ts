import { stringify } from "yaml";
import type { Phase, Plan, Risk, Task } from "./schema.js";

export interface ExportOptions {
  supersededTaskIds?: readonly string[];
  reviewerRisks?: Readonly<Record<string, readonly Risk[]>>;
}

export function exportPlan(plan: Plan, options: ExportOptions = {}): string {
  const superseded = new Set(options.supersededTaskIds);
  function mergeRisk(task: Task): Task {
    const added =
      options.reviewerRisks && Object.hasOwn(options.reviewerRisks, task.id)
        ? (options.reviewerRisks[task.id] ?? [])
        : [];
    if (!added.length) return task;
    const risks = [...(task.risk ? [task.risk] : []), ...added];
    return {
      ...task,
      risk: {
        flags: [...new Set(risks.flatMap((risk) => risk.flags))],
        reason: risks.map((risk) => risk.reason).join("\n\n"),
      },
    };
  }
  const exported = {
    ...plan,
    phases: plan.phases.map((phase) => {
      const docsId = `${phase.id}-docs`;
      const tasks = phase.tasks.filter(
        (task) => task.id !== docsId && !superseded.has(task.id),
      );
      const currentDocs = phase.tasks.find((task) => task.id === docsId);
      return {
        ...phase,
        tasks: [
          ...tasks,
          {
            ...(currentDocs ?? docsTask(phase)),
            dependsOn: tasks.map((task) => task.id),
            generated: true,
          },
        ].map(mergeRisk),
      };
    }),
  };
  return stringify(exported, { lineWidth: 0, blockQuote: "literal" });
}

/**
 * The Docs task Segno adds to close a Phase: id `<phase-id>-docs`, depending
 * on every other Task in the Phase [ADR-0011] [ADR-0044].
 */
export function docsTask(phase: Phase): Task {
  const id = `${phase.id}-docs`;
  return {
    id,
    title: "Docs and changelog",
    description:
      "Update the README and guides to reflect this Phase's behavior changes, and add changelog entries for user-visible changes." +
      (phase.docs ? `\n\n${phase.docs}` : ""),
    acceptance: [
      "README and guides reflect the Phase's behavior changes",
      "Changelog entries exist for user-visible changes",
    ],
    dependsOn: phase.tasks.filter((task) => task.id !== id).map(({ id }) => id),
  };
}
