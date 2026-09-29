// Classification changes membership only on your click, or through a standing
// rule you added. Each change is one action: a row per PR or ticket it gave an
// effort, which is both the audit trail and what Undo reverses. Undo releases
// exactly what the action added, and only while that effort still owns all of it.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { EffortStore, EstablishedEffort } from "./effort-store.js";
import type { RunDb } from "./runstore.js";

/** The source key of the one effort for standalone PRs, created the first time you mark a PR one-off. */
export const ONE_OFFS_SOURCE = "one-offs";
export const ONE_OFFS = { name: "One-offs", goal: "Standalone PRs that belong to no larger outcome." };
/** Append-only: server.ts adds these after effort piles (ids 59-60). */
export const EFFORT_ASSIGNMENT_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS effort_assignments (seq INTEGER PRIMARY KEY AUTOINCREMENT, action_id TEXT NOT NULL, at INTEGER NOT NULL, source TEXT NOT NULL, effort_id TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL, rule_id TEXT, undone_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS effort_assignments_action ON effort_assignments (action_id)`,
];
export type AssignmentSource = "assign" | "new-effort" | "one-off" | "rule";

const failure = z.object({ ok: z.literal(false), error: z.string() });
const prUrls = z.array(z.string().max(500)).min(1).max(100);
export const classifyActionResultSchema = z.discriminatedUnion("ok", [failure, z.object({ ok: z.literal(true), actionId: z.string(),
  effort: z.object({ id: z.string(), key: z.string(), name: z.string() }).strict(),
  /** PRs the action put in the effort; tickets it added don't count. */
  added: z.number() }).strict()]);
export const classifyContract = {
  /** Put open PRs of yours that no effort owns into One-offs, which the first use creates. */
  classify_one_off: { input: z.object({ prUrls }).strict(), output: classifyActionResultSchema },
  /** Reverse one classification action while its effort still owns everything the action added. */
  classify_undo: { input: z.object({ actionId: z.string().uuid() }).strict(), output: z.discriminatedUnion("ok", [failure, z.object({ ok: z.literal(true) }).strict()]) },
};

type Db = RunDb & { transaction<T>(fn: () => T): () => T };
type Row = { effortId: string; source: AssignmentSource; kind: "prUrl" | "ticket"; ref: string };

export function createAssignmentStore(db: Db, efforts: EffortStore, now = Date.now) {
  return {
    /** Claim unowned PRs and tickets for one effort as one action, or nothing when another effort owns any of them. */
    assign(input: { effortId: string; source: AssignmentSource; prUrls: readonly string[]; tickets?: readonly string[]; ruleId?: string }):
      { actionId: string; effort: EstablishedEffort; added: number } {
      return db.transaction(() => {
        const result = efforts.claimUnowned(input.effortId, { tickets: [...input.tickets ?? []], prUrls: [...input.prUrls] });
        if (result.conflict) throw new Error("Another effort owns some of this work now. Refresh and try again.");
        const actionId = randomUUID();
        const insert = db.prepare(`INSERT INTO effort_assignments (action_id, at, source, effort_id, kind, ref, rule_id) VALUES (?, ?, ?, ?, ?, ?, ?)`);
        for (const [kind, refs] of [["prUrl", result.claimed.prUrls], ["ticket", result.claimed.tickets]] as const)
          for (const ref of refs) insert.run(actionId, now(), input.source, result.effort.id, kind, ref, input.ruleId ?? null);
        return { actionId, effort: result.effort, added: result.claimed.prUrls.length };
      })();
    },
    /** Returns the effort the action added to and how, so the caller can finish a new effort's undo. */
    undo(actionId: string): { effortId: string; source: AssignmentSource } {
      return db.transaction(() => {
        const rows = db.prepare(`SELECT effort_id AS effortId, source, kind, ref FROM effort_assignments WHERE action_id = ? AND undone_at IS NULL`).all(actionId) as Row[];
        if (rows.length === 0) throw new Error("Nothing to undo.");
        const { effortId, source } = rows[0]!;
        if (rows.some((row) => efforts.owner(row.kind, row.ref)?.id !== effortId)) throw new Error("This work moved since, so Undo no longer applies.");
        efforts.release(effortId, { tickets: rows.flatMap((row) => row.kind === "ticket" ? [row.ref] : []), prUrls: rows.flatMap((row) => row.kind === "prUrl" ? [row.ref] : []) });
        db.prepare(`UPDATE effort_assignments SET undone_at = ? WHERE action_id = ?`).run(now(), actionId);
        return { effortId, source };
      })();
    },
  };
}
