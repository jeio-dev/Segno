import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent, RunSpec } from "@segno/core";
import { afterEach, expect, test } from "vitest";
import { claudeCodeAdapter } from "../src/index.js";
import { replayStub, type StubOptions } from "./replay.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "segno-s5-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A Coder RunSpec in a fresh worktree directory. */
function coderSpec(dir: string, overrides: Partial<RunSpec> = {}): RunSpec {
  const cwd = join(dir, "worktree");
  mkdirSync(cwd, { recursive: true });
  return {
    runId: "run-1",
    kind: "coder",
    model: "sonnet",
    cwd,
    prompt: "Do the task.",
    systemPrompt: "You are the Coder.",
    permissions: {
      read: true,
      edit: true,
      shell: ["pnpm test", "git status *"],
      network: false,
      mcp: false,
      extraAllow: ["Bash(pnpm *)"],
    },
    env: { SEGNO: "1", SEGNO_RUN_ID: "run-1" },
    transcriptPath: join(dir, "transcript.jsonl"),
    ...overrides,
  };
}

/** Starts one Run against a replay stub and collects everything it reports. */
async function run(spec: RunSpec, stub: StubOptions) {
  const replay = replayStub(tempDir(), stub);
  const adapter = claudeCodeAdapter({ binary: replay.binary });
  const handle = adapter.start(spec);
  const events: RunEvent[] = [];
  for await (const event of handle.events) events.push(event);
  return { replay, events, result: await handle.result };
}

const alwaysDenied = [
  "Bash(git push *)",
  "Bash(git checkout *)",
  "Bash(git switch *)",
  "Bash(git merge *)",
  "Bash(git rebase *)",
  "Bash(git reset *)",
  "Bash(git branch *)",
  "Bash(git worktree *)",
];
const networkTools = ["WebFetch", "WebSearch", "Bash(curl *)", "Bash(wget *)"];
/** A readable tool call on README.md, whichever tool the model chose. */
const toolCall = /^→ \w+ .*README\.md.*\n$/;

test("a new session maps the RunSpec onto the runners.md flag table", async () => {
  const dir = tempDir();
  const { replay, events } = await run(coderSpec(dir), {
    fixture: "completed",
  });
  const [argv] = replay.argv();
  const sessionId = argv?.[argv.indexOf("--session-id") + 1];
  expect(sessionId).toMatch(uuid);
  expect(argv).toEqual([
    "-p",
    "Do the task.",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    "sonnet",
    "--append-system-prompt",
    "You are the Coder.",
    "--session-id",
    sessionId,
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
    "--allowedTools",
    "Read(./**)",
    "Edit(./**)",
    "Bash(pnpm test)",
    "Bash(git status *)",
    "Bash(pnpm *)",
    "--disallowedTools",
    ...alwaysDenied,
    ...networkTools,
    "--setting-sources",
    "project",
    "--strict-mcp-config",
  ]);
  expect(events[0]).toEqual({ type: "started", sessionId });
  expect(replay.cwd()).toBe(join(dir, "worktree"));
  expect(replay.env()).toMatchObject({ SEGNO: "1", SEGNO_RUN_ID: "run-1" });
});

test("a probe Run has no tools at all", async () => {
  const dir = tempDir();
  const { replay } = await run(
    coderSpec(dir, {
      kind: "probe",
      model: "haiku",
      prompt: "Reply with the single word ok.",
      systemPrompt: "",
      permissions: {
        read: true,
        edit: false,
        shell: [],
        network: false,
        mcp: false,
        extraAllow: [],
      },
    }),
    { fixture: "completed" },
  );
  const [argv] = replay.argv();
  expect(argv?.slice(argv.indexOf("--strict-mcp-config"))).toEqual([
    "--strict-mcp-config",
    "--tools",
    "",
  ]);
});

test("the repo's own permission grants outside the Run's allowlist are denied", async () => {
  const dir = tempDir();
  const spec = coderSpec(dir, {
    kind: "reviewer",
    permissions: {
      read: true,
      edit: false,
      shell: ["git log *"],
      network: false,
      mcp: false,
      extraAllow: [],
    },
  });
  mkdirSync(join(spec.cwd, ".claude"));
  writeFileSync(
    join(spec.cwd, ".claude", "settings.json"),
    JSON.stringify({
      permissions: {
        allow: ["Bash(node *)", "Read(./**)", "Bash(git log *)", "Edit"],
      },
    }),
  );
  const { replay } = await run(spec, { fixture: "completed" });
  const argv = replay.argv()[0] ?? [];
  expect(
    argv.slice(
      argv.indexOf("--disallowedTools") + 1,
      argv.indexOf("--setting-sources"),
    ),
  ).toEqual([...alwaysDenied, ...networkTools, "Bash(node *)", "Edit"]);
});

test("a repo grant the Run's allowlist already covers is left alone", async () => {
  const spec = coderSpec(tempDir(), {
    kind: "onboarding",
    permissions: {
      read: true,
      edit: true,
      shell: ["*"],
      network: true,
      mcp: false,
      extraAllow: [],
    },
  });
  mkdirSync(join(spec.cwd, ".claude"));
  writeFileSync(
    join(spec.cwd, ".claude", "settings.json"),
    JSON.stringify({
      permissions: {
        allow: ["Bash(npm run test:*)", "WebFetch(domain:example.com)", "Edit"],
      },
    }),
  );
  const { replay } = await run(spec, { fixture: "completed" });
  const argv = replay.argv()[0] ?? [];
  expect(
    argv.slice(
      argv.indexOf("--disallowedTools") + 1,
      argv.indexOf("--setting-sources"),
    ),
  ).toEqual([...alwaysDenied, "Edit"]);
});

test("a repo without settings, or with unreadable ones, adds no deny entries", async () => {
  for (const settings of [undefined, "{ not json", '{"permissions":{}}']) {
    const spec = coderSpec(tempDir());
    if (settings !== undefined) {
      mkdirSync(join(spec.cwd, ".claude"));
      writeFileSync(join(spec.cwd, ".claude", "settings.json"), settings);
    }
    const { replay } = await run(spec, { fixture: "completed" });
    const argv = replay.argv()[0] ?? [];
    expect(
      argv.slice(
        argv.indexOf("--disallowedTools") + 1,
        argv.indexOf("--setting-sources"),
      ),
    ).toEqual([...alwaysDenied, ...networkTools]);
  }
});

test("a resumed, read-only Run with an output schema and network allowed", async () => {
  const dir = tempDir();
  const schema = { type: "object", required: ["decision"] };
  const { replay, events } = await run(
    coderSpec(dir, {
      kind: "reviewer",
      model: "opus",
      systemPrompt: "",
      resumeSessionId: "5b1c3a52-58a4-4c39-9f53-4b3b5f0b9a10",
      outputSchema: schema,
      permissions: {
        read: true,
        edit: false,
        shell: ["git log *"],
        network: false,
        mcp: false,
        extraAllow: ["WebFetch(domain:example.com)"],
      },
    }),
    { fixture: "completed-structured" },
  );
  expect(replay.argv()[0]).toEqual([
    "-p",
    "Do the task.",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    "opus",
    "--resume",
    "5b1c3a52-58a4-4c39-9f53-4b3b5f0b9a10",
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
    "--allowedTools",
    "Read(./**)",
    "Bash(git log *)",
    "WebFetch(domain:example.com)",
    "--disallowedTools",
    ...alwaysDenied,
    "WebSearch",
    "Bash(curl *)",
    "Bash(wget *)",
    "--setting-sources",
    "project",
    "--strict-mcp-config",
    "--json-schema",
    JSON.stringify(schema),
  ]);
  expect(events[0]).toEqual({
    type: "started",
    sessionId: "5b1c3a52-58a4-4c39-9f53-4b3b5f0b9a10",
  });
});

test("the onboarding profile allows every command and the network, minus the always-denied set", async () => {
  const dir = tempDir();
  const { replay } = await run(
    coderSpec(dir, {
      kind: "onboarding",
      permissions: {
        read: true,
        edit: true,
        shell: ["*"],
        network: true,
        mcp: false,
        extraAllow: [],
      },
    }),
    { fixture: "completed-structured" },
  );
  const argv = replay.argv()[0] ?? [];
  const allowed = argv.slice(
    argv.indexOf("--allowedTools") + 1,
    argv.indexOf("--disallowedTools"),
  );
  const denied = argv.slice(
    argv.indexOf("--disallowedTools") + 1,
    argv.indexOf("--setting-sources"),
  );
  expect(allowed).toEqual([
    "Read(./**)",
    "Edit(./**)",
    "Bash",
    "WebFetch",
    "WebSearch",
  ]);
  expect(denied).toEqual(alwaysDenied);
});

test("a completed Run streams readable output and tees the raw stream to the transcript", async () => {
  const dir = tempDir();
  const spec = coderSpec(dir);
  const { replay, events, result } = await run(spec, { fixture: "completed" });
  const [started] = events;
  const sessionId = started?.type === "started" ? started.sessionId : "";
  // The model's words and tool choice vary between recordings.
  expect(result).toEqual({
    kind: "completed",
    sessionId,
    finalText: expect.stringMatching(/hello/i),
  });
  const output = events.flatMap((event) =>
    event.type === "output" ? [event.text] : [],
  );
  expect(output.slice(0, -1)).toEqual(
    output.slice(0, -1).map(() => expect.stringMatching(toolCall)),
  );
  expect(output.length).toBeGreaterThan(1);
  expect(output.at(-1)).toBe(
    `${result.kind === "completed" ? result.finalText : ""}\n`,
  );
  expect(
    events.filter(({ type }) => type === "activity").length,
  ).toBeGreaterThan(0);
  const recorded = readFileSync(
    new URL("./fixtures/completed.jsonl", import.meta.url),
    "utf8",
  );
  expect(readFileSync(spec.transcriptPath, "utf8")).toBe(
    recorded.replaceAll("__SESSION_ID__", sessionId),
  );
  expect(replay.argv()).toHaveLength(1);
});

test("structured output is set only when the RunSpec asked for a schema", async () => {
  const schema = { type: "object" };
  const withSchema = await run(coderSpec(tempDir(), { outputSchema: schema }), {
    fixture: "completed-structured",
  });
  expect(withSchema.result).toMatchObject({
    kind: "completed",
    finalText: expect.any(String),
    structured: { word: expect.stringMatching(/hello/i) },
  });
  const without = await run(coderSpec(tempDir()), {
    fixture: "completed-structured",
  });
  expect(without.result).not.toHaveProperty("structured");
});

test("an error result is failed, with the CLI's message and exit code", async () => {
  const { result } = await run(coderSpec(tempDir()), { fixture: "failed" });
  expect(result).toEqual({
    kind: "failed",
    detail: expect.stringContaining("no-such-model-segno"),
    exitCode: 1,
  });
});

test("a non-zero exit is failed even after a successful result", async () => {
  const { result } = await run(coderSpec(tempDir()), {
    fixture: "completed",
    exit: 2,
  });
  expect(result).toEqual({
    kind: "failed",
    detail: expect.stringMatching(/hello/i),
    exitCode: 2,
  });
});

test("death by signal is crashed", async () => {
  const { events, result } = await run(coderSpec(tempDir()), {
    fixture: "crashed",
  });
  expect(result).toEqual({
    kind: "crashed",
    detail: "claude was killed by SIGKILL.",
  });
  expect(events.filter(({ type }) => type === "output")).toEqual([
    { type: "output", text: expect.stringMatching(toolCall) },
  ]);
});

test("a stream that ends without a result is crashed, with its exit code", async () => {
  const { result } = await run(coderSpec(tempDir()), {
    fixture: "crashed",
    signal: undefined,
    exit: 143,
  });
  expect(result).toEqual({
    kind: "crashed",
    detail: "The stream ended without a result.",
    exitCode: 143,
  });
});

test("a binary that can't be started is crashed", async () => {
  const adapter = claudeCodeAdapter({ binary: join(tempDir(), "missing") });
  const handle = adapter.start(coderSpec(tempDir()));
  expect(await handle.result).toMatchObject({ kind: "crashed" });
  await handle.stop();
});

test("stop() ends the process, is idempotent and resolves once it has exited", async () => {
  const replay = replayStub(tempDir(), { fixture: "crashed", hold: true });
  const handle = claudeCodeAdapter({ binary: replay.binary }).start(
    coderSpec(tempDir()),
  );
  for await (const event of handle.events) if (event.type === "output") break;
  let exited = false;
  void handle.result.then(() => {
    exited = true;
  });
  await Promise.all([handle.stop(), handle.stop()]);
  expect(exited).toBe(true);
  expect(await handle.result).toEqual({
    kind: "crashed",
    detail: "The stream ended without a result.",
    exitCode: 143,
  });
  await handle.stop();
});

test("stop() kills a process that ignores SIGTERM after the grace period", async () => {
  const replay = replayStub(tempDir(), {
    fixture: "crashed",
    hold: true,
    ignoreTerm: true,
  });
  const handle = claudeCodeAdapter({
    binary: replay.binary,
    stopGraceMs: 200,
  }).start(coderSpec(tempDir()));
  for await (const event of handle.events) if (event.type === "output") break;
  await handle.stop();
  expect(await handle.result).toEqual({
    kind: "crashed",
    detail: "claude was killed by SIGKILL.",
  });
});

test("stop() kills a tool process that outlives claude once the grace period ends", async () => {
  const replay = replayStub(tempDir(), {
    fixture: "crashed",
    hold: true,
    orphan: true,
  });
  const handle = claudeCodeAdapter({
    binary: replay.binary,
    stopGraceMs: 200,
  }).start(coderSpec(tempDir()));
  for await (const event of handle.events) if (event.type === "output") break;
  const tool = replay.orphanPid();
  cleanups.push(() => {
    try {
      process.kill(tool, "SIGKILL");
    } catch {}
  });
  await handle.stop();
  expect(alive(tool)).toBe(false);
});

/** Whether a process exists, a zombie not yet reaped included. */
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("a usage-limit signal is rate-limited, with resetAt when the CLI gives one", async () => {
  const { events, result } = await run(coderSpec(tempDir()), {
    fixture: "rate-limited",
  });
  expect(result).toEqual({
    kind: "rate-limited",
    resetAt: "2026-10-14T17:00:00.000Z",
    detail: "You've hit your limit · resets 5pm (UTC)",
  });
  expect(events).toContainEqual({
    type: "rateLimited",
    resetAt: "2026-10-14T17:00:00.000Z",
  });
  expect(events).toContainEqual({
    type: "usage",
    used: 100,
    limit: 100,
    resetAt: "2026-10-14T17:00:00.000Z",
  });
});

test("a Run that completes after a rejected limit event, as on overage, is completed", async () => {
  const { result } = await run(coderSpec(tempDir()), {
    fixture: "completed",
    edit: (message) =>
      message.type === "rate_limit_event"
        ? {
            ...message,
            rate_limit_info: {
              ...(message.rate_limit_info as object),
              status: "rejected",
              isUsingOverage: true,
            },
          }
        : message,
  });
  expect(result).toMatchObject({ kind: "completed" });
});

test("a usage-limit signal without a reset time is rate-limited without resetAt", async () => {
  const { events, result } = await run(coderSpec(tempDir()), {
    fixture: "rate-limited-no-reset",
  });
  expect(result).toEqual({
    kind: "rate-limited",
    detail: "You've hit your limit",
  });
  expect(events).toContainEqual({ type: "rateLimited" });
  expect(events.some(({ type }) => type === "usage")).toBe(false);
});

/** The completed fixture, with its usage windows pinned to known values. */
function windows(rateLimitType?: string) {
  return (message: Record<string, unknown>) =>
    message.type === "rate_limit_event"
      ? {
          ...message,
          rate_limit_info: {
            status: "allowed",
            ...(rateLimitType ? { rateLimitType } : {}),
            unifiedWindows: {
              five_hour: { utilization: 0.034, resetsAt: 1791997200 },
              seven_day: { utilization: 0.57, resetsAt: 1792105200 },
            },
          },
        }
      : message;
}

test("usage reports the window the CLI names as binding, as a percentage", async () => {
  const { events } = await run(coderSpec(tempDir()), {
    fixture: "completed",
    edit: windows("five_hour"),
  });
  expect(events.filter(({ type }) => type === "usage")).toEqual([
    {
      type: "usage",
      used: 3,
      limit: 100,
      resetAt: "2026-10-14T17:00:00.000Z",
    },
  ]);
});

test("usage reports the fullest window when the CLI names none", async () => {
  const { events } = await run(coderSpec(tempDir()), {
    fixture: "completed",
    edit: windows(),
  });
  expect(events.filter(({ type }) => type === "usage")).toEqual([
    {
      type: "usage",
      used: 57,
      limit: 100,
      resetAt: "2026-10-15T23:00:00.000Z",
    },
  ]);
});

test("detect() reports the installed version and turns on usage for a version whose stream reports it", async () => {
  const replay = replayStub(tempDir(), { version: "2.1.299 (Claude Code)" });
  const adapter = claudeCodeAdapter({ binary: replay.binary });
  expect(adapter.capabilities.usage).toBe(false);
  expect(await adapter.detect()).toEqual({
    installed: true,
    version: "2.1.299",
    binary: replay.binary,
  });
  expect(adapter.capabilities).toEqual({
    resume: true,
    structuredOutput: true,
    toolAllowlist: true,
    usage: true,
  });
});

test("detect() leaves usage off for an older version, and reports a missing binary", async () => {
  const older = claudeCodeAdapter({
    binary: replayStub(tempDir(), { version: "2.1.250 (Claude Code)" }).binary,
  });
  expect(await older.detect()).toMatchObject({
    installed: true,
    version: "2.1.250",
  });
  expect(older.capabilities.usage).toBe(false);
  const missing = claudeCodeAdapter({ binary: join(tempDir(), "claude") });
  expect(await missing.detect()).toEqual({ installed: false });
  expect(missing.capabilities.usage).toBe(false);
});
