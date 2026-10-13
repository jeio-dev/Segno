import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AppSettings,
  appSettingsSchema,
  HostError,
  type ResolvedSettings,
} from "@segno/core";
import type { HostLog } from "./log.js";
import { writeAtomic } from "./projects.js";

const defaults = {
  notifications: true,
  theme: "system",
  launchAtLogin: false,
} as const;

/** settings.json: app settings, written only through the app [ADR-0038]. */
export function openSettings(appData: string, log: HostLog) {
  const path = join(appData, "settings.json");
  let stored: AppSettings = {};

  return {
    async load() {
      if (!existsSync(path)) return;
      try {
        stored = appSettingsSchema.parse(
          JSON.parse(await readFile(path, "utf8")),
        );
      } catch (error) {
        log.write("warn", "settings.json is invalid; using defaults.", {
          error,
        });
      }
    },
    get(): ResolvedSettings {
      return { ...defaults, ...stored };
    },
    async set(changes: Record<string, unknown>) {
      const next: Record<string, unknown> = { ...stored };
      for (const [key, value] of Object.entries(changes)) {
        if (value === null) delete next[key];
        else next[key] = value;
      }
      const parsed = appSettingsSchema.safeParse(next);
      if (!parsed.success)
        throw new HostError(
          "bad-request",
          parsed.error.issues
            .map(
              (issue) =>
                `${issue.path.join(".") || "settings"}: ${issue.message}`,
            )
            .join("; "),
        );
      await writeAtomic(path, `${JSON.stringify(parsed.data, null, 2)}\n`);
      stored = parsed.data;
    },
  };
}
