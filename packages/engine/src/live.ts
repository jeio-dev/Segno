import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  AgentAdapter,
  RunEvent,
  RunOutcome,
  RunOutputItem,
  RunResult,
  RunSpec,
} from "@segno/core";

export type LimitEvent = Extract<RunEvent, { type: "usage" | "rateLimited" }>;

export interface LiveRun {
  stop(): Promise<void>;
  listeners: Set<(item: RunOutputItem) => void>;
  /** Everything output so far, replayed to a listener that joins late. */
  output: string[];
}
export type LiveRuns = Map<string, LiveRun>;

/** Sends one item to a live Run's listeners. */
export function send(live: LiveRuns, runId: string, item: RunOutputItem) {
  const run = live.get(runId);
  if (item.kind === "output") run?.output.push(item.text);
  for (const listener of run?.listeners ?? [])
    try {
      listener(item);
    } catch {}
}

/** Ends the live stream once the Run's outcome is recorded. */
export function ended(live: LiveRuns, runId: string, outcome: RunOutcome) {
  send(live, runId, { kind: "end", outcome });
  live.delete(runId);
}

/**
 * Writes `prompt.md` and starts an agent Run. Its live output goes to the
 * Run's listeners, and its result to `onResult` once its events are drained.
 */
export function launchAgentRun({
  adapter,
  spec,
  live,
  onSession,
  onLimit,
  onResult,
}: {
  adapter: AgentAdapter;
  spec: RunSpec;
  live: LiveRuns;
  onSession(sessionId: string): void;
  /** Usage and rate-limit signals, as the Adapter reported them. */
  onLimit?(event: LimitEvent): void;
  onResult(result: RunResult): void;
}) {
  // prompt.md is exactly what the Run was given [ADR-0033].
  writeFileSync(join(dirname(spec.transcriptPath), "prompt.md"), spec.prompt);
  const handle = adapter.start(spec);
  live.set(spec.runId, {
    stop: () => handle.stop(),
    listeners: new Set(),
    output: [],
  });
  const drained = (async () => {
    for await (const event of handle.events) {
      if (event.type === "started") onSession(event.sessionId);
      else if (event.type === "output")
        send(live, spec.runId, { kind: "output", text: event.text });
      else if (event.type === "usage" || event.type === "rateLimited")
        onLimit?.(event);
    }
  })().catch(() => {});
  void Promise.all([
    handle.result.catch(
      (error): RunResult => ({
        kind: "crashed",
        detail: error instanceof Error ? error.message : String(error),
      }),
    ),
    drained,
  ]).then(([result]) => onResult(result));
}
