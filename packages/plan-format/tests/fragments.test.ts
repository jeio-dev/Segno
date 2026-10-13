import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import type { Plan } from "../src/index.js";
import { validateFragment } from "../src/index.js";

const plan: Plan = {
  schemaVersion: 1,
  title: "Notes",
  summary: "Find saved notes.",
  phases: [
    {
      id: "index",
      title: "Index",
      tasks: [
        {
          id: "store",
          title: "Store",
          description: "Store notes.",
          acceptance: ["Notes persist"],
        },
        {
          id: "query",
          title: "Query",
          description: "Query notes.",
          acceptance: ["Notes are found"],
          dependsOn: ["store"],
        },
        {
          id: "display",
          title: "Display",
          description: "Display notes.",
          acceptance: ["Notes are shown"],
          dependsOn: ["query"],
        },
      ],
    },
    {
      id: "screen",
      title: "Screen",
      tasks: [
        {
          id: "search",
          title: "Search",
          description: "Search notes.",
          acceptance: ["Search works"],
        },
      ],
    },
  ],
};

const context = {
  kind: "replan" as const,
  plan,
  taskId: "query",
  idHistory: ["store", "query", "display", "search", "retired"],
};

test("validates a replan definition without inheriting or changing dependencies", () => {
  const before = JSON.stringify(plan);
  expect(
    validateFragment(
      `id: query
title: Query by title
description: Query note titles.
acceptance: [Titles are found]
`,
      context,
    ),
  ).toEqual({
    valid: true,
    tasks: [
      {
        id: "query",
        title: "Query by title",
        description: "Query note titles.",
        acceptance: ["Titles are found"],
      },
    ],
  });
  expect(JSON.stringify(plan)).toBe(before);
});

test("rejects a replan that changes the Task id", () => {
  expect(
    validateFragment(
      readFileSync(
        new URL(
          "../../../examples/fragments/invalid-id-mismatch.yaml",
          import.meta.url,
        ),
        "utf8",
      ),
      context,
    ),
  ).toEqual({
    valid: false,
    errors: [
      {
        path: "/id",
        line: 1,
        column: 5,
        code: "id-mismatch",
        message: expect.any(String),
      },
    ],
  });
});

test("rejects dependencies and structural errors in a replan", () => {
  expect(
    validateFragment(
      `id: query
description: Query note titles.
acceptance: []
dependsOn: []
`,
      context,
    ),
  ).toEqual({
    valid: false,
    errors: [
      {
        path: "/title",
        line: 1,
        column: 1,
        code: "schema",
        message: expect.any(String),
      },
      {
        path: "/acceptance",
        line: 3,
        column: 13,
        code: "schema",
        message: expect.any(String),
      },
      {
        path: "/dependsOn",
        line: 4,
        column: 1,
        code: "schema",
        message: expect.any(String),
      },
    ],
  });
});

const split = `- id: query-title
  title: Query titles
  description: Query titles only.
  acceptance: [Titles are found]
  dependsOn: [store]
- id: query-content
  title: Query content
  description: Query content only.
  acceptance: [Content is found]
  dependsOn: [query-title]
`;

test("validates a split with explicit existing and fragment dependencies", () => {
  const before = JSON.stringify(plan);
  expect(validateFragment(split, { ...context, kind: "split" })).toEqual({
    valid: true,
    tasks: [
      {
        id: "query-title",
        title: "Query titles",
        description: "Query titles only.",
        acceptance: ["Titles are found"],
        dependsOn: ["store"],
      },
      {
        id: "query-content",
        title: "Query content",
        description: "Query content only.",
        acceptance: ["Content is found"],
        dependsOn: ["query-title"],
      },
    ],
  });
  expect(JSON.stringify(plan)).toBe(before);
});

test.each([
  readFileSync(
    new URL(
      "../../../examples/fragments/invalid-too-few-tasks.yaml",
      import.meta.url,
    ),
    "utf8",
  ),
  `- id: replacement
  title: Replacement
  description: A single replacement.
  acceptance: [It works]
`,
])("rejects a split with fewer than two Tasks", (source) => {
  expect(validateFragment(source, { ...context, kind: "split" })).toEqual({
    valid: false,
    errors: [
      {
        path: "",
        line: 1,
        column: 1,
        code: "too-few-tasks",
        message: expect.any(String),
      },
    ],
  });
});

test("rejects a split id used by a superseded Task in the Plan's history", () => {
  expect(
    validateFragment(
      readFileSync(
        new URL(
          "../../../examples/fragments/invalid-id-reused.yaml",
          import.meta.url,
        ),
        "utf8",
      ),
      {
        ...context,
        kind: "split",
      },
    ),
  ).toEqual({
    valid: false,
    errors: [
      {
        path: "/0/id",
        line: 1,
        column: 7,
        code: "id-reused",
        message: expect.any(String),
      },
    ],
  });
});

test("rejects duplicate ids within a split fragment", () => {
  expect(
    validateFragment(
      `- id: replacement
  title: First
  description: First change.
  acceptance: [First works]
- id: replacement
  title: Second
  description: Second change.
  acceptance: [Second works]
`,
      { ...context, kind: "split" },
    ),
  ).toEqual({
    valid: false,
    errors: [
      {
        path: "/1/id",
        line: 5,
        column: 7,
        code: "duplicate-id",
        message: expect.any(String),
      },
    ],
  });
});

test("rejects split dependencies on unknown or newly superseded Tasks", () => {
  for (const dependency of ["missing", "query"]) {
    expect(
      validateFragment(split.replace("[store]", `[${dependency}]`), {
        ...context,
        kind: "split",
      }),
    ).toEqual({
      valid: false,
      errors: [
        {
          path: "/0/dependsOn/0",
          line: 5,
          column: 15,
          code: "unknown-dependency",
          message: expect.any(String),
        },
      ],
    });
  }
});

test("rejects a split dependency on a Task in another Phase", () => {
  expect(
    validateFragment(split.replace("[store]", "[search]"), {
      ...context,
      kind: "split",
    }),
  ).toEqual({
    valid: false,
    errors: [
      {
        path: "/0/dependsOn/0",
        line: 5,
        column: 15,
        code: "cross-phase-dependency",
        message: expect.any(String),
      },
    ],
  });
});

test("rejects reserved Docs ids and dependencies in a split", () => {
  expect(
    validateFragment(
      split
        .replace("id: query-title", "id: index-docs")
        .replace("[store]", "[screen-docs]")
        .replace("[query-title]", "[index-docs]"),
      { ...context, kind: "split" },
    ),
  ).toEqual({
    valid: false,
    errors: [
      {
        path: "/0/id",
        line: 1,
        column: 7,
        code: "reserved-id",
        message: expect.any(String),
      },
      {
        path: "/0/dependsOn/0",
        line: 5,
        column: 15,
        code: "reserved-id",
        message: expect.any(String),
      },
      {
        path: "/1/dependsOn/0",
        line: 10,
        column: 15,
        code: "reserved-id",
        message: expect.any(String),
      },
    ],
  });
});

test("rejects a split cycle introduced by rewiring the original Task's dependents", () => {
  expect(
    validateFragment(split.replace("[store]", "[display]"), {
      ...context,
      kind: "split",
    }),
  ).toEqual({
    valid: false,
    errors: [
      {
        path: "/0/dependsOn/0",
        line: 5,
        column: 15,
        code: "dependency-cycle",
        message:
          "Dependency cycle among Tasks: query-title, query-content, display.",
      },
    ],
  });
});

test("uses the same array-uniqueness rules in fragments", () => {
  const result = validateFragment(split.replace("[store]", "[store, store]"), {
    ...context,
    kind: "split",
  });
  expect(result).toEqual({
    valid: false,
    errors: [
      {
        path: "/0/dependsOn/1",
        line: 5,
        column: 22,
        code: "schema",
        message: expect.any(String),
      },
    ],
  });
});
