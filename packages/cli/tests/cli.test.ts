import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

let directory: string;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "segno-b1-"));
  cpSync(
    new URL("../dist/index.mjs", import.meta.url),
    join(directory, "segno.mjs"),
  );
  cpSync(
    new URL("../../../examples/", import.meta.url),
    join(directory, "examples"),
    { recursive: true },
  );
  expect(
    spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: directory })
      .status,
  ).not.toBe(0);
});

afterAll(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});

function segno(...args: string[]) {
  return spawnSync(process.execPath, ["segno.mjs", ...args], {
    cwd: directory,
    encoding: "utf8",
  });
}

test("the standalone bundle accepts offline validation and rejects unknown commands", () => {
  const valid = segno("plan", "validate", "examples/two-phase.yaml");
  expect({
    status: valid.status,
    stdout: valid.stdout,
    stderr: valid.stderr,
  }).toEqual({ status: 0, stdout: "", stderr: "" });
  const unknown = segno("plan", "submit", "examples/two-phase.yaml");
  expect(unknown.status).toBe(2);
  expect(unknown.stdout).toBe("");
  expect(unknown.stderr).toContain("Usage: segno plan validate <file>");
});

test("prints every validation error with its source location and exits 2", () => {
  const result = segno("plan", "validate", "examples/invalid-reserved-id.yaml");
  expect({
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  }).toEqual({
    status: 2,
    stdout: "",
    stderr:
      "examples/invalid-reserved-id.yaml:8:13  reserved-id  Task id work-docs is reserved for a Docs task.\nexamples/invalid-reserved-id.yaml:16:21  reserved-id  Dependency work-docs is a Docs task.\n",
  });
});

test("missing files are read errors with exit code 2", () => {
  const result = segno("plan", "validate", "missing.yaml");
  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toMatch(/^Cannot read missing\.yaml: /);
  expect(result.stderr).not.toContain("\n    at ");
});

test("treats a non-YAML extension as a usage error", () => {
  const result = segno("plan", "validate", "notes.txt");
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("Usage: segno plan validate <file>");
  expect(result.stderr).not.toContain("Cannot read");
});

const invalidFixtures = [
  ["invalid-yaml-syntax.yaml", ["yaml-syntax"]],
  ["invalid-schema-version.yaml", ["schema-version"]],
  ["invalid-schema.yaml", Array(15).fill("schema")],
  ["invalid-schema-duplicate-risk.yaml", ["schema"]],
  ["invalid-schema-duplicate-dependency.yaml", ["schema"]],
  ["invalid-duplicate-id.yaml", ["duplicate-id", "duplicate-id"]],
  ["invalid-unknown-dependency.yaml", ["unknown-dependency"]],
  ["invalid-cross-phase-dependency.yaml", ["cross-phase-dependency"]],
  ["invalid-dependency-cycle.yaml", ["dependency-cycle", "dependency-cycle"]],
  ["invalid-reserved-id.yaml", ["reserved-id", "reserved-id"]],
  ["invalid-generated-task.yaml", ["generated-task"]],
] as const;

test.each(invalidFixtures)(
  "exits 2 and prints every diagnostic for %s",
  (name, codes) => {
    const result = segno("plan", "validate", `examples/${name}`);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    const lines = result.stderr.trimEnd().split("\n");
    expect(lines.map((line) => line.split("  ")[1])).toEqual(codes);
    for (const line of lines)
      expect(line).toMatch(
        /^examples\/invalid-[a-z-]+\.yaml:\d+:\d+ {2}[a-z-]+ {2}.+$/,
      );
  },
);

test.each(
  [
    [],
    ["plan"],
    ["plan", "validate"],
    ["plan", "validate", "examples/two-phase.yaml", "extra"],
  ].map((args) => ({ args })),
)("bad arguments exit 2", ({ args }) => {
  expect(segno(...args).status).toBe(2);
});

test("a .yml file validates too, and an empty file uses unknown locations", () => {
  cpSync(
    join(directory, "examples/two-phase.yaml"),
    join(directory, "plan.yml"),
  );
  expect(segno("plan", "validate", "plan.yml").status).toBe(0);
  writeFileSync(join(directory, "empty.yaml"), "");
  const result = segno("plan", "validate", "empty.yaml");
  expect(result.status).toBe(2);
  expect(
    result.stderr
      .split("\n")
      .slice(0, -1)
      .map((line) => line.split("  ").slice(0, 2)),
  ).toEqual([
    ["empty.yaml:?:?", "schema-version"],
    ["empty.yaml:?:?", "schema"],
  ]);
});

test("rejects malformed UTF-8 as a read error instead of replacing bytes", () => {
  const source = Buffer.from(
    "schemaVersion: 1\ntitle: Bad byte\nsummary: Invalid UTF-8\nphases:\n  - id: work\n    title: Work\n    tasks:\n      - id: implement\n        title: Implement\n        description: Change\n        acceptance: [It works]\n",
  );
  source[source.indexOf("Bad byte")] = 0xff;
  writeFileSync(join(directory, "invalid-encoding.yaml"), source);
  const result = segno("plan", "validate", "invalid-encoding.yaml");
  expect(result.status).toBe(2);
  expect(result.stderr).toMatch(/^Cannot read invalid-encoding\.yaml: /);
});
