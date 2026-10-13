import { readdirSync, readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, test } from "vitest";
import { parseDocument } from "yaml";

const examples = new URL("../../../examples/", import.meta.url);
const crossReferenceFixtures = [
  "invalid-duplicate-id.yaml",
  "invalid-unknown-dependency.yaml",
  "invalid-cross-phase-dependency.yaml",
  "invalid-dependency-cycle.yaml",
  "invalid-reserved-id.yaml",
];

test.each([
  "two-phase.yaml",
  ...readdirSync(examples).filter(
    (name) => name.startsWith("invalid-") && name.endsWith(".yaml"),
  ),
  ...readdirSync(new URL("fragments/", examples)).map(
    (name) => `fragments/${name}`,
  ),
])(
  "committed JSON Schema has the specified structural result for %s",
  (name) => {
    const schema = JSON.parse(
      readFileSync(
        new URL("../../../schemas/plan-file.v1.json", import.meta.url),
        "utf8",
      ),
    );
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(
      schema,
    );
    const document = parseDocument(
      readFileSync(new URL(name, examples), "utf8"),
    );
    const accepted = document.errors.length === 0 && validate(document.toJS());
    expect(accepted).toBe(
      name === "two-phase.yaml" || crossReferenceFixtures.includes(name),
    );
  },
);
