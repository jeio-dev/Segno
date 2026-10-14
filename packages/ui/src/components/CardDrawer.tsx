import {
  type BoardTask,
  type HostClient,
  type RunState,
  scriptRunKinds as scriptKinds,
  type TaskState,
} from "@segno/core";
import { useEffect, useId, useState } from "react";
import { errorMessage } from "../format.js";
import { RunLog } from "./RunLog.js";
import { holderOf, RoleDot } from "./TaskBoard.js";

const tabs = ["Diff", "Tests", "Transcript"] as const;
type Tab = (typeof tabs)[number];
const roleLabels: Record<string, string> = {
  coder: "Coder",
  reviewer: "Reviewer",
  planner: "Planner",
};

/** A side panel over the board for one Task [gui.md § Card drawer]. */
export function CardDrawer({
  client,
  projectId,
  task,
  card,
  runs,
  onClose,
}: {
  client: HostClient;
  projectId: string;
  task: TaskState;
  card: BoardTask | undefined;
  runs: RunState[];
  onClose(): void;
}) {
  const [tab, setTab] = useState<Tab>("Diff");
  const id = useId();
  const holder = card && holderOf(card);
  const { definition, budgets } = task;
  return (
    <aside className="drawer" aria-label={`Task ${task.id}`}>
      <header className="drawer-header">
        <div className="drawer-title">
          <div className="row">
            <span className="task-id">{task.id}</span>
            <span className="badge badge-muted">{task.state}</span>
            {holder && <RoleDot holder={holder} live={Boolean(card?.run)} />}
          </div>
          <h2>{definition.title}</h2>
          <span className="mono muted">
            R {budgets.review}/2 T {budgets.test}/2
            {budgets.infra > 0 && ` I ${budgets.infra}/3`}
          </span>
        </div>
        <button type="button" className="button button-quiet" onClick={onClose}>
          Close
        </button>
      </header>
      <div className="drawer-body">
        <section className="drawer-definition" aria-label="Definition">
          <p className="prose">{definition.description}</p>
          <div>
            <span className="muted">Acceptance</span>
            <ul>
              {definition.acceptance.map((criterion) => (
                <li key={criterion}>{criterion}</li>
              ))}
            </ul>
          </div>
          {definition.context && definition.context.length > 0 && (
            <p className="muted">
              Context{" "}
              <span className="mono">{definition.context.join("  ")}</span>
            </p>
          )}
        </section>
        <div className="tabs" role="tablist" aria-label="Task details">
          {tabs.map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              id={`${id}-${name}`}
              aria-selected={tab === name}
              aria-controls={`${id}-${name}-panel`}
              className="tab"
              onClick={() => setTab(name)}
            >
              {name}
            </button>
          ))}
        </div>
        <div
          role="tabpanel"
          id={`${id}-${tab}-panel`}
          aria-labelledby={`${id}-${tab}`}
          className="tab-panel"
        >
          {tab === "Diff" ? (
            <DiffView client={client} projectId={projectId} task={task} />
          ) : (
            <RunList
              client={client}
              projectId={projectId}
              runs={runs.filter(({ kind }) =>
                tab === "Tests"
                  ? scriptKinds.includes(kind)
                  : !scriptKinds.includes(kind),
              )}
              script={tab === "Tests"}
            />
          )}
        </div>
      </div>
    </aside>
  );
}

/** The Task's diff, re-read whenever the Task moves on. */
function DiffView({
  client,
  projectId,
  task,
}: {
  client: HostClient;
  projectId: string;
  task: TaskState;
}) {
  const [diff, setDiff] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const moved = task.history.at(-1)?.seq ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the diff changes only as the Task moves between steps
  useEffect(() => {
    let current = true;
    client
      .query(projectId, "taskDiff", { taskId: task.id })
      .then((result) => current && setDiff(result.diff))
      .catch((error) => current && setProblem(errorMessage(error)));
    return () => {
      current = false;
    };
  }, [client, projectId, task.id, moved]);
  if (problem) return <p className="muted">{problem}</p>;
  if (diff === undefined) return <p className="muted">Loading the diff…</p>;
  if (!diff) return <p className="muted">No changes yet.</p>;
  return (
    <pre className="diff">
      {diff.split("\n").map((line, index) => (
        <span
          // Lines of one diff have no identity beyond their position.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above
          key={index}
          className={
            line.startsWith("+") && !line.startsWith("+++")
              ? "diff-line diff-add"
              : line.startsWith("-") && !line.startsWith("---")
                ? "diff-line diff-del"
                : "diff-line"
          }
        >
          {line}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

/** Newest first: agent Runs with Role, model and outcome, or script Runs. */
function RunList({
  client,
  projectId,
  runs,
  script,
}: {
  client: HostClient;
  projectId: string;
  runs: RunState[];
  script: boolean;
}) {
  if (!runs.length)
    return (
      <p className="muted">
        {script ? "No test runs yet." : "No agent runs yet."}
      </p>
    );
  return (
    <ol className="run-list">
      {[...runs].reverse().map((run) => (
        <li key={run.id} className="run">
          <div className="row">
            {script ? (
              <span className="mono">{run.kind}</span>
            ) : (
              <>
                <span>{roleLabels[run.role] ?? run.role}</span>
                {run.kind !== run.role && (
                  <span className="mono muted">{run.kind}</span>
                )}
              </>
            )}
            {run.model && <span className="mono muted">{run.model}</span>}
            <RunStatus run={run} />
            {run.finishedAt && (
              <span className="mono muted">
                {duration(run.startedAt, run.finishedAt)}
              </span>
            )}
          </div>
          <RunLog client={client} projectId={projectId} run={run} />
        </li>
      ))}
    </ol>
  );
}

function RunStatus({ run }: { run: RunState }) {
  if (!run.outcome) return <span className="badge badge-info">live</span>;
  if (run.exitCode !== undefined)
    return (
      <span
        className={`badge ${run.exitCode === 0 ? "badge-ok" : "badge-bad"}`}
      >
        exit {run.exitCode}
      </span>
    );
  return (
    <span
      className={`badge ${run.outcome === "completed" ? "badge-ok" : "badge-bad"}`}
    >
      {run.outcome}
    </span>
  );
}

function duration(from: string, to: string) {
  const seconds = Math.max(
    0,
    Math.round((Date.parse(to) - Date.parse(from)) / 1000),
  );
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
