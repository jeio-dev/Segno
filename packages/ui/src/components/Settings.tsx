import type {
  ConfigStatus,
  HostClient,
  ProjectSummary,
  ResolvedSettings,
} from "@segno/core";
import { useEffect, useState } from "react";
import { errorMessage } from "../format.js";
import type { AppStore } from "../store.js";
import { RemoveProject } from "./RemoveProject.js";

/** App settings, and the selected Project's settings [ADR-0038]. */
export function Settings({
  store,
  client,
  settings,
  project,
}: {
  store: AppStore;
  client: HostClient;
  settings: ResolvedSettings | undefined;
  project: ProjectSummary | undefined;
}) {
  return (
    <div className="page">
      <h1>Settings</h1>
      {settings && <AppSettings store={store} settings={settings} />}
      {project && (
        <ProjectSettings
          key={project.id}
          store={store}
          client={client}
          project={project}
        />
      )}
    </div>
  );
}

function AppSettings({
  store,
  settings,
}: {
  store: AppStore;
  settings: ResolvedSettings;
}) {
  const [editor, setEditor] = useState(settings.editor ?? "");
  const [error, setError] = useState<string>();
  async function save(changes: Parameters<AppStore["setSettings"]>[0]) {
    setError(undefined);
    try {
      await store.setSettings(changes);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }
  return (
    <section className="section" aria-label="App settings">
      <h2>App</h2>
      <label className="field">
        <span className="field-label">Editor command</span>
        <div className="row">
          <input
            className="input mono field-grow"
            aria-label="Editor command"
            placeholder="code {path}"
            value={editor}
            onChange={(event) => setEditor(event.target.value)}
          />
          <button
            type="button"
            className="button"
            disabled={editor === (settings.editor ?? "")}
            onClick={() =>
              void save({ editor: editor.trim() ? editor.trim() : null })
            }
          >
            Save
          </button>
        </div>
        <span className="field-hint">
          Opens a Task's worktree. {"{path}"} is replaced by the worktree path.
        </span>
      </label>
      <fieldset className="field fieldset">
        <legend className="field-label">Theme</legend>
        <div className="row">
          {(["system", "light", "dark"] as const).map((theme) => (
            <label key={theme} className="row">
              <input
                type="radio"
                name="theme"
                value={theme}
                checked={settings.theme === theme}
                onChange={() => void save({ theme })}
              />
              {theme[0]?.toUpperCase()}
              {theme.slice(1)}
            </label>
          ))}
        </div>
      </fieldset>
      {error && <p className="mono">{error}</p>}
    </section>
  );
}

const roles = [
  ["planner", "/roles/planner/model"],
  ["coder", "/roles/coder/model"],
  ["coder-docs", "/roles/coder/docsModel"],
  ["reviewer", "/roles/reviewer/model"],
] as const;

function ProjectSettings({
  store,
  client,
  project,
}: {
  store: AppStore;
  client: HostClient;
  project: ProjectSummary;
}) {
  const [name, setName] = useState(project.name);
  const [config, setConfig] = useState<ConfigStatus>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (project.status !== "running") return;
    client.query(project.id, "config").then(setConfig, () => {});
  }, [client, project]);

  async function rename() {
    setError(undefined);
    try {
      await client.projects.rename(project.id, name);
      await store.refreshProjects();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  const effectiveRoles = config?.effective.roles;
  const models = {
    planner: effectiveRoles?.planner?.model,
    coder: effectiveRoles?.coder.model,
    "coder-docs": effectiveRoles?.coder.docsModel,
    reviewer: effectiveRoles?.reviewer.model,
  };
  return (
    <section className="section" aria-label="Project settings">
      <h2>Project: {project.name}</h2>
      <label className="field">
        <span className="field-label">Name</span>
        <div className="row">
          <input
            className="input field-grow"
            aria-label="Project name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <button
            type="button"
            className="button"
            disabled={!name.trim() || name.trim() === project.name}
            onClick={() => void rename()}
          >
            Rename
          </button>
        </div>
      </label>
      {config && (
        <div className="field">
          <span className="field-label">Models</span>
          <table className="models">
            <tbody>
              {roles.map(([role, pointer]) =>
                models[role] === undefined ? null : (
                  <tr key={role}>
                    <th scope="row">{role}</th>
                    <td className="mono">{models[role]}</td>
                    <td>
                      <span className="badge badge-muted">
                        {config.sources[pointer]}
                      </span>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
          <span className="field-hint">
            Each Role's effective model and where it comes from.
          </span>
        </div>
      )}
      {error && <p className="mono">{error}</p>}
      <div className="row">
        <RemoveProject store={store} client={client} project={project} />
      </div>
    </section>
  );
}
