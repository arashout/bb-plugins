// Your turn lists your PRs where a person's feedback waits on you, and nothing else, as the Reviews plugin reads it: each of the four
// clauses puts a PR on, a bot never does, and your answer takes it off. A held PR, one waiting only on CI, and one waiting on its reviewers
// stay off, so the badge never asks you to act where nothing is yours. Dismiss hides a row until its head moves or a person says more, and a
// sent PR keeps its thread's link with BB's live status for as long as it's open.
import { describe, expect, it } from "vitest";
import type { Pr } from "./contract.js";
import { parsePrList } from "./gh.js";
import { attentionReasons, DEFAULT_ATTENTION_THRESHOLDS } from "./pr-attention.js";
import { dismissed, sentState, sentText, yourTurn, type Sent, type SentItem, type SentRun } from "./your-turn.js";

const NOW = Date.UTC(2026, 8, 29, 15);
const at = (hour: number) => new Date(Date.UTC(2026, 8, 29, hour)).toISOString();
const base = parsePrList(JSON.stringify([{ number: 96, url: "https://github.com/inkwell/catalog/pull/96", state: "OPEN", title: "ABC-121 Show series order",
  isDraft: false, reviewDecision: "REVIEW_REQUIRED", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefOid: "c".repeat(40), latestReviews: [],
  reviewRequests: [], statusCheckRollup: [{ conclusion: "SUCCESS" }] }]))!.pr;
const pr = (patch: Partial<Pr>): Pr => ({ ...base, headCommittedAt: at(9), unresolvedReviewThreads: 0, resolvedReviewThreads: 0,
  approvalFeedback: { status: "none", fingerprint: null, sourceIds: [] }, approvalFeedbackVerified: true,
  reviewFeedback: { openThreads: 0, comment: null, repliedAt: null }, ...patch });
/** Your turn as the server computes it: with the PR's own attention, which asks for an approval's notes only once nothing else holds it. */
const reasons = (facts: Pr) => attentionReasons(facts, {}, { now: NOW, thresholds: DEFAULT_ATTENTION_THRESHOLDS, utcOffsetMinutes: 0 });
const turn = (facts: Pr, held = false) => yourTurn(facts, reasons(facts), held);
const why = (facts: Pr) => turn(facts)?.why ?? null;

const changes = pr({ reviewDecision: "CHANGES_REQUESTED", latestReviews: [{ login: "otto-v", state: "CHANGES_REQUESTED", submittedAt: at(10) }] });
const approval = pr({ reviewDecision: "APPROVED", latestReviews: [{ login: "mira-l", state: "APPROVED", submittedAt: at(11) }],
  approvalFeedback: { status: "present", fingerprint: "a".repeat(64), sourceIds: ["review-1"] }, approvalFeedbackVerified: false,
  reviewFeedback: { openThreads: 0, comment: null, repliedAt: null, noteAt: at(11), followUpAt: null } });
const threads = pr({ reviewFeedback: { openThreads: 2, comment: null, repliedAt: null } });
const comments = pr({ latestReviews: [{ login: "theo-k", state: "COMMENTED", submittedAt: at(12) }],
  reviewFeedback: { openThreads: 0, comment: { login: "theo-k", at: at(12) }, repliedAt: null } });
/** Codex's review with its threads: the review read leaves its threads out of the open threads a person had the last word in. */
const codex = { login: "chatgpt-codex-connector", state: "COMMENTED", submittedAt: at(12) };
const botOnly = pr({ latestReviews: [codex], reviewFeedback: { openThreads: 0, comment: null, repliedAt: null } });

describe("Your turn", () => {
  // Each clause alone puts a PR on, with one line of why: drop any and that kind of feedback waits unseen.
  it("puts a PR on for each of the four clauses, saying why and since when", () => {
    expect(turn(changes)).toEqual({ why: "Changes requested by @otto-v", since: Date.parse(at(10)), latest: Date.parse(at(10)) });
    expect(turn(approval)).toEqual({ why: "Approval comment from @mira-l", since: Date.parse(at(11)), latest: Date.parse(at(11)) });
    expect(turn(threads)).toEqual({ why: "2 open threads", since: null, latest: null });
    expect(turn(comments)).toEqual({ why: "Comment from @theo-k", since: Date.parse(at(12)), latest: Date.parse(at(12)) });
    // Several in one line, oldest for its age; a change request's reviewer isn't named again for its comment.
    const both = pr({ ...changes, reviewFeedback: { openThreads: 1, comment: { login: "theo-k", at: at(12) }, repliedAt: null } });
    expect(turn(both)).toMatchObject({ why: "Changes requested by @otto-v · Comment from @theo-k · 1 open thread", since: Date.parse(at(10)) });
    expect(why(pr({ ...changes, reviewFeedback: { openThreads: 0, comment: { login: "otto-v", at: at(10) }, repliedAt: null } }))).toBe("Changes requested by @otto-v");
  });

  // A code-review app (Claude, Codex, Copilot) never puts a PR on: drop the rule and every drive-by review fills the list and the badge.
  it("keeps a bot-only PR off, whatever the bot said", () => {
    expect(turn(botOnly)).toBeNull();
    expect(turn(pr({ ...botOnly, reviewDecision: "CHANGES_REQUESTED", latestReviews: [{ login: "claude", state: "CHANGES_REQUESTED", submittedAt: at(13) }] }))).toBeNull();
    expect(turn(pr({ latestReviews: [{ login: "copilot-pull-request-reviewer", state: "APPROVED", submittedAt: at(12) }] }))).toBeNull();
    // Beside a person's feedback it's named nowhere.
    expect(why(pr({ ...changes, latestReviews: [...changes.latestReviews, codex] }))).toBe("Changes requested by @otto-v");
  });

  // Your reply last makes it the reviewer's turn: the review read leaves such a thread out of openThreads (ghactions.ts), and a reply
  // after a comment answers it. Drop it and answered threads stay on the list forever.
  it("takes a thread or comment off once your reply is last, and never on a push or a PR that links it", () => {
    expect(turn(pr({ reviewFeedback: { openThreads: 0, comment: null, repliedAt: at(13) } }))).toBeNull();
    expect(turn({ ...comments, reviewFeedback: { ...comments.reviewFeedback!, repliedAt: at(13) } })).toBeNull();
    expect(why({ ...comments, headCommittedAt: at(13) })).toBe("Comment from @theo-k");
    expect(why({ ...comments, reviewFeedback: { ...comments.reviewFeedback!, followUpAt: at(13) } })).toBe("Comment from @theo-k");
    expect(why({ ...comments, reviewFeedback: { ...comments.reviewFeedback!, repliedAt: at(11) } })).toBe("Comment from @theo-k");
    expect(turn({ ...comments, reviewFeedback: undefined })).toBeNull();
  });

  // Answered by a push or a reply, a change request waits on your re-request, which the row offers off Your turn; GitHub's decision still
  // holds the merge. Drop it and every answered request sits on Your turn until the reviewer comes back.
  it("takes a change request off once you pushed or replied after it, and offers Re-request", () => {
    for (const answered of [pr({ ...changes, headCommittedAt: at(13) }), pr({ ...changes, reviewFeedback: { openThreads: 0, comment: null, repliedAt: at(13) } })]) {
      expect(turn(answered)).toBeNull();
      expect(reasons(answered)).toContainEqual(expect.objectContaining({ kind: "rereview-needed", action: "rerequest", reviewers: ["otto-v"] }));
    }
    expect(why(pr({ ...changes, reviewFeedback: { openThreads: 0, comment: null, repliedAt: at(9) } }))).toBe("Changes requested by @otto-v");
    expect(turn({ ...changes, reviewRequests: ["otto-v"] })).toBeNull();
  });

  // An approval's note waits on your reply whatever CI says; once you replied it waits only on your Confirm, which still blocks the merge.
  it("keeps an approval comment on until you reply on the PR, then leaves it to Confirm", () => {
    for (const checks of [["PENDING"], ["FAILURE"]]) expect(why({ ...approval, checkConclusions: checks, mergeStateStatus: "UNSTABLE" })).toBe("Approval comment from @mira-l");
    // A PR that mentions it later, or a worker's evidence, is no answer the reviewer sees.
    expect(why({ ...approval, approvalFeedbackVerified: true, reviewFeedback: { ...approval.reviewFeedback!, followUpAt: at(14) } })).toBe("Approval comment from @mira-l");
    const answered = pr({ ...approval, reviewFeedback: { ...approval.reviewFeedback!, repliedAt: at(13) } });
    expect(turn(answered)).toBeNull();
    expect(reasons(answered)).toEqual([expect.objectContaining({ kind: "approval-comments", action: "confirm-handled" })]);
    expect(turn({ ...approval, approvalFeedbackVerified: true, approvalFeedbackConfirmed: true })).toBeNull();
  });

  it("leaves off a held or closed PR, one waiting on CI or reviewers, and a draft but for its comments and approval notes", () => {
    for (const facts of [changes, approval, threads, comments]) {
      expect(turn(facts, true)).toBeNull();
      expect(turn({ ...facts, state: "MERGED" })).toBeNull();
    }
    for (const facts of [changes, threads]) expect(turn({ ...facts, isDraft: true })).toBeNull();
    expect(why({ ...approval, isDraft: true })).toBe("Approval comment from @mira-l");
    expect(why({ ...comments, isDraft: true })).toBe("Comment from @theo-k");
    expect(turn(pr({ checkConclusions: ["FAILURE"], mergeStateStatus: "UNSTABLE" }))).toBeNull();
    expect(turn(pr({ reviewRequests: ["mira-l"] }))).toBeNull();
  });
});

// Dismiss hides a row from Your turn on the head it saw, like Reviews' dismissed items: a new head or a person's newer word brings it back.
// It keeps the newest word the row showed, not the click's time: a comment written before the click but read after it was never seen.
describe("Dismiss", () => {
  const head = base.headRefOid!;
  const seen = { head, latest: turn(comments)!.latest };
  it("hides until the head moves or a person says something newer than the row showed", () => {
    expect(dismissed(seen, head, turn(comments))).toBe(true);
    expect(dismissed(seen, "d".repeat(40), turn(comments))).toBe(false);
    const unseen = pr({ ...comments, reviewFeedback: { ...comments.reviewFeedback!, comment: { login: "theo-k", at: "2026-09-29T12:55:00.000Z" } } });
    expect(dismissed(seen, head, turn(unseen))).toBe(false);
    expect(dismissed(seen, head, turn(pr({ ...changes, latestReviews: [{ login: "otto-v", state: "CHANGES_REQUESTED", submittedAt: at(14) }] })))).toBe(false);
    // Nothing waiting, or never dismissed, is nothing to hide.
    expect(dismissed(seen, head, null)).toBe(false);
    expect(dismissed(null, head, turn(comments))).toBe(false);
  });
});

// A sent PR's one link reads its batch item while the batch waits or was refused, else its newest claim and BB's status for that thread.
// The link outlives the claim for as long as the PR is open; only a newer batch replaces it.
describe("a sent PR", () => {
  const T = 1_000_000;
  const item = (state: SentItem["state"], detail: string | null = null): SentItem => ({ state, detail, batchId: "b-2", confirmedAt: T });
  const run = (status: string, startedAt = T + 8_000): SentRun => ({ threadId: "thr-1", status, startedAt });
  const shown = (sent: Sent | null) => sent && [sent.state, sent.threadId, sentText(sent)];
  const thread = (active: boolean) => ({ title: "Address feedback: catalog #96", active });

  it("shows Sending with Undo, then its thread with BB's live status, and keeps the link after the thread ends", () => {
    expect(shown(sentState(item("queued"), null, null))).toEqual(["sending", null, "Sending"]);
    expect(sentState(item("queued"), null, null)?.batchId).toBe("b-2");
    expect(sentState(item("sending"), null, null)?.batchId).toBeNull();
    expect(shown(sentState(item("sent"), run("running"), thread(true)))).toEqual(["working", "thr-1", "Working"]);
    expect(shown(sentState(item("sent"), run("needs-you"), thread(false)))).toEqual(["needs-you", "thr-1", "Needs you"]);
    // The claim ended, however it ended: the link stays, and BB says whether the thread works again.
    for (const status of ["done", "failed"]) {
      expect(shown(sentState(item("sent"), run(status), thread(false)))).toEqual(["idle", "thr-1", "Idle"]);
      expect(shown(sentState(null, run(status), thread(true)))).toEqual(["working", "thr-1", "Working"]);
    }
    expect(sentState(null, run("done"), null)).toMatchObject({ state: "idle", threadId: "thr-1", title: null });
  });

  it("says why dispatch refused it, and lets a newer batch replace an older thread's link", () => {
    const old = run("done", T - 3_600_000);
    expect(shown(sentState(item("refused", "On hold. Release it first."), old, null))).toEqual(["refused", null, "Not sent: On hold. Release it first."]);
    expect(shown(sentState(item("queued"), old, null))).toEqual(["sending", null, "Sending"]);
    expect(shown(sentState(item("unknown", "The plugin restarted"), { ...run("running"), threadId: "thr-2" }, thread(true)))).toEqual(["working", "thr-2", "Working"]);
  });
});
