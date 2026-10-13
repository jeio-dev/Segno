/** git operations no Role may run, because the Engine owns branches [ADR-0004]. */
export const alwaysDeniedGit = [
  "push",
  "checkout",
  "switch",
  "merge",
  "rebase",
  "reset",
  "branch",
  "worktree",
] as const;

const bypassMarkers = [
  "bypassPermissions",
  "dangerously-skip-permissions",
  "--permission-mode",
];

export interface AllowProblem {
  index: number;
  code: "denied-permission" | "schema";
  message: string;
}

/**
 * Config-time guard for roles.<role>.allow entries in Claude Code's rule
 * syntax. Runtime enforcement is the Adapter's deny list (B5).
 */
export function validateAllow(entries: readonly string[]): AllowProblem[] {
  const problems: AllowProblem[] = [];
  for (const [index, entry] of entries.entries()) {
    if (bypassMarkers.some((marker) => entry.includes(marker))) {
      problems.push({
        index,
        code: "denied-permission",
        message: `${entry} asks for a permission bypass mode.`,
      });
      continue;
    }
    const rule = entry.match(/^([A-Za-z][A-Za-z0-9_-]*)(?:\((.*)\))?$/s);
    if (!rule) {
      problems.push({
        index,
        code: "schema",
        message: `${entry} is not a Claude Code permission rule.`,
      });
      continue;
    }
    const [, tool, specifier] = rule;
    if (tool !== "Bash") continue;
    const denied =
      specifier === undefined
        ? alwaysDeniedGit[0]
        : alwaysDeniedGit.find((command) =>
            reaches(specifier.replace(/:\*$/, " *"), `git ${command}`),
          );
    if (denied)
      problems.push({
        index,
        code: "denied-permission",
        message: `${entry} would allow git ${denied}, which is always denied.`,
      });
  }
  return problems;
}

/**
 * Whether the glob `pattern` (where `*` is any text) matches some command
 * that is `command` alone or `command` followed by a space and arguments.
 */
function reaches(pattern: string, command: string) {
  const any = command.length + 1;
  const seen = new Set<string>();
  const match = (i: number, state: number): boolean => {
    if (state === any) return true;
    const key = `${i}:${state}`;
    if (seen.has(key)) return false;
    seen.add(key);
    if (i === pattern.length) return state === command.length;
    const next = (char: string) =>
      state < command.length
        ? char === command[state]
          ? state + 1
          : undefined
        : char === " "
          ? any
          : undefined;
    if (pattern[i] === "*") {
      if (match(i + 1, state)) return true;
      const step = next(state < command.length ? (command[state] ?? "") : " ");
      return step !== undefined && match(i, step);
    }
    const step = next(pattern[i] ?? "");
    return step !== undefined && match(i + 1, step);
  };
  return match(0, 0);
}
