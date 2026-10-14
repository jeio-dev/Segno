import type { HostClient, InspectResult, SegnoConfig } from "@segno/core";
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
  const detected =
    result.source === "detected" ? (result.config as SegnoConfig) : undefined;
  const [draft, setDraft] = useState(() => draftFrom(detected));

  async function add() {
    setBusy(true);
    setError(undefined);
    try {
      const { id } = detected
        ? await client.projects.add(result.path, configFrom(detected, draft))
        : await client.projects.add(result.path);
      await onAdded(id);
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  }

  const field = (key: keyof Draft, label: string, mono = true) => (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        className={mono ? "input mono" : "input"}
        aria-label={label}
        value={draft[key]}
        onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
      />
    </label>
  );

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
      {detected ? (
        <section className="section">
          <h2>Detected settings</h2>
          <p className="field-hint">
            Review them. <strong>Add</strong> writes them as segno.config.json
            in the repo root. Segno never commits it.
          </p>
          <div className="grid-2">
            <label className="field">
              <span className="field-label">Package manager</span>
              <input
                className="input mono"
                aria-label="Package manager"
                value={result.packageManager ?? "none"}
                readOnly
              />
            </label>
            {field("baseBranch", "Base branch")}
            {field("tests", "Test command")}
            {field("setup", "Setup command")}
            {field("planner", "Planner model")}
            {field("coder", "Coder model")}
            {field("docs", "coder-docs model")}
            {field("reviewer", "Reviewer model")}
          </div>
          <label className="field">
            <span className="field-label">Coder allow</span>
            <textarea
              className="input mono"
              aria-label="Coder allow"
              value={draft.allow}
              onChange={(event) =>
                setDraft({ ...draft, allow: event.target.value })
              }
            />
            <span className="field-hint">
              One Claude Code permission rule per line, added to the Coder's
              allowlist.
            </span>
          </label>
          {result.errors.length > 0 && <ConfigErrors errors={result.errors} />}
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
          disabled={busy || (detected !== undefined && !complete(draft))}
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

type Draft = Record<
  | "baseBranch"
  | "tests"
  | "setup"
  | "planner"
  | "coder"
  | "docs"
  | "reviewer"
  | "allow",
  string
>;

function draftFrom(config: SegnoConfig | undefined): Draft {
  return {
    baseBranch: config?.baseBranch ?? "",
    tests: config?.tests.command ?? "",
    setup: config?.setup?.command ?? "",
    planner: config?.roles.planner?.model ?? "",
    coder: config?.roles.coder.model ?? "",
    docs: config?.roles.coder.docsModel ?? "",
    reviewer: config?.roles.reviewer.model ?? "",
    allow: config?.roles.coder.allow?.join("\n") ?? "",
  };
}

/** Every field segno.config.json requires is filled in. */
function complete(draft: Draft) {
  return [draft.baseBranch, draft.tests, draft.coder, draft.reviewer].every(
    (value) => value.trim(),
  );
}

/** The reviewed settings; blank optional fields are left out. */
function configFrom(detected: SegnoConfig, draft: Draft): SegnoConfig {
  const { setup: _setup, ...rest } = detected;
  const allow = draft.allow
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    ...rest,
    baseBranch: draft.baseBranch.trim(),
    tests: { command: draft.tests.trim() },
    ...(draft.setup.trim() ? { setup: { command: draft.setup.trim() } } : {}),
    roles: {
      ...(draft.planner.trim()
        ? { planner: { adapter: "claude-code", model: draft.planner.trim() } }
        : {}),
      coder: {
        adapter: "claude-code",
        model: draft.coder.trim(),
        ...(draft.docs.trim() ? { docsModel: draft.docs.trim() } : {}),
        allow,
      },
      reviewer: { adapter: "claude-code", model: draft.reviewer.trim() },
    },
  };
}
