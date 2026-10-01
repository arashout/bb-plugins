// Your turn lists your PRs where a reviewer's feedback waits on you, and nothing else: each kind of feedback puts a PR in, whatever CI says,
// and a held PR, one waiting only on CI, and one waiting on its reviewers stay out, so the badge never asks you to act where nothing is
// yours. A draft is in only for feedback to address, and only your reply on the PR answers a comment: a push never does, and neither does
// a PR that mentions it.
import { describe, expect, it } from "vitest";
import type { Pr } from "./contract.js";
import { parsePrList } from "./gh.js";
import { attentionReasons, DEFAULT_ATTENTION_THRESHOLDS } from "./pr-attention.js";
import { sentChip, sentState, turnSummary, yourTurn, type Sent, type SentItem, type SentRun } from "./your-turn.js";

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
/** Codex's review with its threads: the review read leaves its threads out of the open threads a person started. */
const codex = { login: "chatgpt-codex-connector", state: "COMMENTED", submittedAt: at(12) };
const botOnly = pr({ latestReviews: [codex], reviewFeedback: { openThreads: 0, comment: null, repliedAt: null } });

describe("Your turn", () => {
  // Only an approval with comments or a person's change request is a real follow-up, which Your turn and the badge count. A bot's review,
  // a person's comment, and a person's open threads still wait, as Comments only, which a batch addresses but nothing counts; drop the
  // split and the badge would count every Codex or Copilot drive-by.
  it("makes only an approval with comments or a person's change request a real follow-up, and the rest Comments only", () => {
    expect([changes, approval].map((facts) => turn(facts)?.followUp)).toEqual(["Changes requested by @otto-v", "Approved with comments"]);
    for (const facts of [threads, comments]) expect(turn(facts)).toMatchObject({ followUp: null });
    // The follow-up leads; comments and bot notes follow it.
    const busy = pr({ ...approval, latestReviews: [...approval.latestReviews, codex], reviewFeedback: { ...approval.reviewFeedback!, comment: { login: "theo-k", at: at(12) } } });
    expect(turn(busy)).toMatchObject({ kinds: ["approval", "comments", "bots"], text: "Approved with comments · New comments from @theo-k · 1 bot note",
      followUp: "Approved with comments" });
  });

  // A code-review app's review, Claude's, Codex's, or Copilot's, is a bot note: it waits until you reply on the PR after it, but alone it
  // never makes the PR a follow-up, and its change request is never a person's.
  it("keeps a bot-only PR off Your turn, in Comments only until you reply after its review", () => {
    expect(turn(botOnly)).toEqual({ kinds: ["bots"], text: "1 bot note", followUp: null, since: Date.parse(at(12)) });
    const two = pr({ ...botOnly, latestReviews: [codex, { login: "claude", state: "CHANGES_REQUESTED", submittedAt: at(13) }], reviewDecision: "CHANGES_REQUESTED" });
    expect(turn(two)).toEqual({ kinds: ["bots"], text: "2 bot notes", followUp: null, since: Date.parse(at(12)) });
    // Your reply after it answers it; one before it, a push, or a PR that links it doesn't.
    expect(turn({ ...botOnly, reviewFeedback: { ...botOnly.reviewFeedback!, repliedAt: at(13) } })).toBeNull();
    expect(turn({ ...botOnly, reviewFeedback: { ...botOnly.reviewFeedback!, repliedAt: at(11), followUpAt: at(14) }, headCommittedAt: at(14) })?.kinds).toEqual(["bots"]);
    // A bot's approval says nothing to address, and a draft waits only for feedback to address.
    expect(turn(pr({ latestReviews: [{ login: "copilot-pull-request-reviewer", state: "APPROVED", submittedAt: at(12) }] }))).toBeNull();
    expect(turn({ ...botOnly, isDraft: true })).toBeNull();
  });

  it("lists each kind of feedback that waits on you, with who and since when", () => {
    expect(turn(changes)).toEqual({ kinds: ["changes"], text: "Changes requested by @otto-v", followUp: "Changes requested by @otto-v", since: Date.parse(at(10)) });
    expect(turn(approval)).toEqual({ kinds: ["approval"], text: "Approved with comments", followUp: "Approved with comments", since: Date.parse(at(11)) });
    expect(turn(threads)).toEqual({ kinds: ["threads"], text: "2 open threads", followUp: null, since: null });
    expect(turn(comments)).toEqual({ kinds: ["comments"], text: "New comments from @theo-k", followUp: null, since: Date.parse(at(12)) });
  });

  it("names every kind a PR has, oldest feedback first for its age", () => {
    const both = pr({ ...changes, reviewFeedback: { openThreads: 1, comment: { login: "theo-k", at: at(12) }, repliedAt: null } });
    expect(turn(both)).toEqual({ kinds: ["changes", "threads", "comments"],
      text: "Changes requested by @otto-v · 1 open thread · New comments from @theo-k", followUp: "Changes requested by @otto-v", since: Date.parse(at(10)) });
  });

  // A change request is a review, and so a comment: the reviewer it names isn't named again for it.
  it("names a reviewer's change request once, not again as new comments", () => {
    const requested = pr({ ...changes, reviewFeedback: { openThreads: 0, comment: { login: "otto-v", at: at(10) }, repliedAt: null } });
    expect(turn(requested)).toEqual({ kinds: ["changes"], text: "Changes requested by @otto-v", followUp: "Changes requested by @otto-v", since: Date.parse(at(10)) });
  });

  // Once you answered the change request (a verified follow-up, pushed since), the reviewer owes nothing and you owe the re-request: Your
  // turn says so, rather than asking for changes that are made. A push alone answers nothing, so it keeps asking for them.
  it("says an answered change request waits on your re-request, and keeps asking for changes nothing answered", () => {
    const answered = pr({ ...changes, headCommittedAt: at(13), reviewFollowupPosted: true });
    expect(turn(answered)).toEqual({ kinds: ["changes"], text: "Answered @otto-v · re-request review", followUp: "Answered @otto-v · re-request review", since: Date.parse(at(10)) });
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
    expect(turn({ ...approval, approvalFeedbackVerified: true })?.text).toBe("Approved with comments");
  });

  // The live case: a conditional approval, then the rest of its stack mentioned the PR hours later. Those links date a follow-up, but the
  // reviewer saw no reply, so it stays yours until you reply on the PR; then only notes a worker verified are off your turn.
  it("keeps an approval comment on Your turn when a PR that mentions it lands later, until you reply on the PR", () => {
    const mentioned = { ...approval, approvalFeedbackVerified: true, reviewFeedback: { ...approval.reviewFeedback!, followUpAt: at(14) } };
    expect(turn(mentioned)).toEqual({ kinds: ["approval"], text: "Approved with comments", followUp: "Approved with comments", since: Date.parse(at(11)) });
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
    expect(turnSummary(turn(approval)!, [])).toBe("Approved with comments");
    // The re-request's part holds a " · " of its own, which must not shift the approval's part out of place.
    const asked = { text: "Answered @otto-v · re-request review · Approved with comments · 2 open threads · 3 bot notes" };
    expect(turnSummary(asked, approval.latestReviews)).toBe("Answered @otto-v · re-request review · Approval comment from @mira-l · 2 open threads · 3 bot notes");
  });
});

// A sent PR's one chip reads its batch item while the batch waits or was refused, else its newest claim: the thread working, waiting on
// you, or how it ended. The thread's link outlives the thread however it ends, until a newer batch or newer feedback replaces it.
describe("a sent PR's state", () => {
  const T = 1_000_000;
  const item = (state: SentItem["state"], detail: string | null = null): SentItem => ({ state, detail, batchId: "b-2", confirmedAt: T });
  const run = (status: SentRun["status"], text: string | null = null, startedAt = T + 8_000): SentRun => ({ threadId: "thr-1", status, startedAt,
    finishedAt: status === "running" || status === "needs-you" ? null : startedAt + 60_000, result: status === "done" ? text : null, error: status === "failed" ? text : null });
  const chip = (sent: Sent | null) => sent && [sent.state, sent.threadId, sentChip(sent).text];

  it("follows the thread through its run, and keeps its link after it ends with a report, a blocker, or none", () => {
    expect(chip(sentState(item("queued"), null, null, null))).toEqual(["sending", null, "Sending"]);
    expect(sentState(item("queued"), null, null, null)?.batchId).toBe("b-2");
    expect(chip(sentState(item("sent"), run("running"), "Address feedback on 2 PRs", null))).toEqual(["working", "thr-1", "Working"]);
    expect(chip(sentState(item("sent"), run("needs-you"), null, null))).toEqual(["needs-you", "thr-1", "Needs you"]);
    expect(chip(sentState(item("sent"), run("done", "Reported changed at bbbbbbb"), null, null))).toEqual(["done", "thr-1", "Done · pushed"]);
    expect(chip(sentState(item("sent"), run("done", "Reported no-change at bbbbbbb"), null, null))).toEqual(["done", "thr-1", "Done · replied"]);
    expect(chip(sentState(item("sent"), run("failed", "Blocked: mira-l asks for a new order"), null, null))).toEqual(["blocked", "thr-1", "Blocked: mira-l asks for a new order"]);
    // Stopped or failed with nothing in its output, or archived or deleted before its output was read: no report, and the link stays.
    for (const text of ["No result line for this PR.", "Its batch thread is gone: deleted or archived while the board wasn't listening. Its report was never read."]) {
      expect(chip(sentState(item("sent"), run("failed", text), null, null))).toEqual(["no-report", "thr-1", "Ended without a report"]);
    }
    // Past the day a batch item is kept, the claim alone still speaks.
    expect(chip(sentState(null, run("failed", "No result line for this PR."), null, null))).toEqual(["no-report", "thr-1", "Ended without a report"]);
  });

  it("says why dispatch refused it, lets a newer batch replace an old thread's link, and drops the link for feedback newer than the thread", () => {
    const old = run("failed", "No result line for this PR.", T - 3_600_000);
    // A newer batch refused at dispatch never claimed the PR: its reason replaces the old thread's link.
    expect(chip(sentState(item("refused", "On hold. Release it first."), old, null, null))).toEqual(["refused", null, "Not sent: On hold. Release it first."]);
    // A newer batch waiting out its window, then its own claim, replace it too.
    expect(chip(sentState(item("queued"), old, null, null))).toEqual(["sending", null, "Sending"]);
    expect(chip(sentState(item("unknown", "The plugin restarted"), { ...run("running"), threadId: "thr-2" }, null, null))).toEqual(["working", "thr-2", "Working"]);
    // Feedback that arrived after the thread ended isn't what it answered; feedback from before keeps the link.
    expect(sentState(null, old, null, old.finishedAt! + 1)).toBeNull();
    expect(chip(sentState(null, old, null, old.startedAt - 1))).toEqual(["no-report", "thr-1", "Ended without a report"]);
  });
});
