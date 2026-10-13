import type { ProjectSummary, State } from "@segno/core";

export function Sidebar({
  projects,
  states,
  selectedId,
  onSelect,
  onAdd,
  onSettings,
}: {
  projects: ProjectSummary[] | undefined;
  states: ReadonlyMap<string, State>;
  selectedId: string | undefined;
  onSelect(id: string): void;
  onAdd(): void;
  onSettings(): void;
}) {
  return (
    <nav className="sidebar" aria-label="Projects">
      <div className="wordmark">Segno</div>
      <h2 className="sidebar-heading">Projects</h2>
      {projects?.length === 0 && <p className="muted">No projects yet</p>}
      <ul className="project-list">
        {projects?.map((project) => {
          // The live count comes from the derived State; list is the fallback.
          const count =
            states.get(project.id)?.awaiting.length ?? project.awaitingCount;
          return (
            <li key={project.id}>
              <button
                type="button"
                className="project-item"
                aria-current={project.id === selectedId ? "page" : undefined}
                aria-label={
                  project.status === "unavailable"
                    ? `${project.name} unavailable`
                    : count > 0
                      ? `${project.name} ${count} awaiting you`
                      : project.name
                }
                onClick={() => onSelect(project.id)}
              >
                <span className="project-name">{project.name}</span>
                {project.status === "unavailable" ? (
                  <span className="badge badge-bad">unavailable</span>
                ) : count > 0 ? (
                  <span className="badge badge-muted">{count}</span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="sidebar-actions">
        <button type="button" className="button" onClick={onAdd}>
          Add project
        </button>
        <button
          type="button"
          className="button button-quiet"
          onClick={onSettings}
        >
          Settings
        </button>
      </div>
    </nav>
  );
}
