import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AgentAdapter,
  type CallName,
  callArgsSchemas,
  defaultProjectModels,
  type HostCalls,
  HostError,
  type HostPort,
  type RunOutputItem,
  requestSchema,
} from "@segno/core";
import { BadRequestError, type Clock, NotFoundError } from "@segno/engine";
import { ghStatus, validateCommittedText } from "./config.js";
import { remotes, topLevelOf } from "./git.js";
import { openHostLog } from "./log.js";
import { openProjects } from "./projects.js";
import { runQuery } from "./queries.js";
import { openSettings } from "./settings.js";
import { openUsage } from "./usage.js";

export interface HostDeps {
  appData: string;
  adapters: readonly AgentAdapter[];
  clock?: Clock;
  /** The gh binary, a system boundary that S6 points at stubs. */
  ghBinary?: string;
}

type Handlers = {
  [C in CallName]: (
    ...args: HostCalls[C]["args"]
  ) => Promise<HostCalls[C]["result"]>;
};

/** The composition root of the Engine host [ADR-0037]. */
export function startHost({
  appData,
  adapters,
  clock = { now: () => new Date() },
  ghBinary = "gh",
}: HostDeps) {
  const log = openHostLog(appData);
  const usage = openUsage();
  const projects = openProjects(appData, log, clock, adapters, usage);
  const settings = openSettings(appData, log);
  const ready = mkdir(appData, { recursive: true }).then(() =>
    Promise.all([settings.load(), projects.load()]),
  );
  // Every call then answers internal; the registry file is left untouched.
  ready.catch((error) =>
    log.write("error", "The host couldn't load projects.json.", { error }),
  );
  const ports = new Set<HostPort>();
  // App-level changes to the registry run one at a time.
  let registryTail: Promise<unknown> = Promise.resolve();
  function serialized<T>(work: () => Promise<T>): Promise<T> {
    const result = registryTail.then(work);
    registryTail = result.catch(() => {});
    return result;
  }

  const handlers: Omit<Handlers, "subscribe" | "runOutput"> = {
    async command(projectId, command) {
      const { engine } = projects.running(projectId);
      if (
        typeof command !== "object" ||
        command === null ||
        typeof (command as { type?: unknown }).type !== "string"
      )
        throw new HostError("bad-request", "A Command needs a string type.");
      try {
        return await engine.handle(command);
      } catch (error) {
        if (error instanceof BadRequestError)
          throw new HostError("bad-request", error.message);
        throw error;
      }
    },
    async query(projectId, name, params) {
      return runQuery(projects.running(projectId), name, params, usage);
    },
    async "projects.list"() {
      return projects.list();
    },
    async "projects.inspect"(path) {
      const top = await addableTopLevel(path);
      const gh = await ghStatus(ghBinary);
      const configPath = join(top, "segno.config.json");
      if (existsSync(configPath)) {
        const text = await readFile(configPath, "utf8");
        const { data, errors } = await validateCommittedText(
          top,
          text,
          adapters,
        );
        return {
          path: top,
          source: "file",
          gh,
          ...(data === undefined ? {} : { config: data }),
          errors,
        };
      }
      return {
        path: top,
        source: "models",
        models: { ...defaultProjectModels },
        gh,
        errors: [],
      };
    },
    "projects.add"(path, models) {
      return serialized(async () =>
        projects.add(await addableTopLevel(path), models),
      );
    },
    "projects.locate"(id, path) {
      return serialized(async () => {
        const top = await topLevel(path);
        projects.assertNew(top, id);
        await projects.locate(id, top);
        return null;
      });
    },
    "projects.rename"(id, name) {
      return serialized(async () => {
        await projects.rename(id, name);
        return null;
      });
    },
    async "settings.get"() {
      return settings.get();
    },
    "settings.set"(changes) {
      return serialized(async () => {
        await settings.set(changes);
        return null;
      });
    },
    "projects.remove"(id, options) {
      return serialized(async () => {
        await projects.remove(id, options);
        return null;
      });
    },
  };

  async function topLevel(path: string) {
    const top = await topLevelOf(path);
    if (!top)
      throw new HostError("not-a-repo", `${path} is not a git top-level.`);
    return top;
  }

  /** The folder must be a git top-level with a remote, not yet a Project. */
  async function addableTopLevel(path: string) {
    const resolved = await topLevel(path);
    if (!(await remotes(resolved)).length)
      throw new HostError("no-remote", `${path} has no git remote.`);
    projects.assertNew(resolved);
    return resolved;
  }

  const subscriptions = new Map<HostPort, Map<number, () => void>>();

  /** Registers, acknowledges and replays in one tick, so nothing is missed. */
  function subscribe(
    port: HostPort,
    id: number,
    projectId: string,
    since: number | undefined,
  ) {
    const { engine } = projects.running(projectId);
    const unsubscribe = engine.onAppend((event) =>
      port.postMessage({ id, item: event }),
    );
    const own = subscriptions.get(port) ?? new Map<number, () => void>();
    subscriptions.set(port, own);
    own.set(id, unsubscribe);
    port.postMessage({ id, result: null });
    if (since !== undefined)
      for (const event of engine.readEvents(since))
        port.postMessage({ id, item: event });
  }

  /** Streams one Run's live output; the stream closes after `end`. */
  function runOutput(
    port: HostPort,
    id: number,
    projectId: string,
    runId: string,
  ) {
    const { engine } = projects.running(projectId);
    const own = subscriptions.get(port) ?? new Map<number, () => void>();
    subscriptions.set(port, own);
    // A finished Run's end arrives during watchRun, before the acknowledgement.
    const early: RunOutputItem[] = [];
    let send = (item: RunOutputItem) => {
      early.push(item);
    };
    let ended = false;
    let stop: () => void;
    try {
      stop = engine.watchRun(runId, (item) => {
        if (item.kind === "end") {
          ended = true;
          own.delete(id);
        }
        send(item);
      });
    } catch (error) {
      if (error instanceof NotFoundError)
        throw new HostError("not-found", error.message);
      throw error;
    }
    if (!ended) own.set(id, stop);
    port.postMessage({ id, result: null });
    send = (item) => port.postMessage({ id, item });
    for (const item of early) send(item);
  }

  async function dispatch(message: unknown, port: HostPort) {
    const parsed = requestSchema.safeParse(message);
    if (!parsed.success) {
      const id = (message as { id?: unknown } | null)?.id;
      if (typeof id === "number")
        port.postMessage({
          id,
          error: { code: "bad-request", message: "Malformed request." },
        });
      return;
    }
    const request = parsed.data;
    if ("cancel" in request) {
      const own = subscriptions.get(port);
      own?.get(request.id)?.();
      own?.delete(request.id);
      return;
    }
    try {
      if (!Object.hasOwn(callArgsSchemas, request.call))
        throw new HostError("bad-request", `Unknown call ${request.call}.`);
      const name = request.call as CallName;
      const args = callArgsSchemas[name].safeParse(request.args);
      if (!args.success)
        throw new HostError("bad-request", `Invalid arguments for ${name}.`);
      await ready;
      if (name === "subscribe") {
        const [projectId, since] = args.data as [string, number?];
        subscribe(port, request.id, projectId, since);
        return;
      }
      if (name === "runOutput") {
        const [projectId, runId] = args.data as [string, string];
        runOutput(port, request.id, projectId, runId);
        return;
      }
      const handler = handlers[name] as (
        ...args: unknown[]
      ) => Promise<unknown>;
      const result = await handler(...(args.data as unknown[]));
      port.postMessage({ id: request.id, result });
    } catch (error) {
      if (error instanceof HostError) {
        port.postMessage({
          id: request.id,
          error: { code: error.code, message: error.message },
        });
      } else {
        log.write("error", "Call failed.", { call: request.call, error });
        port.postMessage({
          id: request.id,
          error: { code: "internal", message: "Internal host error." },
        });
      }
    }
  }

  return {
    connect(port: HostPort) {
      ports.add(port);
      port.onMessage((message) => void dispatch(message, port));
      // A window that reloads or reconnects leaves its old port behind.
      port.onClose?.(() => {
        for (const unsubscribe of subscriptions.get(port)?.values() ?? [])
          unsubscribe();
        subscriptions.delete(port);
        ports.delete(port);
      });
    },
    async close() {
      for (const own of subscriptions.values())
        for (const unsubscribe of own.values()) unsubscribe();
      subscriptions.clear();
      for (const port of ports) port.close();
      ports.clear();
      await ready.catch(() => {});
      await registryTail;
      await projects.close();
    },
  };
}
