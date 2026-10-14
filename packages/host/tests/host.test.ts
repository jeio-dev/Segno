import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { MessageChannel } from "node:worker_threads";
import { createHostClient, type HostClient } from "@segno/core";
import Database from "better-sqlite3";
import { afterEach, expect, test } from "vitest";
import { nodePort, startHost } from "../src/index.js";

const twoPhase = readFileSync(
  new URL("../../../examples/two-phase.yaml", import.meta.url),
  "utf8",
);

const models = { planner: "opus", coder: "sonnet", reviewer: "opus" };

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});

function tempDir(prefix = "segno-s6-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A repo with one commit on `main`, pushed to a bare `origin`. */
function repoWithRemote(files: Record<string, string> = {}) {
  const remote = tempDir("segno-remote-");
  git(remote, "init", "-q", "--bare", "-b", "main");
  const repo = tempDir("segno-repo-");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  for (const [name, content] of Object.entries({
    "README.md": "x\n",
    ...files,
  }))
    writeFileSync(join(repo, name), content);
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "initial");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "origin", "main");
  git(repo, "remote", "set-head", "origin", "main");
  return realpathSync(repo);
}

function hostAt(
  appData = tempDir(),
  { ghBinary = join(appData, "no-such-gh") } = {},
): HostClient {
  const host = startHost({ appData, adapters: [], ghBinary });
  const { port1, port2 } = new MessageChannel();
  host.connect(nodePort(port1));
  const client = createHostClient(nodePort(port2));
  cleanups.push(async () => {
    client.close();
    await host.close();
  });
  return client;
}

test("add keeps chosen models pending and leaves an unconfigured repo untouched", async () => {
  const appData = tempDir();
  const client = hostAt(appData);
  const repo = repoWithRemote();
  const { id } = await client.projects.add(repo, {
    planner: "planner-custom",
    coder: "coder-custom",
    reviewer: "reviewer-custom",
  });
  expect(await client.projects.list()).toEqual([
    {
      id,
      name: basename(repo),
      path: repo,
      status: "not-onboarded",
      awaitingCount: 0,
    },
  ]);
  const pending = {
    roles: {
      planner: { model: "planner-custom" },
      coder: { model: "coder-custom", docsModel: "haiku" },
      reviewer: { model: "reviewer-custom" },
    },
  };
  expect(
    JSON.parse(
      readFileSync(join(appData, "projects", id, "pending.json"), "utf8"),
    ),
  ).toEqual(pending);
  expect(await client.query(id, "config")).toEqual({
    effective: null,
    sources: {},
    rejected: null,
    committed: false,
    pending,
  });
  expect(git(repo, "status", "--porcelain")).toBe("");
  expect(existsSync(join(repo, "segno.config.json"))).toBe(false);
});

test("a not-onboarded Project rejects Plan submission without appending an Event", async () => {
  const client = hostAt();
  const { id } = await client.projects.add(repoWithRemote(), {
    planner: "opus",
    coder: "sonnet",
    reviewer: "opus",
  });
  expect(
    await client.command(id, { type: "plan.submit", yaml: twoPhase }),
  ).toMatchObject({ ok: false, code: "not-onboarded" });
  const events: unknown[] = [];
  await client.subscribe(id, 0, (event) => events.push(event));
  await client.query(id, "board");
  expect(events).toEqual([]);
  for (const type of ["onboarding.start", "onboarding.stop"])
    await expect(client.command(id, { type })).rejects.toMatchObject({
      code: "bad-request",
    });
});

test("manual confirmation validates before writing and uses the pending models", async () => {
  const appData = tempDir();
  const client = hostAt(appData);
  const repo = repoWithRemote(nodeRepo);
  const { id } = await client.projects.add(repo, {
    planner: "custom-planner",
    coder: "custom-coder",
    reviewer: "custom-reviewer",
  });
  const events: { type: string; payload: unknown }[] = [];
  await client.subscribe(id, 0, (event) => events.push(event));
  const bad = await client.command(id, {
    type: "onboarding.confirm",
    config: {
      schemaVersion: 1,
      baseBranch: "absent",
      tests: { command: "" },
    },
  });
  expect(bad).toMatchObject({
    ok: false,
    code: "validation",
    errors: expect.arrayContaining([
      expect.objectContaining({
        file: "segno.config.json",
        path: "/baseBranch",
        code: "unknown-branch",
      }),
      expect.objectContaining({
        file: "segno.config.json",
        path: "/tests/command",
        code: "schema",
      }),
    ]),
  });
  expect(git(repo, "status", "--porcelain")).toBe("");
  expect(existsSync(join(appData, "projects", id, "pending.json"))).toBe(true);
  expect(events).toEqual([]);
  const config = {
    schemaVersion: 1,
    baseBranch: "main",
    tests: { command: "npm test" },
    roles: { coder: { allow: ["Bash(npm *)"] } },
  };
  expect(
    await client.command(id, { type: "onboarding.confirm", config }),
  ).toEqual({ ok: true, events: [1] });
  const written = {
    ...config,
    roles: {
      planner: { adapter: "claude-code", model: "custom-planner" },
      coder: {
        adapter: "claude-code",
        model: "custom-coder",
        docsModel: "haiku",
        allow: ["Bash(npm *)"],
      },
      reviewer: { adapter: "claude-code", model: "custom-reviewer" },
    },
  };
  expect(
    JSON.parse(readFileSync(join(repo, "segno.config.json"), "utf8")),
  ).toEqual(written);
  expect(existsSync(join(appData, "projects", id, "pending.json"))).toBe(false);
  expect(await client.projects.list()).toMatchObject([
    { id, status: "running" },
  ]);
  expect(await client.query(id, "config")).toMatchObject({
    effective: written,
    pending: null,
    committed: false,
  });
  expect(await client.query(id, "onboarding")).toMatchObject({ state: "done" });
  expect(events).toMatchObject([
    {
      type: "onboarding.confirmed",
      payload: { via: "manual", config: written },
    },
  ]);
  expect(git(repo, "status", "--porcelain")).toBe("?? segno.config.json");
  expect(
    await client.command(id, { type: "onboarding.confirm", config }),
  ).toMatchObject({ ok: false, code: "invalid-transition" });
  expect(
    await client.command(id, { type: "plan.submit", yaml: twoPhase }),
  ).toEqual({ ok: true, events: [2] });
});

test("a config supplied before restart confirms onboarding via file once and removes pending config", async () => {
  const appData = tempDir();
  let client = hostAt(appData);
  const repo = repoWithRemote();
  const { id } = await client.projects.add(repo, {
    planner: "opus",
    coder: "sonnet",
    reviewer: "opus",
  });
  writeFileSync(join(repo, "segno.config.json"), JSON.stringify(validConfig));
  client = hostAt(appData);
  expect(await client.projects.list()).toMatchObject([
    { id, status: "running" },
  ]);
  const events: unknown[] = [];
  await client.subscribe(id, 0, (event) => events.push(event));
  await client.query(id, "board");
  expect(events).toEqual([
    {
      seq: 1,
      type: "onboarding.confirmed",
      v: 1,
      ts: expect.any(String),
      payload: { via: "file" },
    },
  ]);
  expect(existsSync(join(appData, "projects", id, "pending.json"))).toBe(false);
  client = hostAt(appData);
  const replay: unknown[] = [];
  await client.subscribe(id, 0, (event) => replay.push(event));
  await client.query(id, "board");
  expect(replay).toEqual(events);
});

test("missing config replays the log before checking local settings", async () => {
  const appData = tempDir();
  let client = hostAt(appData);
  const { id, repo } = await addProject(client);
  rmSync(join(repo, "segno.config.json"));
  writeFileSync(join(appData, "projects", id, "local.json"), "{broken");
  const db = new Database(join(appData, "projects", id, "segno.db"));
  db.prepare(
    "INSERT INTO events (seq, type, v, ts, payload) VALUES (2, 'unknown', 1, '2026-10-13T20:00:00.000Z', '{}')",
  ).run();
  db.close();
  client = hostAt(appData);
  expect(await client.projects.list()).toMatchObject([
    { status: "unavailable", reason: "unreadable-log" },
  ]);
});

test("missing config after a submitted Plan is unavailable even after abandonment", async () => {
  const appData = tempDir();
  let client = hostAt(appData);
  const { id, repo } = await addProject(client);
  await client.command(id, { type: "plan.submit", yaml: twoPhase });
  const [plan] = await client.query(id, "plans");
  await client.command(id, {
    type: "plan.abandon",
    planId: plan?.id,
    reason: "Done",
  });
  rmSync(join(repo, "segno.config.json"));
  client = hostAt(appData);
  expect(await client.projects.list()).toMatchObject([
    {
      id,
      status: "unavailable",
      reason: "invalid-config",
      errors: [{ file: "segno.config.json", code: "missing-file" }],
    },
  ]);
});

test("missing config without a Plan recreates absent pending config with the Add defaults", async () => {
  const appData = tempDir();
  let client = hostAt(appData);
  const { id, repo } = await addProject(client);
  rmSync(join(repo, "segno.config.json"));
  client = hostAt(appData);
  expect(await client.projects.list()).toMatchObject([
    { id, status: "not-onboarded" },
  ]);
  expect(await client.query(id, "config")).toEqual({
    effective: null,
    sources: {},
    rejected: null,
    committed: false,
    pending: {
      roles: {
        planner: { model: "opus" },
        coder: { model: "sonnet", docsModel: "haiku" },
        reviewer: { model: "opus" },
      },
    },
  });
  expect(
    await client.command(id, {
      type: "onboarding.confirm",
      config: validConfig,
    }),
  ).toMatchObject({ ok: true });
  expect(await client.projects.list()).toMatchObject([
    { id, status: "running" },
  ]);
});

test("an empty app data directory lists no Projects", async () => {
  const client = hostAt();
  expect(await client.projects.list()).toEqual([]);
});

test("inspect refuses a folder that is not a git top-level", async () => {
  const client = hostAt();
  const plain = tempDir();
  await expect(client.projects.inspect(plain)).rejects.toMatchObject({
    code: "not-a-repo",
  });
  const repo = tempDir();
  git(repo, "init", "-q");
  const nested = join(repo, "src");
  execFileSync("mkdir", [nested]);
  await expect(client.projects.inspect(nested)).rejects.toMatchObject({
    code: "not-a-repo",
  });
});

test("inspect refuses a repo without a remote", async () => {
  const client = hostAt();
  const repo = tempDir();
  git(repo, "init", "-q");
  await expect(client.projects.inspect(repo)).rejects.toMatchObject({
    code: "no-remote",
  });
});

test("inspect offers only default models before Add; onboarding detects manual settings", async () => {
  const client = hostAt();
  const repo = repoWithRemote({
    "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  });
  expect(await client.projects.inspect(repo)).toEqual({
    path: repo,
    source: "models",
    gh: "missing",
    errors: [],
    models: { planner: "opus", coder: "sonnet", reviewer: "opus" },
  });
  const { id } = await client.projects.add(repo, {
    planner: "opus",
    coder: "sonnet",
    reviewer: "opus",
  });
  expect(await client.query(id, "onboarding")).toEqual({
    state: "idle",
    detected: {
      packageManager: "pnpm",
      config: {
        schemaVersion: 1,
        baseBranch: "main",
        remote: "origin",
        tests: { command: "pnpm test" },
        setup: { command: "pnpm install --frozen-lockfile" },
        roles: {
          planner: { adapter: "claude-code", model: "opus" },
          coder: {
            adapter: "claude-code",
            model: "sonnet",
            docsModel: "haiku",
            allow: ["Bash(pnpm *)"],
          },
          reviewer: { adapter: "claude-code", model: "opus" },
        },
      },
    },
  });
});

const validConfig = {
  schemaVersion: 1,
  baseBranch: "main",
  tests: { command: "pnpm test" },
  roles: {
    coder: { adapter: "claude-code", model: "sonnet" },
    reviewer: { adapter: "claude-code", model: "opus" },
  },
};

test("inspect validates an existing segno.config.json with located errors", async () => {
  const client = hostAt();
  const text = `{
  "schemaVersion": 1,
  "baseBranch": "trunk",
  "tests": { "command": "" },
  "roles": {
    "coder": { "adapter": "claude-code", "model": "sonnet" },
    "reviewer": { "adapter": "claude-code", "model": "opus" }
  },
  "concurrency": 2,
  "colour": "blue"
}
`;
  const repo = repoWithRemote({ "segno.config.json": text });
  expect(await client.projects.inspect(repo)).toEqual({
    path: repo,
    source: "file",
    gh: "missing",
    config: JSON.parse(text),
    errors: [
      {
        file: "segno.config.json",
        path: "/baseBranch",
        line: 3,
        column: 17,
        code: "unknown-branch",
        message: "trunk is not a branch on origin.",
      },
      {
        file: "segno.config.json",
        path: "/tests/command",
        line: 4,
        column: 25,
        code: "schema",
        message: "Must not be empty.",
      },
      {
        file: "segno.config.json",
        path: "/concurrency",
        line: 9,
        column: 18,
        code: "schema",
        message: "v1 requires concurrency 1.",
      },
      {
        file: "segno.config.json",
        path: "/colour",
        line: 10,
        column: 3,
        code: "schema",
        message: "Unknown key: colour.",
      },
    ],
  });
});

test("inspect reports a config that is not JSON", async () => {
  const client = hostAt();
  const repo = repoWithRemote({
    "segno.config.json": '{\n  "schemaVersion": 1,\n}\n',
  });
  const result = await client.projects.inspect(repo);
  expect(result).toMatchObject({
    source: "file",
    errors: [{ code: "json-syntax", line: 3, column: 1 }],
  });
  expect(result).not.toHaveProperty("config");
});

test.each([
  {
    name: "Yarn 2+ with a lockfile",
    files: {
      "package.json": JSON.stringify({ scripts: { test: "jest" } }),
      "yarn.lock": "",
      ".yarnrc.yml": "",
    },
    packageManager: "yarn",
    test: "yarn test",
    setup: "yarn install --immutable",
  },
  {
    name: "Yarn 1 with a lockfile",
    files: { "package.json": "{}", "yarn.lock": "" },
    packageManager: "yarn",
    test: "",
    setup: "yarn install --frozen-lockfile",
  },
  {
    name: "npm with a lockfile",
    files: {
      "package.json": JSON.stringify({ scripts: { test: "mocha" } }),
      "package-lock.json": "{}",
    },
    packageManager: "npm",
    test: "npm test",
    setup: "npm ci",
  },
  {
    name: "bun with a text lockfile",
    files: { "package.json": "{}", "bun.lock": "" },
    packageManager: "bun",
    test: "",
    setup: "bun install --frozen-lockfile",
  },
  {
    name: "a declared packageManager without a lockfile",
    files: {
      "package.json": JSON.stringify({
        packageManager: "pnpm@12.11.2",
        scripts: { test: "vitest" },
      }),
    },
    packageManager: "pnpm",
    test: "pnpm test",
  },
  {
    name: "a manifest alone",
    files: { "package.json": JSON.stringify({ scripts: { test: "tap" } }) },
    packageManager: "npm",
    test: "npm test",
  },
  { name: "no manifest", files: {}, test: "" },
])(
  "onboarding detects $name",
  async ({ files, packageManager, test, setup }) => {
    const client = hostAt();
    const { id } = await client.projects.add(repoWithRemote(files), models);
    const { detected: result } = await client.query(id, "onboarding");
    expect(result.packageManager).toBe(packageManager);
    expect(result.config).toMatchObject({
      tests: { command: test },
      roles: {
        coder: { allow: packageManager ? [`Bash(${packageManager} *)`] : [] },
      },
    });
    expect((result.config as { setup?: unknown }).setup).toEqual(
      setup ? { command: setup } : undefined,
    );
  },
);

test("onboarding detects the base branch from the remote's HEAD, then main or master", async () => {
  const client = hostAt();
  const repo = repoWithRemote();
  git(repo, "branch", "develop");
  git(repo, "push", "-q", "origin", "develop");
  git(repo, "remote", "set-head", "origin", "develop");
  git(repo, "remote", "rename", "origin", "upstream");
  git(repo, "remote", "set-head", "upstream", "develop");
  const { id } = await client.projects.add(repo, models);
  expect((await client.query(id, "onboarding")).detected).toMatchObject({
    config: { remote: "upstream", baseBranch: "develop" },
  });
  git(repo, "remote", "set-head", "upstream", "--delete");
  git(repo, "branch", "-m", "main", "master");
  git(repo, "push", "-q", "upstream", "master");
  git(repo, "update-ref", "-d", "refs/remotes/upstream/main");
  expect((await client.query(id, "onboarding")).detected).toMatchObject({
    config: { baseBranch: "master" },
  });
});

test("inspect warns about a logged-out gh and still proposes the Project", async () => {
  const bin = tempDir();
  const stub = (name: string, exitCode: number) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\nexit ${exitCode}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const repo = repoWithRemote();
  const loggedOut = hostAt(undefined, { ghBinary: stub("gh-out", 1) });
  expect(await loggedOut.projects.inspect(repo)).toMatchObject({
    gh: "logged-out",
    source: "models",
  });
  const loggedIn = hostAt(undefined, { ghBinary: stub("gh-in", 0) });
  expect(await loggedIn.projects.inspect(repo)).toMatchObject({ gh: "ok" });
});

test("inspect refuses allow entries that reach always-denied git operations or bypass modes", async () => {
  const client = hostAt();
  const allow = [
    "Bash(pnpm *)",
    "Bash(git log:*)",
    "Bash",
    "Bash(*)",
    "Bash(git *)",
    "Bash(git push:*)",
    "Bash(git p*)",
    "Bash(git worktree add *)",
    "WebFetch",
    "Read(./src/**)",
    "bypassPermissions",
    "Bash(claude --dangerously-skip-permissions)",
    "Bash(claude --permission-mode *)",
    "not a rule(",
    "mcp__claude-in-chrome__navigate",
  ];
  const config = {
    ...validConfig,
    roles: {
      ...validConfig.roles,
      coder: { ...validConfig.roles.coder, allow },
    },
  };
  const repo = repoWithRemote({
    "segno.config.json": JSON.stringify(config),
  });
  const { errors } = await client.projects.inspect(repo);
  expect(errors.map(({ path, code }) => ({ path, code }))).toEqual([
    { path: "/roles/coder/allow/2", code: "denied-permission" },
    { path: "/roles/coder/allow/3", code: "denied-permission" },
    { path: "/roles/coder/allow/4", code: "denied-permission" },
    { path: "/roles/coder/allow/5", code: "denied-permission" },
    { path: "/roles/coder/allow/6", code: "denied-permission" },
    { path: "/roles/coder/allow/7", code: "denied-permission" },
    { path: "/roles/coder/allow/10", code: "denied-permission" },
    { path: "/roles/coder/allow/11", code: "denied-permission" },
    { path: "/roles/coder/allow/12", code: "denied-permission" },
    { path: "/roles/coder/allow/13", code: "schema" },
  ]);
});

const nodeRepo = {
  "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
  "package-lock.json": "{}",
};

test("add requires valid models only without a config and ignores models for an existing file", async () => {
  const client = hostAt();
  const bare = repoWithRemote();
  for (const invalid of [
    undefined,
    {},
    { ...models, coder: "" },
    { ...models, extra: "no" },
  ])
    await expect(client.projects.add(bare, invalid)).rejects.toMatchObject({
      code: "bad-request",
    });
  const committed = `${JSON.stringify(validConfig)}\n`;
  const configured = repoWithRemote({ "segno.config.json": committed });
  await client.projects.add(configured, { ignored: true });
  expect(readFileSync(join(configured, "segno.config.json"), "utf8")).toBe(
    committed,
  );
  expect(git(bare, "status", "--porcelain")).toBe("");
  expect(await client.projects.list()).toMatchObject([{ status: "running" }]);
});

/** A Project added with a valid committed config. */
async function addProject(client: HostClient) {
  const repo = repoWithRemote({
    "segno.config.json": `${JSON.stringify(validConfig)}\n`,
  });
  const { id } = await client.projects.add(repo);
  return { id, repo };
}

test("a Plan submitted in one Project needs approval in that Project only", async () => {
  const client = hostAt();
  const a = await addProject(client);
  const b = await addProject(client);
  expect(
    await client.command(a.id, {
      type: "plan.submit",
      yaml: twoPhase,
      sourcePath: "/plans/two-phase.yaml",
    }),
  ).toEqual({ ok: true, events: [2] });
  const [item] = await client.query(a.id, "awaiting");
  expect(item).toEqual({
    id: 2,
    kind: "plan-approval",
    planId: expect.any(String),
    title: "Search saved notes",
    createdAt: expect.any(String),
  });
  expect(await client.query(b.id, "awaiting")).toEqual([]);
  expect(
    (await client.projects.list()).map(({ id, awaitingCount }) => ({
      id,
      awaitingCount,
    })),
  ).toEqual([
    { id: a.id, awaitingCount: 1 },
    { id: b.id, awaitingCount: 0 },
  ]);
  expect(
    await client.command(a.id, { type: "plan.approve", planId: item?.planId }),
  ).toEqual({ ok: true, events: [3] });
  expect(await client.query(a.id, "awaiting")).toEqual([]);
});

test("calls on an unknown Project get unknown-project", async () => {
  const client = hostAt();
  await expect(
    client.command("no-such-project", { type: "plan.submit", yaml: twoPhase }),
  ).rejects.toMatchObject({ code: "unknown-project" });
  await expect(
    client.query("no-such-project", "awaiting"),
  ).rejects.toMatchObject({ code: "unknown-project" });
});

test("v1.2 Commands are rejected unsupported-in-version, even when malformed", async () => {
  const client = hostAt();
  const { id } = await addProject(client);
  for (const command of [
    { type: "planning.start", brief: "Add search." },
    { type: "planning.start" },
    { type: "planning.reply", sessionId: "s", text: "Yes." },
    { type: "planning.draftNow", sessionId: "s" },
    { type: "planning.stop", sessionId: "s" },
    { type: "planning.discard", sessionId: "s" },
    { type: "task.askPlanner", taskId: "t" },
    { type: "task.applyPlannerAdvice", taskId: "t", adviceId: "a" },
  ])
    expect(await client.command(id, command)).toEqual({
      ok: false,
      code: "unsupported-in-version",
      message: `${command.type} is a v1.2 Command; this Engine is v1.`,
    });
  expect(await client.query(id, "awaiting")).toEqual([]);
});

test("a Command without a recognizable type is a bad request", async () => {
  const client = hostAt();
  const { id } = await addProject(client);
  for (const command of [
    null,
    "plan.submit",
    {},
    { type: 7 },
    { type: "nope" },
  ])
    await expect(client.command(id, command)).rejects.toMatchObject({
      code: "bad-request",
    });
});

test("subscribe replays after since, then streams the live tail without gaps or duplicates", async () => {
  const client = hostAt();
  const { id } = await addProject(client);
  await client.command(id, { type: "plan.submit", yaml: twoPhase });
  const [first] = await client.query(id, "awaiting");
  await client.command(id, {
    type: "plan.sendBack",
    planId: first?.planId,
    notes: "Narrow it.",
  });

  const replayed: number[] = [];
  const live: number[] = [];
  const fromOne = await client.subscribe(id, 1, (event) =>
    replayed.push(event.seq),
  );
  const tailOnly = await client.subscribe(id, undefined, (event) =>
    live.push(event.seq),
  );
  // Commands and a new subscription race; every seq still arrives exactly once.
  const racing: number[] = [];
  const [, , , fromZero] = await Promise.all([
    client.command(id, { type: "plan.submit", yaml: twoPhase }),
    client.command(id, { type: "plan.submit", yaml: twoPhase }),
    client.query(id, "awaiting"),
    client.subscribe(id, 0, (event) => racing.push(event.seq)),
  ]);
  const [second] = await client.query(id, "awaiting");
  await client.command(id, { type: "plan.approve", planId: second?.planId });

  expect(replayed).toEqual([2, 3, 4, 5]);
  expect(live).toEqual([4, 5]);
  expect(racing).toEqual([1, 2, 3, 4, 5]);
  fromOne.close();
  fromZero.close();
  await client.command(id, {
    type: "plan.abandon",
    planId: second?.planId,
    reason: "Stop.",
  });
  await client.query(id, "awaiting");
  expect(replayed).toEqual([2, 3, 4, 5]);
  expect(live).toEqual([4, 5, 6]);
  tailOnly.close();
});

test("queries read the Plan and Phase level of a Project", async () => {
  const client = hostAt();
  const { id } = await addProject(client);
  expect(await client.query(id, "board")).toEqual({ plan: null, phase: null });
  expect(await client.query(id, "plans")).toEqual([]);
  expect(await client.query(id, "phases")).toEqual([]);

  await client.command(id, {
    type: "plan.submit",
    yaml: twoPhase,
    sourcePath: "/plans/two-phase.yaml",
  });
  const planId = (await client.query(id, "awaiting"))[0]?.planId ?? "";
  // A Plan awaiting approval is not on the board.
  expect(await client.query(id, "board")).toEqual({ plan: null, phase: null });
  await client.command(id, { type: "plan.approve", planId });
  expect(await client.query(id, "board")).toEqual({
    plan: {
      id: planId,
      slug: "search-saved-notes",
      title: "Search saved notes",
      state: "active",
    },
    phase: null,
  });
  expect(await client.query(id, "plans")).toEqual([
    {
      id: planId,
      slug: "search-saved-notes",
      title: "Search saved notes",
      state: "active",
      submittedAt: expect.any(String),
    },
  ]);
  expect(await client.query(id, "plan", { planId })).toMatchObject({
    id: planId,
    slug: "search-saved-notes",
    state: "active",
    sourcePath: "/plans/two-phase.yaml",
    definition: { title: "Search saved notes" },
    phases: [
      { id: "search-index", state: "pending" },
      { id: "search-screen", state: "pending" },
    ],
  });
  const exported = await client.query(id, "planExport", { planId });
  expect(exported).toMatch(/^schemaVersion: 1\n/);
  expect(exported).toContain("id: search-index-docs");
  expect(exported).toContain("id: search-screen-docs");
  expect(exported.match(/generated: true/g)).toHaveLength(2);
  expect(await client.query(id, "phases")).toEqual([]);
  expect(
    await client.query(id, "phaseEvents", { phaseId: "search-index" }),
  ).toEqual([
    expect.objectContaining({ seq: 2, type: "plan.submitted" }),
    expect.objectContaining({ seq: 3, type: "plan.approved" }),
  ]);

  for (const [name, params] of [
    ["plan", { planId: "no-such-plan" }],
    ["planExport", { planId: "no-such-plan" }],
    ["phaseEvents", { phaseId: "no-such-phase" }],
  ] as const)
    await expect(client.query(id, name, params)).rejects.toMatchObject({
      code: "not-found",
    });
  await expect(
    client.query(id, "plan", { plan: planId } as never),
  ).rejects.toMatchObject({ code: "bad-request" });
});

test("config reports the effective config, each key's source and the commit hint", async () => {
  const appData = tempDir();
  let client = hostAt(appData);
  const { id } = await addProject(client);
  writeFileSync(
    join(appData, "projects", id, "local.json"),
    JSON.stringify({
      worktreeRoot: "/srv/worktrees",
      roles: { coder: { model: "opus" }, "coder-docs": { model: "sonnet" } },
    }),
  );
  client = hostAt(appData);
  const role = { adapter: "claude-code", allow: [] };
  expect(await client.query(id, "config")).toEqual({
    effective: {
      schemaVersion: 1,
      baseBranch: "main",
      remote: "origin",
      forge: "github",
      tests: { command: "pnpm test", timeoutMin: 15 },
      roles: {
        coder: { ...role, model: "opus", docsModel: "sonnet", timeoutMin: 45 },
        reviewer: { ...role, model: "opus", timeoutMin: 15 },
      },
      idleTimeoutMin: 10,
      concurrency: 1,
      docs: { changelog: "CHANGELOG.md" },
      retention: { runDays: 30 },
      worktreeRoot: "/srv/worktrees",
    },
    sources: {
      "/schemaVersion": "file",
      "/baseBranch": "file",
      "/remote": "default",
      "/forge": "default",
      "/tests/command": "file",
      "/tests/timeoutMin": "default",
      "/roles/coder/adapter": "file",
      "/roles/coder/model": "local",
      "/roles/coder/docsModel": "local",
      "/roles/coder/timeoutMin": "default",
      "/roles/coder/allow": "default",
      "/roles/reviewer/adapter": "file",
      "/roles/reviewer/model": "file",
      "/roles/reviewer/timeoutMin": "default",
      "/roles/reviewer/allow": "default",
      "/idleTimeoutMin": "default",
      "/concurrency": "default",
      "/docs/changelog": "default",
      "/retention/runDays": "default",
      "/worktreeRoot": "local",
    },
    rejected: null,
    pending: null,
    committed: true,
  });

  const detected = repoWithRemote(nodeRepo);
  const added = await client.projects.add(detected, models);
  const { detected: proposal } = await client.query(added.id, "onboarding");
  await client.command(added.id, {
    type: "onboarding.confirm",
    config: proposal.config,
  });
  expect(await client.query(added.id, "config")).toMatchObject({
    effective: {
      setup: { command: "npm ci" },
      roles: {
        planner: { model: "opus", timeoutMin: 20 },
        coder: { model: "sonnet", docsModel: "haiku" },
      },
    },
    sources: {
      "/setup/command": "file",
      "/roles/planner/model": "file",
      "/roles/coder/docsModel": "file",
    },
    committed: false,
  });
});

test("an invalid config makes one Project unavailable with every error while the other keeps running", async () => {
  const appData = tempDir();
  let client = hostAt(appData);
  const a = await addProject(client);
  const b = await addProject(client);
  writeFileSync(
    join(a.repo, "segno.config.json"),
    JSON.stringify({ ...validConfig, concurrency: 2, remote: "upstream" }),
  );
  writeFileSync(
    join(appData, "projects", a.id, "local.json"),
    JSON.stringify({ port: 8080 }),
  );
  client = hostAt(appData);
  expect(await client.projects.list()).toEqual([
    {
      id: a.id,
      name: basename(a.repo),
      path: a.repo,
      status: "unavailable",
      awaitingCount: 0,
      reason: "invalid-config",
      message: "The Project's config has 3 errors.",
      errors: [
        {
          file: "segno.config.json",
          path: "/concurrency",
          line: 1,
          column: 199,
          code: "schema",
          message: "v1 requires concurrency 1.",
        },
        {
          file: "segno.config.json",
          path: "/remote",
          line: 1,
          column: 210,
          code: "unknown-remote",
          message: "upstream is not a git remote of this repo.",
        },
        {
          file: "local.json",
          path: "/port",
          line: 1,
          column: 2,
          code: "schema",
          message: "Unknown key: port.",
        },
      ],
    },
    expect.objectContaining({ id: b.id, status: "running" }),
  ]);
  await expect(
    client.command(a.id, { type: "plan.submit", yaml: twoPhase }),
  ).rejects.toMatchObject({ code: "unknown-project" });
  expect(
    await client.command(b.id, { type: "plan.submit", yaml: twoPhase }),
  ).toEqual({ ok: true, events: [2] });
});

test("a missing folder, a lost repo or an unknown Event makes a Project unavailable with its reason", async () => {
  const appData = tempDir();
  let client = hostAt(appData);
  const moved = await addProject(client);
  const lost = await addProject(client);
  const corrupt = await addProject(client);
  await client.command(corrupt.id, { type: "plan.submit", yaml: twoPhase });
  renameSync(moved.repo, `${moved.repo}-moved`);
  cleanups.push(() => rmSync(`${moved.repo}-moved`, { recursive: true }));
  rmSync(join(lost.repo, ".git"), { recursive: true });
  // Startup refusal of an unknown Event stays an Event-log fixture, as in B2.
  const db = new Database(join(appData, "projects", corrupt.id, "segno.db"));
  db.prepare(
    "INSERT INTO events (seq, type, v, ts, payload) VALUES (3, 'plan.renamed', 1, '2026-10-13T20:00:00.000Z', '{}')",
  ).run();
  db.close();
  client = hostAt(appData);
  expect(
    (await client.projects.list()).map(({ id, status, ...rest }) => ({
      id,
      status,
      reason: "reason" in rest ? rest.reason : undefined,
    })),
  ).toEqual([
    { id: moved.id, status: "unavailable", reason: "missing-folder" },
    { id: lost.id, status: "unavailable", reason: "not-a-repo" },
    { id: corrupt.id, status: "unavailable", reason: "unreadable-log" },
  ]);
  const [, , unreadable] = await client.projects.list();
  expect(unreadable).toMatchObject({
    message: expect.stringMatching(/plan\.renamed v1/),
  });
});

test("locate points an unavailable Project at its moved folder and starts it", async () => {
  const appData = tempDir();
  let client = hostAt(appData);
  const project = await addProject(client);
  const other = await addProject(client);
  await client.command(project.id, { type: "plan.submit", yaml: twoPhase });
  const movedTo = `${project.repo}-moved`;
  renameSync(project.repo, movedTo);
  cleanups.push(() => rmSync(movedTo, { recursive: true, force: true }));
  client = hostAt(appData);
  await expect(
    client.projects.locate(project.id, tempDir()),
  ).rejects.toMatchObject({ code: "not-a-repo" });
  await expect(
    client.projects.locate(project.id, other.repo),
  ).rejects.toMatchObject({ code: "already-added" });
  await expect(
    client.projects.locate(other.id, other.repo),
  ).rejects.toMatchObject({ code: "bad-request" });
  await client.projects.locate(project.id, movedTo);
  expect((await client.projects.list())[0]).toEqual({
    id: project.id,
    name: basename(project.repo),
    path: movedTo,
    status: "running",
    awaitingCount: 1,
  });
  client = hostAt(appData);
  expect((await client.projects.list())[0]).toMatchObject({
    path: movedTo,
    status: "running",
  });
});

test("rename and remove change only the registry and, when asked, the Project's data", async () => {
  const appData = tempDir();
  let client = hostAt(appData);
  const kept = await addProject(client);
  const deleted = await addProject(client);
  await client.projects.rename(kept.id, "  Notes app  ");
  await expect(client.projects.rename(kept.id, "   ")).rejects.toMatchObject({
    code: "bad-request",
  });
  await expect(
    client.projects.rename("no-such-project", "x"),
  ).rejects.toMatchObject({ code: "unknown-project" });
  await client.projects.remove(kept.id, { deleteData: false });
  await client.projects.remove(deleted.id, { deleteData: true });
  await expect(
    client.projects.remove(deleted.id, { deleteData: true }),
  ).rejects.toMatchObject({ code: "unknown-project" });
  expect(await client.projects.list()).toEqual([]);
  expect(existsSync(join(appData, "projects", kept.id, "segno.db"))).toBe(true);
  expect(existsSync(join(appData, "projects", deleted.id))).toBe(false);
  expect(existsSync(join(deleted.repo, "segno.config.json"))).toBe(true);
  expect(git(deleted.repo, "status", "--porcelain")).toBe("");
  // A removed repo can be added again as a new Project.
  client = hostAt(appData);
  const again = await client.projects.add(kept.repo);
  expect(again.id).not.toBe(kept.id);
});

test("a renamed Project keeps its name across restarts", async () => {
  const appData = tempDir();
  let client = hostAt(appData);
  const { id } = await addProject(client);
  await client.projects.rename(id, "  Notes app  ");
  client = hostAt(appData);
  expect((await client.projects.list())[0]).toMatchObject({
    id,
    name: "Notes app",
  });
});

test("restarting the host gives identical board and awaiting results", async () => {
  const appData = tempDir();
  let client = hostAt(appData);
  const a = await addProject(client);
  const b = await addProject(client);
  await client.command(a.id, { type: "plan.submit", yaml: twoPhase });
  await client.command(b.id, { type: "plan.submit", yaml: twoPhase });
  const planId = (await client.query(b.id, "awaiting"))[0]?.planId;
  await client.command(b.id, { type: "plan.approve", planId });
  const before = await Promise.all(
    [a.id, b.id].flatMap((id) => [
      client.query(id, "board"),
      client.query(id, "awaiting"),
    ]),
  );
  client = hostAt(appData);
  expect(
    await Promise.all(
      [a.id, b.id].flatMap((id) => [
        client.query(id, "board"),
        client.query(id, "awaiting"),
      ]),
    ),
  ).toEqual(before);
});

test("app settings default when unset, and set validates before writing", async () => {
  const appData = tempDir();
  let client = hostAt(appData);
  expect(await client.settings.get()).toEqual({
    notifications: true,
    theme: "system",
    launchAtLogin: false,
  });
  await client.settings.set({ editor: "code {path}", theme: "dark" });
  await expect(client.settings.set({ editor: "code" })).rejects.toMatchObject({
    code: "bad-request",
  });
  await expect(
    client.settings.set({ theme: "sepia" } as never),
  ).rejects.toMatchObject({ code: "bad-request" });
  expect(
    JSON.parse(readFileSync(join(appData, "settings.json"), "utf8")),
  ).toEqual({ editor: "code {path}", theme: "dark" });
  await client.settings.set({ editor: null });
  client = hostAt(appData);
  expect(await client.settings.get()).toEqual({
    notifications: true,
    theme: "dark",
    launchAtLogin: false,
  });
});

test("an unreadable settings file is logged and treated as defaults", async () => {
  const appData = tempDir();
  writeFileSync(join(appData, "settings.json"), "{ not json");
  const client = hostAt(appData);
  expect(await client.settings.get()).toMatchObject({ theme: "system" });
  expect(readFileSync(join(appData, "host.log"), "utf8")).toContain(
    "settings.json",
  );
});

test("malformed requests, unknown calls and bad arguments get bad-request", async () => {
  const appData = tempDir();
  const host = startHost({ appData, adapters: [] });
  const { port1, port2 } = new MessageChannel();
  host.connect(nodePort(port1));
  cleanups.push(async () => {
    port2.close();
    await host.close();
  });
  const responses: unknown[] = [];
  port2.on("message", (message) => responses.push(message));
  for (const request of [
    { id: 1, call: "projects.list" },
    { id: 2, call: "projects.destroy", args: [] },
    { id: 3, call: "projects.inspect", args: [42] },
    { id: 4, call: "query", args: ["p", "board", {}, "extra"] },
    { call: "projects.list", args: [] },
    { id: 5, call: "projects.list", args: [] },
  ])
    port2.postMessage(request);
  await expect.poll(() => responses.length).toBe(5);
  expect(responses).toEqual([
    { id: 1, error: { code: "bad-request", message: expect.any(String) } },
    { id: 2, error: { code: "bad-request", message: expect.any(String) } },
    { id: 3, error: { code: "bad-request", message: expect.any(String) } },
    { id: 4, error: { code: "bad-request", message: expect.any(String) } },
    { id: 5, result: [] },
  ]);
});

test("an unreadable registry is logged and answered internal without overwriting it", async () => {
  const appData = tempDir();
  writeFileSync(join(appData, "projects.json"), "[{ truncated");
  const client = hostAt(appData);
  await expect(client.projects.list()).rejects.toMatchObject({
    code: "internal",
  });
  await expect(
    client.projects.add(repoWithRemote({ "segno.config.json": "{}" })),
  ).rejects.toMatchObject({ code: "internal" });
  expect(readFileSync(join(appData, "projects.json"), "utf8")).toBe(
    "[{ truncated",
  );
  expect(readFileSync(join(appData, "host.log"), "utf8")).toContain(
    "projects.json",
  );
});

test("a closed client rejects waiting and later calls instead of hanging", async () => {
  const client = hostAt();
  const waiting = client.projects.list();
  client.close();
  await expect(waiting).rejects.toMatchObject({ code: "internal" });
  await expect(client.settings.get()).rejects.toMatchObject({
    code: "internal",
  });
});

test("an unreadable pending config is a config error and does not replace the chosen models", async () => {
  const appData = tempDir();
  let client = hostAt(appData);
  const { id } = await client.projects.add(repoWithRemote(), models);
  const pendingPath = join(appData, "projects", id, "pending.json");
  rmSync(pendingPath);
  mkdirSync(pendingPath);
  client = hostAt(appData);
  expect(await client.projects.list()).toMatchObject([
    {
      id,
      status: "unavailable",
      reason: "invalid-config",
      errors: [{ file: "pending.json" }],
    },
  ]);
});

test("a replacement config records via file after a Project becomes not onboarded again", async () => {
  const appData = tempDir();
  let client = hostAt(appData);
  const { id, repo } = await addProject(client);
  rmSync(join(repo, "segno.config.json"));
  client = hostAt(appData);
  expect(await client.projects.list()).toMatchObject([
    { status: "not-onboarded" },
  ]);
  writeFileSync(join(repo, "segno.config.json"), JSON.stringify(validConfig));
  client = hostAt(appData);
  const events: unknown[] = [];
  await client.subscribe(id, 1, (event) => events.push(event));
  await client.query(id, "config");
  expect(events).toMatchObject([
    { seq: 2, type: "onboarding.confirmed", payload: { via: "file" } },
  ]);
});
