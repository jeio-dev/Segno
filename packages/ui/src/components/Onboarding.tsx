import type {
  CommandResult,
  HostClient,
  OnboardingProposal,
  Queries,
  SegnoConfig,
  State,
} from "@segno/core";
import { useState } from "react";
import { errorMessage } from "../format.js";
import { RejectionNotice } from "./RejectionNotice.js";
import { RunLog } from "./RunLog.js";

type Detected = Queries["onboarding"]["result"]["detected"];
type Problem = Parameters<typeof RejectionNotice>[0];

/** The anchor the `onboarding-review` Awaiting-you item scrolls to. */
export const onboardingReviewId = "onboarding-review";

/**
 * A not-onboarded Project's board: Onboard project, its live Run, its
 * failure or proposal, and Set up manually [ADR-0049].
 */
export function Onboarding({
  client,
  projectId,
  state,
  onSaved,
}: {
  client: HostClient;
  projectId: string;
  state: State | undefined;
  onSaved(): Promise<void>;
}) {
  const [form, setForm] = useState<{ base: SegnoConfig; detected: Detected }>();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem>();
  const onboarding = state?.onboarding ?? { state: "idle" };

  async function send(command: object) {
    setBusy(true);
    setProblem(undefined);
    try {
      const result = await client.command(projectId, command);
      if (!result.ok) setProblem(problemOf(result));
      return result;
    } catch (caught) {
      setProblem({ message: errorMessage(caught) });
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  /** Opens the settings form, prefilled with `base` or the detected settings. */
  async function openForm(base?: SegnoConfig) {
    setBusy(true);
    setProblem(undefined);
    try {
      const { detected } = await client.query(projectId, "onboarding");
      setForm({ base: base ?? detected.config, detected });
    } catch (caught) {
      setProblem({ message: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  }

  if (form)
    return (
      <ManualSetup
        client={client}
        projectId={projectId}
        base={form.base}
        detected={form.detected}
        onSaved={onSaved}
        onCancel={() => setForm(undefined)}
      />
    );

  const manual = (
    <button
      type="button"
      className="button"
      disabled={busy}
      onClick={() => void openForm()}
    >
      Set up manually
    </button>
  );
  const run = state?.runs.find(({ id }) => id === onboarding.runId);

  if (onboarding.state === "running")
    return (
      <section className="section" aria-label="Onboarding">
        <h2>Onboarding</h2>
        <p className="muted">
          The Planner is finding this repo's checks and running them in a
          scratch worktree.
        </p>
        {run && <RunLog client={client} projectId={projectId} run={run} />}
        <div className="row">
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={() => void send({ type: "onboarding.stop" })}
          >
            Stop onboarding
          </button>
        </div>
        {problem && <RejectionNotice {...problem} />}
      </section>
    );

  if (onboarding.state === "proposed" && onboarding.proposal)
    return (
      <OnboardingReview
        proposal={onboarding.proposal}
        busy={busy}
        problem={problem}
        onConfirm={async (config) => {
          const result = await send({ type: "onboarding.confirm", config });
          if (result?.ok) await onSaved();
        }}
        onEdit={(config) => void openForm(config)}
      />
    );

  const failure =
    onboarding.state === "failed" ? onboarding.failure : undefined;
  return (
    <section className="empty-state" aria-label="Not onboarded">
      {failure ? (
        <>
          <h2>Onboarding failed</h2>
          <div className="notice notice-start" role="alert">
            <p>
              <span className="badge badge-bad">{failure.reason}</span>
              {failure.detail ?? "The onboarding Run gave no proposal."}
            </p>
            {failure.errors && failure.errors.length > 0 && (
              <ul className="error-list">
                {failure.errors.map((error) => (
                  <li key={JSON.stringify(error)}>{describe(error)}</li>
                ))}
              </ul>
            )}
          </div>
        </>
      ) : (
        <>
          <h2>Not onboarded</h2>
          <p className="muted">
            Onboarding runs the Planner to find this repo's checks and propose a
            config. Nothing is written until you confirm it.
          </p>
        </>
      )}
      <div className="row">
        <button
          type="button"
          className="button button-primary"
          disabled={busy}
          onClick={() => void send({ type: "onboarding.start" })}
        >
          {failure ? "Retry onboarding" : "Onboard project"}
        </button>
        {manual}
      </div>
      {problem && <RejectionNotice {...problem} />}
    </section>
  );
}

/** The `onboarding-review`: each value with its reason, the evidence and the flags. */
function OnboardingReview({
  proposal,
  busy,
  problem,
  onConfirm,
  onEdit,
}: {
  proposal: OnboardingProposal;
  busy: boolean;
  problem: Problem | undefined;
  onConfirm(config: SegnoConfig): Promise<void>;
  onEdit(config: SegnoConfig): void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const { config, reasons, checks, flags = [] } = proposal;
  const noChecks = flags.includes("no-checks");
  const failsOnBase = flags.includes("fails-on-base");
  const allow = config.roles.coder.allow ?? [];
  const values: [string, string, string | undefined][] = [
    ["Test command", "/tests/command", config.tests.command],
    [
      "Test timeout",
      "/tests/timeoutMin",
      config.tests.timeoutMin === undefined
        ? undefined
        : `${config.tests.timeoutMin} min`,
    ],
    ["Setup command", "/setup/command", config.setup?.command],
    ["Base branch", "/baseBranch", config.baseBranch],
    ["Remote", "/remote", config.remote],
    ...allow.map((entry, index): [string, string, string] => [
      "Coder allow",
      `/roles/coder/allow/${index}`,
      entry,
    ]),
  ];
  const reasonOf = (path: string) =>
    reasons[path] ??
    (path.startsWith("/roles/coder/allow/")
      ? reasons["/roles/coder/allow"]
      : undefined);
  const failing = checks.flatMap(({ failing }) => failing ?? []);

  return (
    <section
      className="section"
      id={onboardingReviewId}
      aria-label="Onboarding proposal"
    >
      <h2>Review the onboarding proposal</h2>
      <p className="muted">
        The checks ran on <span className="mono">{proposal.ref}</span> at{" "}
        <span className="mono">{proposal.sha.slice(0, 8)}</span>.
      </p>
      {noChecks && (
        <div className="notice" role="status">
          <span className="badge badge-warn">No checks found</span>
          The repo has no tests, typecheck, build or lint, so the test command
          is the placeholder <span className="mono">true</span>.
        </div>
      )}
      {failsOnBase && (
        <div className="notice" role="status">
          <span className="badge badge-warn">Fails on the base branch</span>
          Tasks will be blocked test-limit until the suite is fixed.
          {failing.length > 0 && (
            <ul className="error-list" aria-label="Failing tests">
              {failing.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <table className="table" aria-label="Proposed values">
        <tbody>
          {values
            .filter(([, , value]) => value !== undefined)
            .map(([label, path, value]) => (
              <tr key={path}>
                <th scope="row">{label}</th>
                <td className="mono">{value}</td>
                <td className="muted">{reasonOf(path)}</td>
              </tr>
            ))}
        </tbody>
      </table>
      <table className="table" aria-label="Commands run">
        <thead>
          <tr>
            <th scope="col">Command</th>
            <th scope="col">Purpose</th>
            <th scope="col">Exit code</th>
            <th scope="col">Duration</th>
          </tr>
        </thead>
        <tbody>
          {checks.map((check) => (
            <tr key={`${check.purpose} ${check.command}`}>
              <td className="mono">{check.command}</td>
              <td>{check.purpose}</td>
              <td className="mono">{check.exitCode}</td>
              <td className="mono">{check.durationSec} s</td>
            </tr>
          ))}
          {checks.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">
                No commands were run.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {noChecks && (
        <label className="row">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
          Every Task will pass tests unchecked
        </label>
      )}
      {problem && <RejectionNotice {...problem} />}
      <div className="row">
        <button
          type="button"
          className="button button-primary"
          disabled={busy || (noChecks && !acknowledged)}
          onClick={() => void onConfirm(config)}
        >
          Confirm
        </button>
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() => onEdit(config)}
        >
          Edit
        </button>
      </div>
    </section>
  );
}

function ManualSetup({
  client,
  projectId,
  base,
  detected,
  onSaved,
  onCancel,
}: {
  client: HostClient;
  projectId: string;
  /** The detected settings, or the proposal being edited. */
  base: SegnoConfig;
  detected: Detected;
  onSaved(): Promise<void>;
  onCancel(): void;
}) {
  const [draft, setDraft] = useState(() => draftFrom(base));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem>();
  async function save() {
    setBusy(true);
    setProblem(undefined);
    try {
      const { setup: _setup, roles: _roles, ...rest } = base;
      const result = await client.command(projectId, {
        type: "onboarding.confirm",
        config: {
          ...rest,
          baseBranch: draft.baseBranch.trim(),
          tests: { ...base.tests, command: draft.tests.trim() },
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
      if (!result.ok) setProblem(problemOf(result));
      else await onSaved();
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
        Review the settings. Save writes segno.config.json in the repo root.
        Segno never commits it.
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
      <div className="row">
        <button
          type="button"
          className="button button-primary"
          disabled={busy || !draft.tests.trim() || !draft.baseBranch.trim()}
          onClick={() => void save()}
        >
          Save
        </button>
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
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

function problemOf(result: Extract<CommandResult, { ok: false }>): Problem {
  return {
    message: result.message,
    ...("errors" in result ? { errors: result.errors } : {}),
  };
}

/** A failure's error: a located config error, or a schema path and message. */
function describe(error: unknown) {
  const { file, path, code, message } = error as Record<string, unknown>;
  return [file && `${String(file)}`, path || "/", code, message]
    .filter(Boolean)
    .map(String)
    .join("  ");
}
