// Your turn lists your PRs where a reviewer's feedback waits on you, and nothing else: each kind of feedback puts a PR in, and a draft, a
// held PR, one waiting only on CI, and one waiting on its reviewers stay out, so the badge never asks you to act where nothing is yours.
import { describe, expect, it } from "vitest";
import { commentsSince, yourTurn, type YourTurnFacts } from "./your-turn.js";

const at = (hour: number) => new Date(Date.UTC(2026, 8, 29, hour)).toISOString();
const PR: YourTurnFacts = { state: "OPEN", isDraft: false, reviewDecision: "REVIEW_REQUIRED", reviewRequests: [], latestReviews: [],
  approvalFeedback: { status: "none", fingerprint: null, sourceIds: [] }, approvalFeedbackVerified: true, headCommittedAt: at(9),
  reviewFeedback: { openThreads: 0, comment: null, repliedAt: null } };
const pr = (patch: Partial<YourTurnFacts>): YourTurnFacts => ({ ...PR, ...patch });
const changes = pr({ reviewDecision: "CHANGES_REQUESTED", latestReviews: [{ login: "otto-v", state: "CHANGES_REQUESTED", submittedAt: at(10) }] });
const approval = pr({ reviewDecision: "APPROVED", latestReviews: [{ login: "mira-l", state: "APPROVED", submittedAt: at(11) }],
  approvalFeedback: { status: "present", fingerprint: "a".repeat(64), sourceIds: ["review-1"] }, approvalFeedbackVerified: false });
const threads = pr({ reviewFeedback: { openThreads: 2, comment: null, repliedAt: null } });
const comments = pr({ latestReviews: [{ login: "theo-k", state: "COMMENTED", submittedAt: at(12) }],
  reviewFeedback: { openThreads: 0, comment: { login: "theo-k", at: at(12) }, repliedAt: null } });

describe("Your turn", () => {
  it("lists each kind of feedback that waits on you, with who and since when", () => {
    expect(yourTurn(changes, false)).toEqual({ kinds: ["changes"], text: "Changes requested by @otto-v", since: Date.parse(at(10)) });
    expect(yourTurn(approval, false)).toEqual({ kinds: ["approval"], text: "Approved with comments", since: Date.parse(at(11)) });
    expect(yourTurn(threads, false)).toEqual({ kinds: ["threads"], text: "2 open threads", since: null });
    expect(yourTurn(comments, false)).toEqual({ kinds: ["comments"], text: "New comments from @theo-k", since: Date.parse(at(12)) });
  });

  it("names every kind a PR has, oldest feedback first for its age", () => {
    const both = pr({ ...changes, reviewFeedback: { openThreads: 1, comment: { login: "otto-v", at: at(10) }, repliedAt: null } });
    expect(yourTurn(both, false)).toEqual({ kinds: ["changes", "threads", "comments"],
      text: "Changes requested by @otto-v · 1 open thread · New comments from @otto-v", since: Date.parse(at(10)) });
  });

  it("leaves out a draft, a PR you hold, and a closed PR, whatever feedback they carry", () => {
    for (const facts of [changes, approval, threads, comments]) {
      expect(yourTurn({ ...facts, isDraft: true }, false)).toBeNull();
      expect(yourTurn(facts, true)).toBeNull();
      expect(yourTurn({ ...facts, state: "MERGED" }, false)).toBeNull();
    }
  });

  // Red checks are the thread's work, not a reviewer's feedback: they never make it your turn on their own.
  it("leaves out a PR waiting only on CI, or on reviewers you asked", () => {
    const red = { ...PR, checkConclusions: ["FAILURE"], mergeStateStatus: "UNSTABLE" } as YourTurnFacts;
    expect(yourTurn(red, false)).toBeNull();
    expect(yourTurn({ ...red, reviewDecision: "APPROVED", latestReviews: [{ login: "mira-l", state: "APPROVED", submittedAt: at(11) }] }, false)).toBeNull();
    expect(yourTurn(pr({ reviewRequests: ["mira-l"] }), false)).toBeNull();
    // Asked again after their change request, the next move is theirs.
    expect(yourTurn({ ...changes, reviewRequests: ["otto-v"] }, false)).toBeNull();
    // An approval whose comments you confirmed handled, or that left none.
    expect(yourTurn({ ...approval, approvalFeedbackVerified: true }, false)).toBeNull();
    expect(yourTurn({ ...approval, approvalFeedback: { status: "none", fingerprint: null, sourceIds: [] }, approvalFeedbackVerified: true }, false)).toBeNull();
  });

  it("clears reviewer comments once you push or reply after them, and only then", () => {
    expect(commentsSince(comments)).toEqual({ login: "theo-k", at: Date.parse(at(12)) });
    expect(yourTurn({ ...comments, headCommittedAt: at(13) }, false)).toBeNull();
    expect(yourTurn({ ...comments, reviewFeedback: { ...comments.reviewFeedback!, repliedAt: at(13) } }, false)).toBeNull();
    // A reply or push before the comment answers nothing.
    expect(yourTurn({ ...comments, headCommittedAt: at(11), reviewFeedback: { ...comments.reviewFeedback!, repliedAt: at(11) } }, false)?.kinds).toEqual(["comments"]);
  });

  // Without the push's date, a comment might be answered already, so it asks nothing rather than guess; so does a PR never read for it.
  it("asks nothing from comments it can't date against your last push", () => {
    expect(yourTurn({ ...comments, headCommittedAt: undefined }, false)).toBeNull();
    expect(yourTurn({ ...comments, reviewFeedback: undefined }, false)).toBeNull();
  });
});
