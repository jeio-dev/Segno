import type { HostClient, Queries, SegnoConfig } from "@segno/core";
import { useState } from "react";
import { errorMessage } from "../format.js";
import { RejectionNotice } from "./RejectionNotice.js";

type Detected = Queries["onboarding"]["result"]["detected"];

export function Onboarding({
  client,
  projectId,
  onSaved,
}: {
  client: HostClient;
  projectId: string;
  onSaved(): Promise<void>;
}) {
  const [detected, setDetected] = useState<Detected>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function open() {
    setBusy(true);
    setError(undefined);
    try {
      setDetected((await client.query(projectId, "onboarding")).detected);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (detected)
    return (
      <ManualSetup
        client={client}
        projectId={projectId}
        detected={detected}
        onSaved={onSaved}
      />
    );
  return (
    <div className="empty-state">
      <h2>Not onboarded</h2>
      <p className="muted">Set up this Project before submitting a Plan.</p>
      <button
        type="button"
        className="button button-primary"
        disabled={busy}
        onClick={() => void open()}
      >
        Set up manually
      </button>
      {error && <RejectionNotice message={error} />}
    </div>
  );
}

function ManualSetup({
  client,
  projectId,
  detected,
  onSaved,
}: {
  client: HostClient;
  projectId: string;
  detected: Detected;
  onSaved(): Promise<void>;
}) {
  const [draft, setDraft] = useState(() => draftFrom(detected.config));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] =
    useState<Parameters<typeof RejectionNotice>[0]>();
  async function save() {
    setBusy(true);
    setProblem(undefined);
    try {
      const { setup: _setup, roles: _roles, ...rest } = detected.config;
      const result = await client.command(projectId, {
        type: "onboarding.confirm",
        config: {
          ...rest,
          baseBranch: draft.baseBranch.trim(),
          tests: { command: draft.tests.trim() },
          ...(draft.setup.trim()
            ? { setup: { command: draft.setup.trim() } }
            : {}),
          roles: {
            coder: {
              allow: draft.allow
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean),
            },
          },
        },
      });
      if (!result.ok) {
        setProblem({
          message: result.message,
          ...("errors" in result ? { errors: result.errors } : {}),
        });
      } else await onSaved();
    } catch (caught) {
      setProblem({ message: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="section" aria-label="Set up manually">
      <h2>Set up manually</h2>
      <p className="field-hint">
        Review the detected settings. Save writes segno.config.json in the repo
        root. Segno never commits it.
      </p>
      <div className="grid-2">
        <label className="field">
          <span className="field-label">Package manager</span>
          <input
            className="input mono"
            aria-label="Package manager"
            value={detected.packageManager ?? "none"}
            readOnly
          />
        </label>
        {(
          [
            ["baseBranch", "Base branch"],
            ["tests", "Test command"],
            ["setup", "Setup command"],
          ] as const
        ).map(([key, label]) => (
          <label className="field" key={key}>
            <span className="field-label">{label}</span>
            <input
              className="input mono"
              aria-label={label}
              value={draft[key]}
              disabled={busy}
              onChange={(event) =>
                setDraft({ ...draft, [key]: event.target.value })
              }
            />
          </label>
        ))}
      </div>
      <label className="field">
        <span className="field-label">Coder allow</span>
        <textarea
          className="input mono"
          aria-label="Coder allow"
          value={draft.allow}
          disabled={busy}
          onChange={(event) =>
            setDraft({ ...draft, allow: event.target.value })
          }
        />
        <span className="field-hint">
          One Claude Code permission rule per line, added to the Coder's
          allowlist.
        </span>
      </label>
      {problem && <RejectionNotice {...problem} />}
      <button
        type="button"
        className="button button-primary"
        disabled={busy || !draft.tests.trim() || !draft.baseBranch.trim()}
        onClick={() => void save()}
      >
        Save
      </button>
    </section>
  );
}

function draftFrom(config: SegnoConfig) {
  return {
    baseBranch: config.baseBranch,
    tests: config.tests.command,
    setup: config.setup?.command ?? "",
    allow: config.roles.coder.allow?.join("\n") ?? "",
  };
}
