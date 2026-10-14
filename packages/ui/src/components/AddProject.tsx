import {
  defaultProjectModels,
  type HostClient,
  type InspectResult,
  type ProjectModels,
} from "@segno/core";
import { useState } from "react";
import { errorMessage, formatConfigError } from "../format.js";
import type { AppStore } from "../store.js";

type Step =
  | { kind: "pick" }
  | { kind: "busy" }
  | { kind: "refused"; message: string }
  | { kind: "proposal"; result: InspectResult };

/** The add-project flow [ADR-0039]. */
export function AddProject({
  store,
  client,
  onAdded,
}: {
  store: AppStore;
  client: HostClient;
  onAdded(projectId: string): void;
}) {
  const [step, setStep] = useState<Step>({ kind: "pick" });

  async function choose() {
    const path = await store.bridge.pickFolder();
    if (!path) return;
    setStep({ kind: "busy" });
    try {
      setStep({
        kind: "proposal",
        result: await client.projects.inspect(path),
      });
    } catch (error) {
      setStep({ kind: "refused", message: errorMessage(error) });
    }
  }

  return (
    <div className="page">
      <h1>Add project</h1>
      <p className="muted">
        A Project is a git repo with a remote. Segno keeps its state in the
        app's data directory and writes nothing into the repo except its
        branches, its commits and, when you confirm it, segno.config.json.
      </p>
      <div className="row">
        <button
          type="button"
          className="button button-primary"
          onClick={() => void choose()}
          disabled={step.kind === "busy"}
        >
          Choose folder…
        </button>
      </div>
      {step.kind === "refused" && (
        <div className="notice" role="alert">
          <p className="mono">
            <span className="badge badge-bad">refused</span>
            {step.message}
          </p>
        </div>
      )}
      {step.kind === "proposal" && (
        <Proposal
          key={step.result.path}
          client={client}
          result={step.result}
          onAdded={async (id) => {
            await store.refreshProjects();
            onAdded(id);
          }}
        />
      )}
    </div>
  );
}

function Proposal({
  client,
  result,
  onAdded,
}: {
  client: HostClient;
  result: InspectResult;
  onAdded(projectId: string): Promise<void>;
}) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState<ProjectModels>(
    result.models ?? defaultProjectModels,
  );

  async function add() {
    setBusy(true);
    setError(undefined);
    try {
      const { id } =
        result.source === "models"
          ? await client.projects.add(result.path, models)
          : await client.projects.add(result.path);
      await onAdded(id);
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  }

  return (
    <>
      <p>
        <span className="muted">Folder </span>
        <span className="mono">{result.path}</span>
      </p>
      {result.gh !== "ok" && (
        <div className="notice" role="status">
          <span className="badge badge-warn">warning</span>
          {result.gh === "missing"
            ? "gh isn't installed. Adding still works; Phase PRs will need a manual step."
            : "gh isn't logged in. Adding still works; Phase PRs will need a manual step."}
        </div>
      )}
      {result.source === "models" ? (
        <section className="section">
          <h2>Models</h2>
          <div className="grid-2">
            {(
              [
                ["planner", "Planner model"],
                ["coder", "Coder model"],
                ["reviewer", "Reviewer model"],
              ] as const
            ).map(([role, label]) => (
              <label className="field" key={role}>
                <span className="field-label">{label}</span>
                <input
                  className="input mono"
                  aria-label={label}
                  value={models[role]}
                  disabled={busy}
                  onChange={(event) =>
                    setModels({ ...models, [role]: event.target.value })
                  }
                />
              </label>
            ))}
          </div>
        </section>
      ) : (
        <section className="section">
          <h2>segno.config.json</h2>
          {result.errors.length ? (
            <ConfigErrors errors={result.errors} />
          ) : (
            <p>
              <span className="badge badge-ok">valid</span> The committed config
              is used as it is.
            </p>
          )}
        </section>
      )}
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
          onClick={() => void add()}
          disabled={
            busy ||
            (result.source === "models" &&
              Object.values(models).some((model) => !model.trim()))
          }
        >
          Add
        </button>
      </div>
    </>
  );
}

export function ConfigErrors({ errors }: { errors: InspectResult["errors"] }) {
  return (
    <div className="notice">
      <span className="badge badge-bad">invalid</span>
      <strong>
        {errors.length} config error{errors.length === 1 ? "" : "s"}
      </strong>
      <ul className="error-list">
        {errors.map((error) => (
          <li key={`${error.file}${error.path}${error.code}`}>
            {formatConfigError(error)}
          </li>
        ))}
      </ul>
    </div>
  );
}
