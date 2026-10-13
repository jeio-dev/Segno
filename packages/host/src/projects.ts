import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  type ConfigError,
  HostError,
  type LocalSettings,
  localSettingsSchema,
  type ProjectSummary,
  type SegnoConfig,
  validateConfigText,
} from "@segno/core";
import { type Clock, type Engine, openEngine } from "@segno/engine";
import { validateCommittedText, validateCommittedValue } from "./config.js";
import { realPath, topLevelOf } from "./git.js";
import type { HostLog } from "./log.js";

export interface RegistryEntry {
  id: string;
  name: string;
  path: string;
  addedAt: string;
}

export type RunningProject = Extract<Project, { status: "running" }>;
type Unavailable = Extract<ProjectSummary, { status: "unavailable" }>;
type Project = RegistryEntry &
  (
    | {
        status: "running";
        engine: Engine;
        config: SegnoConfig;
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
export function openProjects(appData: string, log: HostLog, clock: Clock) {
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
    const { config, local, errors } = await loadConfig(entry);
    if (!config || !local)
      return unavailable(
        entry,
        "invalid-config",
        `The Project's config has ${errors.length} error${errors.length === 1 ? "" : "s"}.`,
        errors,
      );
    try {
      await mkdir(projectDir(entry.id), { recursive: true });
      const engine = openEngine({
        dbPath: join(projectDir(entry.id), "segno.db"),
        clock,
      });
      return { ...entry, status: "running", engine, config, local };
    } catch (error) {
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
      const result = await validateCommittedText(entry.path, text);
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
        if (project.status === "running")
          return {
            id,
            name,
            path,
            status: "running",
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
      if (project?.status !== "running")
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
    async add(top: string, config: unknown) {
      const configPath = join(top, "segno.config.json");
      if (existsSync(configPath)) {
        if (config !== undefined)
          throw new HostError(
            "bad-request",
            "segno.config.json already exists and is never overwritten.",
          );
      } else {
        if (config === undefined)
          throw new HostError(
            "bad-request",
            "The repo has no segno.config.json, so reviewed settings are required.",
          );
        const errors = await validateCommittedValue(top, config);
        if (errors.length)
          throw new HostError(
            "bad-request",
            `The settings are invalid: ${errors.map(({ path, message }) => `${path || "/"} ${message}`).join("; ")}`,
          );
        try {
          await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
            flag: "wx",
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          throw new HostError(
            "bad-request",
            "segno.config.json appeared while adding and is never overwritten.",
          );
        }
      }
      const entry: RegistryEntry = {
        id: randomUUID(),
        name: basename(top),
        path: top,
        addedAt: clock.now().toISOString(),
      };
      projects.set(entry.id, await start(entry));
      await save();
      return { id: entry.id };
    },
    async locate(id: string, top: string) {
      const project = known(id);
      if (project.status === "running")
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
      if (project.status === "running") await project.engine.close();
      projects.delete(id);
      await save();
      if (deleteData)
        await rm(projectDir(id), { recursive: true, force: true });
    },
    async close() {
      await Promise.all(
        [...projects.values()].map((project) =>
          project.status === "running" ? project.engine.close() : undefined,
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
