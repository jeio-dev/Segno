import { z } from "zod";
import type { JSONSchema } from "./adapter.js";
import type { SegnoConfig } from "./config.js";

const text = z.string().min(1);
const minutes = z.number().int().min(1).max(1440);

const check = z.strictObject({
  command: text,
  purpose: z.enum(["setup", "tests", "typecheck", "build", "lint"]),
  exitCode: z.number().int(),
  durationSec: z.number().min(0),
  failing: z.array(z.string()).optional(),
});
const flag = z.enum(["no-checks", "fails-on-base"]);

/** The onboarding Run's structured output (runners.md § Onboarding proposal) [ADR-0049]. */
export const onboardingOutputSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("proposal"),
    config: z.strictObject({
      tests: z.strictObject({ command: text, timeoutMin: minutes.optional() }),
      setup: z.strictObject({ command: text }).optional(),
      baseBranch: text,
      remote: text.optional(),
      coderAllow: z.array(z.string()).optional(),
    }),
    reasons: z.record(z.string(), z.string()),
    checks: z.array(check),
    flags: z.array(flag).optional(),
  }),
  z.strictObject({ kind: z.literal("unable"), explanation: text }),
]);
export type OnboardingOutput = z.infer<typeof onboardingOutputSchema>;

/**
 * The schema the CLI enforces. A tool's input must be one object, so both
 * kinds share it; the Engine then validates against the strict union.
 */
export const onboardingOutputJsonSchema: JSONSchema = z.toJSONSchema(
  z.strictObject({
    kind: z.enum(["proposal", "unable"]),
    config: onboardingOutputSchema.options[0].shape.config.optional(),
    reasons: z.record(z.string(), z.string()).optional(),
    checks: z.array(check).optional(),
    flags: z.array(flag).optional(),
    explanation: text.optional(),
  }),
);

/**
 * A proposal as the Engine records it: the agent's values made into a whole
 * `segno.config.json`, with the pending models and the ref the checks ran on.
 */
export interface OnboardingProposal {
  config: SegnoConfig;
  /** One-line reasons, keyed by JSON pointer into `config`. */
  reasons: Record<string, string>;
  checks: z.infer<typeof check>[];
  flags?: z.infer<typeof flag>[];
  /** The remote-tracking ref the scratch worktree was detached at. */
  ref: string;
  sha: string;
}

export type OnboardingFailureReason =
  | "unable"
  | "invalid-proposal"
  | "crashed"
  | "timeout"
  | "hung";
