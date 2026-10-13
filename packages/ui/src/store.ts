import {
  createHostClient,
  type Event,
  type HostClient,
  type HostPort,
  type ProjectSummary,
  project,
  type ResolvedSettings,
  type State,
} from "@segno/core";
import {
  type HostStatus,
  hostPortMessage,
  type SegnoBridge,
} from "./bridge.js";

export interface Snapshot {
  status: HostStatus | "connecting";
  client: HostClient | undefined;
  projects: ProjectSummary[] | undefined;
  /** Derived per running Project from its Event stream [ADR-0007]. */
  states: ReadonlyMap<string, State>;
  settings: ResolvedSettings | undefined;
}

function webPort(port: MessagePort): HostPort {
  return {
    postMessage: (message) => port.postMessage(message),
    onMessage(listener) {
      port.onmessage = (event) => listener(event.data);
    },
    close: () => port.close(),
  };
}

/**
 * The window's view of the Engine host. It keeps one Event subscription per
 * running Project and resubscribes from the last seq after a host restart.
 */
export class AppStore {
  readonly bridge: SegnoBridge;
  private snapshot: Snapshot = {
    status: "connecting",
    client: undefined,
    projects: undefined,
    states: new Map(),
    settings: undefined,
  };
  private readonly listeners = new Set<() => void>();
  private readonly events = new Map<string, Event[]>();
  private readonly streams = new Map<string, { close(): void }>();

  constructor(bridge: SegnoBridge) {
    this.bridge = bridge;
    window.addEventListener("message", (event) => {
      if (event.source !== window || event.data !== hostPortMessage) return;
      const [port] = event.ports;
      if (port)
        this.attach(createHostClient(webPort(port))).catch(() => {
          // The host went away mid-attach; the next port retries.
        });
    });
    bridge.onHostStatus((status) => {
      // A new port follows "connected"; until then the old client is gone.
      if (status !== "connected") this.update({ status });
    });
    bridge.connect();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  private update(changes: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...changes };
    for (const listener of this.listeners) listener();
  }

  private async attach(client: HostClient) {
    this.snapshot.client?.close();
    for (const stream of this.streams.values()) stream.close();
    this.streams.clear();
    this.update({ client, status: "connected" });
    const settings = await client.settings.get();
    this.update({ settings });
    await this.refreshProjects();
  }

  private refreshing: Promise<void> = Promise.resolve();

  /** Re-reads the registry and keeps a stream open for each running Project. */
  refreshProjects(): Promise<void> {
    // Refreshes run one at a time, so a Project is never followed twice.
    const next = this.refreshing.then(() => this.refreshOnce());
    this.refreshing = next.catch(() => {});
    return next;
  }

  private async refreshOnce() {
    const client = this.snapshot.client;
    if (!client) return;
    const projects = await client.projects.list();
    if (client !== this.snapshot.client) return;
    const running = new Set(
      projects.filter(({ status }) => status === "running").map(({ id }) => id),
    );
    for (const [id, stream] of this.streams)
      if (!running.has(id)) {
        stream.close();
        this.streams.delete(id);
        this.events.delete(id);
      }
    const states = new Map(
      [...this.snapshot.states].filter(([id]) => running.has(id)),
    );
    this.update({ projects, states });
    await Promise.all(
      [...running]
        .filter((id) => !this.streams.has(id))
        .map((id) => this.follow(client, id)),
    );
  }

  private async follow(client: HostClient, projectId: string) {
    const known = this.events.get(projectId) ?? [];
    this.events.set(projectId, known);
    const since = known.at(-1)?.seq ?? 0;
    let stream: { close(): void };
    try {
      stream = await client.subscribe(projectId, since, (event) => {
        const events = this.events.get(projectId);
        if (!events || event.seq <= (events.at(-1)?.seq ?? 0)) return;
        events.push(event);
        this.schedule(projectId);
      });
    } catch {
      // The Project was removed or became unavailable meanwhile.
      return;
    }
    if (client !== this.snapshot.client) {
      stream.close();
      return;
    }
    this.streams.set(projectId, stream);
    this.schedule(projectId);
  }

  private pending = new Set<string>();
  private schedule(projectId: string) {
    if (this.pending.size === 0)
      queueMicrotask(() => {
        const states = new Map(this.snapshot.states);
        for (const id of this.pending)
          states.set(id, project(this.events.get(id) ?? []));
        this.pending.clear();
        this.update({ states });
      });
    this.pending.add(projectId);
  }

  async setSettings(changes: Parameters<HostClient["settings"]["set"]>[0]) {
    const client = this.snapshot.client;
    if (!client) return;
    await client.settings.set(changes);
    this.update({ settings: await client.settings.get() });
  }
}
