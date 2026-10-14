import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

/** The oldest version whose stream is recorded reporting usage [ADR-0021]. */
export const usageSince = "2.1.299";

/** Runs `claude --version`; a binary that can't run isn't installed. */
export function detectClaude(binary: string) {
  return new Promise<{ installed: boolean; version?: string; binary?: string }>(
    (resolve) => {
      execFile(binary, ["--version"], { timeout: 10_000 }, (error, stdout) => {
        const version = stdout.match(/\d+\.\d+\.\d+/)?.[0];
        if (error || !version) return resolve({ installed: false });
        const path = resolveBinary(binary);
        resolve({
          installed: true,
          version,
          ...(path ? { binary: path } : {}),
        });
      });
    },
  );
}

/** Whether `version` is at least `minimum`, both as `major.minor.patch`. */
export function atLeast(version: string, minimum: string) {
  const a = version.split(".").map(Number);
  const b = minimum.split(".").map(Number);
  for (let i = 0; i < 3; i++)
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}

function resolveBinary(binary: string) {
  if (binary.includes("/")) return binary;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const path = join(dir, binary);
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {}
  }
  return undefined;
}
