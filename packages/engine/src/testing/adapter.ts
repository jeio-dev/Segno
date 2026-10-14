import { randomUUID } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  AdapterId,
  AgentAdapter,
  RunEvent,
  RunHandle,
  RunResult,
  RunSpec,
  Verdict,
} from "@segno/core";

/** One Run as a fake script sees it. */
export interface FakeRun {
  spec: RunSpec;
  /** Emits an `output` RunEvent and tees it to the transcript. */
  output(text: string): Promise<void>;
  /** Resolves once the Engine has called `stop()`. */
  stopped: Promise<void>;
}
export type FakeScript = (run: FakeRun) => Promise<RunResult>;

/** A Coder that writes `<task-id>.txt` in its worktree and leaves it uncommitted. */
export function writesFiles(
  files: (spec: RunSpec) => Record<string, string> = (spec) => ({
    [`${spec.env.SEGNO_TASK_ID}.txt`]: `Work for ${spec.env.SEGNO_TASK_ID}\n`,
  }),
): FakeScript {
  return async (run) => {
    for (const [name, content] of Object.entries(files(run.spec))) {
      await run.output(`Writing ${name}\n`);
      writeFileSync(join(run.spec.cwd, name), content);
    }
    await run.output("Done.\n");
    return completed(run.spec);
  };
}

/** A Reviewer that approves. */
export function approves(): FakeScript {
  return async (run) => {
    await run.output("Reviewing the diff.\n");
    const verdict: Verdict = {
      schemaVersion: 1,
      decision: "approve",
      summary: "Meets every acceptance criterion.",
      acceptance: [],
      docs: { needed: false, satisfied: true, note: "" },
      findings: [],
    };
    return { ...completed(run.spec), structured: verdict };
  };
}

/** A Run that keeps going until the Engine stops it. */
export function runsUntilStopped(): FakeScript {
  return async (run) => {
    await run.output("Working…\n");
    await run.stopped;
    return { kind: "crashed", detail: "Stopped." };
  };
}

function completed(spec: RunSpec): RunResult {
  return { kind: "completed", sessionId: spec.runId, finalText: "Done." };
}

/**
 * The fake Agent Adapter for S3, S6 and S9. By default the Coder writes a file
 * and the Reviewer approves. `paceMs` spaces out output so a live Run is seen.
 */
export function fakeAdapter(
  scripts: Partial<Record<RunSpec["kind"], FakeScript>> = {},
  { id = "claude-code", paceMs = 0 }: { id?: AdapterId; paceMs?: number } = {},
) {
  const runs: RunSpec[] = [];
  const defaults: Partial<Record<RunSpec["kind"], FakeScript>> = {
    coder: writesFiles(),
    docs: writesFiles(),
    reviewer: approves(),
  };
  const adapter = {
    id,
    capabilities: {
      resume: true,
      structuredOutput: true,
      toolAllowlist: true,
      usage: false,
    },
    async detect() {
      return { installed: true, version: "fake" };
    },
    /** Every RunSpec the Engine started, in order. */
    runs,
    start(spec: RunSpec): RunHandle {
      runs.push(spec);
      const events = eventQueue();
      let stop!: () => void;
      const stopped = new Promise<void>((resolve) => {
        stop = resolve;
      });
      const emit = (event: RunEvent) => {
        appendFileSync(spec.transcriptPath, `${JSON.stringify(event)}\n`);
        events.push(event);
      };
      const script =
        scripts[spec.kind] ??
        defaults[spec.kind] ??
        (async () => completed(spec));
      const result = (async () => {
        emit({ type: "started", sessionId: randomUUID() });
        return script({
          spec,
          stopped,
          async output(text) {
            if (paceMs) await sleep(paceMs);
            emit({ type: "output", text });
          },
        });
      })().finally(() => events.end());
      return {
        events,
        result,
        async stop() {
          stop();
          await result.catch(() => {});
        },
      };
    },
  } satisfies AgentAdapter & Record<string, unknown>;
  return adapter;
}
export type FakeAdapter = ReturnType<typeof fakeAdapter>;

function eventQueue() {
  const buffered: RunEvent[] = [];
  let ended = false;
  let wake: (() => void) | undefined;
  return {
    push(event: RunEvent) {
      buffered.push(event);
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const next = buffered.shift();
        if (next) yield next;
        else if (ended) return;
        else
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
      }
    },
  };
}
