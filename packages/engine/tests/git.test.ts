import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  commitLeftovers,
  createTaskWorktree,
  cutPhaseBranch,
  diffAgainstPhase,
  fastForward,
  fetchRemote,
  GitError,
  mergePhaseInto,
  removeTaskWorktree,
} from "../src/git.js";
import { gitSync as git, tempRepos } from "../src/testing/repos.js";

const repos = tempRepos();
afterEach(() => repos.dispose());

test("a Phase branch is cut from the fetched remote base, not the local branch", async () => {
  const { repo, remote } = repos.repoWithRemote();
  // The remote moves on after the clone, and the local main lags behind it.
  const other = repos.dir();
  git(other, "clone", "-q", remote, ".");
  git(other, "config", "user.email", "teammate@example.com");
  git(other, "config", "user.name", "Teammate");
  writeFileSync(join(other, "pulled.txt"), "from a teammate\n");
  git(other, "add", ".");
  git(other, "commit", "-q", "-m", "teammate change");
  git(other, "push", "-q", "origin", "main");
  const remoteTip = git(other, "rev-parse", "HEAD");
  const localTip = git(repo, "rev-parse", "main");

  await fetchRemote(repo, "origin");
  const baseSha = await cutPhaseBranch(repo, {
    branch: "segno/search-notes/index",
    remote: "origin",
    baseBranch: "main",
  });

  expect(baseSha).toBe(remoteTip);
  expect(git(repo, "rev-parse", "segno/search-notes/index")).toBe(remoteTip);
  expect(git(repo, "rev-parse", "main")).toBe(localTip);
});

test("fetching an unreachable remote fails with a git error", async () => {
  const { repo } = repos.repoWithRemote();
  git(repo, "remote", "set-url", "origin", join(repos.dir(), "gone.git"));
  await expect(fetchRemote(repo, "origin")).rejects.toBeInstanceOf(GitError);
});

/** A repo with a Phase branch cut from origin/main. */
async function withPhaseBranch(files: Record<string, string> = {}) {
  const { repo, remote } = repos.repoWithRemote(files);
  const phase = "segno/search-notes/index";
  await fetchRemote(repo, "origin");
  await cutPhaseBranch(repo, {
    branch: phase,
    remote: "origin",
    baseBranch: "main",
  });
  return { repo, remote, phase };
}

test("a Task worktree is created outside the repo on its Task branch at the Phase tip", async () => {
  const { repo, phase } = await withPhaseBranch();
  const path = join(repos.dir("segno-worktrees-"), "index-notes");

  await createTaskWorktree(repo, {
    path,
    branch: "segno/search-notes/index--index-notes",
    from: phase,
  });

  expect(git(path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
    "segno/search-notes/index--index-notes",
  );
  expect(git(path, "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", phase));
  expect(git(repo, "status", "--porcelain")).toBe("");
  expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
});

async function withTaskWorktree(files: Record<string, string> = {}) {
  const phased = await withPhaseBranch(files);
  const path = join(repos.dir("segno-worktrees-"), "index-notes");
  const branch = "segno/search-notes/index--index-notes";
  await createTaskWorktree(phased.repo, { path, branch, from: phased.phase });
  return { ...phased, path, branch };
}

test("leftover changes are committed with the developer's identity and the Segno-Task trailer", async () => {
  const { path } = await withTaskWorktree();
  writeFileSync(join(path, "README.md"), "changed\n");
  writeFileSync(join(path, "index.ts"), "export {};\n");

  const sha = await commitLeftovers(path, {
    message: "segno: uncommitted changes (run-1)",
    taskId: "index-notes",
  });

  expect(sha).toBe(git(path, "rev-parse", "HEAD"));
  expect(git(path, "log", "-1", "--format=%an <%ae>")).toBe(
    "Test <test@example.com>",
  );
  expect(git(path, "log", "-1", "--format=%B")).toBe(
    "segno: uncommitted changes (run-1)\n\nSegno-Task: index-notes",
  );
  expect(
    git(path, "show", "--name-only", "--format=", "HEAD").split("\n").sort(),
  ).toEqual(["README.md", "index.ts"]);
  expect(git(path, "status", "--porcelain")).toBe("");
});

test("a clean worktree commits nothing", async () => {
  const { path } = await withTaskWorktree();
  const head = git(path, "rev-parse", "HEAD");
  expect(
    await commitLeftovers(path, {
      message: "segno: uncommitted changes (run-1)",
      taskId: "index-notes",
    }),
  ).toBeUndefined();
  expect(git(path, "rev-parse", "HEAD")).toBe(head);
});

/** Moves the Phase branch on by one commit, as another Task's merge would. */
function advancePhase(
  repo: string,
  phase: string,
  files: Record<string, string>,
) {
  const other = join(repos.dir("segno-worktrees-"), "other");
  git(repo, "worktree", "add", "-q", other, phase);
  for (const [name, content] of Object.entries(files))
    writeFileSync(join(other, name), content);
  git(other, "add", ".");
  git(other, "commit", "-q", "-m", "other Task");
  git(repo, "worktree", "remove", "--force", other);
  return git(repo, "rev-parse", phase);
}

const merge = { taskId: "index-notes", message: "segno: merge Phase branch" };

test("merging an unmoved Phase branch has nothing to merge", async () => {
  const { path, phase } = await withTaskWorktree();
  writeFileSync(join(path, "index.ts"), "export {};\n");
  await commitLeftovers(path, { message: "work", taskId: "index-notes" });
  const head = git(path, "rev-parse", "HEAD");

  expect(await mergePhaseInto(path, { phase, ...merge })).toEqual({
    kind: "up-to-date",
  });
  expect(git(path, "rev-parse", "HEAD")).toBe(head);
});

test("a clean merge of a moved Phase branch commits with the trailer and reports lockfile changes", async () => {
  const { repo, path, phase } = await withTaskWorktree();
  writeFileSync(join(path, "index.ts"), "export {};\n");
  await commitLeftovers(path, { message: "work", taskId: "index-notes" });
  const taskTip = git(path, "rev-parse", "HEAD");
  const phaseTip = advancePhase(repo, phase, {
    "pnpm-lock.yaml": "lockfileVersion: 9\n",
  });

  const result = await mergePhaseInto(path, { phase, ...merge });

  expect(result).toEqual({
    kind: "merged",
    sha: git(path, "rev-parse", "HEAD"),
    lockfileChanged: true,
  });
  expect(git(path, "log", "-1", "--format=%P")).toBe(`${taskTip} ${phaseTip}`);
  expect(
    git(path, "log", "-1", "--format=%(trailers:key=Segno-Task,valueonly)"),
  ).toBe("index-notes");
});

test("a clean merge without lockfile changes says so", async () => {
  const { repo, path, phase } = await withTaskWorktree();
  advancePhase(repo, phase, { "notes.md": "notes\n" });
  expect(await mergePhaseInto(path, { phase, ...merge })).toMatchObject({
    kind: "merged",
    lockfileChanged: false,
  });
});

test("a conflicting merge lists the files and is left in progress", async () => {
  const { repo, path, phase } = await withTaskWorktree();
  writeFileSync(join(path, "README.md"), "mine\n");
  await commitLeftovers(path, { message: "work", taskId: "index-notes" });
  advancePhase(repo, phase, { "README.md": "theirs\n" });

  expect(await mergePhaseInto(path, { phase, ...merge })).toEqual({
    kind: "conflict",
    files: ["README.md"],
  });
  expect(
    existsSync(
      git(
        path,
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "MERGE_HEAD",
      ),
    ),
  ).toBe(true);
});

test("the Phase branch fast-forwards to a merged Task branch", async () => {
  const { repo, path, phase, branch } = await withTaskWorktree();
  writeFileSync(join(path, "index.ts"), "export {};\n");
  const taskTip = await commitLeftovers(path, {
    message: "work",
    taskId: "index-notes",
  });

  await fastForward(repo, { branch: phase, to: branch });

  expect(git(repo, "rev-parse", phase)).toBe(taskTip);
});

test("the Phase branch refuses to move except by fast-forward", async () => {
  const { repo, path, phase, branch } = await withTaskWorktree();
  writeFileSync(join(path, "index.ts"), "export {};\n");
  await commitLeftovers(path, { message: "work", taskId: "index-notes" });
  const phaseTip = advancePhase(repo, phase, { "notes.md": "notes\n" });

  await expect(
    fastForward(repo, { branch: phase, to: branch }),
  ).rejects.toBeInstanceOf(GitError);
  expect(git(repo, "rev-parse", phase)).toBe(phaseTip);
});

test("a Task's diff is its own changes against its merge-base with the Phase branch", async () => {
  const { repo, path, phase, branch } = await withTaskWorktree();
  writeFileSync(join(path, "index.ts"), "export {};\n");
  await commitLeftovers(path, { message: "work", taskId: "index-notes" });
  advancePhase(repo, phase, { "notes.md": "notes\n" });

  expect(await diffAgainstPhase(repo, { phase, head: branch })).toBe(
    [
      "diff --git a/index.ts b/index.ts",
      "new file mode 100644",
      "index 0000000..cb0ff5c",
      "--- /dev/null",
      "+++ b/index.ts",
      "@@ -0,0 +1 @@",
      "+export {};",
      "",
    ].join("\n"),
  );
});

test("removing a Task worktree deletes it and its Task branch", async () => {
  const { repo, path, branch } = await withTaskWorktree();
  writeFileSync(join(path, "scratch.txt"), "left behind\n");

  await removeTaskWorktree(repo, { path, branch });

  expect(existsSync(path)).toBe(false);
  expect(git(repo, "branch", "--list", branch)).toBe("");
  expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(path);
});
