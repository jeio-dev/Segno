import type {
  EffectiveConfig,
  JSONSchema,
  PermissionProfile,
  RunSpec,
} from "@segno/core";
import type { Phase, Plan, Task } from "@segno/plan-format";

type AgentKind = "coder" | "docs" | "reviewer";

/**
 * Listing and searching files: Claude Code has no Glob or Grep tool, and
 * none of these can write a file or start another program [ADR-0059].
 */
const searchShell = ["ls *", "grep *", "git ls-files *", "git grep *"];

/** The Reviewer's read-only shell commands [ADR-0004] [ADR-0059]. */
const readOnlyShell = ["git log *", "git show *", "git diff *", ...searchShell];

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
      ...searchShell,
    ],
    network: false,
    mcp: false,
    extraAllow: config.roles.coder.allow ?? [],
  };
}

interface Finding {
  file?: string | undefined;
  line?: number | undefined;
  body: string;
}

/**
 * The shell commands a Run may use, one at a time [ADR-0058]. Claude Code
 * refuses a joined command whole, and agents that chain an unlisted one
 * otherwise take the shell for off.
 */
function shellSection({ shell, extraAllow }: PermissionProfile) {
  const commands = [
    ...shell,
    ...extraAllow.flatMap((entry) => /^Bash\((.+)\)$/s.exec(entry)?.[1] ?? []),
  ];
  return [
    "## Shell",
    "Run only these shell commands, where `*` stands for any arguments:",
    list(commands.map((command) => `\`${command}\``)),
    "Run each one on its own, never joined with `&&`, `||`, `;`, `|` or `$(…)`: a joined command is refused whole if any part isn't listed. A refused command doesn't turn the shell off, so keep using the listed ones.",
  ];
}

/** The first-pass Coder's context [ADR-0024] [ADR-0049] [ADR-0058]. */
export function coderPrompt({
  plan,
  phase,
  task,
  testsCommand,
  permissions,
}: {
  plan: Plan;
  phase: Phase;
  task: Task;
  testsCommand: string;
  permissions: PermissionProfile;
}) {
  return document([
    "You are working one Task of a Segno Plan, in this worktree.",
    `# Plan: ${plan.title}`,
    plan.summary,
    `## Phase: ${phase.title}`,
    `## Task: ${task.title}`,
    task.description,
    "### Acceptance criteria",
    list(task.acceptance),
    ...(task.context?.length
      ? ["### Context", "Start from these:", list(task.context)]
      : []),
    ...shellSection(permissions),
    "## Definition of done",
    list([
      "Meet every acceptance criterion.",
      "Update the docs for any behavior you change.",
      `Run \`${testsCommand}\` before you finish, and fix what fails.`,
      "Commit your work.",
    ]),
  ]);
}

/** The Reviewer's context, asking for a Verdict [ADR-0024] [ADR-0016] [ADR-0058]. */
export function reviewerPrompt({
  task,
  base,
  schema,
  permissions,
}: {
  task: Task;
  /** The merge-base of the Task branch with the Phase branch. */
  base: string;
  schema: JSONSchema;
  permissions: PermissionProfile;
}) {
  const range = `${base}..HEAD`;
  return document([
    "You are reviewing one Task of a Segno Plan, in this worktree. Its tests passed.",
    `# Task: ${task.title}`,
    task.description,
    "## Acceptance criteria",
    task.acceptance
      .map((criterion, index) => `${index}. ${criterion}`)
      .join("\n"),
    ...(task.risk
      ? [
          "## Risk",
          `Flagged ${task.risk.flags.join(", ")}: ${task.risk.reason}`,
        ]
      : []),
    "## Changes",
    `Review the changes in \`${range}\`, for example with \`git diff ${range}\`.`,
    "## Docs",
    "Check whether the changes alter behavior that docs describe, and whether those docs were updated to match.",
    ...shellSection(permissions),
    "## Verdict",
    "Answer with a Verdict that matches this JSON Schema. In `acceptance`, `index` is the criterion's number above.",
    fenced(schema),
  ]);
}

/** The Docs task's context [ADR-0024] [ADR-0018] [ADR-0058]. */
export function docsPrompt({
  plan,
  phase,
  done,
  advisory,
  base,
  baseBranch,
  changelog,
  permissions,
}: {
  plan: Plan;
  phase: Phase;
  /** Each done Task's title and final Verdict summary. */
  done: { title: string; summary?: string | undefined }[];
  advisory: Finding[];
  /** Where the Phase branch was cut from `baseBranch`. */
  base: string;
  baseBranch: string;
  changelog: string;
  permissions: PermissionProfile;
}) {
  return document([
    "You are writing the docs for a finished Phase of a Segno Plan, in this worktree.",
    `# Phase: ${phase.title}`,
    plan.summary,
    "## Done Tasks",
    list(
      done.map(({ title, summary }) =>
        summary ? `${title}: ${summary}` : title,
      ),
    ),
    ...(advisory.length
      ? [
          "## Advisory Findings",
          list(
            advisory.map(({ file, line, body }) =>
              file ? `${file}${line ? `:${line}` : ""}: ${body}` : body,
            ),
          ),
        ]
      : []),
    "## Changes",
    `The Phase's changes are \`${base}..HEAD\`, against \`${baseBranch}\`.`,
    ...(phase.docs ? ["## Docs to write", phase.docs] : []),
    ...shellSection(permissions),
    "## Changelog",
    `Add entries for user-visible changes to \`${changelog}\`.`,
    "Commit your work when you're done.",
  ]);
}

function list(items: readonly string[]) {
  return items.map((item) => `- ${item}`).join("\n");
}

/** Paragraphs separated by blank lines; empty ones are left out. */
function document(paragraphs: readonly string[]) {
  return `${paragraphs
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .join("\n\n")}\n`;
}

/** The broadest profile in Segno, for onboarding only [ADR-0049]. */
export const onboardingPermissions: PermissionProfile = {
  read: true,
  edit: true,
  shell: ["*"],
  network: true,
  mcp: false,
  // roles.planner.allow doesn't apply.
  extraAllow: [],
};

/** The onboarding Run's context [ADR-0049]. */
export function onboardingPrompt({
  guess,
  schema,
}: {
  /** The detected settings, in the proposal's config shape. */
  guess: Record<string, unknown>;
  schema: JSONSchema;
}) {
  return document([
    "You are onboarding this repo to Segno, in a scratch worktree of its base branch that is deleted afterwards. Propose the config Segno will use to check every Task.",
    "## What Segno detected",
    "A starting guess, to verify rather than trust:",
    fenced(guess),
    "## Choosing the test command",
    "The test command is the strongest check the repo has, in this order: tests, then typecheck, then build, then lint. Never choose a weaker check because a stronger one fails. Propose the failing check with the `fails-on-base` flag, and list what fails in `failing`. If the repo has no check at all, propose `true` with the `no-checks` flag.",
    "## Running the checks",
    "Run the setup command, if the repo needs one, and then the chosen check. Report every command you ran in `checks`, with its exit code and its duration in seconds. Set `tests.timeoutMin` to the check's duration with headroom. Put what the Coder needs to run the checks itself in `coderAllow`, for example `Bash(npm *)`.",
    "## Your answer",
    'Answer with a proposal that matches this JSON Schema, with a one-line reason for each value in `reasons`, keyed by JSON pointer into `config`. If you can\'t onboard this repo, answer with `kind: "unable"` and an `explanation` instead.',
    fenced(schema),
  ]);
}

function fenced(value: unknown) {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

/**
 * A rate-limit probe: a minimal fixed prompt in the repo root, with no tools
 * [ADR-0021] [ADR-0054]. B8's rate-limit pause starts it.
 */
export function probeSpec({
  runId,
  model,
  repo,
  transcriptPath,
}: {
  runId: string;
  model: string;
  repo: string;
  transcriptPath: string;
}): RunSpec {
  return {
    runId,
    kind: "probe",
    model,
    cwd: repo,
    prompt: "Reply with the single word ok.\n",
    systemPrompt: "",
    // The Adapter gives a probe no tools, whatever the profile allows.
    permissions: {
      read: true,
      edit: false,
      shell: [],
      network: false,
      mcp: false,
      extraAllow: [],
    },
    // No SEGNO_TASK_ID: a probe works no Task [ADR-0029].
    env: { SEGNO: "1", SEGNO_RUN_ID: runId, SEGNO_SLOT: "0" },
    transcriptPath,
  };
}
