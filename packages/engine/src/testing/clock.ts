import type { Clock } from "../engine.js";

/** A clock that moves only when told to, firing the timers that fall due. */
export function fakeClock(start = "2026-10-13T20:00:00.000Z") {
  let now = new Date(start).getTime();
  let nextId = 0;
  const timers = new Map<number, { at: number; fire: () => void }>();
  return {
    now: () => new Date(now),
    setTimer(at: Date, fire: () => void) {
      const id = nextId++;
      timers.set(id, { at: at.getTime(), fire });
      return () => {
        timers.delete(id);
      };
    },
    /** Moves time forward by `ms`, firing each due timer in time order. */
    advance(ms: number) {
      now += ms;
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= now)
        .sort(([, a], [, b]) => a.at - b.at);
      for (const [id, timer] of due) {
        timers.delete(id);
        timer.fire();
      }
    },
    /** How many timers are waiting to fire. */
    get pending() {
      return timers.size;
    },
  } satisfies Clock & Record<string, unknown>;
}
export type FakeClock = ReturnType<typeof fakeClock>;
