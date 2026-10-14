import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  type AdapterId,
  type AgentAdapter,
  type CommandResult,
  type ConfigError,
  type OnboardingProposal,
  onboardingOutputJsonSchema,
  onboardingOutputSchema,
  pointer,
  type RunResult,
  type SegnoConfig,
  type State,
} from "@segno/core";
import { onboardingPermissions, onboardingPrompt } from "./context.js";
import { createScratchWorktree, removeScratchWorktree } from "./git.js";
import {
  ended,
  type LimitEvent,
  type LiveRuns,
  launchAgentRun,
} from "./live.js";
import type { Draft } from "./work.js";

/** What an onboarding Run needs from the host while a Project isn't onboarded. */
export interface OnboardingContext {
  adapter: AdapterId;
  /** The pending config's Planner model, overridden by local settings. */
  model: string;
  /** The detected remote and base branch the checks run on. */
  remote: string;
  baseBranch: string;
  /** The detected settings, in the proposal's config shape. */
  guess: Record<string, unknown>;
  worktreeRoot?: string | undefined;
}

interface OnboardingDeps {
  repo: string;
  projectDir: string;
  adapters: readonly AgentAdapter[];
  context(): Promise<OnboardingContext>;
  /** Validates a config overlaid with the pending models, as onboarding.confirm does. */
  prepare(
    config: unknown,
  ): Promise<{ config?: SegnoConfig; errors: ConfigError[] }>;
  readState(): State;
  emit(drafts: readonly Draft[]): number[];
  internal(work: () => Promise<unknown>): void;
  live: LiveRuns;
  onLimit(adapter: AgentAdapter, event: LimitEvent): void;
  onError(error: unknown): void;
}

const rejected = (message: string): CommandResult => ({
  ok: false,
  code: "invalid-transition",
  message,
});

/** The onboarding Run: one Planner Run that proposes a config [ADR-0049]. */
export function openOnboarding(deps: OnboardingDeps) {
  const { repo, projectDir, readState, emit, internal, live } = deps;
  /** Each live Run's scratch worktree, and the ref and commit it's at. */
  const scratches = new Map<
    string,
    { path: string; ref: string; sha: string }
  >();

  /** `_onboarding/` where the Task worktrees go [ADR-0009]. */
  function scratchPath(worktreeRoot: string | undefined) {
    return worktreeRoot
      ? join(worktreeRoot, basename(projectDir), "_onboarding")
      : join(projectDir, "worktrees", "_onboarding");
  }

  /** Deletes a Run's scratch worktree, wherever a restart left it. */
  async function removeScratch(runId: string) {
    try {
      const path =
        scratches.get(runId)?.path ??
        scratchPath((await deps.context()).worktreeRoot);
      await removeScratchWorktree(repo, path);
    } catch (error) {
      deps.onError(error);
    }
    scratches.delete(runId);
  }

  async function start(): Promise<CommandResult> {
    const { onboarding } = readState();
    if (onboarding.state === "running")
      return rejected("An onboarding Run is already live.");
    if (onboarding.state === "proposed")
      return rejected("A proposal is awaiting review.");
    const context = await deps.context();
    const adapter = deps.adapters.find(({ id }) => id === context.adapter);
    if (!adapter)
      throw new Error(`No ${context.adapter} Adapter is available.`);
    const path = scratchPath(context.worktreeRoot);
    // A crash or restart can leave the last one behind.
    if (existsSync(path)) await removeScratchWorktree(repo, path);
    await mkdir(dirname(path), { recursive: true });
    const ref = `${context.remote}/${context.baseBranch}`;
    const sha = await createScratchWorktree(repo, { path, ref });
    const runId = randomUUID();
    scratches.set(runId, { path, ref, sha });
    const dir = join(projectDir, "runs", runId);
    mkdirSync(dir, { recursive: true });
    const events = emit([
      { type: "onboarding.started", payload: { runId } },
      {
        type: "run.started",
        payload: {
          runId,
          kind: "onboarding",
          role: "planner",
          adapter: adapter.id,
          model: context.model,
        },
      },
    ]);
    try {
      launchAgentRun({
        adapter,
        spec: {
          runId,
          kind: "onboarding",
          model: context.model,
          cwd: path,
          prompt: onboardingPrompt({
            guess: context.guess,
            schema: onboardingOutputJsonSchema,
          }),
          systemPrompt: "",
          permissions: onboardingPermissions,
          outputSchema: onboardingOutputJsonSchema,
          // No SEGNO_TASK_ID: onboarding works no Task [ADR-0029].
          env: { SEGNO: "1", SEGNO_RUN_ID: runId, SEGNO_SLOT: "0" },
          transcriptPath: join(dir, "transcript.jsonl"),
        },
        live,
        onSession: (sessionId) =>
          internal(async () => {
            if (!finishedRun(runId))
              emit([
                { type: "run.sessionStarted", payload: { runId, sessionId } },
              ]);
          }),
        onLimit: (event) => deps.onLimit(adapter, event),
        onResult: (result) =>
          internal(() =>
            finish(runId, result).catch(async (error) => {
              deps.onError(error);
              await fail(runId, "crashed", { detail: describe(error) });
            }),
          ),
      });
    } catch (error) {
      await fail(runId, "crashed", { detail: describe(error) });
    }
    return { ok: true, events };
  }

  function finishedRun(runId: string) {
    return readState().runs.find(({ id }) => id === runId)?.outcome;
  }

  async function finish(runId: string, result: RunResult) {
    if (finishedRun(runId)) return;
    if (result.kind === "rate-limited") {
      // No failure: B8's rate-limit pause reruns it; until then it's idle again.
      await removeScratch(runId);
      emit([
        {
          type: "run.finished",
          payload: {
            runId,
            outcome: "rate-limited",
            detail: result.detail,
            ...(result.resetAt ? { resetAt: result.resetAt } : {}),
          },
        },
      ]);
      return ended(live, runId, "rate-limited");
    }
    // Crashed or failed: onboarding calls both crashed.
    if (result.kind !== "completed")
      return fail(
        runId,
        "crashed",
        { detail: result.detail },
        {
          outcome: result.kind,
          ...(result.exitCode === undefined
            ? {}
            : { exitCode: result.exitCode }),
        },
      );
    const structured = result.structured;
    if (structured !== undefined)
      // The proposal exactly as received [ADR-0033].
      writeFileSync(
        join(projectDir, "runs", runId, "proposal.json"),
        `${JSON.stringify(structured, null, 2)}\n`,
      );
    if (structured === undefined)
      return fail(runId, "invalid-proposal", {
        detail: "The Run gave no structured output.",
      });
    const parsed = onboardingOutputSchema.safeParse(structured);
    if (!parsed.success)
      return fail(runId, "invalid-proposal", {
        detail: "The output doesn't match the proposal schema.",
        errors: parsed.error.issues.map((issue) => ({
          path: pointer(issue.path as (string | number)[]),
          code: "schema",
          message: issue.message,
        })),
      });
    const output = parsed.data;
    if (output.kind === "unable")
      return fail(runId, "unable", { detail: output.explanation });
    const { coderAllow, ...values } = output.config;
    // The Engine adds the pending models; the proposal is then a whole config.
    const candidate = {
      schemaVersion: 1,
      ...values,
      roles: { coder: coderAllow ? { allow: coderAllow } : {} },
    };
    const prepared = await deps.prepare(candidate);
    if (prepared.errors.length || !prepared.config)
      return fail(runId, "invalid-proposal", {
        detail: "The proposed config is invalid.",
        errors: prepared.errors,
      });
    const scratch = scratches.get(runId);
    if (!scratch) throw new Error(`Run ${runId} has no scratch worktree.`);
    const proposal: OnboardingProposal = {
      config: prepared.config,
      reasons: Object.fromEntries(
        Object.entries(output.reasons).map(([path, reason]) => [
          path.replace(/^\/coderAllow(?=\/|$)/, "/roles/coder/allow"),
          reason,
        ]),
      ),
      checks: output.checks,
      ...(output.flags ? { flags: output.flags } : {}),
      ref: scratch.ref,
      sha: scratch.sha,
    };
    await removeScratch(runId);
    emit([
      { type: "run.finished", payload: { runId, outcome: "completed" } },
      { type: "onboarding.proposed", payload: { runId, proposal } },
    ]);
    ended(live, runId, "completed");
  }

  /**
   * Records the Run's outcome and why onboarding failed. A Run that crashed
   * or failed is recorded as it ended; onboarding calls both `crashed`.
   */
  async function fail(
    runId: string,
    reason: "unable" | "invalid-proposal" | "crashed",
    extra: { detail?: string; errors?: unknown[] },
    run: { outcome: "crashed" | "failed"; exitCode?: number } = {
      outcome: "crashed",
    },
  ) {
    await removeScratch(runId);
    const finished =
      reason === "crashed"
        ? {
            ...run,
            ...(extra.detail === undefined ? {} : { detail: extra.detail }),
          }
        : { outcome: "completed" as const };
    emit([
      { type: "run.finished", payload: { runId, ...finished } },
      { type: "onboarding.failed", payload: { runId, reason, ...extra } },
    ]);
    ended(live, runId, finished.outcome);
  }

  /** Stops the live Run; recorded even if a restart already ended it. */
  async function stop(): Promise<CommandResult> {
    const { onboarding } = readState();
    const runId = onboarding.runId;
    if (onboarding.state !== "running" || !runId)
      return rejected("No onboarding Run is live.");
    const events = emit([
      { type: "run.finished", payload: { runId, outcome: "stopped" } },
      { type: "onboarding.stopped", payload: { runId } },
    ]);
    await live.get(runId)?.stop();
    await removeScratch(runId);
    ended(live, runId, "stopped");
    return { ok: true, events };
  }

  return { start, stop };
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
