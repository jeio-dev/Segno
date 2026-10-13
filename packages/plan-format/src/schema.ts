import { z } from "zod";

const slug = z
  .string()
  .max(48)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);
const nonEmpty = z.string().regex(/\S/, "Must contain non-whitespace text.");

export const riskSchema = z.strictObject({
  flags: z
    .array(
      z.enum([
        "migration",
        "auth",
        "payments",
        "data-deletion",
        "security",
        "other",
      ]),
    )
    .min(1)
    .meta({ uniqueItems: true }),
  reason: nonEmpty,
});

export const taskSchema = z.strictObject({
  id: slug,
  title: nonEmpty,
  description: z.string(),
  acceptance: z.array(nonEmpty).min(1),
  dependsOn: z.array(z.string()).meta({ uniqueItems: true }).optional(),
  context: z.array(z.string()).optional(),
  risk: riskSchema.optional(),
});

export const phaseSchema = z.strictObject({
  id: slug,
  title: nonEmpty,
  docs: z.string().optional(),
  tasks: z.array(taskSchema).min(1),
});

export const planSchema = z.strictObject({
  schemaVersion: z.literal(1),
  title: nonEmpty,
  summary: z.string(),
  phases: z.array(phaseSchema).min(1),
});

export type Plan = z.infer<typeof planSchema>;
export type Phase = z.infer<typeof phaseSchema>;
export type Task = z.infer<typeof taskSchema>;
export type Risk = z.infer<typeof riskSchema>;
