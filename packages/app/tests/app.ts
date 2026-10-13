import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { afterEach } from "vitest";

const appDir = join(import.meta.dirname, "..");
export const electronBinary = createRequire(import.meta.url)(
  "electron",
) as unknown as string;
export const examples = join(import.meta.dirname, "../../../examples");

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});

export function tempDir(prefix = "segno-s9-") {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A repo with one commit on `main`, pushed to a bare `origin`. */
export function repoWithRemote(files: Record<string, string> = {}) {
  const remote = tempDir("segno-remote-");
  git(remote, "init", "-q", "--bare", "-b", "main");
  const repo = tempDir("segno-repo-");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  for (const [name, content] of Object.entries({
    "README.md": "x\n",
    ...files,
  }))
    writeFileSync(join(repo, name), content);
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "initial");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "origin", "main");
  git(repo, "remote", "set-head", "origin", "main");
  return repo;
}

export interface Launched {
  app: ElectronApplication;
  page: Page;
  appData: string;
}

/** Launches the built app on its own app data directory [ADR-0048]. */
export async function launch(appData = tempDir()): Promise<Launched> {
  const app = await _electron.launch({
    args: [appDir],
    env: { ...process.env, SEGNO_APP_DATA: appData },
  });
  cleanups.push(() => app.close().catch(() => {}));
  const page = await app.firstWindow();
  return { app, page, appData };
}

/** Starts a second instance with the same app data and waits for it to exit. */
export function launchSecond(appData: string): Promise<number | null> {
  const child = spawn(electronBinary, [appDir], {
    env: { ...process.env, SEGNO_APP_DATA: appData },
    stdio: "ignore",
  });
  return new Promise((resolve) => child.once("exit", resolve));
}

/** Replaces a main-process dialog so the next call returns `result`. */
export async function stubDialog(
  app: ElectronApplication,
  method: "showOpenDialog" | "showSaveDialog",
  result: object,
) {
  await app.evaluate(
    ({ dialog }, { method, result }) => {
      dialog[method] = (async () => result) as never;
    },
    { method, result },
  );
}

/** The pid of the Engine host utilityProcess, found through app metrics. */
export async function hostPid(app: ElectronApplication) {
  return app.evaluate(({ app }) => {
    const metric = app
      .getAppMetrics()
      // The fork's serviceName option is reported as the metric's name.
      .find(
        ({ type, name }) => type === "Utility" && name === "Segno Engine host",
      );
    return metric?.pid;
  });
}
