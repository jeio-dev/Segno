export const validationCodes = [
  "yaml-syntax",
  "schema-version",
  "schema",
  "duplicate-id",
  "unknown-dependency",
  "cross-phase-dependency",
  "dependency-cycle",
  "reserved-id",
  "generated-task",
  "id-mismatch",
  "too-few-tasks",
  "id-reused",
] as const;
export type ValidationCode = (typeof validationCodes)[number];

export interface ValidationError {
  path: string;
  line?: number;
  column?: number;
  code: ValidationCode;
  message: string;
}

export type ValidationResult<T> =
  | { valid: true; plan: T }
  | { valid: false; errors: ValidationError[] };
