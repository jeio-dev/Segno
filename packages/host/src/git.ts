import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";

/** Runs git in `cwd`; resolves stdout trimmed, or undefined when git fails. */
export function git(
  cwd: string,
  ...args: string[]
): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, encoding: "utf8" }, (error, stdout) => {
      resolve(error ? undefined : stdout.trim());
    });
  });
}

/** The real path of `path` when it is itself a git top-level. */
export async function topLevelOf(path: string) {
  const top = await git(path, "rev-parse", "--show-toplevel");
  return top !== undefined && realPath(top) === realPath(path)
    ? realPath(top)
    : undefined;
}

export async function remotes(top: string) {
  return ((await git(top, "remote")) ?? "").split("\n").filter(Boolean);
}

export function realPath(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
