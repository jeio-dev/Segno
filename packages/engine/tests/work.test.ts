import { existsSync, readFileSync } from "node:fs";
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
  clock = fakeClock(),
}: {
  adapters?: AgentAdapter[];
  config?: Partial<SegnoConfig>;
  clock?: FakeClock;
} = {}) {
  const { repo, remote } = repos.repoWithRemote();
  const projectDir = repos.dir("segno-project-");
  const { effective } = resolveConfig({ ...baseConfig, ...config });
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
