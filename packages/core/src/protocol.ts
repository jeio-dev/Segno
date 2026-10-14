import { z } from "zod";
import type { CommandResult } from "./commands.js";
import type {
  AppSettings,
  ConfigError,
  ConfigSource,
  EffectiveConfig,
  PendingConfig,
  ProjectModels,
  SegnoConfig,
} from "./config.js";
import type {
  BlockReason,
  Budget,
  Event,
  PhaseStatus,
  PlanStatus,
  RunKind,
  RunOutcome,
  TaskStatus,
} from "./events.js";
import type {
  AwaitingItem,
  OnboardingState,
  PlanState,
  RunState,
  TaskState,
} from "./project.js";

/** A message port as both ends of the host protocol see it. */
export interface HostPort {
  postMessage(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
  /** Called once the other end disconnects, where the transport reports it. */
  onClose?(listener: () => void): void;
  close(): void;
}

export const hostErrorCodes = [
  "bad-request",
  "unknown-project",
  "not-found",
  "no-worktree",
  "no-editor",
  "pruned",
  "not-a-repo",
  "no-remote",
  "already-added",
  "install-failed",
  "internal",
] as const;
export type HostErrorCode = (typeof hostErrorCodes)[number];

export const hostErrorSchema = z.strictObject({
  code: z.enum(hostErrorCodes),
  message: z.string(),
});

export class HostError extends Error {
  readonly code: HostErrorCode;
  constructor(code: HostErrorCode, message: string) {
    super(message);
    this.name = "HostError";
    this.code = code;
  }
}

export const requestSchema = z.union([
  z.strictObject({
    id: z.number().int(),
    call: z.string(),
    args: z.array(z.unknown()),
  }),
  z.strictObject({ id: z.number().int(), cancel: z.literal(true) }),
]);
export type Request = z.infer<typeof requestSchema>;

export const responseSchema = z.union([
  z.strictObject({ id: z.number().int(), result: z.unknown() }),
  z.strictObject({ id: z.number().int(), error: hostErrorSchema }),
  z.strictObject({ id: z.number().int(), item: z.unknown() }),
]);
export type Response = z.infer<typeof responseSchema>;

export type ProjectSummary = {
  id: string;
  name: string;
  path: string;
} & (
  | { status: "running" | "not-onboarded"; awaitingCount: number }
  | {
      status: "unavailable";
      awaitingCount: 0;
      reason:
        | "missing-folder"
        | "not-a-repo"
        | "invalid-config"
        | "unreadable-log";
      message: string;
      /** Every config error, for invalid-config. */
      errors?: ConfigError[];
    }
);

export interface InspectResult {
  /** The repo's git top-level. */
  path: string;
  source: "file" | "models";
  models?: ProjectModels;
  packageManager?: "pnpm" | "yarn" | "npm" | "bun";
  gh: "ok" | "missing" | "logged-out";
  /** The existing file's parsed JSON, absent when unparseable. */
  config?: unknown;
  errors: ConfigError[];
}

/** One card on the board [gui.md § Card]. */
export interface BoardTask {
  id: string;
  title: string;
  state: TaskStatus;
  paused: boolean;
  budgets: Record<Budget, number>;
  blockReason?: BlockReason;
  /** Why a queued Task isn't moving, e.g. `needs a` or `slots full`. */
  waitReason?: string;
  highRisk: boolean;
  /** The Task's live Run. */
  run?: { id: string; kind: RunKind; role: string };
  /** Merging, but behind another Task in the merge queue. */
  queuedToMerge?: true;
}

/** The active Plan's active or awaiting-merge Phase [api.md § Queries]. */
export interface Board {
  plan: { id: string; slug: string; title: string; state: "active" } | null;
  phase: {
    id: string;
    title: string;
    state: "active" | "awaiting-merge";
    branch: string;
    prUrl?: string;
  } | null;
  /** In scheduling order; superseded Tasks are never shown. */
  tasks: BoardTask[];
  /** Task ids in the merge queue, the one merging first. */
  mergeQueue: string[];
  /** Live agent Runs against concurrency, and agent sessions in this Phase. */
  sessions: { live: number; concurrency: number; startedInPhase: number };
  /** Subscription usage, only as the Adapter reports it [ADR-0021]. */
  usage?: Usage;
}

/**
 * The latest usage an Adapter reported, or only the last known reset time
 * when it doesn't report usage. Never estimated [ADR-0021].
 */
export interface Usage {
  used?: number;
  limit?: number;
  resetAt?: string;
}

/** The `task` query: the full Task with its Runs. */
export type TaskDetail = Omit<TaskState, "runIds"> & { runs: RunState[] };

export interface PlanSummary {
  id: string;
  slug: string;
  title: string;
  state: PlanStatus;
  submittedAt: string;
}

export interface ArchivedPhase {
  id: string;
  planId: string;
  title: string;
  state: PhaseStatus;
  prUrl?: string;
  startedAt: string;
  mergedAt?: string;
}

/** The config query: effective config, sources and status [ADR-0047]. */
export interface ConfigStatus {
  effective: EffectiveConfig | null;
  pending: PendingConfig | null;
  sources: Record<string, ConfigSource>;
  rejected: {
    seq: number;
    source: "file" | "local" | "command";
    errors: ConfigError[];
  } | null;
  /** Whether segno.config.json is on <remote>/<baseBranch>; false shows the commit hint. */
  committed: boolean;
}

/** Every query's params and result. */
export interface Queries {
  board: { params: undefined; result: Board };
  awaiting: { params: undefined; result: AwaitingItem[] };
  plans: { params: undefined; result: PlanSummary[] };
  plan: { params: { planId: string }; result: PlanState };
  planExport: { params: { planId: string }; result: string };
  phases: { params: undefined; result: ArchivedPhase[] };
  phaseEvents: { params: { phaseId: string }; result: Event[] };
  task: { params: { taskId: string }; result: TaskDetail };
  /** The Task branch against its merge-base, or the diff kept at merge time. */
  taskDiff: { params: { taskId: string }; result: { diff: string } };
  run: { params: { runId: string }; result: RunState };
  runTranscript: { params: { runId: string }; result: string };
  runPrompt: { params: { runId: string }; result: string };
  config: { params: undefined; result: ConfigStatus };
  onboarding: {
    params: undefined;
    result: OnboardingState & {
      detected: {
        config: SegnoConfig;
        packageManager?: InspectResult["packageManager"];
      };
    };
  };
}
export type QueryName = keyof Queries;
const planParams = z.strictObject({ planId: z.string().min(1) });
const taskParams = z.strictObject({ taskId: z.string().min(1) });
const runParams = z.strictObject({ runId: z.string().min(1) });
export const queryParamsSchemas = {
  board: z.undefined(),
  awaiting: z.undefined(),
  plans: z.undefined(),
  plan: planParams,
  planExport: planParams,
  phases: z.undefined(),
  phaseEvents: z.strictObject({ phaseId: z.string().min(1) }),
  task: taskParams,
  taskDiff: taskParams,
  run: runParams,
  runTranscript: runParams,
  runPrompt: runParams,
  config: z.undefined(),
  onboarding: z.undefined(),
} satisfies Record<QueryName, z.ZodType>;

/** One item of a Run's live output stream. */
export type RunOutputItem =
  | { kind: "output"; text: string }
  | { kind: "end"; outcome: RunOutcome };

/** Request and result types of every call. */
export interface HostCalls {
  /** A stream: acknowledged with null, then output items until `end`. */
  runOutput: { args: [projectId: string, runId: string]; result: null };
  /** A stream: acknowledged with null, then one item per Event. */
  subscribe: { args: [projectId: string, since?: number]; result: null };
  command: {
    args: [projectId: string, command: unknown];
    result: CommandResult;
  };
  query: {
    args: [projectId: string, name: QueryName, params?: unknown];
    result: Queries[QueryName]["result"];
  };
  "projects.list": { args: []; result: ProjectSummary[] };
  "projects.inspect": { args: [path: string]; result: InspectResult };
  "projects.add": {
    args: [path: string, models?: unknown];
    result: { id: string };
  };
  "projects.remove": {
    args: [id: string, options: { deleteData: boolean }];
    result: null;
  };
  "projects.locate": { args: [id: string, path: string]; result: null };
  "projects.rename": { args: [id: string, name: string]; result: null };
  "settings.get": { args: []; result: ResolvedSettings };
  "settings.set": { args: [changes: SettingsChanges]; result: null };
}

/** App settings with defaults filled; `editor` stays unset until chosen. */
export type ResolvedSettings = Required<Omit<AppSettings, "editor">> &
  Pick<AppSettings, "editor">;
/** Keys to change; `null` unsets a key. */
export type SettingsChanges = {
  [K in keyof AppSettings]?: AppSettings[K] | null;
};
export type CallName = keyof HostCalls;

const projectId = z.string().min(1);
export const callArgsSchemas = {
  subscribe: z.union([
    z.tuple([projectId]),
    z.tuple([projectId, z.number().int().min(0)]),
  ]),
  runOutput: z.tuple([projectId, z.string().min(1)]),
  command: z.tuple([projectId, z.unknown()]),
  query: z.union([
    z.tuple([projectId, z.string()]),
    z.tuple([projectId, z.string(), z.unknown()]),
  ]),
  "projects.list": z.tuple([]),
  "projects.inspect": z.tuple([z.string().min(1)]),
  "projects.add": z.union([
    z.tuple([z.string().min(1)]),
    z.tuple([z.string().min(1), z.unknown()]),
  ]),
  "projects.remove": z.tuple([
    projectId,
    z.strictObject({ deleteData: z.boolean() }),
  ]),
  "projects.locate": z.tuple([projectId, z.string().min(1)]),
  "projects.rename": z.tuple([projectId, z.string()]),
  "settings.get": z.tuple([]),
  "settings.set": z.tuple([z.record(z.string(), z.unknown())]),
} satisfies Record<CallName, z.ZodType>;

export function createHostClient(port: HostPort) {
  let nextId = 1;
  let closed = false;
  const closedError = () =>
    new HostError("internal", "The connection to the Engine host is closed.");
  const pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: HostError): void }
  >();
  const streams = new Map<number, (item: unknown) => void>();
  port.onMessage((message) => {
    const parsed = responseSchema.safeParse(message);
    if (!parsed.success) return;
    const response = parsed.data;
    if ("item" in response) {
      streams.get(response.id)?.(response.item);
      return;
    }
    const waiter = pending.get(response.id);
    if (!waiter) return;
    if ("error" in response) {
      pending.delete(response.id);
      waiter.reject(new HostError(response.error.code, response.error.message));
    } else if ("result" in response) {
      pending.delete(response.id);
      waiter.resolve(response.result);
    }
  });
  function call<C extends CallName>(
    name: C,
    ...args: HostCalls[C]["args"]
  ): Promise<HostCalls[C]["result"]> {
    const id = nextId++;
    // A closed client answers at once rather than waiting on a dead port.
    if (closed) return Promise.reject(closedError());
    return new Promise((resolve, reject) => {
      pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      port.postMessage({ id, call: name, args });
    });
  }
  return {
    command: (projectId: string, command: unknown) =>
      call("command", projectId, command),
    /**
     * The Project's Event stream: every Event after `since`, then the live
     * tail; without `since`, the live tail only.
     */
    async subscribe(
      projectId: string,
      since: number | undefined,
      onEvent: (event: Event) => void,
    ) {
      const id = nextId;
      streams.set(id, (item) => onEvent(item as Event));
      try {
        await (since === undefined
          ? call("subscribe", projectId)
          : call("subscribe", projectId, since));
      } catch (error) {
        streams.delete(id);
        throw error;
      }
      return {
        close() {
          if (streams.delete(id)) port.postMessage({ id, cancel: true });
        },
      };
    },
    /**
     * A Run's live output, then `end`; a finished Run's `end` at once. The
     * stream closes after `end`.
     */
    async runOutput(
      projectId: string,
      runId: string,
      onItem: (item: RunOutputItem) => void,
    ) {
      const id = nextId;
      streams.set(id, (item) => {
        const output = item as RunOutputItem;
        if (output.kind === "end") streams.delete(id);
        onItem(output);
      });
      try {
        await call("runOutput", projectId, runId);
      } catch (error) {
        streams.delete(id);
        throw error;
      }
      return {
        close() {
          if (streams.delete(id)) port.postMessage({ id, cancel: true });
        },
      };
    },
    query: <Q extends QueryName>(
      projectId: string,
      name: Q,
      ...params: Queries[Q]["params"] extends undefined
        ? []
        : [Queries[Q]["params"]]
    ) =>
      call("query", projectId, name, ...params) as Promise<
        Queries[Q]["result"]
      >,
    projects: {
      list: () => call("projects.list"),
      inspect: (path: string) => call("projects.inspect", path),
      add: (path: string, models?: unknown) =>
        models === undefined
          ? call("projects.add", path)
          : call("projects.add", path, models),
      remove: (id: string, options: { deleteData: boolean }) =>
        call("projects.remove", id, options),
      locate: (id: string, path: string) => call("projects.locate", id, path),
      rename: (id: string, name: string) => call("projects.rename", id, name),
    },
    settings: {
      get: () => call("settings.get"),
      set: (changes: SettingsChanges) => call("settings.set", changes),
    },
    close() {
      if (closed) return;
      closed = true;
      for (const waiter of pending.values()) waiter.reject(closedError());
      pending.clear();
      streams.clear();
      port.close();
    },
  };
}
export type HostClient = ReturnType<typeof createHostClient>;
