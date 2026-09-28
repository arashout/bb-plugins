import { describe, expect, it } from "vitest";
import type { AdvanceFacts } from "./advance-contract.js";
import { advanceChecks } from "./advance-host.js";
import type { ApprovalFeedbackRecord } from "./approval-feedback.js";
import { FRESH_MS, GATE_IDS, mergeWait, prGates, type GateId, type GateInput, type Gates } from "./pr-gates.js";

const head = "a".repeat(40);
const url = "https://github.com/inkwell/folio/pull/42";
const fingerprint = "f".repeat(64);
// Approved, green, clean, and its approval note verified on this head: every gate passes.
const facts: AdvanceFacts = {
  prUrl: url, number: 42, title: "ABC-42 Keep shelf order on reload", repo: "inkwell/folio",
  headRefName: "abc-42-shelf-order", baseRefName: "main", headOid: head, baseOid: "b".repeat(40),
  state: "OPEN", isDraft: false, isCrossRepository: false, reviewDecision: "APPROVED",
  mergeStateStatus: "CLEAN", mergeable: "MERGEABLE", needsPreparation: false, readiness: "ready",
  detail: "Approved, review feedback clear, checks passed, and branch ready to merge.",
  unresolvedThreads: 0, threadsComplete: true, checks: "passed", basePrNumber: null,
  approvalFeedback: { status: "present", fingerprint, sourceIds: ["approval-42"] },
};
const feedback: ApprovalFeedbackRecord = {
  attemptId: "attempt-42", headOid: head, fingerprint, blockers: [], prUrl: url, threadId: "thr_worker", verifiedAt: 1,
  findings: [{ sourceId: "approval-42", resolution: "fixed", evidence: "Shelf order now survives a reload.",
    validation: { outcome: "passed", detail: "npm test -- shelf" } }],
};
const now = 1_000_000;
const base: GateInput = { facts, observedAt: now - 30_000, now, held: false, feedback,
  reviewers: { reviewRequests: [], latestReviews: [{ login: "mira", state: "APPROVED" }] } };

function gates(change: Partial<Omit<GateInput, "facts">> & { facts?: Partial<AdvanceFacts> } = {}): Gates {
  return prGates({ ...base, ...change, facts: { ...facts, ...change.facts } });
}
const flipped = (result: Gates) => GATE_IDS.filter((id) => result[id] !== true);

describe("PR gates", () => {
  it("passes every gate for a verified merge candidate", () => {
    expect(flipped(gates())).toEqual([]);
  });

  // Each row changes one input fact. If a gate starts or stops reading a fact,
  // its row fails, so a readiness rule cannot drift silently.
  it.each<[string, Parameters<typeof gates>[0], GateId[]]>([
    ["closed", { facts: { state: "CLOSED" } }, ["open"]],
    ["held", { held: true }, ["unheld"]],
    ["read too long ago", { observedAt: now - FRESH_MS - 1 }, ["fresh"]],
    ["a fork", { facts: { isCrossRepository: true } }, ["not-fork"]],
    ["conflicting", { facts: { mergeable: "CONFLICTING" } }, ["no-conflict", "merge-clean"]],
    ["dirty", { facts: { mergeStateStatus: "DIRTY" } }, ["no-conflict", "merge-clean"]],
    ["behind its base", { facts: { mergeStateStatus: "BEHIND" } }, ["base-current", "merge-clean"]],
    ["blocked by branch protection", { facts: { mergeStateStatus: "BLOCKED" } }, ["merge-clean"]],
    ["unstable", { facts: { mergeStateStatus: "UNSTABLE" } }, ["merge-clean"]],
    ["still computing mergeability", { facts: { mergeable: "UNKNOWN" } }, ["merge-clean"]],
    ["waiting on checks", { facts: { checks: "pending" } }, ["checks-settled", "checks-green"]],
    ["missing check results", { facts: { checks: "unknown" } }, ["checks-settled", "checks-green"]],
    ["failing checks", { facts: { checks: "failed" } }, ["checks-green"]],
    ["left with an unresolved thread", { facts: { unresolvedThreads: 1 } }, ["threads-resolved"]],
    ["missing thread pages", { facts: { threadsComplete: false } }, ["threads-resolved"]],
    ["pushed after verification", { facts: { headOid: "c".repeat(40) } }, ["feedback-verified"]],
    ["given new approval feedback", { facts: { approvalFeedback: { status: "present", fingerprint: "e".repeat(64), sourceIds: ["approval-42"] } } }, ["feedback-verified"]],
    ["never verified", { feedback: null }, ["feedback-verified"]],
    ["no longer approved", { facts: { reviewDecision: "REVIEW_REQUIRED" } }, ["approved"]],
    ["asked for changes", { facts: { reviewDecision: "CHANGES_REQUESTED" } }, ["changes-addressed", "approved"]],
    ["a draft", { facts: { isDraft: true } }, ["not-draft"]],
    ["stacked on an open parent", { facts: { basePrNumber: 41 } }, ["parent-merged"]],
    // Display text and derived hints never gate; neither do reviewers once approved.
    ["labeled for attention by legacy text", { facts: { readiness: "needs-attention", detail: "Needs attention", needsPreparation: true } }, []],
    ["approved with unobserved reviewers", { reviewers: null }, []],
  ])("a PR that is %s fails exactly the gates that read that fact", (_name, change, expected) => {
    expect(flipped(gates(change))).toEqual(expected);
  });

  it("keeps a running check with an empty conclusion unsettled", () => {
    const checks = advanceChecks([{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "IN_PROGRESS", conclusion: "" }]);
    expect(gates({ facts: { checks } })).toMatchObject({ "checks-settled": false, "checks-green": false });
  });

  it("names a protected-branch block as its own wait and observes an unknown merge state", () => {
    expect(gates({ facts: { mergeStateStatus: "HAS_HOOKS" } })["merge-clean"]).toBe(true);
    expect(gates({ facts: { mergeStateStatus: "UNSTABLE" } })["merge-clean"]).toBe(false);
    expect(mergeWait({ mergeStateStatus: "UNSTABLE" })).toBe("merge-requirements");
    expect(gates({ facts: { mergeStateStatus: "BLOCKED" } })["merge-clean"]).toBe(false);
    expect(mergeWait({ mergeStateStatus: "BLOCKED" })).toBe("merge-blocked");
    expect(gates({ facts: { mergeStateStatus: "UNKNOWN" } })["merge-clean"]).toBeNull();
  });

  it("observes unknown feedback history instead of treating it as work", () => {
    const result = gates({ facts: { approvalFeedback: { status: "unknown", fingerprint: null, sourceIds: [] } } });
    expect(result["feedback-verified"]).toBeNull();
    expect(GATE_IDS.filter((id) => result[id] === false)).toEqual([]);
  });

  it("asks again only reviewers who requested changes or had their review dismissed", () => {
    const changes = { reviewDecision: "CHANGES_REQUESTED", reviewFollowupPosted: true };
    const latestReviews = [{ login: "Mira", state: "CHANGES_REQUESTED" }, { login: "otto", state: "COMMENTED" }];
    expect(gates({ facts: changes, reviewers: { reviewRequests: [], latestReviews } })["rereview-requested"]).toBe(false);
    expect(gates({ facts: changes, reviewers: { reviewRequests: ["otto"], latestReviews } })["rereview-requested"]).toBe(false);
    expect(gates({ facts: changes, reviewers: { reviewRequests: ["mira"], latestReviews } })["rereview-requested"]).toBe(true);
    const dismissed = [{ login: "otto", state: "DISMISSED" }];
    const pending = { reviewDecision: "REVIEW_REQUIRED" };
    expect(gates({ facts: pending, reviewers: { reviewRequests: [], latestReviews: dismissed } })["rereview-requested"]).toBe(false);
    expect(gates({ facts: pending, reviewers: { reviewRequests: ["otto"], latestReviews: dismissed } })["rereview-requested"]).toBe(true);
    // An approval only has to stay true; nobody is asked to review again.
    expect(gates({ reviewers: { reviewRequests: [], latestReviews: dismissed } })["rereview-requested"]).toBe(true);
  });

  it("finds a PR nobody has been asked to review", () => {
    const pending = { reviewDecision: "REVIEW_REQUIRED" };
    expect(gates({ facts: pending, reviewers: { reviewRequests: [], latestReviews: [] } })["review-requested"]).toBe(false);
    expect(gates({ facts: pending, reviewers: { reviewRequests: [], latestReviews: [{ login: "me", state: "PENDING" }] } })["review-requested"]).toBe(false);
    expect(gates({ facts: pending, reviewers: { reviewRequests: ["mira"], latestReviews: [] } })["review-requested"]).toBe(true);
    expect(gates({ facts: pending, reviewers: { reviewRequests: [], latestReviews: [{ login: "otto", state: "COMMENTED" }] } })["review-requested"]).toBe(true);
    expect(gates({ facts: pending, reviewers: null })).toMatchObject({ "review-requested": null, "rereview-requested": null });
  });
});
