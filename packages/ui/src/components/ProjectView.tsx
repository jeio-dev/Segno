import type {
  AwaitingItem,
  CommandResult,
  ConfigStatus,
  HostClient,
  PlanState,
  ProjectSummary,
  State,
} from "@segno/core";
import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "../format.js";
import type { AppStore } from "../store.js";
import { AwaitingPanel } from "./AwaitingPanel.js";
import { Onboarding } from "./Onboarding.js";
import { PlanReview } from "./PlanReview.js";
import { RejectionNotice } from "./RejectionNotice.js";

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
      />
      <AwaitingPanel items={state?.awaiting} onReview={setReviewing} />
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
}: {
  store: AppStore;
  client: HostClient;
  project: ProjectSummary;
  state: State | undefined;
  config: ConfigStatus | undefined;
  onReview(item: AwaitingItem): void;
}) {
  const active = state?.plans.find((plan) => plan.state === "active");
  const awaitingItem = state?.awaiting.find(
    (item) => item.kind === "plan-approval",
  );

  return (
    <section className="board" aria-label="Board">
      <header className="board-header">
        <div className="board-title">
          {active && <span className="muted">{project.name}</span>}
          <h1>{active ? active.definition.title : project.name}</h1>
          {active && (
            <div className="board-meta">
              <span className="badge badge-info">{active.state}</span>
              <span>First Phase not started</span>
            </div>
          )}
        </div>
        {active && (
          <ExportPlan
            store={store}
            client={client}
            projectId={project.id}
            plan={active}
          />
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
            onSaved={() => store.refreshProjects()}
          />
        ) : active ? (
          <p className="muted">
            The board shows the active Phase once it starts.
          </p>
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
    </section>
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
