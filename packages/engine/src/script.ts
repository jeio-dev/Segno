import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";

export interface ScriptResult {
  exitCode?: number;
  signal?: string;
  error?: string;
}

/**
 * Runs `command` through the user's shell in `cwd` [ADR-0029]. Combined stdout
 * and stderr go to `logPath` and to `onOutput` as they arrive.
 */
export function runScript({
  command,
  cwd,
  env,
  logPath,
  onOutput,
}: {
  command: string;
  cwd: string;
  env: Record<string, string>;
  logPath: string;
  onOutput(text: string): void;
}) {
  const log = createWriteStream(logPath);
  // A lost output.log must not take the host down; the exit code still counts.
  log.on("error", () => {});
  // Its own process group, so stop() also ends whatever the command started.
  const child = spawn("sh", ["-c", command], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const write = (chunk: Buffer) => {
    log.write(chunk);
    onOutput(chunk.toString("utf8"));
  };
  child.stdout.on("data", write);
  child.stderr.on("data", write);
  const result = new Promise<ScriptResult>((resolve) => {
    child.once("error", (error) => {
      log.end(() => resolve({ error: error.message }));
    });
    child.once("close", (code, signal) => {
      log.end(() =>
        resolve({
          ...(code === null ? {} : { exitCode: code }),
          ...(signal === null ? {} : { signal }),
        }),
      );
    });
  });
  return {
    result,
    async stop() {
      if (child.exitCode === null && child.signalCode === null && child.pid)
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {}
      await result;
    },
  };
}
