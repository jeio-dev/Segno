import { useEffect, useState, useSyncExternalStore } from "react";
import { AddProject } from "./components/AddProject.js";
import { ConnectionBanner } from "./components/ConnectionBanner.js";
import { ProjectView } from "./components/ProjectView.js";
import { Settings } from "./components/Settings.js";
import { Sidebar } from "./components/Sidebar.js";
import { UnavailableProject } from "./components/UnavailableProject.js";
import type { AppStore } from "./store.js";

export type Screen = "project" | "add" | "settings";

export function App({ store }: { store: AppStore }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [screen, setScreen] = useState<Screen>("project");
  const [selectedId, setSelectedId] = useState<string>();
  const theme = snapshot.settings?.theme ?? "system";

  useEffect(() => {
    // A stored choice sets data-theme; "system" follows prefers-color-scheme [ADR-0032].
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    store.bridge.setTheme(theme);
  }, [theme, store]);

  const projects = snapshot.projects;
  const selected =
    projects?.find(({ id }) => id === selectedId) ?? projects?.[0];

  function content() {
    const client = snapshot.client;
    if (!client) return <div className="placeholder">Connecting…</div>;
    if (screen === "add")
      return (
        <AddProject
          store={store}
          client={client}
          onAdded={(id) => {
            setSelectedId(id);
            setScreen("project");
          }}
        />
      );
    if (screen === "settings")
      return (
        <Settings
          store={store}
          client={client}
          settings={snapshot.settings}
          project={selected}
        />
      );
    if (!selected)
      return (
        <div className="placeholder">
          <p>Add a git repo as a Project to start.</p>
        </div>
      );
    if (selected.status === "unavailable")
      return (
        <UnavailableProject
          key={selected.id}
          store={store}
          client={client}
          project={selected}
        />
      );
    return (
      <ProjectView
        key={selected.id}
        store={store}
        client={client}
        project={selected}
        state={snapshot.states.get(selected.id)}
      />
    );
  }

  return (
    <div className="app">
      <ConnectionBanner store={store} status={snapshot.status} />
      <Sidebar
        projects={projects}
        states={snapshot.states}
        selectedId={screen === "project" ? selected?.id : undefined}
        onSelect={(id) => {
          setSelectedId(id);
          setScreen("project");
        }}
        onAdd={() => setScreen("add")}
        onSettings={() => setScreen("settings")}
      />
      <main className="main">{content()}</main>
    </div>
  );
}
