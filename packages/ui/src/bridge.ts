/** What the preload exposes to the window as `window.segno` [ADR-0037]. */
export interface SegnoBridge {
  /** Asks the app for a host port; it arrives as a "segno:host-port" window message. */
  connect(): void;
  onHostStatus(listener: (status: HostStatus) => void): void;
  restartHost(): void;
  pickFolder(): Promise<string | null>;
  pickPlanFile(): Promise<PlanFilePick | null>;
  saveFile(defaultName: string, text: string): Promise<boolean>;
  pathForFile(file: File): string;
  setTheme(theme: "system" | "light" | "dark"): void;
}

export type HostStatus = "connected" | "reconnecting" | "failed";
export type PlanFilePick =
  | { path: string; yaml: string }
  | { path: string; error: string };

export const hostPortMessage = "segno:host-port";
