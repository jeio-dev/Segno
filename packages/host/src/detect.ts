import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { InspectResult, SegnoConfig } from "@segno/core";
import { git, remotes as listRemotes } from "./git.js";

type PackageManager = NonNullable<InspectResult["packageManager"]>;

/** The add-project proposal for a repo without segno.config.json [ADR-0039]. */
export async function detectConfig(top: string) {
  const manifest = readManifest(top);
  const packageManager = detectPackageManager(top, manifest);
  const remotes = await listRemotes(top);
  const remote = remotes.includes("origin")
    ? "origin"
    : (remotes[0] ?? "origin");
  const setup = packageManager && setupCommand(top, packageManager);
  const config = {
    schemaVersion: 1,
    baseBranch: await detectBaseBranch(top, remote),
    remote,
    tests: {
      command:
        packageManager && typeof manifest?.scripts?.test === "string"
          ? `${packageManager} test`
          : "",
    },
    ...(setup ? { setup: { command: setup } } : {}),
    roles: {
      planner: { adapter: "claude-code", model: "opus" },
      coder: {
        adapter: "claude-code",
        model: "sonnet",
        docsModel: "haiku",
        allow: packageManager ? [`Bash(${packageManager} *)`] : [],
      },
      reviewer: { adapter: "claude-code", model: "opus" },
    },
  } satisfies SegnoConfig;
  return { config, ...(packageManager ? { packageManager } : {}) };
}

const lockfiles: [string, PackageManager][] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
];

function detectPackageManager(
  top: string,
  manifest: ReturnType<typeof readManifest>,
): PackageManager | undefined {
  for (const [file, manager] of lockfiles)
    if (existsSync(join(top, file))) return manager;
  const declared = String(manifest?.packageManager ?? "").split("@")[0];
  if (lockfiles.some(([, manager]) => manager === declared))
    return declared as PackageManager;
  return manifest ? "npm" : undefined;
}

function setupCommand(top: string, manager: PackageManager) {
  if (!lockfiles.some(([file]) => existsSync(join(top, file))))
    return undefined;
  if (manager === "npm") return "npm ci";
  if (manager === "yarn")
    return existsSync(join(top, ".yarnrc.yml"))
      ? "yarn install --immutable"
      : "yarn install --frozen-lockfile";
  return `${manager} install --frozen-lockfile`;
}

async function detectBaseBranch(top: string, remote: string) {
  const head = await git(
    top,
    "symbolic-ref",
    "--short",
    `refs/remotes/${remote}/HEAD`,
  );
  if (head?.startsWith(`${remote}/`)) return head.slice(remote.length + 1);
  for (const branch of ["main", "master"])
    if (
      (await git(
        top,
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/remotes/${remote}/${branch}`,
      )) !== undefined
    )
      return branch;
  return (await git(top, "branch", "--show-current")) || "main";
}

function readManifest(
  top: string,
): { scripts?: Record<string, unknown>; packageManager?: unknown } | undefined {
  try {
    const value = JSON.parse(readFileSync(join(top, "package.json"), "utf8"));
    return typeof value === "object" && value !== null ? value : undefined;
  } catch {
    return undefined;
  }
}
