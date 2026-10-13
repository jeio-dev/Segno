import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { parsePlan } from "../src/index.js";

const example = readFileSync(
  new URL("../../../examples/two-phase.yaml", import.meta.url),
  "utf8",
);

function fixture(name: string) {
  return readFileSync(
    new URL(`../../../examples/${name}`, import.meta.url),
    "utf8",
  );
}

test("parses a two-Phase Plan with authored Tasks, Markdown and risk", () => {
  expect(parsePlan(example)).toEqual({
    valid: true,
    plan: {
      schemaVersion: 1,
      title: "Search saved notes",
      summary:
        "Let people find their saved notes by title and content.\n\nBuild the search index first, then add the search screen.\n",
      phases: [
        {
          id: "search-index",
          title: "Search index",
          docs: "Document how the search index is rebuilt.\n",
          tasks: [
            {
              id: "index-notes",
              title: "Index saved notes",
              description: "Index note titles and content when notes change.\n",
              acceptance: ["Saved notes are searchable by title and content"],
              context: ["src/notes/**"],
              risk: {
                flags: ["migration"],
                reason: "Adds an index to existing note data.",
              },
            },
            {
              id: "query-notes",
              title: "Query the search index",
              description: "Return matching notes in relevance order.",
              acceptance: ["Search returns matching notes in relevance order"],
              dependsOn: ["index-notes"],
            },
          ],
        },
        {
          id: "search-screen",
          title: "Search screen",
          tasks: [
            {
              id: "show-results",
              title: "Show search results",
              description: "Add a search field and a list of matching notes.",
              acceptance: ["Typing a query shows matching notes"],
            },
          ],
        },
      ],
    },
  });
});

test("reports YAML syntax errors with a source position", () => {
  expect(parsePlan(fixture("invalid-yaml-syntax.yaml"))).toEqual({
    valid: false,
    errors: [
      {
        path: "",
        line: 4,
        column: 1,
        code: "yaml-syntax",
        message: expect.any(String),
      },
    ],
  });
});

test("rejects an unsupported schema version at its source value", () => {
  expect(parsePlan(fixture("invalid-schema-version.yaml"))).toEqual({
    valid: false,
    errors: [
      {
        path: "/schemaVersion",
        line: 1,
        column: 16,
        code: "schema-version",
        message: expect.any(String),
      },
    ],
  });
});

test("reports a missing schema version at the containing object", () => {
  expect(parsePlan(example.replace("schemaVersion: 1\n", ""))).toEqual({
    valid: false,
    errors: [
      {
        path: "/schemaVersion",
        line: 1,
        column: 1,
        code: "schema-version",
        message: expect.any(String),
      },
    ],
  });
});

test("rejects structural field errors and unknown keys at every level", () => {
  const result = parsePlan(fixture("invalid-schema.yaml"));
  expect(result.valid).toBe(false);
  if (result.valid) throw new Error("Expected structural errors");
  expect(result.errors.map(({ path, code }) => ({ path, code }))).toEqual([
    { path: "/title", code: "schema" },
    { path: "/summary", code: "schema" },
    { path: "/phases/0/id", code: "schema" },
    { path: "/phases/0/title", code: "schema" },
    { path: "/phases/0/tasks/0/id", code: "schema" },
    { path: "/phases/0/tasks/0/title", code: "schema" },
    { path: "/phases/0/tasks/0/description", code: "schema" },
    { path: "/phases/0/tasks/0/acceptance", code: "schema" },
    { path: "/phases/0/tasks/0/context/0", code: "schema" },
    { path: "/phases/0/tasks/0/risk/flags/0", code: "schema" },
    { path: "/phases/0/tasks/0/risk/reason", code: "schema" },
    { path: "/phases/0/tasks/0/risk/extra", code: "schema" },
    { path: "/phases/0/tasks/0/extra", code: "schema" },
    { path: "/phases/0/extra", code: "schema" },
    { path: "/extra", code: "schema" },
  ]);
});

test("reports repeated Task ids and Phase ids at their repeated definitions", () => {
  expect(parsePlan(fixture("invalid-duplicate-id.yaml"))).toEqual({
    valid: false,
    errors: [
      {
        path: "/phases/0/tasks/1/id",
        line: 12,
        column: 13,
        code: "duplicate-id",
        message: expect.any(String),
      },
      {
        path: "/phases/1/id",
        line: 16,
        column: 9,
        code: "duplicate-id",
        message: expect.any(String),
      },
    ],
  });
});

test("rejects an unknown dependency at its source value", () => {
  expect(parsePlan(fixture("invalid-unknown-dependency.yaml"))).toEqual({
    valid: false,
    errors: [
      {
        path: "/phases/0/tasks/0/dependsOn/0",
        line: 12,
        column: 21,
        code: "unknown-dependency",
        message: expect.any(String),
      },
    ],
  });
});

test("distinguishes a dependency on a Task in another Phase", () => {
  expect(parsePlan(fixture("invalid-cross-phase-dependency.yaml"))).toEqual({
    valid: false,
    errors: [
      {
        path: "/phases/0/tasks/0/dependsOn/0",
        line: 12,
        column: 21,
        code: "cross-phase-dependency",
        message: expect.any(String),
      },
    ],
  });
});

test("rejects duplicate risk flags and dependency entries as schema errors", () => {
  const source = example
    .replace("flags: [migration]", "flags: [migration, migration]")
    .replace(
      "dependsOn: [index-notes]",
      "dependsOn: [index-notes, index-notes]",
    );
  const result = parsePlan(source);
  expect(result.valid).toBe(false);
  if (result.valid) throw new Error("Expected uniqueness errors");
  expect(result.errors.map(({ path, code }) => ({ path, code }))).toEqual([
    { path: "/phases/0/tasks/0/risk/flags/1", code: "schema" },
    { path: "/phases/0/tasks/1/dependsOn/1", code: "schema" },
  ]);
});

test("reports separate cyclic groups, including self-dependencies", () => {
  expect(parsePlan(fixture("invalid-dependency-cycle.yaml"))).toEqual({
    valid: false,
    errors: [
      {
        path: "/phases/0/tasks/0/dependsOn/0",
        line: 12,
        column: 21,
        code: "dependency-cycle",
        message: "Dependency cycle among Tasks: first, second.",
      },
      {
        path: "/phases/0/tasks/2/dependsOn/0",
        line: 22,
        column: 21,
        code: "dependency-cycle",
        message: "Dependency cycle among Tasks: self.",
      },
    ],
  });
});

test("rejects authored Docs ids and dependencies on Docs Tasks", () => {
  expect(parsePlan(fixture("invalid-reserved-id.yaml"))).toEqual({
    valid: false,
    errors: [
      {
        path: "/phases/0/tasks/0/id",
        line: 8,
        column: 13,
        code: "reserved-id",
        message: expect.any(String),
      },
      {
        path: "/phases/0/tasks/1/dependsOn/0",
        line: 16,
        column: 21,
        code: "reserved-id",
        message: expect.any(String),
      },
    ],
  });
});

test("rejects a generated Task at its marker", () => {
  expect(parsePlan(fixture("invalid-generated-task.yaml"))).toEqual({
    valid: false,
    errors: [
      {
        path: "/phases/0/tasks/0/generated",
        line: 12,
        column: 20,
        code: "generated-task",
        message: expect.any(String),
      },
    ],
  });
});

test("reports unresolved YAML aliases as validation errors rather than throwing", () => {
  expect(parsePlan("title: *missing\nsummary: *also-missing\n")).toEqual({
    valid: false,
    errors: [
      {
        path: "",
        line: 1,
        column: 8,
        code: "yaml-syntax",
        message: expect.any(String),
      },
      {
        path: "",
        line: 2,
        column: 10,
        code: "yaml-syntax",
        message: expect.any(String),
      },
    ],
  });
});

test("keeps a cycle's source index when a preceding dependency has the wrong type", () => {
  const source = fixture("invalid-unknown-dependency.yaml")
    .replace("id: implement", "id: self")
    .replace("[missing]", "[42, self]");
  expect(parsePlan(source)).toEqual({
    valid: false,
    errors: [
      {
        path: "/phases/0/tasks/0/dependsOn/0",
        line: 12,
        column: 21,
        code: "schema",
        message: expect.any(String),
      },
      {
        path: "/phases/0/tasks/0/dependsOn/1",
        line: 12,
        column: 25,
        code: "dependency-cycle",
        message: "Dependency cycle among Tasks: self.",
      },
    ],
  });
});

test("recognizes aliased generated markers in every authored Task", () => {
  const source =
    fixture("invalid-generated-task.yaml") +
    `      - id: another
        title: Another Task
        description: Make another change.
        acceptance: [The change works]
        generated: *marker
`;
  const result = parsePlan(
    source.replace("generated: true", "generated: &marker true"),
  );
  expect(result.valid).toBe(false);
  if (result.valid) throw new Error("Expected generated Tasks to be rejected");
  expect(result.errors.map(({ path, code }) => ({ path, code }))).toEqual([
    { path: "/phases/0/tasks/0/generated", code: "generated-task" },
    { path: "/phases/0/tasks/1/generated", code: "generated-task" },
  ]);
});

test.each(["1.1", "1.3"])("rejects a YAML %s directive", (version) => {
  expect(parsePlan(`%YAML ${version}\n---\n${example}`)).toEqual({
    valid: false,
    errors: [
      {
        path: "",
        line: 1,
        column: 1,
        code: "yaml-syntax",
        message: expect.any(String),
      },
    ],
  });
});

test("rejects an unresolved custom YAML tag", () => {
  expect(
    parsePlan(
      example.replace(
        "title: Search saved notes",
        "title: !custom Search saved notes",
      ),
    ),
  ).toEqual({
    valid: false,
    errors: [
      {
        path: "",
        line: 2,
        column: 8,
        code: "yaml-syntax",
        message: expect.any(String),
      },
    ],
  });
});

test("ordinary aliases have no extra authored-context count limit", () => {
  const source = example
    .replace("title: Search saved notes", "title: &text Search saved notes")
    .replace("- src/notes/**", `[${Array(101).fill("*text").join(", ")}]`);
  const result = parsePlan(source);
  expect(result.valid).toBe(true);
  if (!result.valid) throw new Error("Expected an aliased Plan");
  expect(result.plan.phases[0]?.tasks[0]?.context).toHaveLength(101);
  expect(result.plan.phases[0]?.tasks[0]?.context?.[100]).toBe(
    "Search saved notes",
  );
});
