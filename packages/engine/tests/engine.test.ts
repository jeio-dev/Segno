import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, test } from "vitest";
import { type Engine, openEngine } from "../src/index.js";

const yaml = `schemaVersion: 1
title: Search notes
summary: Find saved notes.
phases:
  - id: index
    title: Search index
    tasks:
      - id: index-notes
        title: Index notes
        description: Build the index.
        acceptance: [Notes are searchable]
`;
const definition = {
  schemaVersion: 1,
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

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});

function databasePath() {
  const dir = mkdtempSync(join(tmpdir(), "segno-b2-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "segno.db");
}

function engineAt(dbPath = databasePath()) {
  const engine = openEngine({
    dbPath,
    clock: { now: () => new Date("2026-10-13T20:00:00.000Z") },
  });
  cleanups.push(() => engine.close());
  return engine;
}

test("submission appends the full Plan once and creates its approval item", async () => {
  const engine = engineAt();
  expect(
    await engine.handle({
      type: "plan.submit",
      yaml,
      sourcePath: "/plans/search.yaml",
    }),
  ).toEqual({
    ok: true,
    events: [1],
  });
  const events = engine.readEvents();
  const first = events[0];
  if (first?.type !== "plan.submitted")
    throw new Error("Missing submission Event.");
  expect(events).toEqual([
    {
      seq: 1,
      type: "plan.submitted",
      v: 1,
      ts: "2026-10-13T20:00:00.000Z",
      payload: {
        planId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        ),
        slug: "search-notes",
        plan: definition,
        sourcePath: "/plans/search.yaml",
      },
    },
  ]);
  expect(engine.state.awaiting).toEqual([
    {
      id: 1,
      kind: "plan-approval",
      planId: first.payload.planId,
      title: "Search notes",
      createdAt: "2026-10-13T20:00:00.000Z",
    },
  ]);
});

test("a second submitted Plan is rejected without appending an Event", async () => {
  const engine = engineAt();
  await engine.handle({ type: "plan.submit", yaml });
  expect(await engine.handle({ type: "plan.submit", yaml })).toMatchObject({
    ok: false,
    code: "plan-exists",
  });
  expect(engine.readEvents()).toHaveLength(1);
  expect(engine.state.lastSeq).toBe(1);
});

test("an invalid Plan returns located validation errors and writes nothing", async () => {
  const engine = engineAt();
  expect(
    await engine.handle({
      type: "plan.submit",
      yaml: yaml.replace("schemaVersion: 1", "schemaVersion: 2"),
    }),
  ).toEqual({
    ok: false,
    code: "validation",
    message: expect.any(String),
    errors: [
      {
        path: "/schemaVersion",
        line: 1,
        column: 16,
        code: "schema-version",
        message: expect.any(String),
      },
    ],
  });
  expect(engine.readEvents()).toEqual([]);
  expect(await engine.handle({ type: "plan.submit", yaml })).toEqual({
    ok: true,
    events: [1],
  });
});

test("send back archives the Plan and allows a revised file as a new Plan", async () => {
  const engine = engineAt();
  await engine.handle({ type: "plan.submit", yaml });
  const planId = engine.state.plans[0]?.id;
  expect(
    await engine.handle({
      type: "plan.sendBack",
      planId,
      notes: "Narrow the scope.",
    }),
  ).toEqual({ ok: true, events: [2] });
  expect(engine.readEvents(1)).toEqual([
    {
      seq: 2,
      type: "plan.returned",
      v: 1,
      ts: "2026-10-13T20:00:00.000Z",
      payload: { planId, notes: "Narrow the scope." },
    },
  ]);
  expect(engine.state.plans[0]).toMatchObject({
    state: "returned",
    notes: "Narrow the scope.",
  });
  expect(engine.state.awaiting).toEqual([]);
  expect(
    await engine.handle({
      type: "plan.submit",
      yaml: yaml.replace("Search notes", "Search revised notes"),
    }),
  ).toEqual({ ok: true, events: [3] });
  expect(engine.state.plans.map(({ state }) => state)).toEqual([
    "returned",
    "awaiting-approval",
  ]);
  expect(engine.state.plans[1]?.id).not.toBe(planId);
  expect(engine.state.awaiting[0]?.id).toBe(3);
});

test("approval activates the Plan, clears its item and still prevents another Plan", async () => {
  const engine = engineAt();
  await engine.handle({ type: "plan.submit", yaml });
  const planId = engine.state.plans[0]?.id;
  expect(await engine.handle({ type: "plan.approve", planId })).toEqual({
    ok: true,
    events: [2],
  });
  expect(engine.readEvents(1)).toEqual([
    {
      seq: 2,
      type: "plan.approved",
      v: 1,
      ts: "2026-10-13T20:00:00.000Z",
      payload: { planId },
    },
  ]);
  expect(engine.state.plans[0]).toMatchObject({
    state: "active",
    phases: [{ id: "index", state: "starting" }],
  });
  expect(engine.state.awaiting).toEqual([]);
  expect(await engine.handle({ type: "plan.submit", yaml })).toMatchObject({
    ok: false,
    code: "plan-exists",
  });
  expect(engine.readEvents()).toHaveLength(2);
});

test.each([false, true])(
  "abandon records its reason from approved=%s and releases the Project",
  async (approved) => {
    const engine = engineAt();
    await engine.handle({ type: "plan.submit", yaml });
    const planId = engine.state.plans[0]?.id;
    if (approved) await engine.handle({ type: "plan.approve", planId });
    expect(
      await engine.handle({
        type: "plan.abandon",
        planId,
        reason: "Priorities changed.",
      }),
    ).toEqual({ ok: true, events: [approved ? 3 : 2] });
    expect(engine.state.plans[0]).toMatchObject({
      state: "abandoned",
      reason: "Priorities changed.",
      phases: [{ id: "index", state: "abandoned" }],
    });
    expect(engine.state.awaiting).toEqual([]);
    expect(engine.readEvents().at(-1)).toMatchObject({
      type: "plan.abandoned",
      payload: { planId, reason: "Priorities changed." },
    });
    expect(
      await engine.handle({
        type: "plan.submit",
        yaml: yaml.replace("Search notes", "Another Plan"),
      }),
    ).toEqual({ ok: true, events: [approved ? 4 : 3] });
  },
);

test.each([
  { type: "plan.approve", planId: "missing" },
  { type: "plan.sendBack", planId: "missing", notes: "Revise it." },
  { type: "plan.abandon", planId: "missing", reason: "Cancel it." },
])(
  "$type rejects an unknown Plan without appending anything",
  async (command) => {
    const engine = engineAt();
    expect(await engine.handle(command)).toMatchObject({
      ok: false,
      code: "not-found",
    });
    expect(engine.readEvents()).toEqual([]);
  },
);

test.each([
  ["active", "plan.approve"],
  ["active", "plan.sendBack"],
  ["returned", "plan.approve"],
  ["returned", "plan.sendBack"],
  ["returned", "plan.abandon"],
  ["abandoned", "plan.approve"],
  ["abandoned", "plan.sendBack"],
  ["abandoned", "plan.abandon"],
])("a %s Plan rejects %s and names its current state", async (state, type) => {
  const engine = engineAt();
  await engine.handle({ type: "plan.submit", yaml });
  const planId = engine.state.plans[0]?.id;
  if (state === "active") await engine.handle({ type: "plan.approve", planId });
  if (state === "returned")
    await engine.handle({ type: "plan.sendBack", planId, notes: "Revise it." });
  if (state === "abandoned")
    await engine.handle({ type: "plan.abandon", planId, reason: "Cancel it." });
  const command = {
    type,
    planId,
    ...(type === "plan.sendBack" ? { notes: "Revise it." } : {}),
    ...(type === "plan.abandon" ? { reason: "Cancel it." } : {}),
  };
  expect(await engine.handle(command)).toEqual({
    ok: false,
    code: "invalid-transition",
    message: expect.stringContaining(state),
  });
  expect(engine.readEvents()).toHaveLength(2);
});

test.each([
  { type: "plan.submit", yaml: 12 },
  { type: "plan.submit", yaml, surprise: true },
  { type: "plan.approve" },
  { type: "plan.sendBack", planId: "missing", notes: 12 },
  { type: "plan.abandon", planId: "missing", reason: 12 },
])(
  "a recognized Command with an invalid payload returns validation errors",
  async (command) => {
    const engine = engineAt();
    const result = await engine.handle(command);
    expect(result).toMatchObject({
      ok: false,
      code: "validation",
      errors: [
        {
          code: "schema",
          path: expect.any(String),
          message: expect.any(String),
        },
      ],
    });
    expect(engine.readEvents()).toEqual([]);
  },
);

test("each unrecognized field gets its own validation message", async () => {
  const engine = engineAt();
  expect(
    await engine.handle({
      type: "plan.approve",
      planId: "missing",
      approvedBy: "a",
      clientVersion: "2",
    }),
  ).toMatchObject({
    ok: false,
    code: "validation",
    errors: [
      {
        code: "schema",
        path: "/approvedBy",
        message: 'Unrecognized key: "approvedBy"',
      },
      {
        code: "schema",
        path: "/clientVersion",
        message: 'Unrecognized key: "clientVersion"',
      },
    ],
  });
});

test.each([undefined, "", " \n\t"])(
  "missing or blank notes/reason use their specific rejections",
  async (text) => {
    const engine = engineAt();
    await engine.handle({ type: "plan.submit", yaml });
    const planId = engine.state.plans[0]?.id;
    expect(
      await engine.handle({
        type: "plan.sendBack",
        planId,
        ...(text === undefined ? {} : { notes: text }),
      }),
    ).toMatchObject({ ok: false, code: "notes-required" });
    expect(
      await engine.handle({
        type: "plan.abandon",
        planId,
        ...(text === undefined ? {} : { reason: text }),
      }),
    ).toMatchObject({ ok: false, code: "reason-required" });
    expect(engine.readEvents()).toHaveLength(1);
  },
);

test.each([null, {}, { type: "unknown" }, { type: 42 }, { yaml }])(
  "an unrecognizable Command gets bad-request, with no Event",
  async (command) => {
    const engine = engineAt();
    await expect(engine.handle(command)).rejects.toMatchObject({
      code: "bad-request",
    });
    expect(engine.readEvents()).toEqual([]);
  },
);

test.each([
  { type: "plan.future", v: 1 },
  { type: "plan.submitted", v: 2 },
  { type: "toString", v: 1 },
])(
  "startup refuses an unknown Event $type v$v and names both",
  async ({ type, v }) => {
    const dbPath = databasePath();
    const engine = engineAt(dbPath);
    await engine.handle({ type: "plan.submit", yaml });
    await engine.close();
    const db = new Database(dbPath);
    try {
      db.prepare(
        "INSERT INTO events (seq, type, v, ts, payload) VALUES (2, ?, ?, ?, '{}')",
      ).run(type, v, "2026-10-13T20:01:00.000Z");
    } finally {
      db.close();
    }
    expect(() => openEngine({ dbPath })).toThrow(new RegExp(`${type}.*${v}`));
  },
);

test("slug collisions include terminal Plans and skip already occupied suffixes", async () => {
  const engine = engineAt();
  for (const title of [
    "SEARCH / Notes!",
    "Search notes-2",
    "Search notes",
    "Search notes",
  ]) {
    await engine.handle({
      type: "plan.submit",
      yaml: yaml.replace(
        "title: Search notes",
        `title: ${JSON.stringify(title)}`,
      ),
    });
    const planId = engine.state.plans.at(-1)?.id;
    await engine.handle({ type: "plan.sendBack", planId, notes: "Revise it." });
  }
  expect(engine.state.plans.map(({ slug }) => slug)).toEqual([
    "search-notes",
    "search-notes-2",
    "search-notes-3",
    "search-notes-4",
  ]);
});

test.each([
  ["日本語", "plan"],
  ["!!!", "plan"],
  [
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    "abcdefghijklmnopqrstuvwxyz-abcdefghijklm",
  ],
  [`${"a".repeat(39)} tail`, "a".repeat(39)],
  [`${"a".repeat(39)}  tail`, "a".repeat(39)],
])("the slug for %s is %s", async (title, slug) => {
  const engine = engineAt();
  await engine.handle({
    type: "plan.submit",
    yaml: yaml.replace(
      "title: Search notes",
      `title: ${JSON.stringify(title)}`,
    ),
  });
  expect(engine.state.plans[0]?.slug).toBe(slug);
});

test("a truncated slug that collides gets one separator before its suffix", async () => {
  const engine = engineAt();
  for (const title of [`${"a".repeat(39)} one`, `${"a".repeat(39)} two`]) {
    await engine.handle({
      type: "plan.submit",
      yaml: yaml.replace("title: Search notes", `title: ${title}`),
    });
    const planId = engine.state.plans.at(-1)?.id;
    await engine.handle({ type: "plan.sendBack", planId, notes: "Revise it." });
  }
  expect(engine.state.plans.map(({ slug }) => slug)).toEqual([
    "a".repeat(39),
    `${"a".repeat(39)}-2`,
  ]);
});

test("closing and reopening reproduces Plans, approval items and the next sequence", async () => {
  const dbPath = databasePath();
  const engine = engineAt(dbPath);
  await engine.handle({ type: "plan.submit", yaml });
  const planId = engine.state.plans[0]?.id;
  await engine.handle({ type: "plan.sendBack", planId, notes: "Narrow it." });
  await engine.handle({ type: "plan.submit", yaml });
  const before = engine.state;
  await engine.close();
  const reopened = engineAt(dbPath);
  expect(reopened.state).toEqual(before);
  expect(reopened.state.plans.map(({ slug }) => slug)).toEqual([
    "search-notes",
    "search-notes-2",
  ]);
  expect(
    await reopened.handle({
      type: "plan.approve",
      planId: before.plans[1]?.id,
    }),
  ).toEqual({ ok: true, events: [4] });
});

test("a Command arriving during processing is serialized after the current Command", async () => {
  let nested: Promise<unknown> | undefined;
  let engine: Engine;
  let first = true;
  engine = openEngine({
    dbPath: databasePath(),
    clock: {
      now() {
        if (first) {
          first = false;
          nested = engine.handle({ type: "plan.submit", yaml });
        }
        return new Date("2026-10-13T20:00:00.000Z");
      },
    },
  });
  cleanups.push(() => engine.close());
  expect(await engine.handle({ type: "plan.submit", yaml })).toEqual({
    ok: true,
    events: [1],
  });
  expect(await nested).toMatchObject({ ok: false, code: "plan-exists" });
  expect(engine.readEvents()).toHaveLength(1);
});

test("close drains queued Commands in arrival order and rejects later input", async () => {
  const engine = engineAt();
  await engine.handle({ type: "plan.submit", yaml });
  const planId = engine.state.plans[0]?.id;
  const returned = engine.handle({
    type: "plan.sendBack",
    planId,
    notes: "Revise it.",
  });
  const submitted = engine.handle({ type: "plan.submit", yaml });
  const closed = engine.close();
  await expect(engine.handle({ type: "plan.submit", yaml })).rejects.toThrow(
    "closed",
  );
  expect(await returned).toEqual({ ok: true, events: [2] });
  expect(await submitted).toEqual({ ok: true, events: [3] });
  await closed;
});

test("reading a closed Engine throws the closed-Engine error", async () => {
  const engine = engineAt();
  await engine.close();
  expect(() => engine.state).toThrow("The Engine is closed.");
  expect(() => engine.readEvents()).toThrow("The Engine is closed.");
});

test("the queued Command retains the payload received at arrival", async () => {
  const engine = engineAt();
  const command = {
    type: "plan.submit",
    yaml,
    sourcePath: "/plans/original.yaml",
  };
  const result = engine.handle(command);
  command.yaml = "invalid";
  command.sourcePath = "/plans/changed.yaml";
  expect(await result).toEqual({ ok: true, events: [1] });
  expect(engine.state.plans[0]).toMatchObject({
    definition,
    sourcePath: "/plans/original.yaml",
  });
});

test("a failed SQLite write appends nothing, consumes no seq and does not poison the queue", async () => {
  const dbPath = databasePath();
  const engine = engineAt(dbPath);
  const db = new Database(dbPath);
  try {
    db.exec(
      "CREATE TRIGGER fail_write AFTER INSERT ON events BEGIN SELECT RAISE(FAIL, 'write failed'); END",
    );
    await expect(engine.handle({ type: "plan.submit", yaml })).rejects.toThrow(
      "write failed",
    );
    expect(engine.readEvents()).toEqual([]);
    expect(engine.state).toEqual({
      lastSeq: 0,
      plans: [],
      tasks: [],
      runs: [],
      awaiting: [],
      onboarding: { state: "idle" },
    });
    db.exec("DROP TRIGGER fail_write");
    expect(await engine.handle({ type: "plan.submit", yaml })).toEqual({
      ok: true,
      events: [1],
    });
  } finally {
    db.close();
  }
});
