// The Agent Adapter interface [ADR-0017]. The Engine depends only on these types.

export type AdapterId = "claude-code" | "codex" | "opencode";
export type JSONSchema = Record<string, unknown>;

export interface PermissionProfile {
  read: true;
  edit: boolean;
  shell: string[];
  network: boolean;
  mcp: false;
  extraAllow: string[];
}

export interface RunSpec {
  runId: string;
  kind: "coder" | "docs" | "reviewer" | "onboarding" | "planner" | "probe";
  /** Passed through verbatim. */
  model: string;
  cwd: string;
  prompt: string;
  systemPrompt: string;
  permissions: PermissionProfile;
  outputSchema?: JSONSchema;
  resumeSessionId?: string;
  /** Includes the SEGNO_* variables. */
  env: Record<string, string>;
  /** The Adapter tees raw CLI output here. */
  transcriptPath: string;
}

export type RunEvent =
  | { type: "started"; sessionId: string }
  | { type: "activity"; summary: string }
  | { type: "output"; text: string }
  | { type: "usage"; used: number; limit?: number; resetAt?: string }
  | { type: "rateLimited"; resetAt?: string };

export type RunResult =
  | {
      kind: "completed";
      sessionId: string;
      finalText: string;
      structured?: unknown;
    }
  | { kind: "failed" | "crashed"; detail: string; exitCode?: number }
  | { kind: "rate-limited"; resetAt?: string; detail: string };

export interface RunHandle {
  events: AsyncIterable<RunEvent>;
  result: Promise<RunResult>;
  /** Idempotent; resolves once the process has exited. */
  stop(): Promise<void>;
}

export interface AgentAdapter {
  id: AdapterId;
  detect(): Promise<{ installed: boolean; version?: string; binary?: string }>;
  capabilities: {
    resume: boolean;
    structuredOutput: boolean;
    toolAllowlist: boolean;
    usage: boolean;
  };
  start(spec: RunSpec): RunHandle;
}
