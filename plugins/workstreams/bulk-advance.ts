// Legacy Advance's saved batches. Nothing starts or rechecks a job any more: the
// batches are history that thread links, All PRs, and every writer's fence read,
// in the shape the removed engine wrote them.
import { z } from "zod";
import { approvalFeedbackSchema } from "./approval-feedback.js";
import { canonicalPrUrl } from "./pr-holds.js";
import type { RunDb } from "./runstore.js";

export const advancePreviewJobSchema = z.object({
  prUrl: z.string(), repo: z.string(), number: z.number(), title: z.string(), headOid: z.string(),
  baseOid: z.string().optional(),
  baseRefName: z.string(), headRefName: z.string(), needsPreparation: z.boolean(), needsFeedback: z.boolean().default(false), needsChecks: z.boolean().default(false), eligible: z.boolean(),
  approvalFeedback: approvalFeedbackSchema.optional(),
  detail: z.string(), workspace: z.enum(["existing", "create", "unavailable"]),
});
const advanceAttemptSchema = z.object({ attemptId: z.string(), threadId: z.string().nullable(), path: z.string().nullable(), detail: z.string(), status: z.string(), updatedAt: z.number() });
export const advanceJobSchema = advancePreviewJobSchema.extend({
  id: z.string(), hiddenFromProgress: z.boolean().default(false), status: z.enum(["queued", "launching", "running", "verifying", "ready", "waiting-checks", "waiting-review", "needs-attention", "cancelled", "merged", "closed"]),
  attemptId: z.string().nullable().default(null), dedicated: z.boolean().default(false), previousAttempts: z.array(advanceAttemptSchema).max(5).default([]),
  threadId: z.string().nullable(), path: z.string().nullable(), checkedHeadOid: z.string().nullable(), checkedBaseOid: z.string().nullable().optional(), updatedAt: z.number(), uncertain: z.boolean().default(false),
});
export const advanceBatchSchema = z.object({ id: z.string(), createdAt: z.number(), cancelled: z.boolean(), instruction: z.string().max(4_000).optional(), jobs: z.array(advanceJobSchema) });
export type AdvanceJob = z.infer<typeof advanceJobSchema>;
export type AdvanceBatch = z.infer<typeof advanceBatchSchema>;
/** The saved form also kept each job's routing facts; only the scanned checkout path each was routed from still matters, to the fence. */
const savedSchema = advanceBatchSchema.extend({ facts: z.record(z.string(), z.object({ path: z.string().nullable() })).default({}) });
export const ADVANCE_MIGRATIONS = ["CREATE TABLE IF NOT EXISTS advance_batches (id TEXT PRIMARY KEY, body TEXT NOT NULL)"];
const ACTIVE = new Set<AdvanceJob["status"]>(["queued", "launching", "running", "verifying"]);

/** The saved batches, read once when the plugin loads, newest first. */
export function createAdvanceHistory(db: RunDb) {
  const saved = (db.prepare("SELECT body FROM advance_batches").all() as { body: string }[])
    .map(({ body }) => savedSchema.parse(JSON.parse(body))).sort((a, b) => b.createdAt - a.createdAt);
  const batches = saved.map(({ facts: _facts, ...batch }): AdvanceBatch => batch);
  return {
    list: (): AdvanceBatch[] => [...batches],
    /** A job that never settled (queued, launching, running, verifying, or uncertain) still holds its PR and checkouts. */
    reserved(prUrl: string, path: string | null): boolean {
      const key = canonicalPrUrl(prUrl) ?? prUrl.toLowerCase();
      return saved.some((batch) => batch.jobs.some((job) => (ACTIVE.has(job.status) || job.uncertain) &&
        ((canonicalPrUrl(job.prUrl) ?? job.prUrl.toLowerCase()) === key ||
          (path !== null && (batch.facts[job.id]?.path === path || job.path === path)))));
    },
  };
}
