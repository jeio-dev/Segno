import { execFile } from "node:child_process";
import { validateAllow } from "@segno/adapter-claude-code";
import {
  type AgentAdapter,
  type ConfigError,
  locateConfigErrors,
  type SegnoConfig,
  segnoConfigSchema,
  sortErrors,
  validateConfigText,
  validateConfigValue,
} from "@segno/core";
import { git, remotes } from "./git.js";

const file = "segno.config.json";

/**
 * Validates segno.config.json text, including its local git checks and each
 * Role's Adapter.
 */
export async function validateCommittedText(
  top: string,
  text: string,
  adapters: readonly AgentAdapter[],
) {
  const result = validateConfigText(file, text, segnoConfigSchema);
  return {
    ...result,
    errors: sortErrors([
      ...result.errors,
      ...locateConfigErrors(text, [
        ...allowErrors(result.data),
        ...(await gitErrors(top, result.data)),
        ...(await adapterErrors(result.data, adapters)),
      ]),
    ]),
  };
}

/** Validates a proposed config object, as the add-project flow edits it. */
export async function validateCommittedValue(
  top: string,
  data: unknown,
  adapters: readonly AgentAdapter[],
) {
  return sortErrors([
    ...validateConfigValue(file, data, segnoConfigSchema),
    ...allowErrors(data),
    ...(await gitErrors(top, data)),
    ...(await adapterErrors(data, adapters)),
  ]);
}

type Capability = keyof AgentAdapter["capabilities"];

/** What each Role needs from its Adapter (runners.md § Adapter interface) [ADR-0017]. */
const needs: Record<string, { name: string; capabilities: Capability[] }> = {
  planner: {
    name: "Planner",
    capabilities: ["toolAllowlist", "structuredOutput"],
  },
  coder: { name: "Coder", capabilities: ["toolAllowlist"] },
  reviewer: {
    name: "Reviewer",
    capabilities: ["toolAllowlist", "structuredOutput"],
  },
};

const described: Partial<Record<Capability, string>> = {
  toolAllowlist: "enforce a tool allowlist",
  structuredOutput: "enforce structured output",
};

/**
 * Whether an Adapter's CLI is installed. A found CLI is remembered for the
 * host's lifetime; a missing one is looked for again, as it may be installed.
 */
const installed = new WeakMap<AgentAdapter, Promise<boolean>>();
function isInstalled(adapter: AgentAdapter) {
  let known = installed.get(adapter);
  if (!known) {
    known = adapter.detect().then(
      (result) => result.installed,
      () => false,
    );
    installed.set(adapter, known);
    void known.then((found) => {
      if (!found) installed.delete(adapter);
    });
  }
  return known;
}

/** A Role whose Adapter isn't installed or lacks a capability it needs. */
async function adapterErrors(
  data: unknown,
  adapters: readonly AgentAdapter[],
): Promise<ConfigError[]> {
  const roles = (data as { roles?: unknown } | null)?.roles;
  if (typeof roles !== "object" || roles === null) return [];
  const errors: ConfigError[] = [];
  for (const [role, value] of Object.entries(roles)) {
    const id = (value as { adapter?: unknown } | null)?.adapter;
    const need = needs[role];
    if (!need || typeof id !== "string") continue;
    const path = `/roles/${role}/adapter`;
    const adapter = adapters.find((candidate) => candidate.id === id);
    if (!adapter || !(await isInstalled(adapter))) {
      errors.push({
        file,
        path,
        code: "adapter",
        message: `${id} is not installed.`,
      });
      continue;
    }
    for (const capability of need.capabilities)
      if (!adapter.capabilities[capability])
        errors.push({
          file,
          path,
          code: "adapter",
          message: `${id} can't ${described[capability]}, which the ${need.name} needs.`,
        });
  }
  return errors;
}

/** Each claude-code Role's allow entries, in that Adapter's syntax [ADR-0004]. */
function allowErrors(data: unknown): ConfigError[] {
  const roles = (data as { roles?: unknown } | null)?.roles;
  if (typeof roles !== "object" || roles === null) return [];
  return Object.entries(roles).flatMap(([role, value]) => {
    const { adapter, allow } = (value ?? {}) as Record<string, unknown>;
    if (adapter !== "claude-code" || !Array.isArray(allow)) return [];
    const entries = allow.filter((entry) => typeof entry === "string");
    if (entries.length !== allow.length) return [];
    return validateAllow(entries).map(({ index, code, message }) => ({
      file,
      path: `/roles/${role}/allow/${index}`,
      code,
      message,
    }));
  });
}

/** remote and baseBranch are checked offline against local refs. */
async function gitErrors(top: string, data: unknown): Promise<ConfigError[]> {
  if (typeof data !== "object" || data === null) return [];
  const config = data as Partial<SegnoConfig>;
  const remote = typeof config.remote === "string" ? config.remote : "origin";
  if (!(await remotes(top)).includes(remote))
    return [
      {
        file,
        path: "/remote",
        code: "unknown-remote",
        message: `${remote} is not a git remote of this repo.`,
      },
    ];
  if (typeof config.baseBranch !== "string" || !config.baseBranch) return [];
  const ref = `refs/remotes/${remote}/${config.baseBranch}`;
  if ((await git(top, "rev-parse", "--verify", "--quiet", ref)) === undefined)
    return [
      {
        file,
        path: "/baseBranch",
        code: "unknown-branch",
        message: `${config.baseBranch} is not a branch on ${remote}.`,
      },
    ];
  return [];
}

/** A missing or logged-out gh is a warning, never a refusal [ADR-0023]. */
export function ghStatus(
  binary: string,
): Promise<"ok" | "missing" | "logged-out"> {
  return new Promise((resolve) => {
    // gh may contact GitHub; a slow network must not hold up adding a Project.
    execFile(binary, ["auth", "status"], { timeout: 10_000 }, (error) => {
      if (!error) resolve("ok");
      else if ((error as NodeJS.ErrnoException).code === "ENOENT")
        resolve("missing");
      else resolve("logged-out");
    });
  });
}
