import {
  type AwaitingItem,
  boardOf,
  type CommandResult,
  type ConfigStatus,
  type HostClient,
  type PlanState,
  type ProjectSummary,
  type State,
  type Usage,
} from "@segno/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { errorMessage } from "../format.js";
import type { AppStore } from "../store.js";
import { AwaitingPanel } from "./AwaitingPanel.js";
import { CardDrawer } from "./CardDrawer.js";
import { Onboarding, onboardingReviewId } from "./Onboarding.js";
import { PlanReview } from "./PlanReview.js";
import { RejectionNotice } from "./RejectionNotice.js";
import { TaskBoard } from "./TaskBoard.js";

type PlanErrors = Extract<CommandResult, { code: "validation" }>["errors"];

/** The selected running Project: its board and its Awaiting-you panel. */
export function ProjectView({
  store,
  client,
  project,
  state,
}: {
  store: AppStore;
  client: HostClient;
  project: Exclude<ProjectSummary, { status: "unavailable" }>;
  state: State | undefined;
}) {
  const [config, setConfig] = useState<ConfigStatus>();
  const [selected, setSelected] = useState<string>();
  const [reviewing, setReviewing] = useState<AwaitingItem>();

  const readConfig = useCallback(() => {
    if (project.status === "not-onboarded") {
      setConfig(undefined);
      return;
    }
    // The commit hint is re-checked each time it's read [ADR-0039].
    client
      .query(project.id, "config")
      .then(setConfig)
      .catch(() => setConfig(undefined));
  }, [client, project.id, project.status]);
  useEffect(() => {
    readConfig();
    window.addEventListener("focus", readConfig);
    return () => window.removeEventListener("focus", readConfig);
  }, [readConfig]);

  const reviewedPlan = reviewing
    ? state?.plans.find(({ id }) => id === reviewing.planId)
    : undefined;

  return (
    <div className="project-view">
      <Board
        store={store}
        client={client}
        project={project}
        state={state}
        config={config}
        onReview={setReviewing}
        selected={selected}
        onSelect={setSelected}
      />
      <AwaitingPanel
        client={client}
        projectId={project.id}
        items={state?.awaiting}
        onReview={(item) => {
          // The proposal's review is on the not-onboarded board itself.
          if (item.kind === "onboarding-review")
            document
              .getElementById(onboardingReviewId)
              ?.scrollIntoView({ behavior: "smooth" });
          else if (item.taskId) setSelected(item.taskId);
          else setReviewing(item);
        }}
      />
      {reviewing && reviewedPlan && (
        <PlanReview
          client={client}
          projectId={project.id}
          plan={reviewedPlan}
          open={reviewedPlan.state === "awaiting-approval"}
          onClose={() => setReviewing(undefined)}
        />
      )}
    </div>
  );
}

function Board({
  store,
  client,
  project,
  state,
  config,
  onReview,
  selected,
  onSelect,
}: {
  store: AppStore;
  client: HostClient;
  project: ProjectSummary;
  state: State | undefined;
  config: ConfigStatus | undefined;
  onReview(item: AwaitingItem): void;
  selected: string | undefined;
  onSelect(taskId: string | undefined): void;
}) {
  const active = state?.plans.find((plan) => plan.state === "active");
  const awaitingItem = state?.awaiting.find(
    (item) => item.kind === "plan-approval",
  );
  const concurrency = config?.effective?.concurrency ?? 1;
  const board = useMemo(
    () => (state ? boardOf(state, { concurrency }) : undefined),
    [state, concurrency],
  );
  const doneOrder = useMemo(
    () =>
      new Map(
        (state?.tasks ?? []).map((task) => [
          task.id,
          task.history.at(-1)?.seq ?? 0,
        ]),
      ),
    [state],
  );
  const usage = useUsage(client, project.id, state?.lastSeq);
  const selectedTask = state?.tasks.find(
    ({ id, planId }) => id === selected && planId === active?.id,
  );
  const phase = board?.phase;

  return (
    <section className="board" aria-label="Board">
      <header className="board-header">
        <div className="board-title">
          {active && <span className="muted">{project.name}</span>}
          <h1>{active ? active.definition.title : project.name}</h1>
          {active && (
            <div className="board-meta">
              {phase ? (
                <>
                  <span>{phase.title}</span>
                  <span className="mono">{phase.branch}</span>
                  <span className="badge badge-info">{phase.state}</span>
                </>
              ) : (
                <>
                  <span className="badge badge-info">{active.state}</span>
                  <span>Starting the first Phase</span>
                </>
              )}
            </div>
          )}
        </div>
        {(active || usage) && (
          <div className="row">
            {usage && <UsageMeter usage={usage} />}
            {active && board && (
              <span className="session-meter mono" title="Session meter">
                Sessions {board.sessions.live}/{board.sessions.concurrency} ·{" "}
                {board.sessions.startedInPhase} this phase
              </span>
            )}
            {active && (
              <ExportPlan
                store={store}
                client={client}
                projectId={project.id}
                plan={active}
              />
            )}
          </div>
        )}
      </header>
      <div className="board-body">
        {config?.effective && !config.committed && (
          <div className="notice" role="status">
            <span className="badge badge-warn">hint</span>
            segno.config.json isn't on {config.effective.remote}/
            {config.effective.baseBranch} yet. Commit and push it so the team
            shares it.
          </div>
        )}
        {project.status === "not-onboarded" ? (
          <Onboarding
            client={client}
            projectId={project.id}
            state={state}
            onSaved={() => store.refreshProjects()}
          />
        ) : active ? (
          board?.phase ? (
            <TaskBoard
              board={board}
              doneOrder={doneOrder}
              selected={selectedTask?.id}
              onSelect={onSelect}
            />
          ) : (
            <p className="muted">
              {active.phases.find(({ state }) => state === "starting")?.deferred
                ? "The remote is unreachable; the Phase start is retried every 5 minutes."
                : "Fetching the remote to start the Phase."}
            </p>
          )
        ) : awaitingItem ? (
          <div className="empty-state">
            <h2>A Plan is awaiting your approval</h2>
            <p className="muted">{awaitingItem.title}</p>
            <button
              type="button"
              className="button button-primary"
              onClick={() => onReview(awaitingItem)}
            >
              Review plan
            </button>
          </div>
        ) : (
          <SubmitPlan store={store} client={client} projectId={project.id} />
        )}
      </div>
      {selectedTask && state && (
        <CardDrawer
          key={selectedTask.id}
          client={client}
          projectId={project.id}
          task={selectedTask}
          card={board?.tasks.find(({ id }) => id === selectedTask.id)}
          runs={state.runs.filter(({ taskId }) => taskId === selectedTask.id)}
          onClose={() => onSelect(undefined)}
        />
      )}
    </section>
  );
}

/**
 * Subscription usage from the `board` query, which alone holds it: it's
 * reported in memory, never recorded. Re-read on each Event and every 30 s.
 */
function useUsage(
  client: HostClient,
  projectId: string,
  lastSeq: number | undefined,
) {
  const [usage, setUsage] = useState<Usage>();
  useEffect(() => {
    // Read once the Project's Events have loaded, and again after each one.
    if (lastSeq === undefined) return;
    let current = true;
    const read = () =>
      client
        .query(projectId, "board")
        .then((board) => current && setUsage(board.usage))
        .catch(() => {});
    void read();
    const timer = setInterval(read, 30_000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [client, projectId, lastSeq]);
  return usage;
}

/** Used / limit and the reset time, or only the last known reset time [ADR-0021]. */
function UsageMeter({ usage }: { usage: Usage }) {
  const resets =
    usage.resetAt &&
    new Date(usage.resetAt).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  return (
    <span className="session-meter mono" title="Subscription usage">
      {usage.used === undefined
        ? `Resets ${resets}`
        : `Usage ${usage.used}${usage.limit === undefined ? "" : `/${usage.limit}`}${resets ? ` · resets ${resets}` : ""}`}
    </span>
  );
}

function SubmitPlan({
  store,
  client,
  projectId,
}: {
  store: AppStore;
  client: HostClient;
  projectId: string;
}) {
  const [dragging, setDragging] = useState(false);
  const [problem, setProblem] = useState<{
    message: string;
    errors?: PlanErrors;
  }>();

  async function submit(yaml: string, sourcePath: string) {
    setProblem(undefined);
    try {
      const result = await client.command(projectId, {
        type: "plan.submit",
        yaml,
        sourcePath,
      });
      if (!result.ok)
        setProblem({
          message: result.message,
          ...("errors" in result ? { errors: result.errors } : {}),
        });
    } catch (error) {
      setProblem({ message: errorMessage(error) });
    }
  }

  async function pick() {
    const picked = await store.bridge.pickPlanFile();
    if (!picked) return;
    if ("error" in picked) setProblem({ message: picked.error });
    else await submit(picked.yaml, picked.path);
  }

  async function drop(files: FileList) {
    const file = files[0];
    if (!file) return;
    if (!/\.ya?ml$/i.test(file.name)) {
      setProblem({ message: `${file.name} isn't a .yaml or .yml file.` });
      return;
    }
    await submit(await file.text(), store.bridge.pathForFile(file));
  }

  return (
    <section
      className="empty-state"
      aria-label="Submit a Plan file"
      data-dragging={dragging}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        void drop(event.dataTransfer.files);
      }}
    >
      <h2>No active plan</h2>
      <p className="muted">
        Submit a Plan file, or drop a .yaml or .yml file here.
      </p>
      <button
        type="button"
        className="button button-primary"
        onClick={() => void pick()}
      >
        Submit Plan file…
      </button>
      {problem && <RejectionNotice {...problem} />}
    </section>
  );
}

function ExportPlan({
  store,
  client,
  projectId,
  plan,
}: {
  store: AppStore;
  client: HostClient;
  projectId: string;
  plan: PlanState;
}) {
  const [error, setError] = useState<string>();
  async function exportPlan() {
    setError(undefined);
    try {
      const yaml = await client.query(projectId, "planExport", {
        planId: plan.id,
      });
      await store.bridge.saveFile(`${plan.slug}.yaml`, yaml);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }
  return (
    <div className="row">
      <button
        type="button"
        className="button"
        onClick={() => void exportPlan()}
      >
        Export Plan…
      </button>
      {error && <span className="badge badge-bad">{error}</span>}
    </div>
  );
}
