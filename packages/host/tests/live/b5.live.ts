import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageChannel } from "node:worker_threads";
import { claudeCodeAdapter } from "@segno/adapter-claude-code";
import { createHostClient, type HostClient } from "@segno/core";
import { afterAll, expect, test } from "vitest";
import { nodePort, startHost } from "../../src/index.js";

// The B5 live check (`pnpm check:b5:live`): the real `claude` on the
// developer's subscription, in throwaway repos. Never run in CI.

const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const close of closers) await close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repoWithRemote(files: Record<string, string>) {
  const remote = tempDir("segno-live-remote-");
  git(remote, "init", "-q", "--bare", "-b", "main");
  const repo = tempDir("segno-live-repo-");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "live@example.com");
  git(repo, "config", "user.name", "Live");
  for (const [name, content] of Object.entries(files))
    writeFileSync(join(repo, name), content);
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "initial");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "origin", "main");
  git(repo, "remote", "set-head", "origin", "main");
  return repo;
}

function host(): HostClient {
  const running = startHost({
    appData: tempDir("segno-live-app-"),
    adapters: [claudeCodeAdapter()],
  });
  const { port1, port2 } = new MessageChannel();
  running.connect(nodePort(port1));
  const client = createHostClient(nodePort(port2));
  closers.push(async () => {
    client.close();
    await running.close();
  });
  return client;
}

const minutes = (count: number) => count * 60_000;

test(
  "a one-Task Plan reaches done with the real claude, and prompt.md holds exactly the Run context",
  async () => {
    const client = host();
    const config = {
      schemaVersion: 1,
      baseBranch: "main",
      tests: { command: "node --test" },
      roles: {
        coder: { adapter: "claude-code", model: "haiku", docsModel: "haiku" },
        reviewer: { adapter: "claude-code", model: "haiku" },
      },
    };
    const repo = repoWithRemote({
      "segno.config.json": `${JSON.stringify(config)}\n`,
      "README.md": "# Greeter\n",
      "hello.test.js": `import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert";
test("hello.txt says hello", () => {
  assert.strictEqual(readFileSync("hello.txt", "utf8"), "hello\\n");
});
`,
    });
    const { id } = await client.projects.add(repo);
    await client.command(id, {
      type: "plan.submit",
      yaml: `schemaVersion: 1
title: Greeting
summary: Say hello.
phases:
  - id: hello
    title: Hello file
    tasks:
      - id: hello-file
        title: Add hello.txt
        description: Create hello.txt in the repo root.
        acceptance: [hello.txt contains exactly the line "hello"]
`,
    });
    const [plan] = await client.query(id, "plans");
    await client.command(id, { type: "plan.approve", planId: plan?.id });
    await expect
      .poll(
        async () =>
          (await client.query(id, "board")).tasks.map(({ state }) => state),
        { timeout: minutes(20), interval: 5_000 },
      )
      .toEqual(["done", "done"]);

    const task = await client.query(id, "task", { taskId: "hello-file" });
    const coder = task.runs.find(({ kind }) => kind === "coder");
    expect(
      await client.query(id, "runPrompt", { runId: coder?.id ?? "" }),
    ).toBe(`You are working one Task of a Segno Plan, in this worktree.

# Plan: Greeting

Say hello.

## Phase: Hello file

## Task: Add hello.txt

Create hello.txt in the repo root.

### Acceptance criteria

- hello.txt contains exactly the line "hello"

## Definition of done

- Meet every acceptance criterion.
- Update the docs for any behavior you change.
- Run \`node --test\` before you finish, and fix what fails.
- Commit your work.
`);
    expect(git(repo, "show", "segno/greeting/hello:hello.txt")).toBe("hello");
  },
  minutes(25),
);

test(
  "Onboard project proposes the repo's passing test script with its exit code and duration, and Confirm writes it",
  async () => {
    const client = host();
    const repo = repoWithRemote({
      "package.json": `${JSON.stringify({ name: "live", scripts: { test: "node --test" } }, null, 2)}\n`,
      "sum.test.js": `import { test } from "node:test";
import assert from "node:assert";
test("adds", () => assert.strictEqual(1 + 1, 2));
`,
    });
    const { id } = await client.projects.add(repo, {
      planner: "sonnet",
      coder: "haiku",
      reviewer: "haiku",
    });
    expect(
      await client.command(id, { type: "onboarding.start" }),
    ).toMatchObject({ ok: true });
    await expect
      .poll(async () => (await client.query(id, "onboarding")).state, {
        timeout: minutes(15),
        interval: 5_000,
      })
      .toBe("proposed");

    const { proposal } = await client.query(id, "onboarding");
    expect(proposal?.config.tests.command).toMatch(/test/);
    expect(proposal?.checks).toContainEqual(
      expect.objectContaining({
        purpose: "tests",
        exitCode: 0,
        durationSec: expect.any(Number),
      }),
    );
    expect(proposal?.flags ?? []).toEqual([]);
    expect(
      await client.command(id, {
        type: "onboarding.confirm",
        config: proposal?.config,
      }),
    ).toMatchObject({ ok: true });
    expect(
      JSON.parse(readFileSync(join(repo, "segno.config.json"), "utf8")).tests
        .command,
    ).toBe(proposal?.config.tests.command);
    expect(await client.projects.list()).toEqual([
      expect.objectContaining({ id, status: "running" }),
    ]);
  },
  minutes(20),
);
