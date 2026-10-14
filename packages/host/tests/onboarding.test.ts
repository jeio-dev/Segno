import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MessageChannel } from "node:worker_threads";
import {
  type AgentAdapter,
  createHostClient,
  type Event,
  type HostClient,
  type RunSpec,
} from "@segno/core";
import {
  type FakeScript,
  fakeAdapter,
  gitSync,
  proposes,
  runsUntilStopped,
  tempRepos,
} from "@segno/engine/testing";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, expect, test } from "vitest";
import { nodePort, startHost } from "../src/index.js";

// S6: onboarding a Project with the fake Adapter [ADR-0049].
const nodeRepo = {
  "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
  "package-lock.json": "{}",
};

const output = {
  kind: "proposal",
  config: {
    tests: { command: "npm test", timeoutMin: 5 },
    setup: { command: "npm ci" },
    baseBranch: "main",
    coderAllow: ["Bash(npm *)"],
  },
  reasons: {
    "/tests/command": "package.json defines a test script.",
    "/coderAllow/0": "The Coder runs npm to test.",
  },
  checks: [
    { command: "npm ci", purpose: "setup", exitCode: 0, durationSec: 4 },
    { command: "npm test", purpose: "tests", exitCode: 0, durationSec: 2 },
  ],
};

const repos = tempRepos();
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
  repos.dispose();
});

function hostWith(adapters: AgentAdapter[], appData = repos.dir("segno-s6-")) {
  const host = startHost({ appData, adapters });
  const { port1, port2 } = new MessageChannel();
  host.connect(nodePort(port1));
  const client = createHostClient(nodePort(port2));
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= (async () => {
      client.close();
      await host.close();
    })();
    return closing;
  };
  cleanups.push(close);
  return { client, appData, close };
}

/** A not-onboarded Project with the default models. */
async function notOnboarded(client: HostClient) {
  const { repo } = repos.repoWithRemote(nodeRepo);
  const { id } = await client.projects.add(repo, {
    planner: "opus",
    coder: "sonnet",
    reviewer: "opus",
  });
  const events: Event[] = [];
  await client.subscribe(id, 0, (event) => events.push(event));
  return { id, repo, events };
}

/** Where the scratch worktree is and what it was detached at, seen from the Run. */
function observed(script: FakeScript) {
  const seen: { head?: string; branch?: string } = {};
  const wrapped: FakeScript = async (run) => {
    seen.head = gitSync(run.spec.cwd, "rev-parse", "HEAD");
    seen.branch = gitSync(run.spec.cwd, "branch", "--show-current");
    return script(run);
  };
  return { seen, script: wrapped };
}

function worktrees(repo: string) {
  return gitSync(repo, "worktree", "list", "--porcelain");
}

test("Onboard project runs the Planner in a scratch worktree and a valid proposal awaits review, then Confirm writes it", async () => {
  const { seen, script } = observed(proposes(output));
  const adapter = fakeAdapter({ onboarding: script });
  const { client, appData } = hostWith([adapter]);
  const { id, repo, events } = await notOnboarded(client);
  const base = gitSync(repo, "rev-parse", "origin/main");

  expect(await client.command(id, { type: "onboarding.start" })).toEqual({
    ok: true,
    events: [1, 2],
  });
  await expect
    .poll(async () => (await client.query(id, "onboarding")).state)
    .toBe("proposed");

  const [spec] = adapter.runs as RunSpec[];
  const scratch = join(appData, "projects", id, "worktrees", "_onboarding");
  expect(spec).toMatchObject({
    kind: "onboarding",
    model: "opus",
    cwd: scratch,
    systemPrompt: "",
    permissions: {
      read: true,
      edit: true,
      shell: ["*"],
      network: true,
      mcp: false,
      extraAllow: [],
    },
  });
  expect(spec?.env).toEqual({
    SEGNO: "1",
    SEGNO_RUN_ID: spec?.runId,
    SEGNO_SLOT: "0",
  });
  expect(seen).toEqual({ head: base, branch: "" });
  // The scratch worktree is gone once the Run ends.
  expect(existsSync(scratch)).toBe(false);
  expect(worktrees(repo)).not.toContain("_onboarding");

  const guess = {
    tests: { command: "npm test" },
    setup: { command: "npm ci" },
    baseBranch: "main",
    remote: "origin",
    coderAllow: ["Bash(npm *)"],
  };
  expect(
    spec?.prompt,
  ).toBe(`You are onboarding this repo to Segno, in a scratch worktree of its base branch that is deleted afterwards. Propose the config Segno will use to check every Task.

## What Segno detected

A starting guess, to verify rather than trust:

\`\`\`json
${JSON.stringify(guess, null, 2)}
\`\`\`

## Choosing the test command

The test command is the strongest check the repo has, in this order: tests, then typecheck, then build, then lint. Never choose a weaker check because a stronger one fails. Propose the failing check with the \`fails-on-base\` flag, and list what fails in \`failing\`. If the repo has no check at all, propose \`true\` with the \`no-checks\` flag.

## Running the checks

Run the setup command, if the repo needs one, and then the chosen check. Report every command you ran in \`checks\`, with its exit code and its duration in seconds. Set \`tests.timeoutMin\` to the check's duration with headroom. Put what the Coder needs to run the checks itself in \`coderAllow\`, for example \`Bash(npm *)\`.

## Your answer

Answer with a proposal that matches this JSON Schema, with a one-line reason for each value in \`reasons\`, keyed by JSON pointer into \`config\`. If you can't onboard this repo, answer with \`kind: "unable"\` and an \`explanation\` instead.

\`\`\`json
${JSON.stringify(spec?.outputSchema, null, 2)}
\`\`\`
`);
  expect(
    await client.query(id, "runPrompt", { runId: spec?.runId ?? "" }),
  ).toBe(spec?.prompt);
  const valid = new Ajv2020({ strict: false }).compile(
    spec?.outputSchema ?? {},
  );
  expect(valid(output)).toBe(true);
  expect(valid({ kind: "unable", explanation: "No package manifest." })).toBe(
    true,
  );
  expect(valid({ ...output, extra: 1 })).toBe(false);
  expect(valid({ ...output, kind: "maybe" })).toBe(false);

  const config = {
    schemaVersion: 1,
    baseBranch: "main",
    tests: { command: "npm test", timeoutMin: 5 },
    setup: { command: "npm ci" },
    roles: {
      planner: { adapter: "claude-code", model: "opus" },
      coder: {
        adapter: "claude-code",
        model: "sonnet",
        docsModel: "haiku",
        allow: ["Bash(npm *)"],
      },
      reviewer: { adapter: "claude-code", model: "opus" },
    },
  };
  const proposal = {
    config,
    reasons: {
      "/tests/command": "package.json defines a test script.",
      "/roles/coder/allow/0": "The Coder runs npm to test.",
    },
    checks: output.checks,
    ref: "origin/main",
    sha: base,
  };
  expect(await client.query(id, "onboarding")).toEqual({
    state: "proposed",
    runId: spec?.runId,
    proposal,
    detected: expect.anything(),
  });
  const awaiting = await client.query(id, "awaiting");
  expect(awaiting).toEqual([
    {
      id: 5,
      kind: "onboarding-review",
      runId: spec?.runId,
      title: "Review the onboarding proposal",
      createdAt: expect.any(String),
    },
  ]);
  expect(
    events.map(({ type, payload }) =>
      type === "run.finished" ? `${type} ${payload.outcome}` : type,
    ),
  ).toEqual([
    "onboarding.started",
    "run.started",
    "run.sessionStarted",
    "run.finished completed",
    "onboarding.proposed",
  ]);
  expect(events[1]?.payload).toEqual({
    runId: spec?.runId,
    kind: "onboarding",
    role: "planner",
    adapter: "claude-code",
    model: "opus",
  });

  expect(
    await client.command(id, { type: "onboarding.confirm", config }),
  ).toEqual({ ok: true, events: [6] });
  expect(events.at(-1)).toMatchObject({
    type: "onboarding.confirmed",
    payload: { via: "proposal", config },
  });
  expect(
    JSON.parse(readFileSync(join(repo, "segno.config.json"), "utf8")),
  ).toEqual(config);
  expect(await client.query(id, "awaiting")).toEqual([]);
  expect(await client.query(id, "onboarding")).toMatchObject({
    state: "done",
  });
  expect(await client.projects.list()).toEqual([
    expect.objectContaining({ id, status: "running" }),
  ]);
});

test("the onboarding Run uses the local Planner model and a worktree under worktreeRoot", async () => {
  const adapter = fakeAdapter({ onboarding: proposes(output) });
  const { client, appData, close } = hostWith([adapter]);
  const { id } = await notOnboarded(client);
  await close();
  const root = repos.dir("segno-worktrees-");
  writeFileSync(
    join(appData, "projects", id, "local.json"),
    JSON.stringify({
      worktreeRoot: root,
      roles: { planner: { model: "planner-local" } },
    }),
  );
  // Local settings are read when the Engine starts.
  const restarted = hostWith([adapter], appData).client;
  await restarted.command(id, { type: "onboarding.start" });
  await expect
    .poll(async () => (await restarted.query(id, "onboarding")).state)
    .toBe("proposed");
  expect(adapter.runs[0]).toMatchObject({
    model: "planner-local",
    cwd: join(root, id, "_onboarding"),
  });
});

test("an unable answer, invalid output and an invalid config each record onboarding.failed, and Retry starts again", async () => {
  const answers: unknown[] = [
    { kind: "unable", explanation: "The repo has no package manifest." },
    undefined,
    { ...output, checks: "none" },
    { ...output, config: { ...output.config, baseBranch: "trunk" } },
    output,
  ];
  const adapter = fakeAdapter({ onboarding: proposes(() => answers.shift()) });
  const { client } = hostWith([adapter]);
  const { id, repo, events } = await notOnboarded(client);

  const failures: unknown[] = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    expect(
      await client.command(id, { type: "onboarding.start" }),
    ).toMatchObject({ ok: true });
    await expect
      .poll(async () => (await client.query(id, "onboarding")).state)
      .toBe("failed");
    const onboarding = await client.query(id, "onboarding");
    expect(onboarding.runId).toBe(adapter.runs[attempt]?.runId);
    failures.push(onboarding.failure);
    expect(worktrees(repo)).not.toContain("_onboarding");
  }
  expect(failures).toEqual([
    { reason: "unable", detail: "The repo has no package manifest." },
    {
      reason: "invalid-proposal",
      detail: "The Run gave no structured output.",
    },
    {
      reason: "invalid-proposal",
      detail: "The output doesn't match the proposal schema.",
      errors: [expect.objectContaining({ path: "/checks", code: "schema" })],
    },
    {
      reason: "invalid-proposal",
      detail: "The proposed config is invalid.",
      errors: [
        expect.objectContaining({
          file: "segno.config.json",
          path: "/baseBranch",
          code: "unknown-branch",
        }),
      ],
    },
  ]);
  expect(
    events
      .filter(({ type }) => type === "onboarding.failed")
      .map(({ payload }) => payload),
  ).toEqual(
    failures.map((failure, index) => ({
      runId: adapter.runs[index]?.runId,
      ...(failure as object),
    })),
  );
  expect(await client.query(id, "awaiting")).toEqual([]);

  // Retry: onboarding has no budget.
  await client.command(id, { type: "onboarding.start" });
  await expect
    .poll(async () => (await client.query(id, "onboarding")).state)
    .toBe("proposed");
});

test("a Run that crashes records onboarding.failed crashed with its detail", async () => {
  const adapter = fakeAdapter({
    onboarding: async () => ({
      kind: "crashed",
      detail: "claude was killed by SIGKILL.",
    }),
  });
  const { client } = hostWith([adapter]);
  const { id, repo } = await notOnboarded(client);
  await client.command(id, { type: "onboarding.start" });
  await expect
    .poll(async () => (await client.query(id, "onboarding")).failure)
    .toEqual({ reason: "crashed", detail: "claude was killed by SIGKILL." });
  expect(worktrees(repo)).not.toContain("_onboarding");
});

test("a Run that fails keeps its outcome and records onboarding.failed crashed with the CLI's message", async () => {
  const detail = "There's an issue with the selected model (nope).";
  const adapter = fakeAdapter({
    onboarding: async () => ({ kind: "failed", detail, exitCode: 1 }),
  });
  const { client } = hostWith([adapter]);
  const { id, repo, events } = await notOnboarded(client);
  await client.command(id, { type: "onboarding.start" });
  await expect
    .poll(async () => (await client.query(id, "onboarding")).failure)
    .toEqual({ reason: "crashed", detail });
  const runId = adapter.runs[0]?.runId;
  expect(events.slice(-2)).toMatchObject([
    {
      type: "run.finished",
      payload: { runId, outcome: "failed", exitCode: 1, detail },
    },
    {
      type: "onboarding.failed",
      payload: { runId, reason: "crashed", detail },
    },
  ]);
  expect(worktrees(repo)).not.toContain("_onboarding");
});

test("a rate-limited Run records no failure and returns onboarding to idle", async () => {
  const adapter = fakeAdapter({
    onboarding: async () => ({
      kind: "rate-limited",
      resetAt: "2026-10-14T17:00:00.000Z",
      detail: "You've hit your limit · resets 5pm (UTC)",
    }),
  });
  const { client } = hostWith([adapter]);
  const { id, repo, events } = await notOnboarded(client);
  await client.command(id, { type: "onboarding.start" });
  await expect
    .poll(() => events.map(({ type }) => type))
    .toContain("run.finished");
  expect(events.at(-1)).toMatchObject({
    type: "run.finished",
    payload: {
      runId: adapter.runs[0]?.runId,
      outcome: "rate-limited",
      resetAt: "2026-10-14T17:00:00.000Z",
      detail: "You've hit your limit · resets 5pm (UTC)",
    },
  });
  expect(events.some(({ type }) => type === "onboarding.failed")).toBe(false);
  expect(await client.query(id, "onboarding")).toMatchObject({
    state: "idle",
  });
  expect(worktrees(repo)).not.toContain("_onboarding");
  expect(await client.command(id, { type: "onboarding.start" })).toMatchObject({
    ok: true,
  });
});

test("Stop onboarding records run.finished stopped and onboarding.stopped, and removes the scratch worktree", async () => {
  const adapter = fakeAdapter({ onboarding: runsUntilStopped() });
  const { client, appData } = hostWith([adapter]);
  const { id, repo, events } = await notOnboarded(client);
  await client.command(id, { type: "onboarding.start" });
  await expect.poll(() => adapter.runs.length).toBe(1);

  expect(await client.command(id, { type: "onboarding.stop" })).toEqual({
    ok: true,
    events: [4, 5],
  });
  expect(events.slice(-2)).toMatchObject([
    {
      type: "run.finished",
      payload: { runId: adapter.runs[0]?.runId, outcome: "stopped" },
    },
    { type: "onboarding.stopped", payload: { runId: adapter.runs[0]?.runId } },
  ]);
  expect(await client.query(id, "onboarding")).toMatchObject({
    state: "idle",
  });
  expect(
    existsSync(join(appData, "projects", id, "worktrees", "_onboarding")),
  ).toBe(false);
  expect(worktrees(repo)).not.toContain("_onboarding");
});

test("onboarding Commands are rejected invalid-transition when they don't fit", async () => {
  const adapter = fakeAdapter({ onboarding: runsUntilStopped() });
  const { client } = hostWith([adapter]);
  const { id, repo } = await notOnboarded(client);
  const rejected = { ok: false, code: "invalid-transition" };

  expect(await client.command(id, { type: "onboarding.stop" })).toMatchObject(
    rejected,
  );
  await client.command(id, { type: "onboarding.start" });
  await expect.poll(() => adapter.runs.length).toBe(1);
  expect(await client.command(id, { type: "onboarding.start" })).toMatchObject(
    rejected,
  );
  expect(
    await client.command(id, {
      type: "onboarding.confirm",
      config: { baseBranch: "main", tests: { command: "npm test" } },
    }),
  ).toMatchObject(rejected);
  await client.command(id, { type: "onboarding.stop" });

  // A proposal awaiting review.
  const proposing = fakeAdapter({ onboarding: proposes(output) });
  const second = hostWith([proposing]).client;
  const other = await notOnboarded(second);
  await second.command(other.id, { type: "onboarding.start" });
  await expect
    .poll(async () => (await second.query(other.id, "onboarding")).state)
    .toBe("proposed");
  expect(
    await second.command(other.id, { type: "onboarding.start" }),
  ).toMatchObject(rejected);

  // An onboarded Project.
  await second.command(other.id, {
    type: "onboarding.confirm",
    config: (await second.query(other.id, "onboarding")).proposal?.config,
  });
  for (const type of ["onboarding.start", "onboarding.stop"])
    expect(await second.command(other.id, { type })).toMatchObject(rejected);
  expect(worktrees(repo)).not.toContain("_onboarding");
});
