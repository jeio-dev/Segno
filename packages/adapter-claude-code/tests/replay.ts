import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where the recorded `stream-json` fixtures live. */
export const fixturesDir = new URL("./fixtures/", import.meta.url).pathname;

export interface FixtureEntry {
  /** How the recorded process ended. */
  exit?: number;
  signal?: NodeJS.Signals;
  /** Edited from a real recording, because the case can't be triggered on demand. */
  derivedFrom?: string;
}
export type FixtureName =
  | "completed"
  | "completed-structured"
  | "failed"
  | "crashed"
  | "rate-limited"
  | "rate-limited-no-reset";

export function fixtureManifest(): {
  recordedWith: string;
  fixtures: Record<FixtureName, FixtureEntry>;
} {
  return JSON.parse(readFileSync(join(fixturesDir, "fixtures.json"), "utf8"));
}

/** The placeholder a fixture holds where the CLI printed the session id. */
export const sessionPlaceholder = "__SESSION_ID__";

/** Keys of the init message that describe the recording machine, not the CLI. */
const machineKeys = [
  "plugins",
  "skills",
  "slash_commands",
  "terminal_slash_commands",
  "agents",
  "memory_paths",
  "messaging_socket_path",
];

/** Makes one recorded line safe to commit: no local paths or session id. */
export function sanitize(line: string, { cwd }: { cwd: string }) {
  const message = JSON.parse(line);
  if (message.type === "system" && message.subtype === "init")
    for (const key of machineKeys) delete message[key];
  const sessionId = message.session_id;
  let text = JSON.stringify(message)
    .replaceAll(cwd, "/work/repo")
    .replaceAll(homedir(), "/home/user");
  if (typeof sessionId === "string")
    text = text.replaceAll(sessionId, sessionPlaceholder);
  return text;
}

export interface StubOptions {
  /** The fixture to replay; absent, nothing is printed. */
  fixture?: FixtureName;
  exit?: number;
  /** `undefined` overrides the recorded signal. */
  signal?: NodeJS.Signals | undefined;
  /** After replaying, wait to be signalled; SIGTERM then exits 143, as claude does. */
  hold?: boolean;
  /** Ignore SIGTERM while holding, so only SIGKILL ends it. */
  ignoreTerm?: boolean;
  /**
   * Start a tool process in the stub's process group that ignores SIGTERM
   * and holds none of its pipes, then exit on SIGTERM as claude does.
   */
  orphan?: boolean;
  /** Printed for `--version`. */
  version?: string;
  /** Edits the fixture's messages, for a case no recording shows. */
  edit?: (message: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * Writes a `claude` replay stub into `dir`. It records its argv, replays the
 * fixture with the session id it was given, then exits as recorded.
 */
export function replayStub(dir: string, options: StubOptions = {}) {
  const manifest = fixtureManifest();
  const recorded = options.fixture
    ? manifest.fixtures[options.fixture]
    : undefined;
  const config = {
    lines: options.fixture
      ? readFileSync(join(fixturesDir, `${options.fixture}.jsonl`), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) =>
            options.edit
              ? JSON.stringify(options.edit(JSON.parse(line)))
              : line,
          )
      : [],
    exit: options.exit ?? recorded?.exit ?? 0,
    signal: "signal" in options ? options.signal : recorded?.signal,
    hold: options.hold ?? false,
    ignoreTerm: options.ignoreTerm ?? false,
    orphan: options.orphan ?? false,
    orphanPidPath: join(dir, "orphan.pid"),
    version: options.version ?? `${manifest.recordedWith} (Claude Code)`,
    argvPath: join(dir, "argv.jsonl"),
    envPath: join(dir, "env.json"),
    cwdPath: join(dir, "cwd.txt"),
    placeholder: sessionPlaceholder,
  };
  const binary = join(dir, "claude");
  writeFileSync(
    binary,
    `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
const config = ${JSON.stringify(config)};
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log(config.version);
  process.exit(0);
}
appendFileSync(config.argvPath, JSON.stringify(args) + "\\n");
writeFileSync(config.envPath, JSON.stringify(process.env));
writeFileSync(config.cwdPath, process.cwd());
const at = (flag) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
const session = at("--session-id") ?? at("--resume") ?? "none";
if (config.orphan) {
  // The tool writes its pid once it ignores SIGTERM; the stub waits for that.
  spawn(
    process.execPath,
    [
      "-e",
      "process.on('SIGTERM', () => {});" +
        "require('node:fs').writeFileSync(process.argv[1], String(process.pid));" +
        "setInterval(() => {}, 1000);",
      config.orphanPidPath,
    ],
    { stdio: "ignore" },
  );
  while (!existsSync(config.orphanPidPath))
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
// Installed before any output, so a stop() that follows the output finds it.
if (config.hold)
  process.on("SIGTERM", () => { if (!config.ignoreTerm) process.exit(143); });
for (const line of config.lines)
  process.stdout.write(line.replaceAll(config.placeholder, session) + "\\n");
function end() {
  if (config.signal) process.kill(process.pid, config.signal);
  else process.exit(config.exit);
}
if (config.hold) setInterval(() => {}, 1000);
else process.stdout.write("", end);
`,
  );
  chmodSync(binary, 0o755);
  return {
    binary,
    /** Every argv the stub was started with, in order. */
    argv(): string[][] {
      try {
        return readFileSync(config.argvPath, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },
    env(): Record<string, string> {
      return JSON.parse(readFileSync(config.envPath, "utf8"));
    },
    cwd() {
      return readFileSync(config.cwdPath, "utf8");
    },
    /** The pid of the tool process `orphan` started. */
    orphanPid() {
      return Number(readFileSync(config.orphanPidPath, "utf8"));
    },
  };
}

/**
 * A usage limit can't be hit on demand, so it's derived from the failed
 * recording: the CLI's synthetic error message and result, with a rejected
 * `rate_limit_event`. The reset time is fixed so the S5 literals hold.
 */
export function deriveRateLimited(
  failed: string[],
  completed: string[],
  withReset: boolean,
) {
  const parse = (line: string) => JSON.parse(line) as Record<string, unknown>;
  const [init, ...rest] = failed.map(parse);
  const model = parse(completed[0] ?? "{}").model;
  const event = completed
    .map(parse)
    .find(({ type }) => type === "rate_limit_event");
  const text = withReset
    ? "You've hit your limit · resets 5pm (UTC)"
    : "You've hit your limit";
  const resetsAt = 1791997200;
  const limit = {
    type: "rate_limit_event",
    rate_limit_info: {
      status: "rejected",
      ...(withReset ? { resetsAt } : {}),
      rateLimitType: "five_hour",
      overageStatus: "rejected",
      overageDisabledReason: "out_of_credits",
      isUsingOverage: false,
      ...(withReset
        ? {
            unifiedWindows: {
              five_hour: { utilization: 1.0, resetsAt },
              seven_day: { utilization: 0.57, resetsAt: 1792105200 },
            },
          }
        : {}),
    },
    uuid: event?.uuid,
    session_id: init?.session_id,
  };
  const lines = rest.map((message) => {
    if (message.type === "assistant") {
      const inner = message.message as { content: unknown[] };
      return {
        ...message,
        message: { ...inner, content: [{ type: "text", text }] },
        error: "rate_limit",
        api_error_status: 429,
      };
    }
    if (message.type === "result")
      return { ...message, result: text, api_error_status: 429 };
    return message;
  });
  return [{ ...init, model }, limit, ...lines].map((message) =>
    JSON.stringify(message),
  );
}
