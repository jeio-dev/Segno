import { randomUUID } from "node:crypto";
import {
  type CommandResult,
  type ConfigError,
  commandSchema,
  type Event,
  laterCommandTypes,
  project,
  type SegnoConfig,
} from "@segno/core";
import { parsePlan } from "@segno/plan-format";
import { openEventLog } from "./event-log.js";

export interface Clock {
  now(): Date;
}
export interface ConfigStore {
  prepareOnboarding(
    config: unknown,
  ): Promise<{ config?: SegnoConfig; errors: ConfigError[] }>;
  writeOnboarding(config: SegnoConfig): Promise<void>;
  discardPending(): Promise<void>;
  reload(): Promise<void>;
}
export interface EngineOptions {
  dbPath: string;
  clock?: Clock;
  isOnboarded?: () => boolean;
  configStore?: ConfigStore;
}

export class BadRequestError extends Error {
  readonly code = "bad-request";
  constructor() {
    super("The Command has no recognizable type.");
    this.name = "BadRequestError";
  }
}

export function openEngine({
  dbPath,
  clock = { now: () => new Date() },
  isOnboarded = () => true,
  configStore,
}: EngineOptions) {
  const log = openEventLog(dbPath);
  try {
    project(log.readEvents());
  } catch (error) {
    log.close();
    throw error;
  }
  const listeners = new Set<(event: Event) => void>();
  let tail: Promise<void> = Promise.resolve();
  let closed = false;
  let closing: Promise<void> | undefined;
  return {
    get state() {
      return project(readEvents());
    },
    readEvents,
    /** Startup reconciliation for a valid file, before the host exposes this Engine. */
    async acceptConfigFile(wasNotOnboarded = false) {
      if (!configStore || !isOnboarded()) return;
      const events = readEvents();
      await configStore.discardPending();
      if (
        !wasNotOnboarded &&
        events.some(
          (event) =>
            event.type === "onboarding.confirmed" ||
            event.type === "plan.submitted",
        )
      )
        return;
      append({
        seq: (events.at(-1)?.seq ?? 0) + 1,
        type: "onboarding.confirmed",
        v: 1,
        ts: clock.now().toISOString(),
        payload: { via: "file" },
      });
    },
    /** Calls `listener` with every Event appended from now on, in seq order. */
    onAppend(listener: (event: Event) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    handle(input: unknown): Promise<CommandResult> {
      if (closed) return Promise.reject(closedError());
      // Capture nested config values before the caller can edit a queued Command.
      const received = structuredClone(input);
      const result = tail.then(() => processCommand(received));
      tail = result.then(
        () => {},
        () => {},
      );
      return result;
    },
    close(): Promise<void> {
      closed = true;
      closing ??= tail.then(() => {
        log.close();
      });
      return closing;
    },
  };

  function closedError() {
    return new Error("The Engine is closed.");
  }

  function append(event: Parameters<typeof log.append>[0]) {
    log.append(event);
    // The Event is committed; a failing listener must not fail the Command.
    for (const listener of listeners)
      try {
        listener(event);
      } catch {}
  }

  function readEvents(since?: number) {
    if (closed) throw closedError();
    return log.readEvents(since);
  }

  async function processCommand(input: unknown): Promise<CommandResult> {
    const type = (input as { type?: unknown } | null)?.type;
    const later = (laterCommandTypes as readonly unknown[]).includes(type);
    const recognized =
      commandSchema.options.some(
        (option) => option.shape.type.value === type,
      ) || later;
    if (recognized && type !== "onboarding.confirm" && !isOnboarded())
      return {
        ok: false,
        code: "not-onboarded",
        message: "Set up the Project before submitting or managing Plans.",
      };
    if (later) {
      return {
        ok: false,
        code: "unsupported-in-version",
        message: `${String(type)} is a v1.2 Command; this Engine is v1.`,
      };
    }
    if (
      typeof input !== "object" ||
      input === null ||
      !("type" in input) ||
      !recognized
    ) {
      throw new BadRequestError();
    }
    if (input.type === "plan.sendBack") {
      const notes = "notes" in input ? input.notes : undefined;
      if (notes === undefined || (typeof notes === "string" && !notes.trim())) {
        return {
          ok: false,
          code: "notes-required",
          message: "Non-blank notes are required.",
        };
      }
    }
    if (input.type === "plan.abandon") {
      const reason = "reason" in input ? input.reason : undefined;
      if (
        reason === undefined ||
        (typeof reason === "string" && !reason.trim())
      ) {
        return {
          ok: false,
          code: "reason-required",
          message: "A non-blank reason is required.",
        };
      }
    }
    const validated = commandSchema.safeParse(input);
    if (!validated.success) {
      return {
        ok: false,
        code: "validation",
        message: "The Command payload is invalid.",
        errors: validated.error.issues.flatMap((issue) => {
          const paths =
            issue.code === "unrecognized_keys"
              ? issue.keys.map((key) => [...issue.path, key])
              : [issue.path];
          return paths.map((path) => ({
            code: "schema" as const,
            path: path.length
              ? `/${path.map((part) => String(part).replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`
              : "",
            message:
              issue.code === "unrecognized_keys"
                ? `Unrecognized key: ${JSON.stringify(path.at(-1))}`
                : issue.message,
          }));
        }),
      };
    }
    const command = validated.data;
    const state = project(log.readEvents());
    if (command.type === "onboarding.confirm") {
      if (isOnboarded() || !configStore)
        return {
          ok: false,
          code: "invalid-transition",
          message: "The Project is already onboarded.",
        };
      const prepared = await configStore.prepareOnboarding(command.config);
      if (!prepared.config || prepared.errors.length)
        return {
          ok: false,
          code: "validation",
          message: "The config is invalid.",
          errors: prepared.errors,
        };
      await configStore.writeOnboarding(prepared.config);
      const seq = state.lastSeq + 1;
      append({
        seq,
        type: "onboarding.confirmed",
        v: 1,
        ts: clock.now().toISOString(),
        payload: { via: "manual", config: prepared.config },
      });
      await configStore.reload();
      return { ok: true, events: [seq] };
    }
    if (command.type !== "plan.submit") {
      const plan = state.plans.find(({ id }) => id === command.planId);
      if (!plan) {
        return {
          ok: false,
          code: "not-found",
          message: `Unknown Plan ${command.planId}.`,
        };
      }
      if (
        plan.state !== "awaiting-approval" &&
        !(command.type === "plan.abandon" && plan.state === "active")
      ) {
        return {
          ok: false,
          code: "invalid-transition",
          message: `${command.type} is not allowed from ${plan.state}.`,
        };
      }
    }
    if (command.type === "plan.approve") {
      append({
        seq: state.lastSeq + 1,
        type: "plan.approved",
        v: 1,
        ts: clock.now().toISOString(),
        payload: { planId: command.planId },
      });
      return { ok: true, events: [state.lastSeq + 1] };
    }
    if (command.type === "plan.sendBack") {
      append({
        seq: state.lastSeq + 1,
        type: "plan.returned",
        v: 1,
        ts: clock.now().toISOString(),
        payload: { planId: command.planId, notes: command.notes },
      });
      return { ok: true, events: [state.lastSeq + 1] };
    }
    if (command.type === "plan.abandon") {
      append({
        seq: state.lastSeq + 1,
        type: "plan.abandoned",
        v: 1,
        ts: clock.now().toISOString(),
        payload: { planId: command.planId, reason: command.reason },
      });
      return { ok: true, events: [state.lastSeq + 1] };
    }
    if (
      state.plans.some(
        ({ state }) => state === "awaiting-approval" || state === "active",
      )
    ) {
      return {
        ok: false,
        code: "plan-exists",
        message: "A Plan is awaiting approval or active.",
      };
    }
    const parsed = parsePlan(command.yaml);
    if (!parsed.valid)
      return {
        ok: false,
        code: "validation",
        message: "The Plan file is invalid.",
        errors: parsed.errors,
      };
    const seq = state.lastSeq + 1;
    const stem =
      parsed.plan.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 40)
        .replace(/^-|-$/g, "") || "plan";
    const used = new Set(state.plans.map(({ slug }) => slug));
    let slug = stem;
    for (let suffix = 2; used.has(slug); suffix++) slug = `${stem}-${suffix}`;
    append({
      seq,
      type: "plan.submitted",
      v: 1,
      ts: clock.now().toISOString(),
      payload: {
        planId: randomUUID(),
        slug,
        plan: parsed.plan,
        ...(command.sourcePath === undefined
          ? {}
          : { sourcePath: command.sourcePath }),
      },
    });
    return { ok: true, events: [seq] };
  }
}
export type Engine = ReturnType<typeof openEngine>;
