import { z } from "zod";
import type { JSONSchema } from "./adapter.js";

const text = z.string().min(1);

/** The Reviewer's structured output (runners.md § Verdict schema) [ADR-0016]. */
export const verdictSchema = z.strictObject({
  schemaVersion: z.literal(1),
  decision: z.enum(["approve", "reject"]),
  summary: text,
  acceptance: z.array(
    z.strictObject({
      index: z.number().int().min(0),
      met: z.boolean(),
      note: z.string(),
    }),
  ),
  docs: z.strictObject({
    needed: z.boolean(),
    satisfied: z.boolean(),
    note: z.string(),
  }),
  findings: z.array(
    z.strictObject({
      severity: z.enum(["blocking", "advisory"]),
      file: z.string().optional(),
      line: z.number().int().min(1).optional(),
      body: text,
    }),
  ),
  risk: z
    .array(
      z.strictObject({
        flag: z.enum([
          "migration",
          "auth",
          "payments",
          "data-deletion",
          "security",
          "other",
        ]),
        reason: text,
      }),
    )
    .optional(),
});
export type Verdict = z.infer<typeof verdictSchema>;

/** The Verdict schema as the Reviewer's `outputSchema`. */
export const verdictJsonSchema: JSONSchema = z.toJSONSchema(verdictSchema);
