import type { EffectiveConfig, PermissionProfile } from "@segno/core";
import type { Task } from "@segno/plan-format";

type AgentKind = "coder" | "docs" | "reviewer";

/** The Reviewer's read-only shell commands [ADR-0004]. */
const readOnlyShell = ["git log *", "git show *", "git diff *", "ls *"];

/** The default permission profile of a Role, plus its config `allow` [ADR-0004]. */
export function permissionsFor(
  kind: AgentKind,
  config: EffectiveConfig,
): PermissionProfile {
  if (kind === "reviewer")
    return {
      read: true,
      edit: false,
      shell: readOnlyShell,
      network: false,
      mcp: false,
      extraAllow: config.roles.reviewer.allow ?? [],
    };
  return {
    read: true,
    edit: true,
    shell: [
      config.tests.command,
      ...(config.setup ? [config.setup.command] : []),
      "git status *",
      "git diff *",
      "git log *",
      "git show *",
      "git add *",
      "git commit *",
    ],
    network: false,
    mcp: false,
    extraAllow: config.roles.coder.allow ?? [],
  };
}

/**
 * A minimal placeholder prompt. B5 replaces it with the Run context built
 * from the fixed ingredients in runners.md [ADR-0024].
 */
export function placeholderPrompt(kind: AgentKind, task: Task) {
  const intro =
    kind === "reviewer"
      ? "Review the changes on this branch against the Task below."
      : "Work the Task below in this worktree, then commit your work.";
  return [
    intro,
    "",
    `# ${task.title}`,
    "",
    task.description,
    "",
    "## Acceptance",
    "",
    ...task.acceptance.map((criterion) => `- ${criterion}`),
    "",
  ].join("\n");
}
