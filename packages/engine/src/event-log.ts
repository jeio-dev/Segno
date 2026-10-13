import { type Event, type EventType, eventVersions } from "@segno/core";
import Database from "better-sqlite3";

interface Row {
  seq: number;
  type: string;
  v: number;
  ts: string;
  payload: string;
}

/** Private persistence port: only the Engine decides what to append. */
export function openEventLog(path: string) {
  const db = new Database(path);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY CHECK (seq >= 1),
        type TEXT NOT NULL,
        v INTEGER NOT NULL CHECK (v >= 1),
        ts TEXT NOT NULL,
        plan_id TEXT,
        task_id TEXT,
        payload TEXT NOT NULL
      );
    `);
  } catch (error) {
    db.close();
    throw error;
  }
  const read = db.prepare<[number], Row>(
    "SELECT seq, type, v, ts, payload FROM events WHERE seq > ? ORDER BY seq",
  );
  const insert = db.prepare(
    "INSERT INTO events (seq, type, v, ts, plan_id, task_id, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  return {
    readEvents(since = 0): Event[] {
      return read.all(since).map((row) => {
        if (
          !Object.hasOwn(eventVersions, row.type) ||
          eventVersions[row.type as EventType] !== row.v
        ) {
          throw new Error(
            `Unknown Event type ${row.type} v${row.v} at seq ${row.seq}.`,
          );
        }
        return {
          seq: row.seq,
          type: row.type,
          v: row.v,
          ts: row.ts,
          payload: JSON.parse(row.payload),
        };
      }) as Event[];
    },
    append(event: Extract<Event, { type: `plan.${string}` }>) {
      db.transaction(() => {
        insert.run(
          event.seq,
          event.type,
          event.v,
          event.ts,
          event.payload.planId,
          null,
          JSON.stringify(event.payload),
        );
      })();
    },
    close() {
      db.close();
    },
  };
}
