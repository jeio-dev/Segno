import type { HostClient, ProjectSummary } from "@segno/core";
import { useRef, useState } from "react";
import { errorMessage } from "../format.js";
import type { AppStore } from "../store.js";

/** Remove asks whether to delete the Project's Segno data too [ADR-0038]. */
export function RemoveProject({
  store,
  client,
  project,
}: {
  store: AppStore;
  client: HostClient;
  project: ProjectSummary;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [deleteData, setDeleteData] = useState(false);
  const [error, setError] = useState<string>();

  async function remove() {
    setError(undefined);
    try {
      await client.projects.remove(project.id, { deleteData });
      dialog.current?.close();
      await store.refreshProjects();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <>
      <button
        type="button"
        className="button button-danger"
        onClick={() => dialog.current?.showModal()}
      >
        Remove project
      </button>
      <dialog
        ref={dialog}
        className="dialog dialog-small"
        aria-label={`Remove ${project.name}`}
      >
        <div className="dialog-body">
          <h2>Remove {project.name}?</h2>
          <p>
            Segno stops this Project and forgets it. The repo itself is never
            touched.
          </p>
          <label className="row">
            <input
              type="checkbox"
              checked={deleteData}
              onChange={(event) => setDeleteData(event.target.checked)}
            />
            Also delete its Segno data (Event log, Runs and worktrees)
          </label>
          {error && <p className="mono">{error}</p>}
        </div>
        <div className="dialog-actions">
          <button
            type="button"
            className="button"
            onClick={() => dialog.current?.close()}
          >
            Cancel
          </button>
          <button
            type="button"
            className="button button-danger"
            onClick={() => void remove()}
          >
            Remove
          </button>
        </div>
      </dialog>
    </>
  );
}
