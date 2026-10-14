import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Runs git synchronously in `cwd` and returns its trimmed stdout. */
export function gitSync(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/**
 * Temp directories and real git repos for tests at S3, S4, S6 and S9.
 * Call `dispose()` after each test.
 */
export function tempRepos() {
  const dirs: string[] = [];
  function dir(prefix = "segno-test-") {
    const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    dirs.push(path);
    return path;
  }
  return {
    dir,
    /** A repo with one commit on `main`, pushed to a bare `origin`. */
    repoWithRemote(files: Record<string, string> = {}) {
      const remote = dir("segno-remote-");
      gitSync(remote, "init", "-q", "--bare", "-b", "main");
      const repo = dir("segno-repo-");
      gitSync(repo, "init", "-q", "-b", "main");
      gitSync(repo, "config", "user.email", "test@example.com");
      gitSync(repo, "config", "user.name", "Test");
      for (const [name, content] of Object.entries({
        "README.md": "x\n",
        ...files,
      }))
        writeFileSync(join(repo, name), content);
      gitSync(repo, "add", ".");
      gitSync(repo, "commit", "-q", "-m", "initial");
      gitSync(repo, "remote", "add", "origin", remote);
      gitSync(repo, "push", "-q", "origin", "main");
      gitSync(repo, "remote", "set-head", "origin", "main");
      return { repo, remote };
    },
    dispose() {
      for (const path of dirs.splice(0).reverse())
        rmSync(path, { recursive: true, force: true });
    },
  };
}
