import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { APPROVAL_FEEDBACK_MIGRATION, FEEDBACK_REPORT_PREFIX, createApprovalFeedbackStore, feedbackVerified, parseFeedbackReport } from "./approval-feedback.js";
import { readReviewThreads, type GhRunner } from "./ghactions.js";

const url = "https://github.com/example/widget/pull/42";
const target = { host: "github.com", owner: "example", name: "widget", number: 42, slug: "example/widget" };
const head = "a".repeat(40);
const review = { id: "review-42", state: "APPROVED", body: "Fix the fallback", submittedAt: "2026-09-24T12:00:00Z",
  author: { login: "reviewer" }, commit: { oid: head } };
const gh: GhRunner = async () => ({ ok: true, stdout: JSON.stringify({ data: { repository: { pullRequest: {
  headRefOid: head, author: { login: "author" }, reviews: { pageInfo: { hasPreviousPage: false }, nodes: [review] },
  reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
} } } }) });

function report(attemptId: string, fingerprint: string, outcome: "passed" | "not-needed" | "failed" = "passed") {
  return { attemptId, headOid: head, fingerprint, findings: [{ sourceId: review.id, resolution: "already-satisfied",
    evidence: "The current fallback already handles the reviewed case in src/fallback.ts.",
    validation: { outcome, detail: outcome === "not-needed" ? "Static inspection covers this wording request." : "Focused fallback test passed." } }], blockers: [] };
}

describe("approval feedback verification", () => {
  it("accepts a no-change worker report only for the exact current review and head, then survives a base-only change", async () => {
    const read = await readReviewThreads(gh, target);
    if (!read.ok) throw new Error(read.error);
    const snapshot = read.approvalFeedback;
    expect(snapshot).toMatchObject({ status: "present", sourceIds: [review.id] });
    const db = new Database(":memory:");
    db.exec(APPROVAL_FEEDBACK_MIGRATION);
    const store = createApprovalFeedbackStore(db);
    const output = `${FEEDBACK_REPORT_PREFIX}${JSON.stringify(report("attempt-1", snapshot.fingerprint!, "not-needed"))}\nWorkstreams job attempt-1 complete: prepared`;
    const parsed = parseFeedbackReport(output, "attempt-1", snapshot, head);
    expect(parsed).not.toBeNull();
    store.save(url, "thread-1", parsed!, 1_000);
    expect(store.get(url)?.provenance).toEqual({ kind: "worker" });
    expect(feedbackVerified(snapshot, head, store.get(url))).toBe(true);
    expect(feedbackVerified(snapshot, "b".repeat(40), store.get(url))).toBe(false);
    expect(feedbackVerified({ ...snapshot, fingerprint: "c".repeat(64) }, head, store.get(url))).toBe(false);
    expect(feedbackVerified({ status: "none", fingerprint: null, sourceIds: [] }, head, null)).toBe(true);
    expect(feedbackVerified({ status: "unknown", fingerprint: null, sourceIds: [] }, head, store.get(url))).toBe(false);
    db.close();
  });

  it("loads older worker records and keeps audited legacy provenance without weakening current-head checks", async () => {
    const read = await readReviewThreads(gh, target);
    if (!read.ok) throw new Error(read.error);
    const snapshot = read.approvalFeedback;
    const parsed = parseFeedbackReport(`${FEEDBACK_REPORT_PREFIX}${JSON.stringify(report("old-attempt", snapshot.fingerprint!))}`,
      "old-attempt", snapshot, head);
    if (!parsed) throw new Error("Synthetic report did not parse");
    const db = new Database(":memory:");
    db.exec(APPROVAL_FEEDBACK_MIGRATION);
    const store = createApprovalFeedbackStore(db);
    store.save(url, "old-thread", parsed, 1_000);
    const row = db.prepare("SELECT body FROM approval_feedback_verifications WHERE pr_url = ?").get(url) as { body: string };
    const { provenance: _provenance, ...older } = JSON.parse(row.body) as Record<string, unknown>;
    db.prepare("UPDATE approval_feedback_verifications SET body = ? WHERE pr_url = ?").run(JSON.stringify(older), url);
    expect(store.get(url)?.provenance).toEqual({ kind: "worker" });

    const provenance = { kind: "legacy-reconciliation" as const, auditThreadId: "thr_audit",
      evidenceRefs: ["thr_old", "https://github.com/example/widget/pull/42#discussion_r1"] };
    const reconciled = store.save(url, "old-thread", parsed, 2_000, provenance);
    expect(store.get(url)?.provenance).toEqual(provenance);
    expect(reconciled).toMatchObject({ attemptId: "old-attempt", threadId: "old-thread", provenance });
    expect(feedbackVerified(snapshot, head, store.get(url))).toBe(true);
    expect(feedbackVerified(snapshot, "b".repeat(40), store.get(url))).toBe(false);
    expect(feedbackVerified({ ...snapshot, fingerprint: "c".repeat(64) }, head, store.get(url))).toBe(false);
    expect(feedbackVerified({ ...snapshot, sourceIds: ["different-source"] }, head, store.get(url))).toBe(false);
    for (const invalid of [
      { ...provenance, auditThreadId: "  " },
      { ...provenance, evidenceRefs: [] },
      { ...provenance, evidenceRefs: ["  "] },
    ]) expect(() => store.save(url, "old-thread", parsed, 3_000, invalid)).toThrow();
    expect(store.get(url)?.verifiedAt).toBe(2_000);
    db.close();
  });

  it("rejects failed validation, omitted sources, wrong attempts, and stale feedback", async () => {
    const read = await readReviewThreads(gh, target);
    if (!read.ok) throw new Error(read.error);
    const snapshot = read.approvalFeedback;
    const line = (value: unknown) => `${FEEDBACK_REPORT_PREFIX}${JSON.stringify(value)}`;
    expect(parseFeedbackReport(line(report("attempt-1", snapshot.fingerprint!, "failed")), "attempt-1", snapshot, head)).toBeNull();
    expect(parseFeedbackReport(line({ ...report("attempt-1", snapshot.fingerprint!), findings: [] }), "attempt-1", snapshot, head)).toBeNull();
    expect(parseFeedbackReport(line(report("attempt-2", snapshot.fingerprint!)), "attempt-1", snapshot, head)).toBeNull();
    expect(parseFeedbackReport(line(report("attempt-1", "d".repeat(64))), "attempt-1", snapshot, head)).toBeNull();
    expect(parseFeedbackReport(line(report("attempt-1", snapshot.fingerprint!)), "attempt-1", snapshot, "b".repeat(40))).toBeNull();
  });

  it("cannot claim an approved PR has no inline feedback when a thread root lacks review identity", async () => {
    const run: GhRunner = async () => ({ ok: true, stdout: JSON.stringify({ data: { repository: { pullRequest: {
      headRefOid: head, author: { login: "author" }, reviews: { pageInfo: { hasPreviousPage: false }, nodes: [{ ...review, body: "" }] },
      reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [{ id: "thread-1", isResolved: true,
        comments: { pageInfo: { hasNextPage: false }, nodes: [{ id: "comment-1", body: "Fix the fallback", createdAt: review.submittedAt,
          updatedAt: review.submittedAt, author: { login: "reviewer" }, pullRequestReview: null }] } }] },
    } } } }) });
    const read = await readReviewThreads(run, target);
    expect(read).toMatchObject({ ok: true, approvalFeedback: { status: "unknown" } });
  });
});
