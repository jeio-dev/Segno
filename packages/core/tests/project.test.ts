import { expect, test } from "vitest";
import { boardOf, type Event, project } from "../src/index.js";

const definition = {
  schemaVersion: 1 as const,
  title: "Search notes",
  summary: "Find saved notes.",
  phases: [
    {
      id: "index",
      title: "Search index",
      tasks: [
        {
          id: "index-notes",
          title: "Index notes",
          description: "Build the index.",
          acceptance: ["Notes are searchable"],
        },
      ],
    },
  ],
};

const submitted: Event = {
  seq: 1,
  type: "plan.submitted",
  v: 1,
  ts: "2026-10-13T20:00:00.000Z",
  payload: {
    planId: "plan-1",
    slug: "search-notes",
    plan: definition,
    sourcePath: "/plans/search.yaml",
  },
};

test("a submitted Plan is pending approval with one Awaiting-you item", () => {
  expect(project([submitted])).toEqual({
    lastSeq: 1,
    plans: [
      {
        id: "plan-1",
        slug: "search-notes",
        definition,
        sourcePath: "/plans/search.yaml",
        state: "awaiting-approval",
        submittedAt: "2026-10-13T20:00:00.000Z",
        phases: [{ id: "index", state: "pending" }],
      },
    ],
    tasks: [],
    runs: [],
    awaiting: [
      {
        id: 1,
        kind: "plan-approval",
        planId: "plan-1",
        title: "Search notes",
        createdAt: "2026-10-13T20:00:00.000Z",
      },
    ],
    onboarding: { state: "idle" },
  });
});

test("approval clears Awaiting you and the first Phase starts", () => {
  const state = project([
    submitted,
    {
      seq: 2,
      type: "plan.approved",
      v: 1,
      ts: "2026-10-13T20:01:00.000Z",
      payload: { planId: "plan-1" },
    },
  ]);
  expect(state.plans[0]?.state).toBe("active");
  expect(state.plans[0]?.phases).toEqual([{ id: "index", state: "starting" }]);
  expect(state.awaiting).toEqual([]);
  expect(state.lastSeq).toBe(2);
});

test("send back retains the Plan and notes in History and clears its approval item", () => {
  const state = project([
    submitted,
    {
      seq: 2,
      type: "plan.returned",
      v: 1,
      ts: "2026-10-13T20:01:00.000Z",
      payload: { planId: "plan-1", notes: "Narrow the scope." },
    },
  ]);
  expect(state.plans[0]).toMatchObject({
    state: "returned",
    notes: "Narrow the scope.",
    definition,
  });
  expect(state.awaiting).toEqual([]);
});

test.each([false, true])(
  "abandon archives an approved=%s Plan and its Phases",
  (approved) => {
    const events: Event[] = [submitted];
    if (approved) {
      events.push({
        seq: 2,
        type: "plan.approved",
        v: 1,
        ts: "2026-10-13T20:01:00.000Z",
        payload: { planId: "plan-1" },
      });
    }
    events.push({
      seq: approved ? 3 : 2,
      type: "plan.abandoned",
      v: 1,
      ts: "2026-10-13T20:02:00.000Z",
      payload: { planId: "plan-1", reason: "Priorities changed." },
    });
    const state = project(events);
    expect(state.plans[0]).toMatchObject({
      state: "abandoned",
      reason: "Priorities changed.",
      phases: [{ id: "index", state: "abandoned" }],
    });
    expect(state.awaiting).toEqual([]);
  },
);

test("editing projected State cannot change the Events used by later replay", () => {
  const events: Event[] = [JSON.parse(JSON.stringify(submitted))];
  const state = project(events);
  const task = state.plans[0]?.definition.phases[0]?.tasks[0];
  if (!task) throw new Error("Missing Task definition.");
  task.title = "Changed in the client";
  task.acceptance.push("Client-only criterion");
  expect(project(events).plans[0]?.definition).toEqual(definition);
});

test("replay keeps malformed review errors and raised risk for the board and Review tab", () => {
  const meta = { v: 1 as const, ts: "2026-10-14T20:00:00.000Z" };
  const events: Event[] = [
    submitted,
    { ...meta, seq: 2, type: "plan.approved", payload: { planId: "plan-1" } },
    {
      ...meta,
      seq: 3,
      type: "phase.started",
      payload: {
        phaseId: "index",
        branch: "segno/search-notes/index",
        baseSha: "base",
        docsTask: {
          id: "index-docs",
          title: "Docs",
          description: "Write docs",
          acceptance: ["Docs updated"],
          dependsOn: ["index-notes"],
        },
      },
    },
    {
      ...meta,
      seq: 4,
      type: "verdict.malformed",
      payload: {
        taskId: "index-notes",
        runId: "r",
        errors: ["Missing criterion 0"],
        raw: "{}",
      },
    },
    {
      ...meta,
      seq: 5,
      type: "task.riskRaised",
      payload: {
        taskId: "index-notes",
        flags: ["security"],
        reason: "Permissions changed",
        byRunId: "r",
      },
    },
    {
      ...meta,
      seq: 6,
      type: "task.budgetUsed",
      payload: { taskId: "index-notes", budget: "infra", count: 3 },
    },
    {
      ...meta,
      seq: 7,
      type: "task.transitioned",
      payload: {
        taskId: "index-notes",
        from: "reviewing",
        to: "blocked",
        cause: "infra-exhausted",
        blockReason: "verdict-invalid",
      },
    },
  ];
  const state = project(events);
  expect(state.tasks[0]).toMatchObject({
    malformedVerdicts: [
      { seq: 4, runId: "r", errors: ["Missing criterion 0"], raw: "{}" },
    ],
  });
  expect(boardOf(state, { concurrency: 1 }).tasks).toMatchObject([
    {
      id: "index-notes",
      state: "blocked",
      blockReason: "verdict-invalid",
      budgets: { review: 0, test: 0, infra: 3 },
      highRisk: true,
      risk: [{ flag: "security", reason: "Permissions changed" }],
    },
    {
      id: "index-docs",
      state: "waiting",
      waitReason: "waiting on blocked index-notes",
    },
  ]);
  expect(state.awaiting).toMatchObject([
    { id: 7, kind: "blocked", taskId: "index-notes" },
  ]);
});
