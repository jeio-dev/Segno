import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";

/** A git operation that failed without a conflict: an infra failure [ADR-0029]. */
export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly stderr: string,
    readonly exitCode?: number,
  ) {
    super(`git ${args.join(" ")} failed: ${stderr.trim()}`);
    this.name = "GitError";
  }
}

/** Runs git non-interactively in `cwd`; rejects with a GitError on failure. */
export function git(cwd: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
      (error, stdout, stderr) => {
        if (error)
          reject(
            new GitError(
              args,
              stderr || error.message,
              typeof error.code === "number" ? error.code : undefined,
            ),
          );
        else resolve(stdout.trimEnd());
      },
    );
  });
}

export async function fetchRemote(repo: string, remote: string) {
  await git(repo, "fetch", "--quiet", remote);
}

/**
 * Cuts the Phase branch from `<remote>/<baseBranch>`, never the local branch,
 * and returns the commit it was cut at [ADR-0029].
 */
export async function cutPhaseBranch(
  repo: string,
  {
    branch,
    remote,
    baseBranch,
  }: { branch: string; remote: string; baseBranch: string },
) {
  const baseSha = await git(
    repo,
    "rev-parse",
    "--verify",
    `refs/remotes/${remote}/${baseBranch}^{commit}`,
  );
  await git(repo, "branch", "--no-track", branch, baseSha);
  return baseSha;
}

/** A Task's worktree, outside the repo, on a new Task branch [ADR-0009] [ADR-0033]. */
export async function createTaskWorktree(
  repo: string,
  { path, branch, from }: { path: string; branch: string; from: string },
) {
  await git(repo, "worktree", "add", "--quiet", "-b", branch, path, from);
}

/**
 * Onboarding's scratch worktree, detached at `ref` with no branch; returns
 * the commit it was detached at [ADR-0049].
 */
export async function createScratchWorktree(
  repo: string,
  { path, ref }: { path: string; ref: string },
) {
  const sha = await git(repo, "rev-parse", "--verify", `${ref}^{commit}`);
  await git(repo, "worktree", "add", "--quiet", "--detach", path, sha);
  return sha;
}

/** Deletes the scratch worktree, including one a crash left behind. */
export async function removeScratchWorktree(repo: string, path: string) {
  await git(repo, "worktree", "remove", "--force", "--force", path).catch(
    () => {},
  );
  await rm(path, { recursive: true, force: true });
  await git(repo, "worktree", "prune");
}

/** Commits a Segno-made commit with the developer's identity and trailer [ADR-0029]. */
function commit(cwd: string, message: string, taskId: string) {
  return git(
    cwd,
    "commit",
    "--quiet",
    "-m",
    message,
    "--trailer",
    `Segno-Task: ${taskId}`,
  );
}

/** Commits everything left uncommitted; returns the new sha, or undefined if clean. */
export async function commitLeftovers(
  worktree: string,
  { message, taskId }: { message: string; taskId: string },
) {
  await git(worktree, "add", "--all");
  if (!(await git(worktree, "status", "--porcelain"))) return undefined;
  await commit(worktree, message, taskId);
  return git(worktree, "rev-parse", "HEAD");
}

const lockfiles = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lockb",
]);

export type MergeResult =
  | { kind: "up-to-date" }
  | { kind: "merged"; sha: string; lockfileChanged: boolean }
  | { kind: "conflict"; files: string[] };

/**
 * Merges the Phase branch tip into the Task branch checked out at `worktree`,
 * non-interactively [ADR-0005]. A conflict is left in progress for the Coder.
 */
export async function mergePhaseInto(
  worktree: string,
  {
    phase,
    taskId,
    message,
  }: { phase: string; taskId: string; message: string },
): Promise<MergeResult> {
  const before = await git(worktree, "rev-parse", "HEAD");
  if (await isAncestor(worktree, phase, before)) return { kind: "up-to-date" };
  try {
    await git(worktree, "merge", "--quiet", "--no-ff", "--no-commit", phase);
  } catch (error) {
    const files = (
      await git(worktree, "diff", "--name-only", "--diff-filter=U")
    )
      .split("\n")
      .filter(Boolean);
    if (files.length) return { kind: "conflict", files };
    throw error;
  }
  await commit(worktree, message, taskId);
  const changed = await git(worktree, "diff", "--name-only", before, "HEAD");
  return {
    kind: "merged",
    sha: await git(worktree, "rev-parse", "HEAD"),
    lockfileChanged: changed
      .split("\n")
      .some((file) => lockfiles.has(file.split("/").at(-1) ?? "")),
  };
}

async function isAncestor(cwd: string, ancestor: string, of: string) {
  try {
    await git(cwd, "merge-base", "--is-ancestor", ancestor, of);
    return true;
  } catch (error) {
    // Exit code 1 means "not an ancestor"; anything else is a real failure.
    if (error instanceof GitError && error.exitCode === 1) return false;
    throw error;
  }
}

/** Moves `branch` to `to`, only by fast-forward [ADR-0005]. */
export async function fastForward(
  repo: string,
  { branch, to }: { branch: string; to: string },
) {
  const current = await git(
    repo,
    "rev-parse",
    "--verify",
    `refs/heads/${branch}`,
  );
  const target = await git(repo, "rev-parse", "--verify", `${to}^{commit}`);
  if (!(await isAncestor(repo, current, target)))
    throw new GitError(
      ["update-ref", `refs/heads/${branch}`, target],
      `${branch} can't fast-forward to ${to}.`,
    );
  // The old value guards against the branch moving underneath us.
  await git(repo, "update-ref", `refs/heads/${branch}`, target, current);
}

/** A unified diff of `head` against its merge-base with the Phase branch. */
export function diffAgainstPhase(
  repo: string,
  { phase, head }: { phase: string; head: string },
) {
  return git(
    repo,
    "diff",
    "--no-color",
    "--no-ext-diff",
    `${phase}...${head}`,
  ).then((diff) => (diff ? `${diff}\n` : ""));
}

/** Deletes a Task's worktree together with its Task branch [ADR-0033]. */
export async function removeTaskWorktree(
  repo: string,
  { path, branch }: { path: string; branch: string },
) {
  await git(repo, "worktree", "remove", "--force", "--force", path);
  await git(repo, "branch", "-D", branch);
}

/**
 * The Plan slugs that already have Segno branches in the repo, locally or on
 * `remote` as last fetched [ADR-0053].
 */
export async function slugsWithBranches(repo: string, remote: string) {
  const refs = await git(
    repo,
    "for-each-ref",
    "--format=%(refname)",
    "refs/heads/segno/",
    `refs/remotes/${remote}/segno/`,
  );
  return new Set(
    refs
      .split("\n")
      .filter(Boolean)
      .map((ref) => ref.replace(/^refs\/(heads|remotes\/[^/]+)\/segno\//, ""))
      .map((rest) => rest.split("/")[0] ?? ""),
  );
}
