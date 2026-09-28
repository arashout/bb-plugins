// Roster numbers authorize work ("move 3 forward"), so a number must never point
// at a different PR. Numbers are permanent per effort: reordering keeps them, and
// a PR that leaves or merges keeps its number reserved. A snapshot records the
// numbered set a user saw, so ranges and `all` expand against exactly that set.
import { createHash } from "node:crypto";
import { z } from "zod";
import type { EffortStore } from "./effort-store.js";
import { canonicalPrUrl } from "./pr-holds.js";
import type { RunDb } from "./runstore.js";

/** Append-only: server.ts adds these after effort_admin_sync (ids 35-37). */
export const EFFORT_ROSTER_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS effort_roster_numbers (effort_id TEXT NOT NULL, ordinal INTEGER NOT NULL, target TEXT NOT NULL, assigned_at INTEGER NOT NULL, PRIMARY KEY (effort_id, ordinal), UNIQUE (effort_id, target))`,
  `CREATE TABLE IF NOT EXISTS effort_roster_snapshots (id TEXT PRIMARY KEY, effort_id TEXT NOT NULL, created_at INTEGER NOT NULL, body TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS effort_roster_snapshots_effort ON effort_roster_snapshots (effort_id, created_at)`,
];

const snapshotBodySchema = z.object({
  rows: z.array(z.object({ n: z.number().int().positive(), target: z.string() }).strict()),
}).strict();
export type RosterNumber = { n: number; target: string; provisional: boolean };
export type RosterSnapshot = z.infer<typeof snapshotBodySchema> & { id: string; effortId: string; createdAt: number; stale: boolean };
type RosterDb = RunDb & { transaction<T>(fn: () => T): () => T };

export function createEffortRosterStore(db: RosterDb, efforts: Pick<EffortStore, "get">, now = Date.now) {
  function resolve(effortId: string): string {
    const effort = efforts.get(effortId);
    if (!effort) throw new Error("The effort no longer exists. Refresh the roster.");
    return effort.id;
  }
  function target(value: string): string {
    const key = canonicalPrUrl(value);
    if (key === null) throw new Error("Roster targets must be GitHub PR URLs.");
    return key;
  }
  /** Existing numbers, then provisional numbers after the highest ever assigned. */
  function read(effortId: string, targets: readonly string[]): RosterNumber[] {
    // A read-only copy of a database from before roster numbering has no numbers yet.
    const numbered = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'effort_roster_numbers'`).get() !== undefined;
    const known = new Map((numbered ? db.prepare(`SELECT target, ordinal FROM effort_roster_numbers WHERE effort_id = ?`).all(effortId) as { target: string; ordinal: number }[] : [])
      .map((row) => [row.target, row.ordinal]));
    let highest = [...known.values()].reduce((max, n) => Math.max(max, n), 0);
    return [...new Set(targets.map(target))].map((key) => {
      const n = known.get(key);
      return n === undefined ? { n: ++highest, target: key, provisional: true } : { n, target: key, provisional: false };
    });
  }
  return {
    /**
     * Number the targets a roster shows, in their display order. A merged effort
     * resolves to its destination's numbering. `assign: false` writes nothing, so a
     * read-only copy can preview; its provisional numbers carry no snapshot.
     */
    numbers(effortId: string, targets: readonly string[], options: { assign: boolean }): { effortId: string; rows: RosterNumber[]; snapshotId: string | null } {
      const id = resolve(effortId);
      if (!options.assign) return { effortId: id, rows: read(id, targets), snapshotId: null };
      return db.transaction(() => {
        const rows = read(id, targets).map((row) => {
          if (row.provisional) db.prepare(`INSERT INTO effort_roster_numbers (effort_id, ordinal, target, assigned_at) VALUES (?, ?, ?, ?)`)
            .run(id, row.n, row.target, now());
          return { ...row, provisional: false };
        });
        const body = snapshotBodySchema.parse({ rows: rows.map(({ n, target }) => ({ n, target })).sort((a, b) => a.n - b.n) });
        const snapshotId = `S-${createHash("sha256").update(JSON.stringify([id, body.rows])).digest("hex").slice(0, 12)}`;
        const latest = db.prepare(`SELECT id, created_at AS createdAt FROM effort_roster_snapshots WHERE effort_id = ? ORDER BY created_at DESC LIMIT 1`)
          .get(id) as { id: string; createdAt: number } | undefined;
        // State and head changes keep the set, so they never write; a set seen before becomes the latest again.
        if (latest?.id !== snapshotId) db.prepare(`INSERT INTO effort_roster_snapshots (id, effort_id, created_at, body) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET created_at = excluded.created_at`)
          .run(snapshotId, id, Math.max(now(), (latest?.createdAt ?? 0) + 1), JSON.stringify(body));
        return { effortId: id, rows, snapshotId };
      })();
    },
    /** A snapshot of a merged or missing effort is stale: its numbers no longer authorize anything. */
    snapshot(id: string): RosterSnapshot | null {
      const row = db.prepare(`SELECT effort_id AS effortId, created_at AS createdAt, body FROM effort_roster_snapshots WHERE id = ?`)
        .get(id) as { effortId: string; createdAt: number; body: string } | undefined;
      if (!row) return null;
      return { id, effortId: row.effortId, createdAt: row.createdAt, ...snapshotBodySchema.parse(JSON.parse(row.body)),
        stale: efforts.get(row.effortId)?.id !== row.effortId };
    },
  };
}
