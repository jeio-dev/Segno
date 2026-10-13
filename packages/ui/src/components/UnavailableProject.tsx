import type { HostClient, ProjectSummary } from "@segno/core";
import { useState } from "react";
import { errorMessage } from "../format.js";
import type { AppStore } from "../store.js";
import { ConfigErrors } from "./AddProject.js";
import { RemoveProject } from "./RemoveProject.js";

const reasons = {
  "missing-folder": "The folder is gone",
  "not-a-repo": "The folder is no longer a git repo",
  "invalid-config": "The config is invalid",
  "unreadable-log": "The Event log can't be read",
} as const;

/** An unavailable Project: its reason, every config error, Locate… and Remove. */
export function UnavailableProject({
  store,
  client,
  project,
}: {
  store: AppStore;
  client: HostClient;
  project: Extract<ProjectSummary, { status: "unavailable" }>;
}) {
  const [error, setError] = useState<string>();
  async function locate() {
    const path = await store.bridge.pickFolder();
    if (!path) return;
    setError(undefined);
    try {
      await client.projects.locate(project.id, path);
      await store.refreshProjects();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }
  return (
    <div className="page">
      <div>
        <span className="muted">{project.name}</span>
        <h1>{reasons[project.reason]}</h1>
      </div>
      <p>
        <span className="badge badge-bad">{project.reason}</span>{" "}
        {project.message}
      </p>
      <p className="mono muted">{project.path}</p>
      {project.errors && <ConfigErrors errors={project.errors} />}
      {error && (
        <div className="notice" role="alert">
          <p className="mono">
            <span className="badge badge-bad">error</span>
            {error}
          </p>
        </div>
      )}
      <div className="row">
        <button
          type="button"
          className="button button-primary"
          onClick={() => void locate()}
        >
          Locate…
        </button>
        <RemoveProject store={store} client={client} project={project} />
      </div>
    </div>
  );
}
