import { isMap, isNode, isScalar, LineCounter, parseDocument } from "yaml";
import { z } from "zod";

export const configErrorCodes = [
  "json-syntax",
  "schema-version",
  "schema",
  "denied-permission",
  "unknown-remote",
  "unknown-branch",
  "missing-file",
  "adapter",
] as const;
export type ConfigErrorCode = (typeof configErrorCodes)[number];
export type ConfigFile = "segno.config.json" | "local.json" | "pending.json";

export const configErrorSchema = z.strictObject({
  file: z.enum(["segno.config.json", "local.json", "pending.json"]),
  path: z.string(),
  line: z.number().int().min(1).optional(),
  column: z.number().int().min(1).optional(),
  code: z.enum(configErrorCodes),
  message: z.string(),
});
export type ConfigError = z.infer<typeof configErrorSchema>;

const nonEmpty = z.string().min(1, "Must not be empty.");
export const projectModelsSchema = z.strictObject({
  planner: nonEmpty,
  coder: nonEmpty,
  reviewer: nonEmpty,
});
export type ProjectModels = z.infer<typeof projectModelsSchema>;
export const defaultProjectModels: ProjectModels = {
  planner: "opus",
  coder: "sonnet",
  reviewer: "opus",
};
export const pendingConfigSchema = z.strictObject({
  roles: z.strictObject({
    planner: z.strictObject({ model: nonEmpty }),
    coder: z.strictObject({ model: nonEmpty, docsModel: nonEmpty }),
    reviewer: z.strictObject({ model: nonEmpty }),
  }),
});
export type PendingConfig = z.infer<typeof pendingConfigSchema>;
export function pendingFromModels(models: ProjectModels): PendingConfig {
  return {
    roles: {
      planner: { model: models.planner },
      coder: { model: models.coder, docsModel: "haiku" },
      reviewer: { model: models.reviewer },
    },
  };
}

const minutes = z.number().int().min(1).max(1440);
const role = z.strictObject({
  adapter: z.literal("claude-code", {
    error: "v1 supports only the claude-code Adapter.",
  }),
  model: nonEmpty,
  timeoutMin: minutes.optional(),
  allow: z.array(z.string()).optional(),
});

export const segnoConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  baseBranch: nonEmpty,
  remote: nonEmpty.optional(),
  forge: z.literal("github", { error: "v1 supports only github." }).optional(),
  tests: z.strictObject({ command: nonEmpty, timeoutMin: minutes.optional() }),
  setup: z.strictObject({ command: nonEmpty }).optional(),
  roles: z.strictObject({
    planner: role.optional(),
    coder: role.extend({ docsModel: nonEmpty.optional() }),
    reviewer: role,
  }),
  idleTimeoutMin: minutes.optional(),
  concurrency: z.literal(1, { error: "v1 requires concurrency 1." }).optional(),
  docs: z
    .strictObject({
      changelog: nonEmpty.refine(
        (path) => !path.startsWith("/") && !path.split(/[\\/]/).includes(".."),
        "Must be a repo-relative path.",
      ),
    })
    .optional(),
  retention: z.strictObject({ runDays: z.number().int().min(0) }).optional(),
});
export type SegnoConfig = z.infer<typeof segnoConfigSchema>;

export const localSettingsSchema = z.strictObject({
  worktreeRoot: nonEmpty
    .refine((path) => path.startsWith("/"), "Must be an absolute path.")
    .optional(),
  roles: z
    .strictObject({
      planner: z.strictObject({ model: nonEmpty }).optional(),
      coder: z.strictObject({ model: nonEmpty }).optional(),
      "coder-docs": z.strictObject({ model: nonEmpty }).optional(),
      reviewer: z.strictObject({ model: nonEmpty }).optional(),
    })
    .optional(),
});
export type LocalSettings = z.infer<typeof localSettingsSchema>;

export const appSettingsSchema = z.strictObject({
  editor: z
    .string()
    .refine((command) => command.includes("{path}"), "Must contain {path}.")
    .optional(),
  notifications: z.boolean().optional(),
  theme: z.enum(["system", "light", "dark"]).optional(),
  launchAtLogin: z.boolean().optional(),
});
export type AppSettings = z.infer<typeof appSettingsSchema>;

type Path = (string | number)[];

/**
 * Validates one config file's text against its schema. Locations come from the
 * JSON source: values for value errors, keys for unknown keys, and the
 * containing object for missing fields.
 */
export function validateConfigText<T>(
  file: ConfigFile,
  text: string,
  schema: z.ZodType<T>,
): { value?: T; data?: unknown; errors: ConfigError[] } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    const position = (error as Error).message.match(/position (\d+)/);
    const at = position ? linePos(text, Number(position[1])) : undefined;
    return {
      errors: [
        {
          file,
          path: "",
          ...(at ? { line: at.line, column: at.col } : {}),
          code: "json-syntax",
          message: (error as Error).message,
        },
      ],
    };
  }
  const errors = configIssues(file, text, data, schema);
  return errors.length
    ? { data, errors }
    : { value: data as T, data, errors: [] };
}

/** Validates an already-parsed value, with no source locations. */
export function validateConfigValue<T>(
  file: ConfigFile,
  data: unknown,
  schema: z.ZodType<T>,
) {
  return configIssues(file, undefined, data, schema);
}

function configIssues(
  file: ConfigFile,
  text: string | undefined,
  data: unknown,
  schema: z.ZodType,
): ConfigError[] {
  const errors: ConfigError[] = [];
  const located = text === undefined ? undefined : locator(text);
  const report = (
    path: Path,
    code: ConfigErrorCode,
    message: string,
    key = false,
  ) => {
    const at = located?.(path, key);
    errors.push({
      file,
      path: pointer(path),
      ...(at ? { line: at.line, column: at.col } : {}),
      code,
      message,
    });
  };
  const versioned = file === "segno.config.json";
  if (
    versioned &&
    (typeof data !== "object" ||
      data === null ||
      (data as { schemaVersion?: unknown }).schemaVersion !== 1)
  ) {
    report(["schemaVersion"], "schema-version", "schemaVersion must be 1.");
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.map((part) =>
        typeof part === "number" ? part : String(part),
      );
      if (versioned && path.length === 1 && path[0] === "schemaVersion")
        continue;
      if (issue.code === "unrecognized_keys") {
        for (const key of issue.keys)
          report([...path, key], "schema", `Unknown key: ${key}.`, true);
      } else {
        report(path, "schema", issue.message);
      }
    }
  }
  return sortErrors(errors);
}

export function sortErrors(errors: ConfigError[]) {
  return errors.sort(
    (a, b) =>
      (a.line ?? Infinity) - (b.line ?? Infinity) ||
      (a.column ?? Infinity) - (b.column ?? Infinity),
  );
}

export function pointer(path: Path) {
  return path.length
    ? `/${path.map((part) => String(part).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`
    : "";
}

/** Adds source locations to errors found outside schema validation. */
export function locateConfigErrors(text: string, errors: ConfigError[]) {
  const located = locator(text);
  return errors.map((error) => {
    if (error.line !== undefined) return error;
    const path = error.path
      .split("/")
      .slice(1)
      .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
      .map((part) => (/^\d+$/.test(part) ? Number(part) : part));
    const at = located(path, false);
    return at ? { ...error, line: at.line, column: at.col } : error;
  });
}

/** Finds a path's line and column in JSON text, which is valid YAML 1.2. */
function locator(text: string) {
  const lineCounter = new LineCounter();
  const document = parseDocument(text, { lineCounter, version: "1.2" });
  return (path: Path, key: boolean) => {
    let node = document.getIn(path, true);
    if (key && path.length) {
      const parent = document.getIn(path.slice(0, -1), true);
      if (isMap(parent))
        node = parent.items.find(
          (pair) => isScalar(pair.key) && pair.key.value === path.at(-1),
        )?.key;
    }
    let parentPath = path;
    while (!isNode(node) && parentPath.length) {
      parentPath = parentPath.slice(0, -1);
      node = document.getIn(parentPath, true);
    }
    if (!isNode(node)) node = document.contents ?? undefined;
    return isNode(node) && node.range
      ? lineCounter.linePos(node.range[0])
      : undefined;
  };
}

function linePos(text: string, offset: number) {
  const before = text.slice(0, offset).split("\n");
  return { line: before.length, col: (before.at(-1)?.length ?? 0) + 1 };
}

export type ConfigSource = "file" | "local" | "default";
export type EffectiveConfig = SegnoConfig & { worktreeRoot?: string };

const roleTimeouts = { planner: 20, coder: 45, reviewer: 15 } as const;

/**
 * The committed file overlaid with local settings and filled with defaults,
 * plus the source of every leaf, keyed by JSON pointer [ADR-0025].
 */
export function resolveConfig(file: SegnoConfig, local: LocalSettings = {}) {
  const sources: Record<string, ConfigSource> = {};
  const pick = <T>(
    path: string,
    ...candidates: [ConfigSource, T | undefined][]
  ) => {
    for (const [source, value] of candidates)
      if (value !== undefined) {
        sources[path] = source;
        return value;
      }
    throw new Error(`No value for ${path}.`);
  };
  const roles: Record<string, unknown> = {};
  for (const name of ["planner", "coder", "reviewer"] as const) {
    const role = file.roles[name];
    if (!role) continue;
    const at = `/roles/${name}`;
    const model = pick(
      `${at}/model`,
      ["local", local.roles?.[name]?.model],
      ["file", role.model],
    );
    roles[name] = {
      adapter: pick(`${at}/adapter`, ["file", role.adapter]),
      model,
      ...(name === "coder"
        ? {
            docsModel: pick(
              `${at}/docsModel`,
              ["local", local.roles?.["coder-docs"]?.model],
              ["file", file.roles.coder.docsModel],
              ["default", model],
            ),
          }
        : {}),
      timeoutMin: pick(
        `${at}/timeoutMin`,
        ["file", role.timeoutMin],
        ["default", roleTimeouts[name]],
      ),
      allow: pick(`${at}/allow`, ["file", role.allow], ["default", []]),
    };
  }
  const effective = {
    schemaVersion: pick("/schemaVersion", ["file", file.schemaVersion]),
    baseBranch: pick("/baseBranch", ["file", file.baseBranch]),
    remote: pick("/remote", ["file", file.remote], ["default", "origin"]),
    forge: pick("/forge", ["file", file.forge], ["default", "github" as const]),
    tests: {
      command: pick("/tests/command", ["file", file.tests.command]),
      timeoutMin: pick(
        "/tests/timeoutMin",
        ["file", file.tests.timeoutMin],
        ["default", 15],
      ),
    },
    ...(file.setup
      ? {
          setup: {
            command: pick("/setup/command", ["file", file.setup.command]),
          },
        }
      : {}),
    roles: roles as EffectiveConfig["roles"],
    idleTimeoutMin: pick(
      "/idleTimeoutMin",
      ["file", file.idleTimeoutMin],
      ["default", 10],
    ),
    concurrency: pick(
      "/concurrency",
      ["file", file.concurrency],
      ["default", 1 as const],
    ),
    docs: {
      changelog: pick(
        "/docs/changelog",
        ["file", file.docs?.changelog],
        ["default", "CHANGELOG.md"],
      ),
    },
    retention: {
      runDays: pick(
        "/retention/runDays",
        ["file", file.retention?.runDays],
        ["default", 30],
      ),
    },
    ...(local.worktreeRoot
      ? { worktreeRoot: pick("/worktreeRoot", ["local", local.worktreeRoot]) }
      : {}),
  } satisfies EffectiveConfig;
  return { effective, sources };
}
