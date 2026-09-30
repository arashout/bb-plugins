// Your turn lists your PRs where a reviewer's feedback waits on you, and nothing else: each kind of feedback puts a PR in, whatever CI says,
// and a held PR, one waiting only on CI, and one waiting on its reviewers stay out, so the badge never asks you to act where nothing is
// yours. A draft is in only for feedback to address, and only your reply on the PR answers a comment: a push never does, and neither does
// a PR that mentions it.
import { describe, expect, it } from "vitest";
import type { Pr } from "./contract.js";
import { parsePrList } from "./gh.js";
import { attentionReasons, DEFAULT_ATTENTION_THRESHOLDS } from "./pr-attention.js";
import { turnSummary, yourTurn } from "./your-turn.js";

const NOW = Date.UTC(2026, 8, 29, 15);
const at = (hour: number) => new Date(Date.UTC(2026, 8, 29, hour)).toISOString();
const base = parsePrList(JSON.stringify([{ number: 96, url: "https://github.com/inkwell/catalog/pull/96", state: "OPEN", title: "ABC-121 Show series order",
  isDraft: false, reviewDecision: "REVIEW_REQUIRED", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefOid: "c".repeat(40), latestReviews: [],
  reviewRequests: [], statusCheckRollup: [{ conclusion: "SUCCESS" }] }]))!.pr;
const pr = (patch: Partial<Pr>): Pr => ({ ...base, headCommittedAt: at(9), unresolvedReviewThreads: 0, resolvedReviewThreads: 0,
  approvalFeedback: { status: "none", fingerprint: null, sourceIds: [] }, approvalFeedbackVerified: true,
  reviewFeedback: { openThreads: 0, comment: null, repliedAt: null }, ...patch });
/** Your turn as the server computes it: with the PR's own attention, which asks for an approval's notes only once nothing else holds it. */
const turn = (facts: Pr, held = false) => yourTurn(facts, attentionReasons(facts, {}, { now: NOW, thresholds: DEFAULT_ATTENTION_THRESHOLDS, utcOffsetMinutes: 0 }), held);

const changes = pr({ reviewDecision: "CHANGES_REQUESTED", latestReviews: [{ login: "otto-v", state: "CHANGES_REQUESTED", submittedAt: at(10) }] });
const approval = pr({ reviewDecision: "APPROVED", latestReviews: [{ login: "mira-l", state: "APPROVED", submittedAt: at(11) }],
  approvalFeedback: { status: "present", fingerprint: "a".repeat(64), sourceIds: ["review-1"] }, approvalFeedbackVerified: false,
  reviewFeedback: { openThreads: 0, comment: null, repliedAt: null, noteAt: at(11), followUpAt: null } });
const threads = pr({ reviewFeedback: { openThreads: 2, comment: null, repliedAt: null } });
const comments = pr({ latestReviews: [{ login: "theo-k", state: "COMMENTED", submittedAt: at(12) }],
  reviewFeedback: { openThreads: 0, comment: { login: "theo-k", at: at(12) }, repliedAt: null } });

describe("Your turn", () => {
  it("lists each kind of feedback that waits on you, with who and since when", () => {
    expect(turn(changes)).toEqual({ kinds: ["changes"], text: "Changes requested by @otto-v", since: Date.parse(at(10)) });
    expect(turn(approval)).toEqual({ kinds: ["approval"], text: "Approval comment to address", since: Date.parse(at(11)) });
    expect(turn(threads)).toEqual({ kinds: ["threads"], text: "2 open threads", since: null });
    expect(turn(comments)).toEqual({ kinds: ["comments"], text: "New comments from @theo-k", since: Date.parse(at(12)) });
  });

  it("names every kind a PR has, oldest feedback first for its age", () => {
    const both = pr({ ...changes, reviewFeedback: { openThreads: 1, comment: { login: "theo-k", at: at(12) }, repliedAt: null } });
    expect(turn(both)).toEqual({ kinds: ["changes", "threads", "comments"],
      text: "Changes requested by @otto-v · 1 open thread · New comments from @theo-k", since: Date.parse(at(10)) });
  });

  // A change request is a review, and so a comment: the reviewer it names isn't named again for it.
  it("names a reviewer's change request once, not again as new comments", () => {
    const requested = pr({ ...changes, reviewFeedback: { openThreads: 0, comment: { login: "otto-v", at: at(10) }, repliedAt: null } });
    expect(turn(requested)).toEqual({ kinds: ["changes"], text: "Changes requested by @otto-v", since: Date.parse(at(10)) });
  });

  // Once you answered the change request (a verified follow-up, pushed since), the reviewer owes nothing and you owe the re-request: Your
  // turn says so, rather than asking for changes that are made. A push alone answers nothing, so it keeps asking for them.
  it("says an answered change request waits on your re-request, and keeps asking for changes nothing answered", () => {
    const answered = pr({ ...changes, headCommittedAt: at(13), reviewFollowupPosted: true });
    expect(turn(answered)).toEqual({ kinds: ["changes"], text: "Answered @otto-v · re-request review", since: Date.parse(at(10)) });
    expect(turn(pr({ ...changes, headCommittedAt: at(13) }))?.text).toBe("Changes requested by @otto-v");
    // Another reviewer's change request that nothing answered keeps its own words beside it.
    const mixed = pr({ ...answered, latestReviews: [...changes.latestReviews, { login: "mira-l", state: "CHANGES_REQUESTED", submittedAt: at(14) }] });
    expect(turn(mixed)?.text).toBe("Changes requested by @mira-l · Answered @otto-v · re-request review");
  });

  it("leaves out a PR you hold and a closed PR, whatever feedback they carry, and a draft but for its feedback to address", () => {
    for (const facts of [changes, approval, threads, comments]) {
      expect(turn(facts, true)).toBeNull();
      expect(turn({ ...facts, state: "MERGED" })).toBeNull();
    }
    for (const facts of [changes, threads]) expect(turn({ ...facts, isDraft: true })).toBeNull();
    expect(turn({ ...approval, isDraft: true })?.kinds).toEqual(["approval"]);
    expect(turn({ ...comments, isDraft: true })?.kinds).toEqual(["comments"]);
  });

  // Red or running checks are the thread's work or CI's, not a reviewer's feedback: they never make it your turn on their own.
  it("leaves out a PR waiting only on CI, or on reviewers you asked", () => {
    expect(turn(pr({ checkConclusions: ["FAILURE"], mergeStateStatus: "UNSTABLE" }))).toBeNull();
    expect(turn(pr({ reviewRequests: ["mira-l"] }))).toBeNull();
    // Asked again after their change request, the next move is theirs.
    expect(turn({ ...changes, reviewRequests: ["otto-v"] })).toBeNull();
    // An approval whose comments you confirmed on this head, or that left none.
    expect(turn({ ...approval, approvalFeedbackVerified: true, approvalFeedbackConfirmed: true })).toBeNull();
    expect(turn({ ...approval, approvalFeedback: { status: "none", fingerprint: null, sourceIds: [] }, approvalFeedbackVerified: true })).toBeNull();
  });

  // An approval that said something waits on your answer whatever CI says, and a worker's evidence is no answer the reviewer sees.
  it("keeps an approval comment to address on Your turn while checks run or fail, and over a worker's evidence", () => {
    for (const checks of [["PENDING"], ["FAILURE"]]) {
      expect(turn({ ...approval, checkConclusions: checks, mergeStateStatus: "UNSTABLE" })?.kinds).toEqual(["approval"]);
    }
    expect(turn({ ...approval, approvalFeedbackVerified: true })?.text).toBe("Approval comment to address");
  });

  // The live case: a conditional approval, then the rest of its stack mentioned the PR hours later. Those links date a follow-up, but the
  // reviewer saw no reply, so it stays yours until you reply on the PR; then only notes a worker verified are off your turn.
  it("keeps an approval comment on Your turn when a PR that mentions it lands later, until you reply on the PR", () => {
    const mentioned = { ...approval, approvalFeedbackVerified: true, reviewFeedback: { ...approval.reviewFeedback!, followUpAt: at(14) } };
    expect(turn(mentioned)).toEqual({ kinds: ["approval"], text: "Approval comment to address", since: Date.parse(at(11)) });
    expect(turn({ ...mentioned, reviewFeedback: { ...mentioned.reviewFeedback, repliedAt: at(13) } })).toBeNull();
  });

  // A push says nothing to the reviewer, and neither does a PR that mentions this one: only your reply on the PR after the comment answers it.
  it("clears a reviewer's comment once you reply after it, and never on a push or a PR that links it", () => {
    expect(turn({ ...comments, headCommittedAt: at(13) })?.kinds).toEqual(["comments"]);
    expect(turn({ ...comments, reviewFeedback: { ...comments.reviewFeedback!, repliedAt: at(13) } })).toBeNull();
    expect(turn({ ...comments, reviewFeedback: { ...comments.reviewFeedback!, followUpAt: at(13) } })?.kinds).toEqual(["comments"]);
    // A reply before the comment answers an older one, not this.
    expect(turn({ ...comments, reviewFeedback: { ...comments.reviewFeedback!, repliedAt: at(11) } })?.kinds).toEqual(["comments"]);
  });

  // With no push to compare against, the comment still waits: no answer is dated after it. A PR never read for it asks nothing.
  it("keeps a comment no reply answered without the push's date, and asks nothing of a PR never read for it", () => {
    expect(turn({ ...comments, headCommittedAt: undefined })?.kinds).toEqual(["comments"]);
    expect(turn({ ...comments, reviewFeedback: undefined })).toBeNull();
  });

  // Address selected lists each PR with who left what, so you can tell two approvals apart before one thread takes them all.
  it("names who left an approval's comment in a listing, and keeps every other part as Your turn words it", () => {
    const both = { ...approval, reviewFeedback: { ...approval.reviewFeedback!, openThreads: 3 } };
    const summary = turnSummary(turn(both)!, both.latestReviews);
    expect(summary).toBe("Approval comment from @mira-l · 3 open threads");
    expect(turnSummary(turn(changes)!, changes.latestReviews)).toBe("Changes requested by @otto-v");
    // With no approver read, it says what Your turn says.
    expect(turnSummary(turn(approval)!, [])).toBe("Approval comment to address");
    // The re-request's part holds a " · " of its own, which must not shift the approval's part out of place.
    const asked = { text: "Answered @otto-v · re-request review · Approval comment to address · 2 open threads" };
    expect(turnSummary(asked, approval.latestReviews)).toBe("Answered @otto-v · re-request review · Approval comment from @mira-l · 2 open threads");
  });
});
