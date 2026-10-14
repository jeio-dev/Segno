import type { CommandResult } from "@segno/core";
import { formatConfigError, formatPlanError } from "../format.js";

type PlanErrors = Extract<CommandResult, { code: "validation" }>["errors"];

export function RejectionNotice({
  message,
  errors,
}: {
  message: string;
  errors?: PlanErrors | undefined;
}) {
  return (
    <div className="notice notice-start" role="alert">
      <p>
        <span className="badge badge-bad">rejected</span>
        {message}
      </p>
      {errors && errors.length > 0 && (
        <ul className="error-list">
          {errors.map((error) => (
            <li key={`${error.path}${error.code}${error.line}`}>
              {"file" in error
                ? formatConfigError(error)
                : formatPlanError(error)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
