// One execution authority per effort. An effort runs on legacy launchers until
// it opts into v2; from then on every PR its roster owns is fenced from legacy
// Advance, dispatch, repair, and agent runs. The owned set is kept here so each
// fence reads it synchronously, and it is rewritten with the mode in one
// transaction, so an effort is never on v2 with its PRs unfenced.
import type { RunDb } from "./runstore.js";
import { prWorkItemKey } from "./work-item-index.js";

/** Append-only: server.ts adds these after pr_facts (ids 39-41). */
export const EFFORT_EXECUTION_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS effort_execution (effort_id TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK (mode IN ('legacy','v2')), revision INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS effort_v2_targets (target TEXT PRIMARY KEY, effort_id TEXT NOT NULL, source TEXT NOT NULL CHECK (source IN ('pr','ticket')), resolved_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS effort_v2_targets_effort ON effort_v2_targets (effort_id)`,
];

export type ExecutionMode = "legacy" | "v2";
export type Execution = { mode: ExecutionMode; revision: number };
/** A roster PR: an explicit PR member, or a PR whose ticket the effort alone owns. */
export type V2Target = { target: string; source: "pr" | "ticket" };
type WorkDb = RunDb & { transaction<T>(fn: () => T): () => T };

export function createEffortWorkStore(db: WorkDb, now = Date.now) {
  function execution(effortId: string): Execution {
    return (db.prepare(`SELECT mode, revision FROM effort_execution WHERE effort_id = ?`).get(effortId) as Execution | undefined)
      ?? { mode: "legacy", revision: 0 };
  }
  function rewrite(targetsOf: (effortId: string) => readonly V2Target[]): void {
    db.prepare(`DELETE FROM effort_v2_targets`).run();
    const insert = db.prepare(`INSERT INTO effort_v2_targets (target, effort_id, source, resolved_at) VALUES (?, ?, ?, ?)`);
    for (const { effortId } of db.prepare(`SELECT effort_id AS effortId FROM effort_execution WHERE mode = 'v2'`).all() as { effortId: string }[])
      for (const { target, source } of targetsOf(effortId)) insert.run(prWorkItemKey(target), effortId, source, now());
  }
  return {
    execution,
    /** Change one effort's mode only at the revision its caller saw, and rewrite every v2 target with it. */
    setMode(effortId: string, mode: ExecutionMode, expectedRevision: number, targetsOf: (effortId: string) => readonly V2Target[]): Execution {
      return db.transaction(() => {
        if (execution(effortId).revision !== expectedRevision) throw new Error("The effort's execution mode changed. Refresh the preview and try again.");
        db.prepare(`INSERT INTO effort_execution (effort_id, mode, revision, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(effort_id) DO UPDATE SET mode = excluded.mode, revision = excluded.revision, updated_at = excluded.updated_at`)
          .run(effortId, mode, expectedRevision + 1, now());
        rewrite(targetsOf);
        return execution(effortId);
      })();
    },
    /** After membership or board facts change: every v2 effort's roster PRs, replaced at once. */
    rewriteTargets(targetsOf: (effortId: string) => readonly V2Target[]): void {
      db.transaction(() => rewrite(targetsOf))();
    },
    /** Whether a rewrite can change anything: some effort is on v2, or targets remain from one that left. */
    active(): boolean {
      return db.prepare(`SELECT 1 FROM effort_execution WHERE mode = 'v2' UNION ALL SELECT 1 FROM effort_v2_targets LIMIT 1`).get() !== undefined;
    },
    /** The v2 effort whose roster manages this PR, if any. */
    managedBy(prUrl: string): string | null {
      return (db.prepare(`SELECT effort_id AS effortId FROM effort_v2_targets WHERE target = ?`).get(prWorkItemKey(prUrl)) as { effortId: string } | undefined)?.effortId ?? null;
    },
  };
}
