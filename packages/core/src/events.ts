import type { Plan, Risk, Task, ValidationError } from "@segno/plan-format";

export type PlanStatus =
  | "awaiting-approval"
  | "active"
  | "complete"
  | "returned"
  | "abandoned";
export type PhaseStatus =
  | "pending"
  | "starting"
  | "active"
  | "awaiting-merge"
  | "merged"
  | "abandoned";
export type TaskStatus =
  | "waiting"
  | "ready"
  | "coding"
  | "testing"
  | "reviewing"
  | "held"
  | "merging"
  | "done"
  | "blocked"
  | "taken-over"
  | "superseded";
export type BlockReason =
  | "review-limit"
  | "test-limit"
  | "infra-limit"
  | "verdict-invalid"
  | "setup-failed";
export type Budget = "review" | "test" | "infra";
export type RunKind =
  | "coder"
  | "docs"
  | "reviewer"
  | "planner"
  | "tests"
  | "setup"
  | "merge"
  | "probe";
export type RunOutcome =
  | "completed"
  | "failed"
  | "crashed"
  | "timeout"
  | "hung"
  | "rate-limited"
  | "interrupted"
  | "stopped";

export interface Finding {
  id: string;
  source: "reviewer" | "developer";
  severity: "blocking" | "advisory";
  file?: string;
  line?: number;
  body: string;
  createdInRun?: string;
}

// The Verdict's consistency checks and runtime schema arrive in B5/B6.
export interface Verdict {
  schemaVersion: 1;
  decision: "approve" | "reject";
  summary: string;
  acceptance: { index: number; met: boolean; note: string }[];
  docs: { needed: boolean; satisfied: boolean; note: string };
  findings: Omit<Finding, "id" | "source" | "createdInRun">[];
  risk?: { flag: Risk["flags"][number]; reason: string }[];
}

type PlanId = { planId: string };
type PhaseId = { phaseId: string };
type TaskId = { taskId: string };
type RunId = { runId: string };
type ConfigSource = "file" | "local" | "command";

/** All v1 Event payloads. Behavior beyond Plans is added in later build phases. */
export interface EventPayloads {
  "plan.submitted": PlanId & {
    slug: string;
    plan: Plan;
    sourcePath?: string;
  };
  "plan.approved": PlanId;
  "plan.returned": PlanId & { notes: string };
  "plan.abandoned": PlanId & { reason: string };
  "plan.completed": PlanId;
  "phase.startDeferred": PhaseId & { reason: string; nextAttemptAt: string };
  "phase.started": PhaseId & {
    branch: string;
    baseSha: string;
    docsTask: Task;
  };
  "phase.pushed": PhaseId & { sha: string };
  "phase.prOpened": PhaseId & { url: string; number: number };
  "phase.prOpenFailed": PhaseId & { compareUrl: string; detail: string };
  "phase.prStateObserved": PhaseId & { state: "OPEN" | "CLOSED" | "MERGED" };
  "phase.prReopened": PhaseId;
  "phase.merged": PhaseId & { via: "forge" | "manual" };
  "task.transitioned": TaskId & {
    from: TaskStatus;
    to: TaskStatus;
    cause: string;
    blockReason?: BlockReason;
  };
  "task.budgetUsed": TaskId & { budget: Budget; count: number };
  "task.budgetReset": TaskId & { budgets: Budget[]; by: "retry" | "replan" };
  "task.pauseChanged": TaskId & {
    paused: boolean;
    by: "developer" | "board";
  };
  "task.worktreeCreated": TaskId & { path: string; branch: string };
  "task.worktreeRemoved": TaskId & { path: string; branch: string };
  "task.committed": TaskId & { sha: string; by: "engine" | "developer" };
  "task.findingAdded": TaskId & { finding: Finding };
  "task.findingsClosed": TaskId & {
    findingIds: string[];
    byVerdictSeq: number;
  };
  "task.riskRaised": TaskId & {
    flags: Risk["flags"];
    reason: string;
    byRunId: string;
  };
  "task.revised": TaskId & { revision: number; definition: Task };
  // The catalog does not yet specify the entries of rewiredDependents (B7).
  "task.split": TaskId & { newTasks: Task[]; rewiredDependents: unknown[] };
  "task.forceApproved": TaskId & { reason: string };
  "task.takenOver": TaskId;
  "task.handedBack": TaskId;
  "run.started": RunId & {
    taskId?: string;
    sessionKind?: string;
    kind: RunKind;
    role: string;
    adapter?: string;
    model?: string;
    resumeOf?: string;
  };
  "run.sessionStarted": RunId & { sessionId: string };
  "run.finished": RunId & {
    outcome: RunOutcome;
    exitCode?: number;
    detail?: string;
    resetAt?: string;
  };
  "verdict.recorded": RunId & TaskId & { verdict: Verdict };
  "verdict.malformed": RunId & TaskId & { errors: unknown[]; raw?: string };
  "merge.conflicted": TaskId & { files: string[] };
  "board.paused": Record<string, never>;
  "board.resumed": Record<string, never>;
  "ratelimit.paused": {
    adapter: string;
    resetAt?: string;
    nextCheckAt: string;
  };
  "ratelimit.lifted": { adapter: string };
  "watchdog.corrected": TaskId & { violation: string; action: string };
  "config.changed": { source: ConfigSource; changes: Record<string, unknown> };
  "config.rejected": { source: ConfigSource; errors: ValidationError[] };
  "store.pruned": { runIds: string[] };
}

/** Runtime catalog recognition; the first-release catalog freezes in B10. */
export const eventVersions = {
  "plan.submitted": 1,
  "plan.approved": 1,
  "plan.returned": 1,
  "plan.abandoned": 1,
  "plan.completed": 1,
  "phase.startDeferred": 1,
  "phase.started": 1,
  "phase.pushed": 1,
  "phase.prOpened": 1,
  "phase.prOpenFailed": 1,
  "phase.prStateObserved": 1,
  "phase.prReopened": 1,
  "phase.merged": 1,
  "task.transitioned": 1,
  "task.budgetUsed": 1,
  "task.budgetReset": 1,
  "task.pauseChanged": 1,
  "task.worktreeCreated": 1,
  "task.worktreeRemoved": 1,
  "task.committed": 1,
  "task.findingAdded": 1,
  "task.findingsClosed": 1,
  "task.riskRaised": 1,
  "task.revised": 1,
  "task.split": 1,
  "task.forceApproved": 1,
  "task.takenOver": 1,
  "task.handedBack": 1,
  "run.started": 1,
  "run.sessionStarted": 1,
  "run.finished": 1,
  "verdict.recorded": 1,
  "verdict.malformed": 1,
  "merge.conflicted": 1,
  "board.paused": 1,
  "board.resumed": 1,
  "ratelimit.paused": 1,
  "ratelimit.lifted": 1,
  "watchdog.corrected": 1,
  "config.changed": 1,
  "config.rejected": 1,
  "store.pruned": 1,
} as const satisfies Record<keyof EventPayloads, 1>;

export type EventType = keyof EventPayloads;
export type EventOf<T extends EventType> = {
  seq: number;
  type: T;
  v: 1;
  ts: string;
  payload: EventPayloads[T];
};
export type Event = { [T in EventType]: EventOf<T> }[EventType];
