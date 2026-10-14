import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  type AgentAdapter,
  type ConfigError,
  defaultProjectModels,
  HostError,
  type LocalSettings,
  localSettingsSchema,
  type PendingConfig,
  type ProjectSummary,
  pendingConfigSchema,
  pendingFromModels,
  projectModelsSchema,
  resolveConfig,
  type SegnoConfig,
  validateConfigText,
} from "@segno/core";
import { type Clock, type Engine, openEngine } from "@segno/engine";
import { validateCommittedText, validateCommittedValue } from "./config.js";
import { detectConfig } from "./detect.js";
import { realPath, topLevelOf } from "./git.js";
import type { HostLog } from "./log.js";
import type { UsageStore } from "./usage.js";

export interface RegistryEntry {
  id: string;
  name: string;
  path: string;
  addedAt: string;
}

export type RunningProject = Exclude<Project, { status: "unavailable" }>;
type Unavailable = Extract<ProjectSummary, { status: "unavailable" }>;
type Project = RegistryEntry &
  (
    | {
        status: "running" | "not-onboarded";
        /** `projects/<id>/` in the app data directory. */
        dir: string;
        pending: PendingConfig | null;
        engine: Engine;
        config: SegnoConfig | null;
        local: LocalSettings;
      }
    | {
        status: "unavailable";
        reason: Unavailable["reason"];
        message: string;
        errors?: ConfigError[];
      }
  );

/** The Project registry and one Engine per running Project [ADR-0038]. */
export function openProjects(
  appData: string,
  log: HostLog,
  clock: Clock,
  adapters: readonly AgentAdapter[],
  usage: UsageStore,
) {
  const registryPath = join(appData, "projects.json");
  const projects = new Map<string, Project>();

  async function load() {
    let entries: RegistryEntry[] = [];
    // A registry that can't be read stops the host rather than being replaced.
    if (existsSync(registryPath))
      entries = JSON.parse(await readFile(registryPath, "utf8"));
    if (!Array.isArray(entries))
      throw new Error("projects.json is not a list of Projects.");
    for (const entry of entries) projects.set(entry.id, await start(entry));
  }

  async function save() {
    const entries = [...projects.values()].map(
      ({ id, name, path, addedAt }) => ({ id, name, path, addedAt }),
    );
    await writeAtomic(registryPath, `${JSON.stringify(entries, null, 2)}\n`);
  }

  function projectDir(id: string) {
    return join(appData, "projects", id);
  }

  /** Startup for one Project: the availability checks, then its Engine. */
  async function start(entry: RegistryEntry): Promise<Project> {
    if (!existsSync(entry.path))
      return unavailable(
        entry,
        "missing-folder",
        `${entry.path} no longer exists.`,
      );
    if (!(await topLevelOf(entry.path)))
      return unavailable(
        entry,
        "not-a-repo",
        `${entry.path} is no longer a git top-level.`,
      );
    let { config, local, errors } = await loadConfig(entry);
    let running: RunningProject | undefined;
    async function discardPending() {
      try {
        await rm(join(projectDir(entry.id), "pending.json"), { force: true });
      } catch (error) {
        log.write(
          "warn",
          "Could not delete stale pending.json; the Project remains onboarded.",
          {
            projectId: entry.id,
            error,
          },
        );
      }
    }

    if (
      existsSync(join(entry.path, "segno.config.json")) &&
      (!config || !local)
    )
      return unavailable(
        entry,
        "invalid-config",
        `The Project's config has ${errors.length} error${errors.length === 1 ? "" : "s"}.`,
        errors,
      );
    let engine: Engine | undefined;
    try {
      await mkdir(projectDir(entry.id), { recursive: true });
      engine = openEngine({
        dbPath: join(projectDir(entry.id), "segno.db"),
        clock,
        isOnboarded: () => Boolean(config),
        workspace: {
          repo: entry.path,
          projectDir: projectDir(entry.id),
          config() {
            if (!config) throw new Error("The Project is not onboarded.");
            return resolveConfig(config, running?.local ?? local).effective;
          },
          adapters,
          async onboarding() {
            const settings = running?.local ?? local ?? {};
            const pending = running?.pending ?? null;
            const { config: detected } = await detectConfig(entry.path);
            const coderAllow = detected.roles.coder.allow;
            return {
              adapter: "claude-code",
              model:
                settings.roles?.planner?.model ??
                pending?.roles.planner.model ??
                defaultProjectModels.planner,
              remote: detected.remote,
              baseBranch: detected.baseBranch,
              guess: {
                ...(detected.tests.command ? { tests: detected.tests } : {}),
                ...(detected.setup ? { setup: detected.setup } : {}),
                baseBranch: detected.baseBranch,
                remote: detected.remote,
                ...(coderAllow.length ? { coderAllow } : {}),
              },
              worktreeRoot: settings.worktreeRoot,
            };
          },
        },
        onLimit: usage.report,
        onError: (error) =>
          log.write("error", "Engine work failed.", {
            projectId: entry.id,
            error,
          }),
        configStore: {
          discardPending,
          async prepareOnboarding(value) {
            const candidate = withPendingModels(
              value,
              running?.pending ?? null,
            );
            const errors = await validateCommittedValue(
              entry.path,
              candidate,
              adapters,
            );
            return errors.length
              ? { errors }
              : { config: candidate as SegnoConfig, errors };
          },
          async writeOnboarding(value) {
            try {
              await writeFile(
                join(entry.path, "segno.config.json"),
                `${JSON.stringify(value, null, 2)}\n`,
                { flag: "wx" },
              );
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "EEXIST")
                throw error;
              throw new HostError(
                "bad-request",
                "segno.config.json appeared during setup and was not overwritten. Restart Segno to load it.",
              );
            }
            await discardPending();
          },
          async reload() {
            const loaded = await loadConfig(entry);
            if (!loaded.config || !loaded.local)
              throw new Error("The written config could not be loaded.");
            config = loaded.config;
            if (running) {
              running.config = loaded.config;
              running.local = loaded.local;
              running.pending = null;
              running.status = "running";
            }
          },
        },
      });
      if (!config && engine.state.plans.length) {
        await engine.close();
        return unavailable(
          entry,
          "invalid-config",
          "segno.config.json is missing after a Plan was submitted.",
          errors,
        );
      }
      if (!local) {
        await engine.close();
        return unavailable(
          entry,
          "invalid-config",
          "The local settings are invalid.",
          errors.filter((error) => error.file !== "segno.config.json"),
        );
      }
      let pending: PendingConfig | null = null;
      if (!config) {
        const pendingPath = join(projectDir(entry.id), "pending.json");
        if (!existsSync(pendingPath))
          await writeAtomic(
            pendingPath,
            `${JSON.stringify(pendingFromModels(defaultProjectModels), null, 2)}\n`,
          );
        const pendingText = await readText(pendingPath);
        const result =
          pendingText instanceof Error
            ? {
                errors: [unreadable("pending.json", pendingText)],
                value: undefined,
              }
            : validateConfigText(
                "pending.json",
                pendingText,
                pendingConfigSchema,
              );
        if (!result.value) {
          await engine.close();
          return unavailable(
            entry,
            "invalid-config",
            "The pending config is invalid.",
            result.errors,
          );
        }
        pending = result.value;
      }
      running = {
        ...entry,
        status: config ? "running" : "not-onboarded",
        dir: projectDir(entry.id),
        engine,
        config: config ?? null,
        local,
        pending,
      };
      if (config)
        await engine.acceptConfigFile(
          existsSync(join(projectDir(entry.id), "pending.json")),
        );
      return running;
    } catch (error) {
      await engine?.close();
      log.write("error", "Engine failed to start.", {
        projectId: entry.id,
        error,
      });
      return unavailable(
        entry,
        "unreadable-log",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /** The committed file and the local settings, each validated strictly. */
  async function loadConfig(entry: RegistryEntry) {
    const errors: ConfigError[] = [];
    let config: SegnoConfig | undefined;
    const path = join(entry.path, "segno.config.json");
    const text = existsSync(path) ? await readText(path) : undefined;
    if (text instanceof Error) {
      errors.push(unreadable("segno.config.json", text));
    } else if (text !== undefined) {
      const result = await validateCommittedText(entry.path, text, adapters);
      errors.push(...result.errors);
      if (!result.errors.length) config = result.value;
    } else {
      errors.push({
        file: "segno.config.json",
        path: "",
        code: "missing-file",
        message: "segno.config.json is missing from the repo root.",
      });
    }
    let local: LocalSettings | undefined = {};
    const localPath = join(projectDir(entry.id), "local.json");
    const localText = existsSync(localPath)
      ? await readText(localPath)
      : undefined;
    if (localText instanceof Error) {
      errors.push(unreadable("local.json", localText));
      local = undefined;
    } else if (localText !== undefined) {
      const result = validateConfigText(
        "local.json",
        localText,
        localSettingsSchema,
      );
      errors.push(...result.errors);
      local = result.value;
    }
    return { config, local, errors };
  }

  function known(id: string) {
    const project = projects.get(id);
    if (!project)
      throw new HostError("unknown-project", `Unknown Project ${id}.`);
    return project;
  }

  return {
    load,
    list(): ProjectSummary[] {
      return [...projects.values()].map((project) => {
        const { id, name, path } = project;
        if (project.status !== "unavailable")
          return {
            id,
            name,
            path,
            status: project.status,
            awaitingCount: project.engine.state.awaiting.length,
          };
        const { reason, message, errors } = project;
        return {
          id,
          name,
          path,
          status: "unavailable",
          awaitingCount: 0,
          reason,
          message,
          ...(errors ? { errors } : {}),
        };
      });
    },
    /** A running Project, or unknown-project. */
    running(id: string): RunningProject {
      const project = projects.get(id);
      if (!project || project.status === "unavailable")
        throw new HostError(
          "unknown-project",
          project
            ? `The Project ${project.name} is unavailable.`
            : `Unknown Project ${id}.`,
        );
      return project;
    },
    /** Refuses a top-level that is already a Project [ADR-0039]. */
    assertNew(top: string, except?: string) {
      for (const project of projects.values())
        if (project.id !== except && realPath(project.path) === top)
          throw new HostError(
            "already-added",
            `${top} is already the Project ${project.name}.`,
          );
    },
    async add(top: string, models: unknown) {
      const needsConfig = !existsSync(join(top, "segno.config.json"));
      const parsed = projectModelsSchema.safeParse(models);
      if (needsConfig && !parsed.success)
        throw new HostError(
          "bad-request",
          "Planner, Coder and Reviewer models are required.",
        );
      const entry: RegistryEntry = {
        id: randomUUID(),
        name: basename(top),
        path: top,
        addedAt: clock.now().toISOString(),
      };
      if (needsConfig && parsed.success) {
        await mkdir(projectDir(entry.id), { recursive: true });
        await writeAtomic(
          join(projectDir(entry.id), "pending.json"),
          `${JSON.stringify(pendingFromModels(parsed.data), null, 2)}\n`,
        );
      }
      projects.set(entry.id, await start(entry));
      await save();
      return { id: entry.id };
    },
    async locate(id: string, top: string) {
      const project = known(id);
      if (project.status !== "unavailable")
        throw new HostError(
          "bad-request",
          `The Project ${project.name} is running; only an unavailable Project can be located.`,
        );
      const { name, addedAt } = project;
      projects.set(id, await start({ id, name, path: top, addedAt }));
      await save();
    },
    async rename(id: string, name: string) {
      const project = known(id);
      if (!name.trim())
        throw new HostError("bad-request", "A Project name must not be blank.");
      project.name = name.trim();
      await save();
    },
    /** Unregisters a Project; the repo is never touched [ADR-0038]. */
    async remove(id: string, { deleteData }: { deleteData: boolean }) {
      const project = known(id);
      if (project.status !== "unavailable") await project.engine.close();
      projects.delete(id);
      await save();
      if (deleteData)
        await rm(projectDir(id), { recursive: true, force: true });
    },
    async close() {
      await Promise.all(
        [...projects.values()].map((project) =>
          project.status !== "unavailable" ? project.engine.close() : undefined,
        ),
      );
      projects.clear();
    },
  };
}

function unavailable(
  entry: RegistryEntry,
  reason: Unavailable["reason"],
  message: string,
  errors?: ConfigError[],
): Project {
  return {
    ...entry,
    status: "unavailable",
    reason,
    message,
    ...(errors ? { errors } : {}),
  };
}

export async function writeAtomic(path: string, text: string) {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, text);
  await rename(temp, path);
}

async function readText(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

/** A config file that exists but can't be read counts as missing [ADR-0047]. */
function unreadable(file: ConfigError["file"], error: Error): ConfigError {
  return {
    file,
    path: "",
    code: "missing-file",
    message: `${file} can't be read: ${error.message}`,
  };
}

/** Preserve authored settings and unknown keys for strict validation. */
function withPendingModels(
  value: unknown,
  pending: PendingConfig | null,
): unknown {
  if (!isRecord(value) || !pending) return value;
  if (value.roles !== undefined && !isRecord(value.roles)) return value;
  const roles = { ...(value.roles as Record<string, unknown> | undefined) };
  for (const role of ["planner", "coder", "reviewer"] as const) {
    if (roles[role] !== undefined && !isRecord(roles[role])) continue;
    roles[role] = {
      ...(roles[role] as Record<string, unknown> | undefined),
      adapter: "claude-code",
      ...pending.roles[role],
    };
  }
  return { ...value, roles };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
