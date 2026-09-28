// Gates a PR must pass before v2 calls it prepared. Each gate reads live
// preparation facts and stores, never readAdvancePr's readiness or detail, so a
// wait, a repair, and a decision stay distinguishable instead of one attention
// bucket. `null` means the facts cannot decide the gate yet: observe again.
import type { AdvanceFacts } from "./advance-contract.js";
import { feedbackVerificationState, type ApprovalFeedbackRecord } from "./approval-feedback.js";
import type { Pr } from "./contract.js";

export const GATE_IDS = [
  "open", "unheld", "fresh", "not-fork", "no-conflict", "base-current", "checks-settled", "checks-green",
  "threads-resolved", "feedback-verified", "changes-addressed", "rereview-requested", "review-requested",
  "approved", "not-draft", "parent-merged", "merge-clean",
] as const;
export type GateId = (typeof GATE_IDS)[number];
export type Gates = Record<GateId, boolean | null>;

/** A full read older than this is stale for gating. */
export const FRESH_MS = 120_000;

export type GateInput = {
  facts: AdvanceFacts;
  /** When the full read that produced `facts` finished. */
  observedAt: number;
  now: number;
  held: boolean;
  feedback: ApprovalFeedbackRecord | null;
  /** The board's cheap read of reviewers; null when nothing has observed them. */
  reviewers: Pick<Pr, "reviewRequests" | "latestReviews"> | null;
};

export function prGates({ facts, observedAt, now, held, feedback, reviewers }: GateInput): Gates {
  const approved = facts.reviewDecision === "APPROVED";
  const requested = new Set(reviewers?.reviewRequests.map((login) => login.toLowerCase()));
  const feedbackState = feedbackVerificationState(facts.approvalFeedback, facts.headOid || null, feedback);
  return {
    open: facts.state === "OPEN",
    unheld: !held,
    fresh: now - observedAt <= FRESH_MS,
    "not-fork": !facts.isCrossRepository,
    "no-conflict": facts.mergeable !== "CONFLICTING" && facts.mergeStateStatus !== "DIRTY",
    "base-current": facts.mergeStateStatus !== "BEHIND",
    // Unknown results wait like pending ones; only a known failure asks for a check fix.
    "checks-settled": facts.checks === "passed" || facts.checks === "failed",
    "checks-green": facts.checks === "passed",
    "threads-resolved": facts.unresolvedThreads === 0 && facts.threadsComplete,
    "feedback-verified": feedbackState === "unknown" ? null : feedbackState === "none" || feedbackState === "verified",
    "changes-addressed": facts.reviewDecision !== "CHANGES_REQUESTED" || facts.reviewFollowupPosted === true,
    "rereview-requested": approved || (reviewers === null ? null : reviewers.latestReviews.every((review) =>
      !["CHANGES_REQUESTED", "DISMISSED"].includes(review.state) || requested.has(review.login.toLowerCase()))),
    // gh's latestReviews carries no commit, so any submitted review counts as engagement.
    "review-requested": approved || (reviewers === null ? null :
      reviewers.reviewRequests.length > 0 || reviewers.latestReviews.some((review) => review.state !== "PENDING")),
    approved,
    "not-draft": !facts.isDraft,
    "parent-merged": facts.basePrNumber === null,
    "merge-clean": facts.mergeable === "UNKNOWN" || facts.mergeStateStatus === "UNKNOWN" ? null :
      facts.mergeable === "MERGEABLE" && ["CLEAN", "HAS_HOOKS"].includes(facts.mergeStateStatus),
  };
}

/** What a PR short of merge-clean waits on: branch protection, or any other unmet requirement. */
export function mergeWait(facts: Pick<AdvanceFacts, "mergeStateStatus">): "merge-blocked" | "merge-requirements" {
  return facts.mergeStateStatus === "BLOCKED" ? "merge-blocked" : "merge-requirements";
}
