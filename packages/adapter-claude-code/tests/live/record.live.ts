import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { RunResult, RunSpec } from "@segno/core";
import { afterAll, expect, test } from "vitest";
import { claudeCodeAdapter } from "../../src/index.js";
import {
  deriveRateLimited,
  type FixtureEntry,
  type FixtureName,
  fixturesDir,
  replayStub,
  sanitize,
} from "../replay.js";

// `pnpm test:live`: re-records every fixture with the installed `claude`, on
// the developer's subscription, through the Adapter's own transcript tee.
// Never run in CI. Review the fixture diff before committing it.

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "segno-live-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const repo = join(scratch, "repo");
execFileSync("git", ["init", "-q", repo]);
writeFileSync(join(repo, "README.md"), "hello\n");
execFileSync("git", ["-C", repo, "add", "."]);
execFileSync("git", [
  "-C",
  repo,
  "-c",
  "user.email=live@example.com",
  "-c",
  "user.name=Live",
  "commit",
  "-qm",
  "init",
]);

// A wrapper that records claude's pid, so the crashed case can SIGKILL it.
const pidFile = join(scratch, "claude.pid");
const wrapper = join(scratch, "claude");
writeFileSync(wrapper, `#!/bin/sh\necho $$ > "${pidFile}"\nexec claude "$@"\n`);
chmodSync(wrapper, 0o755);
const adapter = claudeCodeAdapter({ binary: wrapper });

function spec(name: string, overrides: Partial<RunSpec> = {}): RunSpec {
  return {
    runId: name,
    kind: "coder",
    model: "haiku",
    cwd: repo,
    prompt: "",
    systemPrompt: "",
    permissions: {
      read: true,
      edit: false,
      shell: [],
      network: false,
      mcp: false,
      extraAllow: [],
    },
    env: {},
    transcriptPath: join(scratch, `${name}.jsonl`),
    ...overrides,
  };
}

const recorded = new Map<
  FixtureName,
  { lines: string[]; entry: FixtureEntry }
>();

async function record(
  name: FixtureName,
  overrides: Partial<RunSpec>,
  { kill = false } = {},
): Promise<RunResult> {
  const runSpec = spec(name, overrides);
  rmSync(pidFile, { force: true });
  const handle = adapter.start(runSpec);
  if (kill) {
    // SIGKILL once the first assistant message is out, as a crash would.
    for await (const event of handle.events) if (event.type === "output") break;
    while (!existsSync(pidFile)) await sleep(50);
    process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
  }
  const result = await handle.result;
  const lines = readFileSync(runSpec.transcriptPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => sanitize(line, { cwd: repo }));
  recorded.set(name, {
    lines,
    entry: kill
      ? { signal: "SIGKILL" }
      : { exit: "exitCode" in result ? (result.exitCode ?? 0) : 0 },
  });
  return result;
}

test("a plain answer is completed", async () => {
  const result = await record("completed", {
    prompt: "Read README.md and reply with its first word only.",
  });
  expect(result).toMatchObject({ kind: "completed" });
});

test("an answer to an output schema is completed with structured output", async () => {
  const result = await record("completed-structured", {
    prompt:
      "Reply with an answer object whose word is the first word of README.md.",
    outputSchema: {
      type: "object",
      properties: { word: { type: "string" } },
      required: ["word"],
      additionalProperties: false,
    },
  });
  expect(result).toMatchObject({ kind: "completed", structured: {} });
});

test("an unknown model is failed", async () => {
  const result = await record("failed", {
    prompt: "Say hi.",
    model: "no-such-model-segno",
  });
  expect(result).toMatchObject({ kind: "failed", exitCode: 1 });
});

test("a killed claude is crashed", async () => {
  const result = await record(
    "crashed",
    {
      prompt:
        "Read README.md, then count slowly from 1 to 40, one number per line.",
    },
    { kill: true },
  );
  expect(result).toMatchObject({ kind: "crashed" });
});

test("the fixtures are written, the rate-limited ones derived, and each replays to its classification", async () => {
  const { version } = await adapter.detect();
  expect(version).toBeDefined();
  const failed = recorded.get("failed");
  const completed = recorded.get("completed");
  if (!failed || !completed) throw new Error("Record every case first.");
  for (const [name, withReset] of [
    ["rate-limited", true],
    ["rate-limited-no-reset", false],
  ] as const)
    recorded.set(name, {
      lines: deriveRateLimited(failed.lines, completed.lines, withReset),
      entry: { ...failed.entry, derivedFrom: "failed" },
    });
  const fixtures: Partial<Record<FixtureName, FixtureEntry>> = {};
  for (const [name, { lines, entry }] of recorded) {
    writeFileSync(join(fixturesDir, `${name}.jsonl`), `${lines.join("\n")}\n`);
    fixtures[name] = entry;
  }
  writeFileSync(
    join(fixturesDir, "fixtures.json"),
    `${JSON.stringify({ recordedWith: version, fixtures }, null, 2)}\n`,
  );

  const expected: Record<FixtureName, RunResult["kind"]> = {
    completed: "completed",
    "completed-structured": "completed",
    failed: "failed",
    crashed: "crashed",
    "rate-limited": "rate-limited",
    "rate-limited-no-reset": "rate-limited",
  };
  for (const [name, kind] of Object.entries(expected)) {
    const dir = mkdtempSync(join(scratch, "replay-"));
    const stub = replayStub(dir, { fixture: name as FixtureName });
    const replayed = await claudeCodeAdapter({ binary: stub.binary }).start(
      spec(`replay-${name}`, { transcriptPath: join(dir, "t.jsonl") }),
    ).result;
    expect({ name, kind: replayed.kind }).toEqual({ name, kind });
  }
});
