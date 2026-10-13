import type { ConfigError } from "@segno/core";

/** `line:column  code  message`, with `?` for a missing location (as the CLI prints). */
export function formatPlanError({
  line,
  column,
  code,
  message,
}: {
  line?: number | undefined;
  column?: number | undefined;
  code: string;
  message: string;
}) {
  return `${line ?? "?"}:${column ?? "?"}  ${code}  ${message}`;
}

export function formatConfigError({
  file,
  path,
  line,
  column,
  code,
  message,
}: ConfigError) {
  return `${file}:${line ?? "?"}:${column ?? "?"}  ${code}  ${message}${line === undefined && path ? ` (${path})` : ""}`;
}

/** A short age such as "just now", "5 min ago" or "3 d ago". */
export function age(iso: string, now = Date.now()) {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

export function errorMessage(error: unknown) {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    "message" in error
  )
    return `${String(error.code)}  ${String(error.message)}`;
  return error instanceof Error ? error.message : String(error);
}
