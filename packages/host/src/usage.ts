import type { AdapterId, AgentAdapter, Usage } from "@segno/core";
import type { LimitEvent } from "@segno/engine";

/**
 * The latest subscription usage per Adapter, app-wide and in memory: usage is
 * the subscription's, not a Project's. Never estimated [ADR-0021].
 */
export function openUsage() {
  const latest = new Map<AdapterId, Usage>();
  return {
    report({ id, capabilities }: AgentAdapter, event: LimitEvent) {
      const { resetAt } = event;
      if (event.type === "usage" && capabilities.usage)
        latest.set(id, {
          used: event.used,
          ...(event.limit === undefined ? {} : { limit: event.limit }),
          ...(resetAt ? { resetAt } : {}),
        });
      // Otherwise only the last known reset time is kept.
      else if (resetAt)
        latest.set(id, {
          ...(capabilities.usage ? latest.get(id) : {}),
          resetAt,
        });
    },
    of(id: AdapterId) {
      return latest.get(id);
    },
  };
}
export type UsageStore = ReturnType<typeof openUsage>;
