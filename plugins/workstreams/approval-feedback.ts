import { z } from "zod";
import type { RunDb } from "./runstore.js";
import { canonicalPrUrl } from "./pr-holds.js";

export const approvalFeedbackSchema = z.object({
  status: z.enum(["none", "present", "unknown"]),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/u).nullable(),
  sourceIds: z.array(z.string().min(1).max(300)).max(300),
}).strict().superRefine((snapshot, ctx) => {
  if (snapshot.status === "present" ? snapshot.fingerprint === null || snapshot.sourceIds.length === 0 : snapshot.fingerprint !== null || snapshot.sourceIds.length > 0) {
    ctx.addIssue({ code: "custom", message: "Feedback identity must match its status" });
  }
});
export type ApprovalFeedbackSnapshot = z.infer<typeof approvalFeedbackSchema>;

const sha = z.string().regex(/^[0-9a-f]{40}$/u);
const fingerprint = z.string().regex(/^[0-9a-f]{64}$/u);
const sourceId = z.string().min(1).max(300);
const findingSchema = z.object({
  sourceId,
  resolution: z.enum(["fixed", "already-satisfied", "no-change-needed"]),
  evidence: z.string().trim().min(10).max(1_500),
  validation: z.object({
    outcome: z.enum(["passed", "not-needed", "failed", "blocked"]),
    detail: z.string().trim().min(3).max(800),
  }).strict(),
}).strict();
const reportSchema = z.object({
  attemptId: z.string().min(1).max(100),
  headOid: sha,
  fingerprint,
  findings: z.array(findingSchema).min(1).max(300),
  blockers: z.array(z.string().max(500)).max(20),
}).strict();
export const approvalFeedbackProvenanceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("worker") }).strict(),
  z.object({ kind: z.literal("legacy-reconciliation"), auditThreadId: z.string().trim().min(1).max(200),
    evidenceRefs: z.array(z.string().trim().min(1).max(500)).min(1).max(100) }).strict(),
]);
export type ApprovalFeedbackProvenance = z.infer<typeof approvalFeedbackProvenanceSchema>;
const recordSchema = reportSchema.extend({
  prUrl: z.string().max(500),
  threadId: z.string().min(1).max(200),
  verifiedAt: z.number().int().nonnegative(),
  // Older worker records predate explicit provenance; only audited recovery uses the legacy variant.
  provenance: approvalFeedbackProvenanceSchema.default({ kind: "worker" }),
  equivalence: z.object({ sourceHeadOid: sha, sourceVerifiedAt: z.number().int().nonnegative(),
    treeOid: sha, checkedAt: z.number().int().nonnegative() }).strict().optional(),
});

// Callers may still construct pre-provenance records; parsing supplies the worker default.
export type ApprovalFeedbackRecord = z.input<typeof recordSchema>;
export const APPROVAL_FEEDBACK_MIGRATION =
  "CREATE TABLE IF NOT EXISTS approval_feedback_verifications (pr_url TEXT PRIMARY KEY, body TEXT NOT NULL)";
export const FEEDBACK_REPORT_PREFIX = "Workstreams approval feedback evidence: ";

/** A worker's final report is evidence to check, never a clearance by itself. */
export function parseFeedbackReport(output: string, attemptId: string, snapshot: ApprovalFeedbackSnapshot, headOid: string): z.infer<typeof reportSchema> | null {
  if (snapshot.status !== "present" || snapshot.fingerprint === null || !sha.safeParse(headOid).success) return null;
  const lines = output.split(/\r?\n/u).filter((line) => line.startsWith(FEEDBACK_REPORT_PREFIX));
  if (lines.length !== 1 || lines[0]!.length > 50_000) return null;
  let raw: unknown;
  try { raw = JSON.parse(lines[0]!.slice(FEEDBACK_REPORT_PREFIX.length)); } catch { return null; }
  const parsed = reportSchema.safeParse(raw);
  if (!parsed.success) return null;
  const report = parsed.data;
  if (report.attemptId !== attemptId || report.headOid !== headOid || report.fingerprint !== snapshot.fingerprint || report.blockers.length > 0 ||
      report.findings.some((finding) => finding.validation.outcome === "failed" || finding.validation.outcome === "blocked")) return null;
  const expected = [...new Set(snapshot.sourceIds)].sort();
  const actual = report.findings.map((finding) => finding.sourceId).sort();
  if (expected.length === 0 || expected.length !== snapshot.sourceIds.length || JSON.stringify(actual) !== JSON.stringify(expected)) return null;
  return report;
}

export function feedbackVerified(snapshot: ApprovalFeedbackSnapshot, headOid: string | null, record: ApprovalFeedbackRecord | null): boolean {
  if (snapshot.status === "none") return true;
  if (snapshot.status !== "present" || snapshot.fingerprint === null || headOid === null || record === null) return false;
  return record.headOid === headOid && record.fingerprint === snapshot.fingerprint && record.blockers.length === 0 &&
    record.findings.every((finding) => finding.validation.outcome === "passed" || finding.validation.outcome === "not-needed") &&
    JSON.stringify(record.findings.map((item) => item.sourceId).sort()) === JSON.stringify([...snapshot.sourceIds].sort());
}

export function feedbackVerificationState(snapshot: ApprovalFeedbackSnapshot | undefined, headOid: string | null,
  record: ApprovalFeedbackRecord | null): "none" | "verified" | "missing" | "head-changed" | "feedback-changed" | "unknown" {
  if (snapshot?.status === "none") return "none";
  if (snapshot?.status !== "present" || headOid === null) return "unknown";
  if (record === null) return "missing";
  if (!feedbackVerified(snapshot, record.headOid, record)) return "feedback-changed";
  if (record.headOid !== headOid) return "head-changed";
  return "verified";
}

export function createApprovalFeedbackStore(db: RunDb) {
  return {
    get(prUrl: string): ApprovalFeedbackRecord | null {
      const key = canonicalPrUrl(prUrl);
      if (key === null) return null;
      const row = db.prepare("SELECT body FROM approval_feedback_verifications WHERE pr_url = ?").get(key) as { body: string } | undefined;
      if (!row) return null;
      try { return recordSchema.safeParse(JSON.parse(row.body)).data ?? null; } catch { return null; }
    },
    save(prUrl: string, threadId: string, report: z.infer<typeof reportSchema>, verifiedAt: number,
      provenance: ApprovalFeedbackProvenance = { kind: "worker" }): ApprovalFeedbackRecord {
      const key = canonicalPrUrl(prUrl);
      if (key === null) throw new Error("Invalid PR URL for feedback verification");
      const record = recordSchema.parse({ ...report, prUrl: key, threadId, verifiedAt, provenance });
      db.prepare("INSERT OR REPLACE INTO approval_feedback_verifications (pr_url, body) VALUES (?, ?)").run(key, JSON.stringify(record));
      return record;
    },
    carryEquivalent(prUrl: string, expected: ApprovalFeedbackRecord, snapshot: ApprovalFeedbackSnapshot,
      currentHeadOid: string, priorTreeOid: string, currentTreeOid: string, checkedAt: number): ApprovalFeedbackRecord | null {
      const key = canonicalPrUrl(prUrl);
      if (key === null || expected.headOid === currentHeadOid || priorTreeOid !== currentTreeOid ||
          !sha.safeParse(currentHeadOid).success || !sha.safeParse(priorTreeOid).success ||
          !feedbackVerified(snapshot, expected.headOid, expected)) return null;
      const row = db.prepare("SELECT body FROM approval_feedback_verifications WHERE pr_url = ?").get(key) as { body: string } | undefined;
      if (!row) return null;
      let body: unknown;
      try { body = JSON.parse(row.body); } catch { return null; }
      const parsed = recordSchema.safeParse(body);
      if (!parsed.success || JSON.stringify(parsed.data) !== JSON.stringify(recordSchema.parse(expected))) return null;
      const next = recordSchema.parse({ ...parsed.data, headOid: currentHeadOid,
        equivalence: { sourceHeadOid: parsed.data.equivalence?.sourceHeadOid ?? parsed.data.headOid,
          sourceVerifiedAt: parsed.data.equivalence?.sourceVerifiedAt ?? parsed.data.verifiedAt,
          treeOid: currentTreeOid, checkedAt } });
      db.prepare("UPDATE approval_feedback_verifications SET body = ? WHERE pr_url = ? AND body = ?")
        .run(JSON.stringify(next), key, row.body);
      const written = db.prepare("SELECT changes() AS count").get() as { count: number };
      return written.count === 1 ? next : null;
    },
  };
}
