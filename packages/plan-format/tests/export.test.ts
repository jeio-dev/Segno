import { expect, test } from "vitest";
import { parse } from "yaml";
import type { Plan } from "../src/index.js";
import { exportPlan, parsePlan } from "../src/index.js";

const plan: Plan = {
  schemaVersion: 1,
  title: "Notes",
  summary: "Find saved notes.\n\nKeep note content private.\n",
  phases: [
    {
      id: "index",
      title: "Index",
      docs: "Document rebuilding the index.\n",
      tasks: [
        {
          id: "query",
          title: "Query",
          description: "Query notes.",
          acceptance: ["Notes are found"],
        },
      ],
    },
  ],
};

const indexPhase = plan.phases[0];
if (!indexPhase) throw new Error("Missing fixture Phase");
const queryTask = indexPhase.tasks[0];
if (!queryTask) throw new Error("Missing fixture Task");

test("exports the Plan with its automatic Docs definition and Markdown intact", () => {
  const before = JSON.stringify(plan);
  expect(parse(exportPlan(plan))).toEqual({
    schemaVersion: 1,
    title: "Notes",
    summary: "Find saved notes.\n\nKeep note content private.\n",
    phases: [
      {
        id: "index",
        title: "Index",
        docs: "Document rebuilding the index.\n",
        tasks: [
          {
            id: "query",
            title: "Query",
            description: "Query notes.",
            acceptance: ["Notes are found"],
          },
          {
            id: "index-docs",
            title: "Docs and changelog",
            description:
              "Update the README and guides to reflect this Phase's behavior changes, and add changelog entries for user-visible changes.\n\nDocument rebuilding the index.\n",
            acceptance: [
              "README and guides reflect the Phase's behavior changes",
              "Changelog entries exist for user-visible changes",
            ],
            dependsOn: ["query"],
            generated: true,
          },
        ],
      },
    ],
  });
  expect(JSON.stringify(plan)).toBe(before);
});

test("omits superseded Tasks and preserves the current Docs definition", () => {
  const current: Plan = {
    ...plan,
    phases: [
      {
        ...indexPhase,
        tasks: [
          ...indexPhase.tasks,
          {
            id: "query-title",
            title: "Query titles",
            description: "Query titles.",
            acceptance: ["Titles are found"],
          },
          {
            id: "query-content",
            title: "Query content",
            description: "Query content.",
            acceptance: ["Content is found"],
          },
          {
            id: "index-docs",
            title: "Docs and changelog",
            description: "Current Docs revision.",
            acceptance: ["Docs reflect current behavior"],
            dependsOn: ["query"],
          },
        ],
      },
    ],
  };
  const exported = parse(exportPlan(current, { supersededTaskIds: ["query"] }));
  expect(exported.phases[0].tasks).toEqual([
    {
      id: "query-title",
      title: "Query titles",
      description: "Query titles.",
      acceptance: ["Titles are found"],
    },
    {
      id: "query-content",
      title: "Query content",
      description: "Query content.",
      acceptance: ["Content is found"],
    },
    {
      id: "index-docs",
      title: "Docs and changelog",
      description: "Current Docs revision.",
      acceptance: ["Docs reflect current behavior"],
      dependsOn: ["query-title", "query-content"],
      generated: true,
    },
  ]);
});

test("merges Reviewer flags and reasons into authored and Docs Tasks", () => {
  const current: Plan = {
    ...plan,
    phases: [
      {
        ...indexPhase,
        tasks: [
          {
            ...queryTask,
            risk: { flags: ["auth"], reason: "Queries contain private data." },
          },
        ],
      },
    ],
  };
  const exported = parse(
    exportPlan(current, {
      reviewerRisks: {
        query: [
          {
            flags: ["auth", "security"],
            reason: "Check access to shared notes.",
          },
          { flags: ["migration"], reason: "Existing indexes need rebuilding." },
        ],
        "index-docs": [
          { flags: ["security"], reason: "Document the access rules." },
        ],
      },
    }),
  );
  expect(
    exported.phases[0].tasks.map((task: { risk: unknown }) => task.risk),
  ).toEqual([
    {
      flags: ["auth", "security", "migration"],
      reason:
        "Queries contain private data.\n\nCheck access to shared notes.\n\nExisting indexes need rebuilding.",
    },
    { flags: ["security"], reason: "Document the access rules." },
  ]);
});

test("exports a 53-character Docs id for a valid 48-character Phase id", () => {
  const source = `schemaVersion: 1
title: Long Phase id
summary: Long authored ids remain valid.
phases:
  - id: abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuv
    title: Work
    tasks:
      - id: work
        title: Work
        description: Make the change.
        acceptance: [It works]
`;
  const result = parsePlan(source);
  expect(result.valid).toBe(true);
  if (!result.valid) throw new Error("Expected a valid Plan");
  expect(parse(exportPlan(result.plan)).phases[0].tasks[1].id).toBe(
    "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuv-docs",
  );
});

test("export round-trips authored definitions but cannot be resubmitted with Docs Tasks", () => {
  const output = exportPlan(plan);
  const decoded = parse(output);
  expect(decoded.phases[0].tasks[0]).toEqual({
    id: "query",
    title: "Query",
    description: "Query notes.",
    acceptance: ["Notes are found"],
  });
  const result = parsePlan(output);
  expect(result.valid).toBe(false);
  if (result.valid) throw new Error("Expected exported Docs rejection");
  expect(result.errors.map(({ code }) => code)).toEqual([
    "reserved-id",
    "generated-task",
  ]);
});
