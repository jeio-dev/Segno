import type { PermissionProfile, RunSpec } from "@segno/core";
import { alwaysDeniedGit } from "./allow.js";

/** Network access, denied unless the profile or its `allow` adds it [ADR-0004]. */
const networkTools = ["WebFetch", "WebSearch", "Bash(curl *)", "Bash(wget *)"];

/** The `claude -p` argv for a RunSpec, per runners.md § Claude Code Adapter. */
export function argvFor(spec: RunSpec, sessionId: string) {
  return [
    "-p",
    spec.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    spec.model,
    ...(spec.systemPrompt ? ["--append-system-prompt", spec.systemPrompt] : []),
    ...(spec.resumeSessionId
      ? ["--resume", spec.resumeSessionId]
      : ["--session-id", sessionId]),
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
    "--allowedTools",
    ...allowedTools(spec.permissions),
    "--disallowedTools",
    ...disallowedTools(spec.permissions),
    // User and local settings never contribute permissions [ADR-0004].
    "--setting-sources",
    "project",
    // mcp is false in every profile: no MCP servers at all.
    "--strict-mcp-config",
    ...(spec.outputSchema
      ? ["--json-schema", JSON.stringify(spec.outputSchema)]
      : []),
    // A probe only checks the rate limit, with no tools at all [ADR-0054].
    ...(spec.kind === "probe" ? ["--tools", ""] : []),
  ];
}

function allowedTools({ edit, shell, network, extraAllow }: PermissionProfile) {
  const anyCommand = shell.includes("*");
  return [
    "Read(./**)",
    ...(edit ? ["Edit(./**)"] : []),
    ...(anyCommand ? ["Bash"] : shell.map((command) => `Bash(${command})`)),
    ...(network
      ? networkTools.filter((tool) => !(anyCommand && tool.startsWith("Bash(")))
      : []),
    ...extraAllow,
  ];
}

function disallowedTools({ network, extraAllow }: PermissionProfile) {
  return [
    ...alwaysDeniedGit.map((command) => `Bash(git ${command} *)`),
    ...(network
      ? []
      : networkTools.filter((tool) => !addedBy(extraAllow, tool))),
  ];
}

/** Whether a Role's `allow` lifts this network deny entry. */
function addedBy(extraAllow: readonly string[], tool: string) {
  // `WebFetch` is lifted by `WebFetch(domain:…)`, `Bash(curl *)` by `Bash(curl …)`.
  const stem = tool.replace(/ \*\)$/, "");
  return extraAllow.some((entry) => entry.startsWith(stem));
}
