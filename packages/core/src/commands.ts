import { validationCodes } from "@segno/plan-format";
import { z } from "zod";

const nonBlank = z.string().regex(/\S/, "Must contain non-whitespace text.");
export const commandSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("plan.submit"),
    yaml: z.string(),
    sourcePath: z.string().optional(),
  }),
  z.strictObject({ type: z.literal("plan.approve"), planId: nonBlank }),
  z.strictObject({
    type: z.literal("plan.sendBack"),
    planId: nonBlank,
    notes: nonBlank,
  }),
  z.strictObject({
    type: z.literal("plan.abandon"),
    planId: nonBlank,
    reason: nonBlank,
  }),
]);
export type Command = z.infer<typeof commandSchema>;

/** Commands of a later version than v1, answered unsupported-in-version. */
export const laterCommandTypes = [
  "planning.start",
  "planning.reply",
  "planning.draftNow",
  "planning.stop",
  "planning.discard",
  "task.askPlanner",
  "task.applyPlannerAdvice",
] as const;

export const rejectionCodeSchema = z.enum([
  "validation",
  "not-found",
  "invalid-transition",
  "plan-exists",
  "reason-required",
  "notes-required",
  "unsupported-in-version",
]);
export type RejectionCode = z.infer<typeof rejectionCodeSchema>;

export const validationErrorSchema = z.strictObject({
  path: z.string(),
  line: z.number().int().min(1).optional(),
  column: z.number().int().min(1).optional(),
  code: z.enum(validationCodes),
  message: z.string(),
});

export const rejectionSchema = z.discriminatedUnion("code", [
  z.strictObject({
    ok: z.literal(false),
    code: z.literal("validation"),
    message: z.string(),
    errors: z.array(validationErrorSchema),
  }),
  z.strictObject({
    ok: z.literal(false),
    code: rejectionCodeSchema.exclude(["validation"]),
    message: z.string(),
  }),
]);
export const commandResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    events: z.array(z.number().int().min(1)),
  }),
  rejectionSchema,
]);
export type Rejection = z.infer<typeof rejectionSchema>;
export type CommandResult = z.infer<typeof commandResultSchema>;
