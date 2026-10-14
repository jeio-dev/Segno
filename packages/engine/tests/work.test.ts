import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  type AgentAdapter,
  resolveConfig,
  type SegnoConfig,
} from "@segno/core";
import { afterEach, expect, test } from "vitest";
import { openEngine } from "../src/index.js";
import {
  type FakeClock,
  fakeAdapter,
  fakeClock,
  gitSync as git,
  runsUntilStopped,
  tempRepos,
  writesFiles,
} from "../src/testing/index.js";

// S3: a Plan worked end to end on a temp repo with a bare remote.
const yaml = `schemaVersion: 1
title: Search notes
summary: Find saved notes.
phases:
  - id: index
    title: Search index
    tasks:
      - id: a
        title: Index notes
        description: Build the index.
        acceptance: [Notes are indexed]
      - id: b
        title: Query notes
        description: Query the index.
        acceptance: [Notes are found]
        dependsOn: [a]
`;

const baseConfig: SegnoConfig = {
  schemaVersion: 1,
  baseBranch: "main",
  tests: { command: "true" },
  roles: {
    coder: { adapter: "claude-code", model: "sonnet", docsModel: "haiku" },
    reviewer: { adapter: "claude-code", model: "opus" },
  },
};

const repos = tempRepos();
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
  repos.dispose();
});

function workEngine({
  adapters = [fakeAdapter()],
  config = {},
  local = {},
  clock = fakeClock(),
}: {
  adapters?: AgentAdapter[];
  config?: Partial<SegnoConfig>;
  local?: { worktreeRoot?: string };
  clock?: FakeClock;
} = {}) {
  const { repo, remote } = repos.repoWithRemote();
  const projectDir = repos.dir("segno-project-");
  const { effective } = resolveConfig({ ...baseConfig, ...config }, local);
  const engine = openEngine({
    dbPath: join(projectDir, "segno.db"),
    clock,
    workspace: { repo, projectDir, config: () => effective, adapters },
  });
  cleanups.push(() => engine.close());
  return { engine, repo, remote, projectDir, clock };
}

async function approvedPlan(engine: ReturnType<typeof openEngine>) {
  await engine.handle({ type: "plan.submit", yaml });
  const [plan] = engine.state.plans;
  if (!plan) throw new Error("The Plan was not submitted.");
  expect(
    await engine.handle({ type: "plan.approve", planId: plan.id }),
  ).toEqual({ ok: true, events: [2] });
  await engine.idle();
  return plan.id;
}

test("approving a Plan cuts its first Phase branch from the remote base and adds the Docs task", async () => {
  // No Adapter is registered, so the Tasks stay where the Phase start put them.
  const { engine, repo } = workEngine({ adapters: [] });
  await approvedPlan(engine);

  const baseSha = git(repo, "rev-parse", "origin/main");
  expect(engine.readEvents().slice(2)).toEqual([
    {
      seq: 3,
      type: "phase.started",
      v: 1,
      ts: "2026-10-13T20:00:00.000Z",
      payload: {
        phaseId: "index",
        branch: "segno/search-notes/index",
        baseSha,
        docsTask: {
          id: "index-docs",
          title: "Docs and changelog",
          description:
            "Update the README and guides to reflect this Phase's behavior changes, and add changelog entries for user-visible changes.",
          acceptance: [
            "README and guides reflect the Phase's behavior changes",
            "Changelog entries exist for user-visible changes",
          ],
          dependsOn: ["a", "b"],
        },
      },
    },
  ]);
  expect(git(repo, "rev-parse", "segno/search-notes/index")).toBe(baseSha);
  expect(engine.state.plans[0]?.phases[0]?.state).toBe("active");
  expect(engine.state.tasks.map(({ id, state }) => ({ id, state }))).toEqual([
    { id: "a", state: "ready" },
    { id: "b", state: "waiting" },
    { id: "index-docs", state: "waiting" },
  ]);
});

test("an unreachable remote defers the Phase start, which the clock retries 5 minutes later", async () => {
  const clock = fakeClock();
  const { engine, repo, remote } = workEngine({ adapters: [], clock });
  git(repo, "remote", "set-url", "origin", join(repos.dir(), "gone.git"));
  await approvedPlan(engine);

  expect(engine.readEvents().slice(2)).toEqual([
    {
      seq: 3,
      type: "phase.startDeferred",
      v: 1,
      ts: "2026-10-13T20:00:00.000Z",
      payload: {
        phaseId: "index",
        reason: "remote-unreachable",
        nextAttemptAt: "2026-10-13T20:05:00.000Z",
      },
    },
  ]);
  expect(engine.state.plans[0]?.phases[0]?.state).toBe("starting");
  expect(git(repo, "branch", "--list", "segno/*")).toBe("");

  git(repo, "remote", "set-url", "origin", remote);
  clock.advance(4 * 60_000 + 59_000);
  await engine.idle();
  expect(engine.readEvents()).toHaveLength(3);

  clock.advance(1_000);
  await engine.idle();
  expect(engine.readEvents().slice(3)).toMatchObject([
    {
      seq: 4,
      type: "phase.started",
      ts: "2026-10-13T20:05:00.000Z",
      payload: { phaseId: "index", branch: "segno/search-notes/index" },
    },
  ]);
});

test("a Task is coded, tested, reviewed and merged onto the Phase branch", async () => {
  const adapter = fakeAdapter();
  const { engine, repo, projectDir } = workEngine({
    adapters: [adapter],
    config: { tests: { command: "test -f a.txt && echo tests passed" } },
  });
  await approvedPlan(engine);

  const a = engine.state.tasks.find(({ id }) => id === "a");
  expect(a?.history.map(({ from, to }) => `${from}→${to}`)).toEqual([
    "ready→coding",
    "coding→testing",
    "testing→reviewing",
    "reviewing→merging",
    "merging→done",
  ]);
  const runs = engine.state.runs.filter(({ taskId }) => taskId === "a");
  expect(
    runs.map(({ kind, role, model, outcome, exitCode }) => ({
      kind,
      role,
      model,
      outcome,
      exitCode,
    })),
  ).toEqual([
    {
      kind: "coder",
      role: "coder",
      model: "sonnet",
      outcome: "completed",
      exitCode: undefined,
    },
    {
      kind: "tests",
      role: "tests",
      model: undefined,
      outcome: "completed",
      exitCode: 0,
    },
    {
      kind: "reviewer",
      role: "reviewer",
      model: "opus",
      outcome: "completed",
      exitCode: undefined,
    },
    {
      kind: "merge",
      role: "none",
      model: undefined,
      outcome: "completed",
      exitCode: undefined,
    },
  ]);

  // The Coder ran in the Task's worktree, outside the repo, with the Run environment.
  const worktree = join(projectDir, "worktrees", "a");
  const [coder] = adapter.runs;
  expect(coder).toMatchObject({
    kind: "coder",
    model: "sonnet",
    cwd: worktree,
    env: {
      SEGNO: "1",
      SEGNO_TASK_ID: "a",
      SEGNO_RUN_ID: runs[0]?.id,
      SEGNO_SLOT: "0",
    },
    transcriptPath: join(
      projectDir,
      "runs",
      runs[0]?.id ?? "",
      "transcript.jsonl",
    ),
  });
  expect(
    readFileSync(
      join(projectDir, "runs", runs[0]?.id ?? "", "prompt.md"),
      "utf8",
    ),
  ).toBe(coder?.prompt);
  expect(
    readFileSync(
      join(projectDir, "runs", runs[1]?.id ?? "", "output.log"),
      "utf8",
    ),
  ).toBe("tests passed\n");

  // The Coder's leftover file landed on the Phase branch with the trailer.
  const phase = "segno/search-notes/index";
  expect(git(repo, "show", `${phase}:a.txt`)).toBe("Work for a");
  expect(
    git(
      repo,
      "log",
      "--format=%s%n%(trailers:key=Segno-Task,valueonly)",
      "-1",
      `${phase}~0`,
      "--",
      "a.txt",
    ),
  ).toBe(`segno: uncommitted changes (${runs[0]?.id})\na`);

  // The worktree and Task branch are gone; the merged diff is kept.
  expect(existsSync(worktree)).toBe(false);
  expect(git(repo, "branch", "--list", `${phase}--a`)).toBe("");
  expect(
    readFileSync(
      join(projectDir, "tasks", "search-notes", "a", "merged.diff"),
      "utf8",
    ),
  ).toContain("+++ b/a.txt\n@@ -0,0 +1 @@\n+Work for a\n");
});

test("every Task, the Docs task last, reaches done and the Phase stays active", async () => {
  const adapter = fakeAdapter();
  const { engine, repo, projectDir } = workEngine({ adapters: [adapter] });
  await approvedPlan(engine);

  expect(engine.state.tasks.map(({ id, state }) => ({ id, state }))).toEqual([
    { id: "a", state: "done" },
    { id: "b", state: "done" },
    { id: "index-docs", state: "done" },
  ]);
  expect(engine.state.plans[0]?.phases[0]?.state).toBe("active");
  // One slot: each Task is worked end to end, in scheduling order [ADR-0051].
  expect(
    adapter.runs.map(({ kind, model, env }) => [
      env.SEGNO_TASK_ID,
      kind,
      model,
    ]),
  ).toEqual([
    ["a", "coder", "sonnet"],
    ["a", "reviewer", "opus"],
    ["b", "coder", "sonnet"],
    ["b", "reviewer", "opus"],
    ["index-docs", "docs", "haiku"],
    ["index-docs", "reviewer", "opus"],
  ]);

  // The Phase branch moved only by fast-forward.
  const phase = "segno/search-notes/index";
  const tips = git(repo, "reflog", "show", "--format=%H", phase)
    .split("\n")
    .reverse();
  expect(tips).toHaveLength(4);
  for (const [older, newer] of tips
    .slice(1)
    .map((tip, index) => [tips[index], tip]))
    expect(() =>
      git(repo, "merge-base", "--is-ancestor", older ?? "", newer ?? ""),
    ).not.toThrow();
  // Every Segno commit on it carries the trailer.
  expect(
    git(
      repo,
      "log",
      "--format=%(trailers:key=Segno-Task,valueonly,separator=)",
      `origin/main..${phase}`,
    ).split("\n"),
  ).toEqual(["index-docs", "b", "a"]);

  // Worktrees and Task branches are gone; every merged diff is kept.
  expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(
    projectDir,
  );
  expect(git(repo, "branch", "--list", `${phase}--*`)).toBe("");
  for (const id of ["a", "b", "index-docs"])
    expect(
      readFileSync(
        join(projectDir, "tasks", "search-notes", id, "merged.diff"),
        "utf8",
      ),
    ).toContain(`+Work for ${id}\n`);
});

test("abandoning an active Plan stops its Run, supersedes unfinished Tasks and deletes their worktrees", async () => {
  const adapter = fakeAdapter({ coder: runsUntilStopped() });
  const { engine, repo, projectDir } = workEngine({ adapters: [adapter] });
  await engine.handle({ type: "plan.submit", yaml });
  const planId = engine.state.plans[0]?.id ?? "";
  await engine.handle({ type: "plan.approve", planId });
  await expect.poll(() => adapter.runs.length).toBe(1);
  const runId = adapter.runs[0]?.runId;

  const result = await engine.handle({
    type: "plan.abandon",
    planId,
    reason: "Priorities changed.",
  });

  const worktree = join(projectDir, "worktrees", "a");
  const branch = "segno/search-notes/index--a";
  expect(result).toMatchObject({ ok: true });
  const seqs = result.ok ? result.events : [];
  expect(
    engine.readEvents().filter(({ seq }) => seqs.includes(seq)),
  ).toMatchObject([
    {
      type: "plan.abandoned",
      payload: { planId, reason: "Priorities changed." },
    },
    { type: "run.finished", payload: { runId, outcome: "stopped" } },
    {
      type: "task.transitioned",
      payload: { taskId: "a", from: "coding", to: "superseded" },
    },
    {
      type: "task.worktreeRemoved",
      payload: { taskId: "a", path: worktree, branch },
    },
    {
      type: "task.transitioned",
      payload: { taskId: "b", from: "waiting", to: "superseded" },
    },
    {
      type: "task.transitioned",
      payload: { taskId: "index-docs", from: "waiting", to: "superseded" },
    },
  ]);
  await engine.idle();
  expect(engine.readEvents().at(-1)?.seq).toBe(Math.max(...seqs));
  expect(existsSync(worktree)).toBe(false);
  expect(git(repo, "branch", "--list", branch)).toBe("");
  // Phase branches are kept.
  expect(git(repo, "branch", "--list", "segno/search-notes/index")).not.toBe(
    "",
  );
});

test("a later Plan reusing an abandoned Plan's Task ids runs to done", async () => {
  const adapter = fakeAdapter({ coder: runsUntilStopped() });
  const { engine } = workEngine({ adapters: [adapter] });
  await engine.handle({ type: "plan.submit", yaml });
  const first = engine.state.plans[0]?.id ?? "";
  await engine.handle({ type: "plan.approve", planId: first });
  await expect.poll(() => adapter.runs.length).toBe(1);
  await engine.handle({ type: "plan.abandon", planId: first, reason: "Redo." });

  const second = fakeAdapter();
  adapter.start = second.start;
  await engine.handle({ type: "plan.submit", yaml });
  const planId = engine.state.plans[1]?.id ?? "";
  await engine.handle({ type: "plan.approve", planId });
  await engine.idle();

  expect(
    engine.state.tasks.map(({ id, planId: plan, state }) => [
      plan === first ? "first" : "second",
      id,
      state,
    ]),
  ).toEqual([
    ["first", "a", "superseded"],
    ["first", "b", "superseded"],
    ["first", "index-docs", "superseded"],
    ["second", "a", "done"],
    ["second", "b", "done"],
    ["second", "index-docs", "done"],
  ]);
});

test("a slug whose branches already exist in the repo is taken", async () => {
  const { engine, repo } = workEngine({ adapters: [] });
  // Left behind by an earlier Event log: a local branch, and one on the remote.
  git(repo, "branch", "segno/search-notes/index", "main");
  git(repo, "push", "-q", "origin", "main:segno/search-notes-2/index");
  git(repo, "fetch", "-q", "origin");

  await engine.handle({ type: "plan.submit", yaml });
  const [plan] = engine.state.plans;
  expect(plan?.slug).toBe("search-notes-3");
  await engine.handle({ type: "plan.approve", planId: plan?.id });
  await engine.idle();
  expect(engine.state.plans[0]?.phases[0]).toMatchObject({
    state: "active",
    branch: "segno/search-notes-3/index",
  });
});

test("two failing test Runs exhaust only the test budget and leave dependents waiting", async () => {
  const { engine } = workEngine({
    config: { tests: { command: "echo broken; exit 1" } },
  });
  await approvedPlan(engine);
  expect(engine.state.tasks[0]).toMatchObject({
    state: "blocked",
    blockReason: "test-limit",
    budgets: { review: 0, test: 2, infra: 0 },
  });
  expect(engine.state.tasks[1]).toMatchObject({ state: "waiting" });
  expect(engine.state.awaiting).toMatchObject([
    { kind: "blocked", taskId: "a" },
  ]);
  expect(engine.state.runs.filter(({ kind }) => kind === "tests")).toHaveLength(
    2,
  );
});

test("two rejects exhaust review budget; the next Coder and re-review receive blocking Findings", async () => {
  const adapter = fakeAdapter({
    reviewer: async () => ({
      kind: "completed",
      sessionId: "review",
      finalText: "",
      structured: {
        schemaVersion: 1,
        decision: "reject",
        summary: "Fix indexing.",
        acceptance: [{ index: 0, met: false, note: "Missing index" }],
        docs: { needed: false, satisfied: true, note: "" },
        findings: [
          {
            severity: "blocking",
            body: "Index the notes",
            file: "a.txt",
            line: 1,
          },
          { severity: "advisory", body: "Optional cleanup" },
        ],
      },
    }),
  });
  const { engine } = workEngine({ adapters: [adapter] });
  await approvedPlan(engine);
  expect(engine.state.tasks[0]).toMatchObject({
    state: "blocked",
    blockReason: "review-limit",
    budgets: { review: 2, test: 0, infra: 0 },
  });
  expect(
    adapter.runs.filter(({ kind }) => kind === "coder")[1]?.prompt,
  ).toContain("a.txt:1: Index the notes");
  expect(
    adapter.runs.filter(({ kind }) => kind === "coder")[1]?.prompt,
  ).not.toContain("Optional cleanup");
  expect(
    adapter.runs.filter(({ kind }) => kind === "reviewer")[1]?.prompt,
  ).toContain("Index the notes");
  expect(
    engine.readEvents().filter(({ type }) => type === "task.findingsClosed"),
  ).toHaveLength(1);
  const events = engine.readEvents();
  const closure = events.find(({ type }) => type === "task.findingsClosed");
  const lastVerdict = events.findLast(
    ({ type }) => type === "verdict.recorded",
  );
  expect(
    closure?.type === "task.findingsClosed" && closure.payload.byVerdictSeq,
  ).toBe(lastVerdict?.seq);
});

test("three crashes retry after 30 seconds and 2 minutes, then block immediately", async () => {
  const adapter = fakeAdapter({
    coder: async () => ({ kind: "crashed", detail: "Process died" }),
  });
  const { engine, clock } = workEngine({ adapters: [adapter] });
  await approvedPlan(engine);
  expect(engine.state.tasks[0]?.budgets).toEqual({
    review: 0,
    test: 0,
    infra: 1,
  });
  clock.advance(29_999);
  await engine.idle();
  expect(adapter.runs).toHaveLength(1);
  clock.advance(1);
  await engine.idle();
  expect(adapter.runs).toHaveLength(2);
  expect(engine.state.tasks[0]?.budgets.infra).toBe(2);
  clock.advance(119_999);
  await engine.idle();
  expect(adapter.runs).toHaveLength(2);
  clock.advance(1);
  await engine.idle();
  expect(engine.state.tasks[0]).toMatchObject({
    state: "blocked",
    blockReason: "infra-limit",
    budgets: { review: 0, test: 0, infra: 3 },
  });
  clock.advance(300_000);
  await engine.idle();
  expect(adapter.runs).toHaveLength(3);
});

test("three malformed Verdicts use infra, resume with validation errors, and block verdict-invalid", async () => {
  const adapter = fakeAdapter({
    reviewer: async () => ({
      kind: "completed",
      sessionId: "review-session",
      finalText: "not a verdict",
    }),
  });
  const { engine, clock } = workEngine({ adapters: [adapter] });
  await approvedPlan(engine);
  expect(engine.state.tasks[0]?.budgets).toEqual({
    review: 0,
    test: 0,
    infra: 1,
  });
  clock.advance(30_000);
  await engine.idle();
  const reviews = adapter.runs.filter(({ kind }) => kind === "reviewer");
  const first = engine.state.runs.find(({ kind }) => kind === "reviewer");
  expect(reviews[1]?.resumeSessionId).toBe(first?.sessionId);
  expect(reviews[1]?.prompt).toContain("Repair");
  expect(reviews[1]?.prompt).toContain("## Shell");
  expect(reviews[1]?.prompt).toContain("validation errors");
  clock.advance(120_000);
  await engine.idle();
  expect(engine.state.tasks[0]).toMatchObject({
    state: "blocked",
    blockReason: "verdict-invalid",
    budgets: { review: 0, test: 0, infra: 3 },
  });
  expect(
    engine.readEvents().filter(({ type }) => type === "verdict.malformed"),
  ).toHaveLength(3);
  expect(
    engine.readEvents().filter(({ type }) => type === "verdict.recorded"),
  ).toHaveLength(0);
});

const approval = {
  schemaVersion: 1,
  decision: "approve",
  summary: "Good",
  acceptance: [{ index: 0, met: true, note: "OK" }],
  docs: { needed: false, satisfied: true, note: "" },
  findings: [],
};
test.each([
  { ...approval, acceptance: [] },
  {
    ...approval,
    acceptance: [
      { index: 0, met: true, note: "" },
      { index: 0, met: true, note: "" },
    ],
  },
  { ...approval, acceptance: [{ index: 1, met: true, note: "" }] },
  { ...approval, acceptance: [{ index: 0, met: false, note: "" }] },
  { ...approval, docs: { needed: true, satisfied: false, note: "" } },
  { ...approval, findings: [{ severity: "blocking", body: "Must fix" }] },
  { ...approval, decision: "reject" },
])(
  "inconsistent Verdict %# uses infra instead of approving or rejecting",
  async (structured) => {
    const adapter = fakeAdapter({
      reviewer: async () => ({
        kind: "completed",
        sessionId: "r",
        finalText: "",
        structured,
      }),
    });
    const { engine } = workEngine({ adapters: [adapter] });
    await approvedPlan(engine);
    expect(engine.state.tasks[0]).toMatchObject({
      state: "reviewing",
      budgets: { review: 0, test: 0, infra: 1 },
      verdicts: [],
    });
    expect(
      engine.readEvents().filter(({ type }) => type === "verdict.malformed"),
    ).toHaveLength(1);
  },
);

test("three failed setup Runs exhaust infra with setup-failed before any Coder starts", async () => {
  const adapter = fakeAdapter();
  const { engine, clock } = workEngine({
    adapters: [adapter],
    config: { setup: { command: "exit 1" } },
  });
  await approvedPlan(engine);
  expect(engine.state.tasks[0]?.budgets.infra).toBe(1);
  clock.advance(30_000);
  await engine.idle();
  clock.advance(120_000);
  await engine.idle();
  expect(engine.state.tasks[0]).toMatchObject({
    state: "blocked",
    blockReason: "setup-failed",
    budgets: { review: 0, test: 0, infra: 3 },
  });
  expect(adapter.runs).toHaveLength(0);
});

test.each(["timeout", "hung"] as const)(
  "a Coder %s stops the Run and uses infra",
  async (outcome) => {
    const adapter = fakeAdapter({ coder: runsUntilStopped() });
    const { engine, clock } = workEngine({
      adapters: [adapter],
      config: {
        roles: {
          ...baseConfig.roles,
          coder: {
            ...baseConfig.roles.coder,
            timeoutMin: outcome === "timeout" ? 1 : 45,
          },
        },
        idleTimeoutMin: outcome === "hung" ? 1 : 10,
      },
    });
    await engine.handle({ type: "plan.submit", yaml });
    await engine.handle({
      type: "plan.approve",
      planId: engine.state.plans[0]?.id,
    });
    await expect.poll(() => adapter.runs.length).toBe(1);
    await expect.poll(() => engine.state.runs[0]?.sessionId).toBeDefined();
    clock.advance(60_000);
    await expect.poll(() => engine.state.runs[0]?.outcome).toBe(outcome);
    await engine.idle();
    expect(engine.state.tasks[0]?.budgets).toEqual({
      review: 0,
      test: 0,
      infra: 1,
    });
  },
);

test.each(["plan", "verdict"])(
  "a Task made high-risk by %s is held until approved",
  async (source) => {
    const adapter = fakeAdapter({
      reviewer: async () => ({
        kind: "completed",
        sessionId: "r",
        finalText: "",
        structured: {
          ...approval,
          ...(source === "verdict"
            ? { risk: [{ flag: "security", reason: "Sensitive" }] }
            : {}),
        },
      }),
    });
    const { engine, repo } = workEngine({ adapters: [adapter] });
    await engine.handle({
      type: "plan.submit",
      yaml:
        source === "plan"
          ? yaml.replace(
              "        acceptance: [Notes are indexed]",
              "        acceptance: [Notes are indexed]\n        risk: { flags: [security], reason: Sensitive }",
            )
          : yaml,
    });
    await engine.handle({
      type: "plan.approve",
      planId: engine.state.plans[0]?.id,
    });
    await engine.idle();
    expect(engine.state.tasks[0]).toMatchObject({
      state: "held",
      highRisk: true,
    });
    expect(engine.state.awaiting).toMatchObject([
      { kind: "merge-hold", taskId: "a" },
    ]);
    expect(
      await engine.handle({ type: "task.approve", taskId: "a" }),
    ).toMatchObject({ ok: true });
    await engine.idle();
    expect(engine.state.tasks[0]?.state).toBe("done");
    expect(git(repo, "show", "segno/search-notes/index:a.txt")).toBe(
      "Work for a",
    );
    expect(engine.state.awaiting.some(({ taskId }) => taskId === "a")).toBe(
      false,
    );
  },
);

test("Send back requires notes, adds a blocking developer Finding and uses no budget", async () => {
  const adapter = fakeAdapter();
  const { engine } = workEngine({ adapters: [adapter] });
  await engine.handle({
    type: "plan.submit",
    yaml: yaml.replace(
      "        acceptance: [Notes are indexed]",
      "        acceptance: [Notes are indexed]\n        risk: { flags: [security], reason: Sensitive }",
    ),
  });
  await engine.handle({
    type: "plan.approve",
    planId: engine.state.plans[0]?.id,
  });
  await engine.idle();
  const seq = engine.state.lastSeq;
  expect(
    await engine.handle({ type: "task.sendBack", taskId: "a", notes: " " }),
  ).toMatchObject({ ok: false, code: "notes-required" });
  expect(engine.state.lastSeq).toBe(seq);
  expect(
    await engine.handle({
      type: "task.sendBack",
      taskId: "a",
      notes: "Protect private notes",
    }),
  ).toMatchObject({ ok: true });
  await engine.idle();
  expect(
    adapter.runs.filter(({ kind }) => kind === "coder")[1]?.prompt,
  ).toContain("Protect private notes");
  expect(engine.state.tasks[0]).toMatchObject({
    state: "held",
    budgets: { review: 0, test: 0, infra: 0 },
  });
  expect(engine.state.tasks[0]?.findings).toMatchObject([
    {
      source: "developer",
      severity: "blocking",
      body: "Protect private notes",
      open: false,
    },
  ]);
});

test("a failing test passes its last 200 lines and full log path to the next Coder", async () => {
  const adapter = fakeAdapter();
  const { engine, projectDir } = workEngine({
    adapters: [adapter],
    config: {
      tests: {
        command:
          "i=1; while [ $i -le 205 ]; do echo line-$i; i=$((i+1)); done; exit 1",
      },
    },
  });
  await approvedPlan(engine);
  const prompt =
    adapter.runs.filter(({ kind }) => kind === "coder")[1]?.prompt ?? "";
  const testRun = engine.state.runs.find(({ kind }) => kind === "tests");
  expect(prompt).toContain(
    join(projectDir, "runs", testRun?.id ?? "", "output.log"),
  );
  expect(prompt).toContain("line-6\n");
  expect(prompt).toContain("line-205");
  expect(prompt).not.toContain("line-5\n");
});

async function heldPlan(engine: ReturnType<typeof openEngine>) {
  await engine.handle({
    type: "plan.submit",
    yaml: yaml.replace(
      "        acceptance: [Notes are indexed]",
      "        acceptance: [Notes are indexed]\n        risk: { flags: [security], reason: Sensitive }",
    ),
  });
  await engine.handle({
    type: "plan.approve",
    planId: engine.state.plans[0]?.id,
  });
  await engine.idle();
}
function advancePhase(repo: string, files: Record<string, string>) {
  const path = repos.dir();
  git(repo, "worktree", "add", path, "segno/search-notes/index");
  for (const [file, body] of Object.entries(files))
    writeFileSync(join(path, file), body);
  git(path, "add", ".");
  git(path, "commit", "-m", "Concurrent work");
  git(repo, "worktree", "remove", path);
}

test("a merge conflict returns to coding with conflicting files, then tests and reviews the resolution", async () => {
  const adapter = fakeAdapter();
  const { engine, repo } = workEngine({ adapters: [adapter] });
  await heldPlan(engine);
  advancePhase(repo, { "a.txt": "Concurrent edit\n" });
  await engine.handle({ type: "task.approve", taskId: "a" });
  await engine.idle();
  expect(
    adapter.runs.filter(({ kind }) => kind === "coder")[1]?.prompt,
  ).toContain("## Conflicting files\n\na.txt");
  expect(
    engine.readEvents().filter(({ type }) => type === "merge.conflicted"),
  ).toMatchObject([{ payload: { taskId: "a", files: ["a.txt"] } }]);
  expect(engine.state.tasks[0]).toMatchObject({
    state: "held",
    budgets: { review: 0, test: 0, infra: 0 },
  });
  await engine.handle({ type: "task.approve", taskId: "a" });
  await engine.idle();
  expect(engine.state.tasks[0]?.state).toBe("done");
});

test("a merge re-test failure uses test budget and returns its log to coding", async () => {
  const adapter = fakeAdapter();
  const { engine, repo } = workEngine({
    adapters: [adapter],
    config: {
      tests: {
        command:
          "test ! -f break-tests || { echo combined-code-failed; exit 1; }",
      },
    },
  });
  await heldPlan(engine);
  advancePhase(repo, { "break-tests": "break\n" });
  await engine.handle({ type: "task.approve", taskId: "a" });
  await engine.idle();
  expect(
    adapter.runs.filter(({ kind }) => kind === "coder")[1]?.prompt,
  ).toContain("combined-code-failed");
  expect(engine.state.tasks[0]).toMatchObject({
    state: "blocked",
    blockReason: "test-limit",
    budgets: { review: 0, test: 2, infra: 0 },
  });
});

test.each(["tests", "setup"] as const)(
  "a %s timeout stops the script process group and consumes the right budget",
  async (kind) => {
    const { engine, clock } = workEngine({
      config: {
        tests: {
          command: kind === "tests" ? "sleep 1000" : "true",
          timeoutMin: 1,
        },
        ...(kind === "setup" ? { setup: { command: "sleep 1000" } } : {}),
      },
    });
    await engine.handle({ type: "plan.submit", yaml });
    await engine.handle({
      type: "plan.approve",
      planId: engine.state.plans[0]?.id,
    });
    await expect
      .poll(() =>
        engine.state.runs.some((run) => run.kind === kind && !run.outcome),
      )
      .toBe(true);
    clock.advance(60_000);
    await expect
      .poll(() => engine.state.runs.find((run) => run.kind === kind)?.outcome)
      .toBe("timeout");
    expect(engine.state.tasks[0]?.budgets).toEqual(
      kind === "tests"
        ? { review: 0, test: 1, infra: 0 }
        : { review: 0, test: 0, infra: 1 },
    );
  },
);

test.each(["timeout", "hung"] as const)(
  "onboarding %s removes its scratch worktree and uses no Task budget",
  async (outcome) => {
    const { repo } = repos.repoWithRemote();
    const projectDir = repos.dir();
    const clock = fakeClock();
    const adapter = fakeAdapter({ onboarding: runsUntilStopped() });
    const { effective } = resolveConfig({
      ...baseConfig,
      idleTimeoutMin: outcome === "hung" ? 1 : 30,
      roles: {
        ...baseConfig.roles,
        planner: {
          adapter: "claude-code",
          model: "opus",
          timeoutMin: outcome === "timeout" ? 1 : 20,
        },
      },
    });
    const engine = openEngine({
      dbPath: join(projectDir, "segno.db"),
      clock,
      isOnboarded: () => false,
      configStore: {
        prepareOnboarding: async () => ({ errors: [] }),
        writeOnboarding: async () => {},
        discardPending: async () => {},
        reload: async () => {},
      },
      workspace: {
        repo,
        projectDir,
        config: () => effective,
        adapters: [adapter],
        onboarding: async () => ({
          adapter: "claude-code",
          model: "opus",
          timeoutMin: outcome === "timeout" ? 1 : 20,
          idleTimeoutMin: outcome === "hung" ? 1 : 30,
          remote: "origin",
          baseBranch: "main",
          guess: {},
        }),
      },
    });
    cleanups.push(() => engine.close());
    await engine.handle({ type: "onboarding.start" });
    await expect.poll(() => engine.state.runs[0]?.sessionId).toBeDefined();
    clock.advance(60_000);
    await expect
      .poll(() => engine.state.onboarding)
      .toMatchObject({ state: "failed", failure: { reason: outcome } });
    expect(engine.state.runs[0]?.outcome).toBe(outcome);
    expect(existsSync(adapter.runs[0]?.cwd ?? "")).toBe(false);
    expect(
      engine.readEvents().some(({ type }) => type === "task.budgetUsed"),
    ).toBe(false);
  },
);

test.each(["launch", "commit"])(
  "a %s failure consumes infra and retries the failed step",
  async (failure) => {
    const adapter = fakeAdapter(
      failure === "commit"
        ? {
            coder: async (run) => {
              const result = await writesFiles()(run);
              git(run.spec.cwd, "config", "commit.gpgSign", "true");
              git(
                run.spec.cwd,
                "config",
                "gpg.program",
                "/nonexistent/segno-gpg",
              );
              return result;
            },
          }
        : {},
    );
    if (failure === "launch")
      adapter.start = () => {
        throw new Error("Cannot spawn agent");
      };
    const { engine, clock } = workEngine({ adapters: [adapter] });
    await approvedPlan(engine);
    expect(engine.state.tasks[0]?.budgets.infra).toBe(1);
    clock.advance(30_000);
    await engine.idle();
    clock.advance(120_000);
    await engine.idle();
    expect(engine.state.tasks[0]).toMatchObject({
      state: "blocked",
      blockReason: "infra-limit",
      budgets: { review: 0, test: 0, infra: 3 },
    });
  },
);

test("a merge timeout stops git and uses infra", async () => {
  const { engine, repo, clock } = workEngine({
    config: { tests: { command: "true", timeoutMin: 1 } },
  });
  await heldPlan(engine);
  advancePhase(repo, { "other.txt": "Other work\n" });
  const lock = git(
    engine.state.tasks[0]?.worktree?.path ?? "",
    "rev-parse",
    "--git-path",
    "index.lock",
  );
  const hook = join(repo, ".git/hooks/pre-commit");
  writeFileSync(
    hook,
    `#!/bin/sh\ntouch ${lock}\ntouch ${repo}/.git/merge-hook-ready\nsleep 3\nrm -f ${lock}\n`,
  );
  chmodSync(hook, 0o755);
  await engine.handle({ type: "task.approve", taskId: "a" });
  await expect
    .poll(() =>
      engine.state.runs.some((run) => run.kind === "merge" && !run.outcome),
    )
    .toBe(true);
  await expect
    .poll(() => existsSync(join(repo, ".git/merge-hook-ready")))
    .toBe(true);
  clock.advance(60_000);
  await expect
    .poll(
      () => engine.state.runs.find(({ kind }) => kind === "merge")?.outcome,
      { timeout: 1800 },
    )
    .toBe("timeout");
  await engine.idle();
  expect(engine.state.runs.find(({ kind }) => kind === "merge")?.outcome).toBe(
    "timeout",
  );
  expect(engine.state.tasks[0]?.budgets).toEqual({
    review: 0,
    test: 0,
    infra: 1,
  });
  expect(existsSync(lock)).toBe(false);
  unlinkSync(hook);
  clock.advance(30_000);
  await engine.idle();
  expect(engine.state.tasks[0]?.state).toBe("done");
});

test("a repaired Verdict is preserved on disk and a non-resuming Adapter gets a fresh review with errors and shell context", async () => {
  let attempt = 0;
  const adapter = fakeAdapter({
    reviewer: async (run) => ({
      kind: "completed",
      sessionId: "r",
      finalText: "",
      structured:
        ++attempt === 1
          ? {}
          : {
              ...approval,
              acceptance:
                run.spec.env.SEGNO_TASK_ID === "index-docs"
                  ? [
                      { index: 0, met: true, note: "OK" },
                      { index: 1, met: true, note: "OK" },
                    ]
                  : approval.acceptance,
            },
    }),
  });
  Object.assign(adapter.capabilities, { resume: false });
  const { engine, clock, projectDir } = workEngine({ adapters: [adapter] });
  await approvedPlan(engine);
  clock.advance(30_000);
  await engine.idle();
  const repaired = adapter.runs.filter(({ kind }) => kind === "reviewer")[1];
  expect(repaired?.resumeSessionId).toBeUndefined();
  expect(repaired?.prompt).toContain("## Acceptance criteria");
  expect(repaired?.prompt).toContain("## Shell");
  expect(repaired?.prompt).toContain("validation errors");
  expect(engine.state.tasks[0]).toMatchObject({
    state: "done",
    budgets: { review: 0, test: 0, infra: 1 },
  });
  expect(
    JSON.parse(
      readFileSync(
        join(projectDir, "runs", repaired?.runId ?? "", "verdict.json"),
        "utf8",
      ),
    ),
  ).toEqual(approval);
});

test("approving a held Task waits for the current slot holder before merging", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const adapter = fakeAdapter({
    coder: async (run) => {
      if (run.spec.env.SEGNO_TASK_ID === "b")
        await Promise.race([gate, run.stopped]);
      return writesFiles()(run);
    },
  });
  const { engine } = workEngine({ adapters: [adapter] });
  await engine.handle({
    type: "plan.submit",
    yaml: yaml
      .replace("        dependsOn: [a]\n", "")
      .replace(
        "        acceptance: [Notes are indexed]",
        "        acceptance: [Notes are indexed]\n        risk: { flags: [security], reason: Sensitive }",
      ),
  });
  await engine.handle({
    type: "plan.approve",
    planId: engine.state.plans[0]?.id,
  });
  await expect
    .poll(() => adapter.runs.some(({ env }) => env.SEGNO_TASK_ID === "b"))
    .toBe(true);
  await engine.handle({ type: "task.approve", taskId: "a" });
  // A subsequent Command is queued behind the scheduler input.
  await engine.handle({ type: "task.approve", taskId: "missing" });
  const premature = engine.state.runs.some(
    ({ taskId, kind }) => taskId === "a" && kind === "merge",
  );
  release();
  await engine.idle();
  expect(premature).toBe(false);
  expect(engine.state.tasks.map(({ state }) => state)).toEqual([
    "done",
    "done",
    "done",
  ]);
});

test("a test script ignoring SIGTERM is killed before a retry can overlap it", async () => {
  const { engine, clock } = workEngine({
    config: {
      tests: { command: "trap '' TERM; echo ready; sleep 3", timeoutMin: 1 },
    },
  });
  await engine.handle({ type: "plan.submit", yaml });
  await engine.handle({
    type: "plan.approve",
    planId: engine.state.plans[0]?.id,
  });
  await expect
    .poll(() => engine.state.runs.find(({ kind }) => kind === "tests")?.id)
    .toBeDefined();
  const run = engine.state.runs.find(({ kind }) => kind === "tests");
  const output: string[] = [];
  const unwatch = engine.watchRun(run?.id ?? "", (item) => {
    if (item.kind === "output") output.push(item.text);
  });
  await expect.poll(() => output.join("")).toContain("ready");
  clock.advance(60_000);
  await expect
    .poll(() => engine.state.runs.find(({ id }) => id === run?.id)?.outcome, {
      timeout: 1800,
    })
    .toBe("timeout");
  unwatch();
});

test("Reviewer-raised risk survives Send back and reaches the re-review context", async () => {
  let reviews = 0;
  const adapter = fakeAdapter({
    reviewer: async () => ({
      kind: "completed",
      sessionId: "r",
      finalText: "",
      structured: {
        ...approval,
        ...(reviews++ === 0
          ? { risk: [{ flag: "security", reason: "Private notes" }] }
          : {}),
      },
    }),
  });
  const { engine } = workEngine({ adapters: [adapter] });
  await approvedPlan(engine);
  await engine.handle({
    type: "task.sendBack",
    taskId: "a",
    notes: "Check access",
  });
  await engine.idle();
  expect(engine.state.tasks[0]).toMatchObject({
    state: "held",
    highRisk: true,
  });
  expect(
    adapter.runs.filter(({ kind }) => kind === "reviewer")[1]?.prompt,
  ).toContain("security: Private notes");
});

test("an agent timeout waits for stop to finish before recording the outcome", async () => {
  let release!: () => void;
  const stopped = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fake = fakeAdapter({ coder: runsUntilStopped() });
  let stopping = false;
  const adapter: AgentAdapter = {
    ...fake,
    start(spec) {
      const handle = fake.start(spec);
      return {
        ...handle,
        stop: async () => {
          stopping = true;
          await handle.stop();
          await stopped;
        },
      };
    },
  };
  const { engine, clock } = workEngine({
    adapters: [adapter],
    config: { idleTimeoutMin: 1 },
  });
  await engine.handle({ type: "plan.submit", yaml });
  await engine.handle({
    type: "plan.approve",
    planId: engine.state.plans[0]?.id,
  });
  await expect.poll(() => engine.state.runs[0]?.sessionId).toBeDefined();
  clock.advance(60_000);
  await expect.poll(() => stopping).toBe(true);
  // Let the adapter result and queued inputs drain without awaiting the live Run.
  await engine.handle({ type: "task.approve", taskId: "missing" });
  await engine.handle({ type: "task.approve", taskId: "missing" });
  const premature = engine.state.runs[0]?.outcome;
  release();
  await engine.idle();
  expect(premature).toBeUndefined();
  expect(engine.state.runs[0]?.outcome).toBe("hung");
});

test("a rejected Docs task receives its blocking Findings on the next pass", async () => {
  const adapter = fakeAdapter({
    reviewer: async (run) => ({
      kind: "completed",
      sessionId: "r",
      finalText: "",
      structured:
        run.spec.env.SEGNO_TASK_ID === "index-docs"
          ? {
              ...approval,
              decision: "reject",
              acceptance: [
                { index: 0, met: true, note: "" },
                { index: 1, met: false, note: "" },
              ],
              findings: [
                { severity: "blocking", body: "Document the search syntax" },
              ],
            }
          : approval,
    }),
  });
  const { engine } = workEngine({ adapters: [adapter] });
  await approvedPlan(engine);
  expect(engine.state.tasks[2]).toMatchObject({
    state: "blocked",
    blockReason: "review-limit",
  });
  expect(
    adapter.runs.filter(({ kind }) => kind === "docs")[1]?.prompt,
  ).toContain("Document the search syntax");
});

test("a worktree creation failure is backed off and exhausts infra rather than leaving a ready Task stuck", async () => {
  const root = join(repos.dir(), "not-a-directory");
  writeFileSync(root, "occupied");
  const { engine, clock } = workEngine({ local: { worktreeRoot: root } });
  await approvedPlan(engine);
  expect(engine.state.tasks[0]?.budgets.infra).toBe(1);
  clock.advance(29_999);
  await engine.idle();
  expect(engine.state.tasks[0]?.budgets.infra).toBe(1);
  clock.advance(1);
  await engine.idle();
  expect(engine.state.tasks[0]?.budgets.infra).toBe(2);
  clock.advance(120_000);
  await engine.idle();
  expect(engine.state.tasks[0]).toMatchObject({
    state: "blocked",
    blockReason: "infra-limit",
    budgets: { review: 0, test: 0, infra: 3 },
  });
});

test("two held Tasks sent back together are worked one at a time without deadlocking", async () => {
  const { engine } = workEngine();
  const independent = yaml
    .replace("        dependsOn: [a]\n", "")
    .replaceAll(
      /( {8}acceptance: \[[^\n]+\]\n)/g,
      "$1        risk: { flags: [security], reason: Sensitive }\n",
    );
  await engine.handle({ type: "plan.submit", yaml: independent });
  await engine.handle({
    type: "plan.approve",
    planId: engine.state.plans[0]?.id,
  });
  await engine.idle();
  expect(engine.state.tasks.slice(0, 2).map(({ state }) => state)).toEqual([
    "held",
    "held",
  ]);
  await Promise.all([
    engine.handle({ type: "task.sendBack", taskId: "a", notes: "Check a" }),
    engine.handle({ type: "task.sendBack", taskId: "b", notes: "Check b" }),
  ]);
  await engine.idle();
  expect(engine.state.tasks.slice(0, 2).map(({ state }) => state)).toEqual([
    "held",
    "held",
  ]);
});

test("git failures while preparing an infra retry consume the remaining infra budget", async () => {
  const adapter = fakeAdapter({
    reviewer: async () => ({ kind: "crashed", detail: "Process died" }),
  });
  const { engine, repo, clock } = workEngine({ adapters: [adapter] });
  await approvedPlan(engine);
  git(repo, "branch", "-D", "segno/search-notes/index");
  clock.advance(30_000);
  await engine.idle();
  expect(engine.state.tasks[0]?.budgets.infra).toBe(2);
  clock.advance(120_000);
  await engine.idle();
  expect(engine.state.tasks[0]).toMatchObject({
    state: "blocked",
    blockReason: "infra-limit",
    budgets: { review: 0, test: 0, infra: 3 },
  });
});

test("a failed launch preparation removes its newly created worktree so the next start can succeed", async () => {
  const adapter = fakeAdapter();
  const { engine, repo, projectDir, clock } = workEngine({
    adapters: [adapter],
  });
  const runs = join(projectDir, "runs");
  writeFileSync(runs, "Temporarily unavailable");
  await approvedPlan(engine);
  expect(engine.state.tasks[0]?.budgets.infra).toBe(1);
  expect(adapter.runs).toHaveLength(0);
  expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(
    join(projectDir, "worktrees", "a"),
  );
  expect(git(repo, "branch", "--list", "segno/search-notes/index--a")).toBe("");
  unlinkSync(runs);
  clock.advance(30_000);
  await engine.idle();
  expect(engine.state.tasks[0]).toMatchObject({
    state: "done",
    budgets: { review: 0, test: 0, infra: 1 },
  });
});

test.each(["crashed", "timeout"] as const)(
  "a conflict-resolution Coder %s retry still receives the unresolved files",
  async (outcome) => {
    let coderRuns = 0;
    const adapter = fakeAdapter({
      coder: async (run) =>
        ++coderRuns === 2
          ? outcome === "crashed"
            ? { kind: "crashed", detail: "Lost Coder" }
            : runsUntilStopped()(run)
          : writesFiles()(run),
    });
    const { engine, repo, clock } = workEngine({
      adapters: [adapter],
      config: {
        roles: {
          ...baseConfig.roles,
          coder: { ...baseConfig.roles.coder, timeoutMin: 1 },
        },
      },
    });
    await heldPlan(engine);
    advancePhase(repo, { "a.txt": "Concurrent edit\n" });
    await engine.handle({ type: "task.approve", taskId: "a" });
    if (outcome === "timeout") {
      await expect
        .poll(() => adapter.runs.filter(({ kind }) => kind === "coder").length)
        .toBe(2);
      clock.advance(60_000);
    }
    await engine.idle();
    expect(engine.state.tasks[0]).toMatchObject({
      state: "coding",
      budgets: { infra: 1 },
    });
    clock.advance(30_000);
    await engine.idle();
    const coders = adapter.runs.filter(({ kind }) => kind === "coder");
    expect(coders[1]?.prompt).toContain("## Conflicting files\n\na.txt");
    expect(coders[2]?.prompt).toContain("## Conflicting files\n\na.txt");
    expect(engine.state.tasks[0]?.state).toBe("held");
  },
);

test("a sent-back Coder preparation failure consumes infra and respects backoff", async () => {
  const adapter = fakeAdapter();
  const { engine, projectDir, clock } = workEngine({ adapters: [adapter] });
  await heldPlan(engine);
  const runs = join(projectDir, "runs");
  const saved = join(projectDir, "saved-runs");
  renameSync(runs, saved);
  writeFileSync(runs, "Temporarily unavailable");
  await engine.handle({
    type: "task.sendBack",
    taskId: "a",
    notes: "Check the permissions",
  });
  await engine.idle();
  expect(engine.state.tasks[0]).toMatchObject({
    state: "coding",
    budgets: { review: 0, test: 0, infra: 1 },
  });
  clock.advance(29_999);
  await engine.idle();
  expect(engine.state.tasks[0]?.budgets.infra).toBe(1);
  unlinkSync(runs);
  renameSync(saved, runs);
  clock.advance(1);
  await engine.idle();
  expect(engine.state.tasks[0]).toMatchObject({
    state: "held",
    budgets: { review: 0, test: 0, infra: 1 },
  });
  expect(adapter.runs.filter(({ kind }) => kind === "coder")).toHaveLength(2);
});

test("a failed merge preserves an index lock that existed before the Run", async () => {
  const { engine, repo, clock } = workEngine();
  await heldPlan(engine);
  advancePhase(repo, { "other.txt": "Other work\n" });
  const lock = git(
    engine.state.tasks[0]?.worktree?.path ?? "",
    "rev-parse",
    "--git-path",
    "index.lock",
  );
  writeFileSync(lock, "Another git operation owns this lock");
  await engine.handle({ type: "task.approve", taskId: "a" });
  await engine.idle();
  expect(engine.state.tasks[0]?.budgets.infra).toBe(1);
  expect(readFileSync(lock, "utf8")).toBe(
    "Another git operation owns this lock",
  );
  unlinkSync(lock);
  clock.advance(30_000);
  await engine.idle();
  expect(engine.state.tasks[0]?.state).toBe("done");
});
