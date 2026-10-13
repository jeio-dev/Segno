import { mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { planSchema } from "../packages/plan-format/dist/schema.js";

const schema = z.toJSONSchema(planSchema, { target: "draft-2020-12" });
schema.title = "Segno Plan file (version 1)";
schema.description =
  "Structural rules for authored Plan files. Segno additionally validates ids and dependency graphs. Exported generated Tasks cannot be submitted.";
mkdirSync(new URL("../schemas/", import.meta.url), { recursive: true });
writeFileSync(
  new URL("../schemas/plan-file.v1.json", import.meta.url),
  `${JSON.stringify(schema, null, 2)}\n`,
);
