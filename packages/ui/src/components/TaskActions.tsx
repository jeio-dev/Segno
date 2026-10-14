import type { HostClient } from "@segno/core";
import { useId, useState } from "react";
import { errorMessage } from "../format.js";

/** The developer's two ways to resolve a Merge hold. */
export function TaskActions({
  client,
  projectId,
  taskId,
}: {
  client: HostClient;
  projectId: string;
  taskId: string;
}) {
  const [sendingBack, setSendingBack] = useState(false);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const id = useId();
  async function send(type: "task.approve" | "task.sendBack") {
    setBusy(true);
    setProblem(undefined);
    try {
      const result = await client.command(
        projectId,
        type === "task.approve" ? { type, taskId } : { type, taskId, notes },
      );
      if (!result.ok) setProblem(result.message);
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <div className="row">
        <button
          type="button"
          className="button button-primary"
          disabled={busy}
          onClick={() => void send("task.approve")}
        >
          Approve
        </button>
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() => setSendingBack(!sendingBack)}
        >
          Send back
        </button>
      </div>
      {sendingBack && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void send("task.sendBack");
          }}
        >
          <label htmlFor={id}>Send back notes</label>
          <textarea
            id={id}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            required
          />
          <button
            type="submit"
            className="button"
            disabled={busy || !notes.trim()}
          >
            Send notes
          </button>
        </form>
      )}
      {problem && <p role="alert">{problem}</p>}
    </div>
  );
}
