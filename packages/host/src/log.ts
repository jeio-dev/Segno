import { appendFileSync } from "node:fs";
import { join } from "node:path";

/** host.log: JSON lines of Engine host diagnostics. */
export function openHostLog(appData: string) {
  const path = join(appData, "host.log");
  return {
    write(level: "info" | "warn" | "error", message: string, details?: object) {
      const entry = {
        ts: new Date().toISOString(),
        level,
        message,
        ...details,
      };
      try {
        appendFileSync(path, `${JSON.stringify(entry, errorFields)}\n`);
      } catch {
        // Diagnostics must never take the host down.
      }
    },
  };
}

function errorFields(_key: string, value: unknown) {
  return value instanceof Error
    ? { name: value.name, message: value.message, stack: value.stack }
    : value;
}
export type HostLog = ReturnType<typeof openHostLog>;
