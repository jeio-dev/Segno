import type { HostClient, PlanState } from "@segno/core";
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../format.js";
import { RejectionNotice } from "./RejectionNotice.js";

type Action = "approve" | "sendBack" | "abandon";

/**
 * Renders every Phase and Task, with dependencies and Risk flags, before the
 * Plan can be approved, sent back or abandoned [ADR-0013].
 */
export function PlanReview({
  client,
  projectId,
  plan,
  open,
  onClose,
}: {
  client: HostClient;
  projectId: string;
  plan: PlanState;
  open: boolean;
  onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [action, setAction] = useState<Action>();
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    // The Plan was decided elsewhere, so there's nothing left to review.
    if (!open) {
      element.close();
      onClose();
    }
  }, [open, onClose]);

  async function send(command: object) {
    setBusy(true);
    setProblem(undefined);
    try {
      const result = await client.command(projectId, command);
      if (result.ok) {
        dialog.current?.close();
        onClose();
        return;
      }
      setProblem(result.message);
    } catch (error) {
      setProblem(errorMessage(error));
    }
    setBusy(false);
  }

  const definition = plan.definition;
  return (
    <dialog
      ref={dialog}
      className="dialog"
      aria-label={`Review plan ${definition.title}`}
      onClose={onClose}
    >
      <div className="dialog-body">
        <div>
          <span className="muted">Plan to approve</span>
          <h2>{definition.title}</h2>
        </div>
        <p className="prose">{definition.summary}</p>
        {definition.phases.map((phase, index) => (
          <section key={phase.id} className="plan-phase">
            <div className="row">
              <span className="badge badge-muted">Phase {index + 1}</span>
              <span className="mono muted">{phase.id}</span>
            </div>
            <h3>{phase.title}</h3>
            {phase.docs && <p className="prose muted">Docs: {phase.docs}</p>}
            {phase.tasks.map((task) => (
              <article key={task.id} className="plan-task">
                <div className="row">
                  <span className="task-id">{task.id}</span>
                  {task.risk && (
                    <span className="badge badge-warn">
                      high risk: {task.risk.flags.join(", ")}
                    </span>
                  )}
                </div>
                <strong>{task.title}</strong>
                <p className="prose">{task.description}</p>
                <div>
                  <span className="muted">Acceptance</span>
                  <ul>
                    {task.acceptance.map((criterion) => (
                      <li key={criterion}>{criterion}</li>
                    ))}
                  </ul>
                </div>
                {task.dependsOn && task.dependsOn.length > 0 && (
                  <p className="muted">
                    Depends on{" "}
                    {task.dependsOn.map((id, i) => (
                      <span key={id}>
                        {i > 0 && ", "}
                        <span className="task-id">{id}</span>
                      </span>
                    ))}
                  </p>
                )}
                {task.context && task.context.length > 0 && (
                  <p className="muted">
                    Context{" "}
                    <span className="mono">{task.context.join("  ")}</span>
                  </p>
                )}
                {task.risk && <p className="muted">Risk: {task.risk.reason}</p>}
              </article>
            ))}
          </section>
        ))}
        {action && action !== "approve" && (
          <label className="field">
            <span className="field-label">
              {action === "sendBack" ? "Notes" : "Reason"}
            </span>
            <textarea
              className="input"
              aria-label={action === "sendBack" ? "Notes" : "Reason"}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          </label>
        )}
        {problem && <RejectionNotice message={problem} />}
      </div>
      <div className="dialog-actions">
        <button
          type="button"
          className="button button-quiet"
          onClick={() => {
            dialog.current?.close();
            onClose();
          }}
        >
          Close
        </button>
        {action === "sendBack" || action === "abandon" ? (
          <>
            <button
              type="button"
              className="button"
              onClick={() => {
                setAction(undefined);
                setText("");
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className={
                action === "abandon" ? "button button-danger" : "button"
              }
              disabled={busy || !text.trim()}
              onClick={() =>
                void send(
                  action === "sendBack"
                    ? { type: "plan.sendBack", planId: plan.id, notes: text }
                    : { type: "plan.abandon", planId: plan.id, reason: text },
                )
              }
            >
              {action === "sendBack" ? "Send back plan" : "Abandon plan"}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="button button-danger"
              onClick={() => setAction("abandon")}
            >
              Abandon
            </button>
            <button
              type="button"
              className="button"
              onClick={() => setAction("sendBack")}
            >
              Send back
            </button>
            <button
              type="button"
              className="button button-primary"
              disabled={busy}
              onClick={() =>
                void send({ type: "plan.approve", planId: plan.id })
              }
            >
              Approve
            </button>
          </>
        )}
      </div>
    </dialog>
  );
}
