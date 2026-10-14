import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openEngine } from "../dist/index.js";

const dir = mkdtempSync(join(tmpdir(), "segno-check-b2-"));
const dbPath = join(dir, "segno.db");
const yaml = readFileSync(
  new URL("../../../examples/two-phase.yaml", import.meta.url),
  "utf8",
);
let engine;
try {
  engine = openEngine({ dbPath });
  assert.deepEqual(await engine.handle({ type: "plan.submit", yaml }), {
    ok: true,
    events: [1],
  });
  assert.equal(engine.readEvents()[0].type, "plan.submitted");
  assert.equal(engine.state.awaiting[0].kind, "plan-approval");
  assert.equal(engine.state.awaiting[0].id, 1);
  assert.equal(
    (await engine.handle({ type: "plan.submit", yaml })).code,
    "plan-exists",
  );

  let planId = engine.state.plans[0].id;
  assert.deepEqual(
    await engine.handle({
      type: "plan.sendBack",
      planId,
      notes: "Narrow the scope.",
    }),
    { ok: true, events: [2] },
  );
  assert.equal(engine.state.plans[0].state, "returned");
  assert.deepEqual(engine.state.awaiting, []);

  const beforeInvalid = engine.readEvents();
  const invalid = await engine.handle({
    type: "plan.submit",
    yaml: "schemaVersion: 2",
  });
  assert.equal(invalid.code, "validation");
  assert.ok(invalid.errors.length > 0);
  assert.deepEqual(engine.readEvents(), beforeInvalid);

  assert.deepEqual(await engine.handle({ type: "plan.submit", yaml }), {
    ok: true,
    events: [3],
  });
  planId = engine.state.plans[1].id;
  assert.deepEqual(
    await engine.handle({
      type: "plan.abandon",
      planId,
      reason: "Priorities changed.",
    }),
    { ok: true, events: [4] },
  );
  assert.equal(engine.state.plans[1].state, "abandoned");
  assert.deepEqual(engine.state.awaiting, []);

  assert.deepEqual(await engine.handle({ type: "plan.submit", yaml }), {
    ok: true,
    events: [5],
  });
  planId = engine.state.plans[2].id;
  assert.deepEqual(await engine.handle({ type: "plan.approve", planId }), {
    ok: true,
    events: [6],
  });
  assert.equal(engine.state.plans[2].state, "active");
  assert.deepEqual(
    engine.state.plans[2].phases.map(({ state }) => state),
    // Approval starts the first Phase; with no workspace it stays starting.
    ["starting", "pending"],
  );
  assert.deepEqual(engine.state.awaiting, []);
  assert.deepEqual(
    engine.state.plans.map(({ slug }) => slug),
    ["search-saved-notes", "search-saved-notes-2", "search-saved-notes-3"],
  );

  const before = engine.state;
  const events = engine.readEvents();
  await engine.close();
  engine = openEngine({ dbPath });
  assert.deepEqual(engine.state, before);
  assert.deepEqual(engine.readEvents(), events);
  console.log("B2 Event log:");
  for (const event of events) console.log(JSON.stringify(event));
  await engine.close();

  // Corrupt-log fixtures are inputs to S3; observations use startup's public API.
  for (const [type, v] of [
    ["unknown.event", 1],
    ["plan.submitted", 2],
  ]) {
    const unknownPath = join(dir, `unknown-${v}.db`);
    const empty = openEngine({ dbPath: unknownPath });
    await empty.close();
    const db = new Database(unknownPath);
    try {
      db.prepare(
        "INSERT INTO events (seq, type, v, ts, payload) VALUES (1, ?, ?, ?, '{}')",
      ).run(type, v, "2026-10-13T20:00:00.000Z");
    } finally {
      db.close();
    }
    assert.throws(
      () => openEngine({ dbPath: unknownPath }),
      new RegExp(`${type}.*${v}`),
    );
  }
  console.log(
    "B2 exit scenario passed, including replay and unknown type/version refusal.",
  );
} finally {
  if (engine) await engine.close();
  rmSync(dir, { recursive: true, force: true });
}
