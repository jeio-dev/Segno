import type { AppStore, Snapshot } from "../store.js";

/** Host restarts and repeated failure [ADR-0037]. */
export function ConnectionBanner({
  store,
  status,
}: {
  store: AppStore;
  status: Snapshot["status"];
}) {
  if (status === "reconnecting")
    return (
      <div className="banner" role="status">
        <span className="badge badge-warn">engine</span>
        Reconnecting…
      </div>
    );
  if (status === "failed")
    return (
      <div className="banner" role="alert">
        <span className="badge badge-bad">engine</span>
        <span>The Engine stopped twice within a minute.</span>
        <button
          type="button"
          className="button button-primary"
          onClick={() => store.bridge.restartHost()}
        >
          Restart Engine
        </button>
      </div>
    );
  return null;
}
