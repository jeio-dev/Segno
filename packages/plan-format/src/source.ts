import {
  isMap,
  isNode,
  isScalar,
  LineCounter,
  parseDocument,
  visit,
} from "yaml";
import type { z } from "zod";
import type { Path } from "./graph.js";
import type { ValidationCode, ValidationError } from "./types.js";

export function readSource(source: string) {
  const lineCounter = new LineCounter();
  const document = parseDocument(source, {
    lineCounter,
    prettyErrors: false,
    version: "1.2",
    schema: "core",
  });
  const errors: ValidationError[] = document.errors.map((error) => {
    const position = lineCounter.linePos(error.pos[0]);
    return {
      path: "",
      code: "yaml-syntax",
      message: error.message,
      line: position.line,
      column: position.col,
    };
  });
  const directive = source.match(/^%YAML[ \t]+([^ \t\r\n]+)/m);
  if (directive && directive[1] !== "1.2") {
    const position = lineCounter.linePos(directive.index ?? 0);
    errors.push({
      path: "",
      code: "yaml-syntax",
      message: "Plan files require YAML 1.2.",
      line: position.line,
      column: position.col,
    });
  }
  for (const warning of document.warnings) {
    if (warning.code !== "TAG_RESOLVE_FAILED") continue;
    const position = lineCounter.linePos(warning.pos[0]);
    errors.push({
      path: "",
      code: "yaml-syntax",
      message: warning.message,
      line: position.line,
      column: position.col,
    });
  }
  if (!errors.length) {
    visit(document, {
      Alias(_key, node) {
        if (node.resolve(document)) return;
        const position = node.range
          ? lineCounter.linePos(node.range[0])
          : undefined;
        errors.push({
          path: "",
          code: "yaml-syntax",
          message: `Unresolved YAML alias: ${node.source}.`,
          ...(position ? { line: position.line, column: position.col } : {}),
        });
      },
    });
  }
  // The Plan contract does not impose an extra count limit on ordinary aliases.
  const data: unknown = errors.length
    ? undefined
    : document.toJS({ maxAliasCount: -1 });
  function report(
    path: Path,
    code: ValidationCode,
    message: string,
    key = false,
  ) {
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
    const position =
      isNode(node) && node.range
        ? lineCounter.linePos(node.range[0])
        : undefined;
    errors.push({
      path: path.length
        ? `/${path.map((part) => String(part).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`
        : "",
      code,
      message,
      ...(position ? { line: position.line, column: position.col } : {}),
    });
  }
  function reportIssues(
    issues: readonly z.core.$ZodIssue[],
    isTaskPath: (path: Path) => boolean,
    skipVersion = false,
  ) {
    for (const issue of issues) {
      const path = issue.path.map((part) =>
        typeof part === "number" ? part : String(part),
      );
      if (skipVersion && path.length === 1 && path[0] === "schemaVersion")
        continue;
      if (issue.code === "unrecognized_keys") {
        for (const key of issue.keys) {
          if (
            key === "generated" &&
            isTaskPath(path) &&
            valueAt([...path, key]) === true
          ) {
            report(
              [...path, key],
              "generated-task",
              "Generated Tasks cannot be submitted.",
            );
          } else {
            report([...path, key], "schema", `Unknown key: ${key}.`, true);
          }
        }
      } else {
        report(path, "schema", issue.message);
      }
    }
  }
  function valueAt(path: Path): unknown {
    let value: unknown = data;
    for (const part of path) {
      if (
        typeof value !== "object" ||
        value === null ||
        !Object.hasOwn(value, part)
      )
        return undefined;
      value = (value as Record<string | number, unknown>)[part];
    }
    return value;
  }
  function sortedErrors() {
    return errors.sort(
      (a, b) =>
        (a.line ?? Infinity) - (b.line ?? Infinity) ||
        (a.column ?? Infinity) - (b.column ?? Infinity),
    );
  }
  return { data, document, errors, report, reportIssues, sortedErrors };
}
