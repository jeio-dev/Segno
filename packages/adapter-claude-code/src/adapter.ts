import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, readFileSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  AgentAdapter,
  RunEvent,
  RunHandle,
  RunResult,
  RunSpec,
} from "@segno/core";
import { atLeast, detectClaude, usageSince } from "./detect.js";
import { argvFor } from "./flags.js";
import { readStream } from "./stream.js";

export interface ClaudeCodeOptions {
  /** The `claude` binary; S5 points it at a replay stub. */
  binary?: string;
  /** How long `stop()` waits after SIGTERM before SIGKILL. */
  stopGraceMs?: number;
}

/** The Claude Code Adapter: `claude -p` with stream-json [ADR-0017]. */
export function claudeCodeAdapter({
  binary = "claude",
  stopGraceMs = 10_000,
}: ClaudeCodeOptions = {}) {
  const capabilities = {
    resume: true,
    structuredOutput: true,
    toolAllowlist: true,
    // Known only once detect() has seen the installed version.
    usage: false,
  };
  return {
    id: "claude-code",
    capabilities,
    async detect() {
      const detected = await detectClaude(binary);
      capabilities.usage = Boolean(
        detected.version && atLeast(detected.version, usageSince),
      );
      return detected;
    },
    start(spec: RunSpec): RunHandle {
      const sessionId = spec.resumeSessionId ?? randomUUID();
      const events = eventQueue();
      const transcript = createWriteStream(spec.transcriptPath, { flags: "a" });
      // A transcript that can't be written loses the record, not the Run.
      transcript.on("error", () => {});
      // Decoded across chunks, so a character split between two reads survives.
      const decoder = new StringDecoder("utf8");
      const stream = readStream({
        sessionId,
        structured: spec.outputSchema !== undefined,
        emit: (event) => events.push(event),
      });
      let stderr = "";
      let exited = false;
      const child = spawn(
        binary,
        argvFor(spec, sessionId, repoGrants(spec.cwd)),
        {
          cwd: spec.cwd,
          env: { ...process.env, ...spec.env },
          stdio: ["ignore", "pipe", "pipe"],
          // Its own process group, so stop() also ends the tools it started.
          detached: true,
        },
      );
      child.stdout.on("data", (chunk: Buffer) => {
        // The raw CLI output, exactly as printed [ADR-0033].
        transcript.write(chunk);
        stream.write(decoder.write(chunk));
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-4000);
      });
      const result = new Promise<RunResult>((resolve) => {
        child.on("error", (error) => {
          exited = true;
          resolve({ kind: "crashed", detail: error.message });
        });
        child.on("close", (code, signal) => {
          exited = true;
          stream.write(decoder.end());
          resolve(stream.end({ code, signal, stderr: stderr.trim() }));
        });
      }).finally(() => {
        events.end();
        transcript.end();
      });
      let stopping: Promise<void> | undefined;
      return {
        events,
        result,
        stop() {
          stopping ??= (async () => {
            const pid = child.pid;
            if (pid === undefined || (exited && !groupAlive(pid))) return;
            signalGroup(pid, "SIGTERM");
            const timer = setTimeout(
              () => signalGroup(pid, "SIGKILL"),
              stopGraceMs,
            );
            await result;
            // Tools claude started can outlive it, so the escalation stands
            // until the whole group has gone (or is past saving).
            const giveUp = Date.now() + stopGraceMs + 5_000;
            while (groupAlive(pid) && Date.now() < giveUp) await sleep(25);
            clearTimeout(timer);
          })();
          return stopping;
        },
      };
    },
  } satisfies AgentAdapter;
}

/** Whether any process of the Run's group is left. */
function groupAlive(pid: number) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The allow rules in the repo's `.claude/settings.json`, if it has any. */
function repoGrants(cwd: string): string[] {
  try {
    const settings = JSON.parse(
      readFileSync(join(cwd, ".claude", "settings.json"), "utf8"),
    );
    const allow = settings?.permissions?.allow;
    return Array.isArray(allow)
      ? allow.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    // Claude Code can't load settings it can't read either.
    return [];
  }
}

function signalGroup(pid: number | undefined, signal: NodeJS.Signals) {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

function eventQueue() {
  const buffered: RunEvent[] = [];
  let ended = false;
  let wake: (() => void) | undefined;
  return {
    push(event: RunEvent) {
      buffered.push(event);
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const next = buffered.shift();
        if (next) yield next;
        else if (ended) return;
        else
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
      }
    },
  };
}
