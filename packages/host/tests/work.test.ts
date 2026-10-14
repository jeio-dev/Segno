import { MessageChannel } from "node:worker_threads";
import {
  type AgentAdapter,
  createHostClient,
  type HostClient,
} from "@segno/core";
import {
  type FakeAdapter,
  fakeAdapter,
  tempRepos,
  writesFiles,
} from "@segno/engine/testing";
import { afterEach, expect, test } from "vitest";
import { nodePort, startHost } from "../src/index.js";

// S6: B4's Runs, their live output and the queries that read them.
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

const config = {
  schemaVersion: 1,
  baseBranch: "main",
  tests: { command: "echo tests passed" },
  roles: {
    coder: { adapter: "claude-code", model: "sonnet" },
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

function hostWith(adapters: AgentAdapter[]): HostClient {
  const appData = repos.dir("segno-s6-");
  const host = startHost({ appData, adapters });
  const { port1, port2 } = new MessageChannel();
  host.connect(nodePort(port1));
  const client = createHostClient(nodePort(port2));
  cleanups.push(async () => {
    client.close();
    await host.close();
  });
  return client;
}

/** A configured Project with the two-Task Plan approved. */
async function approvedProject(client: HostClient) {
  const { repo } = repos.repoWithRemote({
    "segno.config.json": `${JSON.stringify(config)}\n`,
  });
  const { id } = await client.projects.add(repo);
  await client.command(id, { type: "plan.submit", yaml });
  const [plan] = await client.query(id, "plans");
  await client.command(id, { type: "plan.approve", planId: plan?.id });
  return { id, repo };
}

/** A Coder that waits for `release()` before writing its file. */
function gatedCoder() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const adapter: FakeAdapter = fakeAdapter({
    coder: async (run) => {
      await gate;
      return writesFiles()(run);
    },
  });
  return { adapter, release };
}

test("runOutput streams a live Run's output, then its end", async () => {
  const { adapter, release } = gatedCoder();
  const client = hostWith([adapter]);
  const { id } = await approvedProject(client);
  await expect.poll(() => adapter.runs.length).toBe(1);
  const runId = adapter.runs[0]?.runId ?? "";

  const items: unknown[] = [];
  let ended!: () => void;
  const end = new Promise<void>((resolve) => {
    ended = resolve;
  });
  await client.runOutput(id, runId, (item) => {
    items.push(item);
    if (item.kind === "end") ended();
  });
  release();
  await end;

  expect(items).toEqual([
    { kind: "output", text: "Writing a.txt\n" },
    { kind: "output", text: "Done.\n" },
    { kind: "end", outcome: "completed" },
  ]);
});

test("runOutput of a finished Run delivers its end at once", async () => {
  const adapter = fakeAdapter();
  const client = hostWith([adapter]);
  const { id } = await approvedProject(client);
  await expect
    .poll(async () =>
      (await client.query(id, "board")).tasks.map(({ state }) => state),
    )
    .toEqual(["done", "done", "done"]);
  const runId = adapter.runs[0]?.runId ?? "";

  const items: unknown[] = [];
  await new Promise<void>((resolve) => {
    void client.runOutput(id, runId, (item) => {
      items.push(item);
      resolve();
    });
  });
  expect(items).toEqual([{ kind: "end", outcome: "completed" }]);
});

test("runOutput of an unknown Run is not-found", async () => {
  const client = hostWith([fakeAdapter()]);
  const { id } = await approvedProject(client);
  await expect(
    client.runOutput(id, "no-such-run", () => {}),
  ).rejects.toMatchObject({
    code: "not-found",
  });
});

test("the board shows each Task's column state, wait reason, current Run and the session meter", async () => {
  const { adapter, release } = gatedCoder();
  const client = hostWith([adapter]);
  const { id } = await approvedProject(client);
  await expect.poll(() => adapter.runs.length).toBe(1);
  const runId = adapter.runs[0]?.runId;

  expect(await client.query(id, "board")).toEqual({
    plan: {
      id: expect.any(String),
      slug: "search-notes",
      title: "Search notes",
      state: "active",
    },
    phase: {
      id: "index",
      title: "Search index",
      state: "active",
      branch: "segno/search-notes/index",
    },
    tasks: [
      {
        id: "a",
        title: "Index notes",
        state: "coding",
        paused: false,
        budgets: { review: 0, test: 0, infra: 0 },
        highRisk: false,
        run: { id: runId, kind: "coder", role: "coder" },
      },
      {
        id: "b",
        title: "Query notes",
        state: "waiting",
        paused: false,
        budgets: { review: 0, test: 0, infra: 0 },
        highRisk: false,
        waitReason: "needs a",
      },
      {
        id: "index-docs",
        title: "Docs and changelog",
        state: "waiting",
        paused: false,
        budgets: { review: 0, test: 0, infra: 0 },
        highRisk: false,
        waitReason: "needs a",
      },
    ],
    mergeQueue: [],
    sessions: { live: 1, concurrency: 1, startedInPhase: 1 },
  });
  release();
});

test("the Task, Run, transcript, prompt and diff queries read a finished Task", async () => {
  const adapter = fakeAdapter();
  const client = hostWith([adapter]);
  const { id } = await approvedProject(client);
  await expect
    .poll(async () =>
      (await client.query(id, "board")).tasks.map(({ state }) => state),
    )
    .toEqual(["done", "done", "done"]);

  const task = await client.query(id, "task", { taskId: "a" });
  expect(task).toMatchObject({
    id: "a",
    state: "done",
    definition: {
      id: "a",
      title: "Index notes",
      acceptance: ["Notes are indexed"],
    },
    budgets: { review: 0, test: 0, infra: 0 },
    highRisk: false,
    verdicts: [{ verdict: { decision: "approve" } }],
  });
  expect(task.history.map(({ to }) => to)).toEqual([
    "coding",
    "testing",
    "reviewing",
    "merging",
    "done",
  ]);
  expect(task.runs.map(({ kind }) => kind)).toEqual([
    "coder",
    "tests",
    "reviewer",
    "merge",
  ]);
  const [coder, tests] = task.runs;

  expect(
    await client.query(id, "run", { runId: tests?.id ?? "" }),
  ).toMatchObject({
    id: tests?.id,
    kind: "tests",
    role: "tests",
    outcome: "completed",
    exitCode: 0,
    startedAt: expect.any(String),
    finishedAt: expect.any(String),
  });
  expect(
    await client.query(id, "runTranscript", { runId: tests?.id ?? "" }),
  ).toBe("tests passed\n");
  const transcript = await client.query(id, "runTranscript", {
    runId: coder?.id ?? "",
  });
  expect(
    transcript
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line).type),
  ).toEqual(["started", "output", "output"]);
  expect(await client.query(id, "runPrompt", { runId: coder?.id ?? "" })).toBe(
    adapter.runs[0]?.prompt,
  );
  // The worktree is gone, so the diff is the one recorded at merge time.
  expect(await client.query(id, "taskDiff", { taskId: "a" })).toEqual({
    diff: [
      "diff --git a/a.txt b/a.txt",
      "new file mode 100644",
      "index 0000000..dc59fbd",
      "--- /dev/null",
      "+++ b/a.txt",
      "@@ -0,0 +1 @@",
      "+Work for a",
      "",
    ].join("\n"),
  });
});

test("the Task and Run queries refuse unknown ids", async () => {
  const client = hostWith([fakeAdapter()]);
  const { id } = await approvedProject(client);
  for (const [name, params] of [
    ["task", { taskId: "nope" }],
    ["taskDiff", { taskId: "nope" }],
    ["run", { runId: "nope" }],
    ["runTranscript", { runId: "nope" }],
    ["runPrompt", { runId: "nope" }],
  ] as const)
    await expect(client.query(id, name, params as never)).rejects.toMatchObject(
      {
        code: "not-found",
      },
    );
});

test("runOutput replays what a live Run printed before the stream opened", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const adapter = fakeAdapter({
    coder: async (run) => {
      await run.output("Before you looked.\n");
      await gate;
      return writesFiles()(run);
    },
  });
  const client = hostWith([adapter]);
  const { id } = await approvedProject(client);
  await expect.poll(() => adapter.runs.length).toBe(1);
  const runId = adapter.runs[0]?.runId ?? "";
  await expect
    .poll(() => client.query(id, "runTranscript", { runId }))
    .toContain("Before you looked.");

  const items: unknown[] = [];
  let ended!: () => void;
  const end = new Promise<void>((resolve) => {
    ended = resolve;
  });
  await client.runOutput(id, runId, (item) => {
    items.push(item);
    if (item.kind === "end") ended();
  });
  release();
  await end;

  expect(items).toEqual([
    { kind: "output", text: "Before you looked.\n" },
    { kind: "output", text: "Writing a.txt\n" },
    { kind: "output", text: "Done.\n" },
    { kind: "end", outcome: "completed" },
  ]);
});
