// Gates a PR must pass before v2 calls it prepared. Each gate reads live
// preparation facts and stores, never readAdvancePr's readiness or detail, so a
// wait, a repair, and a decision stay distinguishable instead of one attention
// bucket. `null` means the facts cannot decide the gate yet: observe again.
import type { AdvanceFacts } from "./advance-contract.js";
import { feedbackVerificationState, userConfirmation, type ApprovalFeedbackRecord } from "./approval-feedback.js";
import { feedbackToAddress, type FeedbackItem } from "./feedback-to-address.js";
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

type MergeFacts = { mergeable: string | null; mergeStateStatus: string };
type ReviewerFacts<T> = { reviewRequests: readonly string[]; latestReviews: readonly T[] };

/** A conflict GitHub reported; mergeability it hasn't computed yet is not one. */
export function conflicted(facts: MergeFacts): boolean {
  return facts.mergeable === "CONFLICTING" || facts.mergeStateStatus === "DIRTY";
}

/** GitHub would merge this now; null while it is still computing. */
export function mergeClean(facts: MergeFacts): boolean | null {
  return facts.mergeable === "UNKNOWN" || facts.mergeStateStatus === "UNKNOWN" ? null :
    facts.mergeable === "MERGEABLE" && ["CLEAN", "HAS_HOOKS"].includes(facts.mergeStateStatus);
}

/** Someone was asked to review, or reviewed. gh's latestReviews carries no commit, so any submitted review counts as engagement. */
export function reviewEngaged(reviewers: ReviewerFacts<{ state: string }>): boolean {
  return reviewers.reviewRequests.length > 0 || reviewers.latestReviews.some((review) => review.state !== "PENDING");
}

/** GitHub no longer asks for changes, or the author's verified follow-up answers them on a newer head. */
export function changesAddressed(facts: { reviewDecision: string | null; reviewFollowupPosted?: boolean }): boolean {
  return facts.reviewDecision !== "CHANGES_REQUESTED" || facts.reviewFollowupPosted === true;
}

/** Reviewers who requested changes or had their review dismissed, and haven't been asked again. */
export function awaitingRerequest<T extends { login: string; state: string }>(reviewers: ReviewerFacts<T>): T[] {
  const requested = new Set(reviewers.reviewRequests.map((login) => login.toLowerCase()));
  return reviewers.latestReviews.filter((review) =>
    ["CHANGES_REQUESTED", "DISMISSED"].includes(review.state) && !requested.has(review.login.toLowerCase()));
}

export function prGates({ facts, observedAt, now, held, feedback, reviewers }: GateInput): Gates {
  const approved = facts.reviewDecision === "APPROVED";
  const feedbackState = feedbackVerificationState(facts.approvalFeedback, facts.headOid || null, feedback);
  return {
    open: facts.state === "OPEN",
    unheld: !held,
    fresh: now - observedAt <= FRESH_MS,
    "not-fork": !facts.isCrossRepository,
    "no-conflict": !conflicted(facts),
    "base-current": facts.mergeStateStatus !== "BEHIND",
    // Unknown results wait like pending ones; only a known failure asks for a check fix.
    "checks-settled": facts.checks === "passed" || facts.checks === "failed",
    "checks-green": facts.checks === "passed",
    "threads-resolved": facts.unresolvedThreads === 0 && facts.threadsComplete,
    "feedback-verified": feedbackState === "unknown" ? null : feedbackState === "none" || feedbackState === "verified",
    "changes-addressed": changesAddressed(facts),
    "rereview-requested": approved || (reviewers === null ? null : awaitingRerequest(reviewers).length === 0),
    "review-requested": approved || (reviewers === null ? null : reviewEngaged(reviewers)),
    approved,
    "not-draft": !facts.isDraft,
    "parent-merged": facts.basePrNumber === null,
    "merge-clean": mergeClean(facts),
  };
}

/**
 * Feedback to address on this read (feedback-to-address.ts), which no gate names: a worker's evidence verifies feedback, but only your
 * reply, a follow-up, or your confirmation answers it, so this holds Ready and waits on you instead of launching work. Null when the read
 * didn't say who spoke last, which proves no answer.
 */
export function unansweredFeedback(facts: Pick<AdvanceFacts, "approvalFeedback" | "reviewFeedback" | "headOid">, feedback: ApprovalFeedbackRecord | null): FeedbackItem[] | null {
  if (facts.reviewFeedback === undefined) return null;
  return feedbackToAddress(facts, userConfirmation(feedback, facts.approvalFeedback, facts.headOid || null)?.current === true);
}

/** What a PR short of merge-clean waits on: branch protection, or any other unmet requirement. */
export function mergeWait(facts: Pick<AdvanceFacts, "mergeStateStatus">): "merge-blocked" | "merge-requirements" {
  return facts.mergeStateStatus === "BLOCKED" ? "merge-blocked" : "merge-requirements";
}
