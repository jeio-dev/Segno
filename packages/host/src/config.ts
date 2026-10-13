import { execFile } from "node:child_process";
import { validateAllow } from "@segno/adapter-claude-code";
import {
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

/** Validates segno.config.json text, including its local git checks. */
export async function validateCommittedText(top: string, text: string) {
  const result = validateConfigText(file, text, segnoConfigSchema);
  return {
    ...result,
    errors: sortErrors([
      ...result.errors,
      ...locateConfigErrors(text, [
        ...allowErrors(result.data),
        ...(await gitErrors(top, result.data)),
      ]),
    ]),
  };
}

/** Validates a proposed config object, as the add-project flow edits it. */
export async function validateCommittedValue(top: string, data: unknown) {
  return sortErrors([
    ...validateConfigValue(file, data, segnoConfigSchema),
    ...allowErrors(data),
    ...(await gitErrors(top, data)),
  ]);
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
