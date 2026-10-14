import { MessageChannel } from "node:worker_threads";
import {
  type AgentAdapter,
  createHostClient,
  type HostClient,
  type Verdict,
} from "@segno/core";
import {
  type FakeScript,
  fakeAdapter,
  gitSync,
  tempRepos,
} from "@segno/engine/testing";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, expect, test } from "vitest";
import { nodePort, startHost } from "../src/index.js";

// S6: the Run context each agent Run gets, read back through `runPrompt`
// [ADR-0024].
const yaml = `schemaVersion: 1
title: Search notes
summary: Find saved notes.
phases:
  - id: index
    title: Search index
    docs: Document the search syntax in docs/search.md.
    tasks:
      - id: a
        title: Index notes
        description: Build the index.
        acceptance: [Notes are indexed, The index survives a restart]
        context: [src/index.ts, docs/storage.md]
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
  docs: { changelog: "CHANGELOG.md" },
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

async function approvedProject(client: HostClient, plan = yaml) {
  const { repo } = repos.repoWithRemote({
    "segno.config.json": `${JSON.stringify(config)}\n`,
  });
  const { id } = await client.projects.add(repo);
  await client.command(id, { type: "plan.submit", yaml: plan });
  const [submitted] = await client.query(id, "plans");
  await client.command(id, { type: "plan.approve", planId: submitted?.id });
  return { id, base: gitSync(repo, "rev-parse", "origin/main") };
}

/** A Reviewer that approves with one advisory Finding. */
const approvesWithAdvice: FakeScript = async (run) => {
  const verdict: Verdict = {
    schemaVersion: 1,
    decision: "approve",
    summary: `Approved ${run.spec.env.SEGNO_TASK_ID}.`,
    acceptance: [],
    docs: { needed: false, satisfied: true, note: "" },
    findings: [
      {
        severity: "advisory",
        file: `${run.spec.env.SEGNO_TASK_ID}.txt`,
        line: 1,
        body: "Say what the file is for.",
      },
    ],
  };
  return {
    kind: "completed",
    sessionId: run.spec.runId,
    finalText: "Done.",
    structured: verdict,
  };
};

async function promptOf(client: HostClient, id: string, runId: string) {
  return client.query(id, "runPrompt", { runId });
}

test("a first-pass Coder gets its Task, the definition of done and the test command, and nothing else", async () => {
  const adapter = fakeAdapter();
  const client = hostWith([adapter]);
  const { id } = await approvedProject(client);
  await expect.poll(() => adapter.runs.length).toBeGreaterThan(0);
  const [coder] = adapter.runs;

  expect(coder?.kind).toBe("coder");
  expect(coder?.systemPrompt).toBe("");
  expect(coder?.outputSchema).toBeUndefined();
  expect(
    coder?.prompt,
  ).toBe(`You are working one Task of a Segno Plan, in this worktree.

# Plan: Search notes

Find saved notes.

## Phase: Search index

## Task: Index notes

Build the index.

### Acceptance criteria

- Notes are indexed
- The index survives a restart

### Context

Start from these:

- src/index.ts
- docs/storage.md

## Definition of done

- Meet every acceptance criterion.
- Update the docs for any behavior you change.
- Run \`echo tests passed\` before you finish, and fix what fails.
- Commit your work.
`);
  expect(await promptOf(client, id, coder?.runId ?? "")).toBe(coder?.prompt);
});

test("a Reviewer gets the Task, its diff range, that tests passed and the Verdict schema as its output schema", async () => {
  const adapter = fakeAdapter({
    reviewer: async () => ({ kind: "crashed", detail: "Stop here." }),
  });
  const client = hostWith([adapter]);
  const { id, base } = await approvedProject(
    client,
    yaml.replace(
      "        context: [src/index.ts, docs/storage.md]\n",
      "        risk: { flags: [data-deletion, auth], reason: It purges stale notes. }\n",
    ),
  );
  await expect
    .poll(() => adapter.runs.map(({ kind }) => kind))
    .toEqual(["coder", "reviewer"]);
  const reviewer = adapter.runs[1];

  expect(reviewer?.systemPrompt).toBe("");
  expect(reviewer?.permissions).toMatchObject({ edit: false });
  expect(
    reviewer?.prompt,
  ).toBe(`You are reviewing one Task of a Segno Plan, in this worktree. Its tests passed.

# Task: Index notes

Build the index.

## Acceptance criteria

0. Notes are indexed
1. The index survives a restart

## Risk

Flagged data-deletion, auth: It purges stale notes.

## Changes

Review the changes in \`${base}..HEAD\`, for example with \`git diff ${base}..HEAD\`.

## Docs

Check whether the changes alter behavior that docs describe, and whether those docs were updated to match.

## Verdict

Answer with a Verdict that matches this JSON Schema. In \`acceptance\`, \`index\` is the criterion's number above.

\`\`\`json
${JSON.stringify(reviewer?.outputSchema, null, 2)}
\`\`\`
`);
  expect(await promptOf(client, id, reviewer?.runId ?? "")).toBe(
    reviewer?.prompt,
  );

  // The output schema is the runners.md Verdict schema.
  const valid = new Ajv2020({ strict: false }).compile(
    reviewer?.outputSchema ?? {},
  );
  const verdict = {
    schemaVersion: 1,
    decision: "reject",
    summary: "Misses the restart case.",
    acceptance: [{ index: 1, met: false, note: "Not persisted." }],
    docs: { needed: true, satisfied: false, note: "No docs." },
    findings: [
      { severity: "blocking", file: "src/index.ts", line: 3, body: "Persist." },
    ],
    risk: [{ flag: "data-deletion", reason: "Drops the old index." }],
  };
  expect(valid(verdict)).toBe(true);
  expect(valid({ ...verdict, risk: undefined })).toBe(true);
  for (const invalid of [
    { ...verdict, extra: true },
    { ...verdict, decision: "maybe" },
    { ...verdict, summary: "" },
    { ...verdict, schemaVersion: 2 },
    { ...verdict, findings: [{ severity: "blocking", line: 0, body: "x" }] },
    { ...verdict, findings: [{ severity: "advisory", body: "" }] },
    { ...verdict, risk: [{ flag: "style", reason: "x" }] },
    { ...verdict, docs: { needed: true, satisfied: false } },
  ])
    expect(valid(invalid)).toBe(false);
});

test("the Docs task gets the Phase, its done Tasks' Verdict summaries, advisory Findings, the Phase diff range, the docs block and the changelog", async () => {
  const adapter = fakeAdapter({ reviewer: approvesWithAdvice });
  const client = hostWith([adapter]);
  const { id, base } = await approvedProject(client);
  await expect
    .poll(() => adapter.runs.map(({ kind }) => kind))
    .toContain("docs");
  const docs = adapter.runs.find(({ kind }) => kind === "docs");

  expect(docs?.systemPrompt).toBe("");
  expect(docs?.outputSchema).toBeUndefined();
  expect(
    docs?.prompt,
  ).toBe(`You are writing the docs for a finished Phase of a Segno Plan, in this worktree.

# Phase: Search index

Find saved notes.

## Done Tasks

- Index notes: Approved a.
- Query notes: Approved b.

## Advisory Findings

- a.txt:1: Say what the file is for.
- b.txt:1: Say what the file is for.

## Changes

The Phase's changes are \`${base}..HEAD\`, against \`main\`.

## Docs to write

Document the search syntax in docs/search.md.

## Changelog

Add entries for user-visible changes to \`CHANGELOG.md\`.

Commit your work when you're done.
`);
  expect(await promptOf(client, id, docs?.runId ?? "")).toBe(docs?.prompt);
});
