// Three live PRs read as ready, as only red CI, or as off Your turn, while a reviewer's words waited on an answer. Here they are with
// Inkwell names, run through every view the server and the deck compose: attention, All PRs' state and Your turn, the deck's sections, the
// legacy board, and the fresh merge preview. While the feedback waits, nothing reads ready and nothing offers or accepts a merge; only your
// reply on the PR clears it; a push never does, a PR that mentions it never does, and a bot's comment neither holds nor answers anything.
import { describe, expect, it } from "vitest";
import { mergeVerdict, type LiveMergeFacts } from "./actions.js";
import type { ApprovalFeedbackRecord } from "./approval-feedback.js";
import type { Pr } from "./contract.js";
import { deckRows } from "./deck.js";
import { parsePrList } from "./gh.js";
import { reviewFeedbackOf } from "./ghactions.js";
import { inventoryRow } from "./inventory-view.js";
import { inventoryLine } from "./inventory-view-model.js";
import { pipelineCards } from "./pipeline.js";
import { DEFAULT_ATTENTION_THRESHOLDS, prAttention, type StateSince } from "./pr-attention.js";
import { prLifecycle } from "./workstreams.js";

const NOW = Date.UTC(2026, 8, 30, 15);
const HOUR = 3_600_000;
const iso = (at: number) => new Date(at).toISOString();
const HEAD = "a".repeat(40), PUSHED = "b".repeat(40);
const url = (number: number) => `https://github.com/inkwell/folio/pull/${number}`;
const FEEDBACK = (number: number) => ({ status: "present" as const, fingerprint: String(number).padStart(64, "f"), sourceIds: [`review-${number}`] });
/** A worker's evidence for the approval's notes on `head`, which verifies the head but answers no one on GitHub. */
const worker = (number: number, head: string): ApprovalFeedbackRecord => ({ prUrl: url(number), threadId: "thr_worker", attemptId: "attempt-1", headOid: head,
  fingerprint: FEEDBACK(number).fingerprint, verifiedAt: NOW - 20 * HOUR, blockers: [],
  findings: [{ sourceId: `review-${number}`, resolution: "no-change-needed", evidence: "The approval asks for nothing more in this PR.",
    validation: { outcome: "passed", detail: "Shelf tests passed." } }] });

type Shape = { pr: Pr; record: ApprovalFeedbackRecord | null; since: StateSince };
/** A PR as the server holds it after a full read, with its approval verified as the store would find `record` on its head. */
function shape(number: number, title: string, reviewer: string, review: { body: string; at: number }, patch: Partial<Pr>, record: ApprovalFeedbackRecord | null,
  since: StateSince = {}): Shape {
  const base = parsePrList(JSON.stringify([{ number, url: url(number), state: "OPEN", title, isDraft: false, reviewDecision: "APPROVED", mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN", headRefOid: HEAD, baseRefName: "main", headRefName: `ana/${number}`, reviewRequests: [], statusCheckRollup: [{ conclusion: "SUCCESS" }],
    latestReviews: [{ author: { login: reviewer }, state: "APPROVED", submittedAt: iso(review.at) }] }]))!.pr;
  // The review read, as GitHub returns it: the approval with its body, no thread, and nothing from ana since.
  const read = reviewFeedbackOf({ author: { login: "ana-w" }, baseRefName: "main",
    reviews: { nodes: [{ id: `review-${number}`, state: "APPROVED", body: review.body, submittedAt: iso(review.at), author: { __typename: "User", login: reviewer } }] },
    comments: { nodes: [] }, timelineItems: { nodes: [] } }, [], { reviewIds: new Set([`review-${number}`]), threads: new Map(), at: iso(review.at) });
  const pr: Pr = { ...base, createdAt: iso(NOW - 96 * HOUR), headCommittedAt: iso(review.at - 2 * HOUR), unresolvedReviewThreads: 0, resolvedReviewThreads: 0,
    approvalFeedback: FEEDBACK(number), reviewFeedback: read, ...patch };
  return { pr: verified(pr, record), record, since };
}
/** The server's own view of the store: a worker's evidence verifies its head, and only your confirmation sets the confirmed flag. */
const verified = (pr: Pr, record: ApprovalFeedbackRecord | null): Pr => ({ ...pr, approvalFeedbackVerified: record?.headOid === pr.headRefOid,
  approvalFeedbackConfirmed: false });

/**
 * The first live case: an approval whose body says the work isn't done, and nothing after it: no reply, no fix, no thread. A worker judged
 * it needed no change, so its evidence verifies the head, and the PR read "Ready to merge".
 */
const bodyComment = () => shape(360, "ABC-380 Show series order on shelves", "mira-l",
  { body: "listSeriesNames still returns every name, so the shelf shows series it doesn't carry.", at: NOW - 30 * HOUR }, {}, worker(360, HEAD));
/**
 * The second: a conditional approval, then a push that turned CI red. It read "Ready to merge" before the push and "CI failing" after,
 * which hid the condition.
 */
const conditional = (patch: Partial<Pr> = {}) => shape(361, "ABC-381 Carry series in shelf order", "theo-k",
  { body: "Approving, on the understanding that series-aware ordering comes in a separate PR. Without it a shelf mixes two series.", at: NOW - 30 * HOUR },
  { headRefOid: PUSHED, headCommittedAt: iso(NOW - 3 * HOUR), checkConclusions: ["FAILURE"], mergeStateStatus: "UNSTABLE", ...patch }, worker(361, HEAD),
  { "ci-red": NOW - 26 * HOUR });

/** The third live case's approval: its condition names work a later PR does. */
const STACKED_CONDITION = "Approving, on the understanding that series-aware ordering will come in a separate PR, before shelves carry two series.";

/** Everything each view shows for one PR, computed as the server and the deck compose it. */
function views({ pr, record, since }: Shape) {
  const { reasons } = prAttention(pr, { holds: {}, effort: null, since }, { now: NOW, thresholds: DEFAULT_ATTENTION_THRESHOLDS, utcOffsetMinutes: 0 });
  const row = inventoryRow({ prUrl: pr.url, pr, authored: true, stale: false, read: null, reasons, hold: null, observation: null, managed: null, stackedOn: null,
    links: [], attemptThread: null, threads: new Map(), suggestedReviewers: [], lastAction: null, confirmation: null });
  const line = inventoryLine(row, new Map(), { now: NOW, limitedUntil: null });
  const [deck] = deckRows({ now: NOW, efforts: [], rows: [{ ...row, effort: null, pr, tickets: [], decision: null, acted: null }] });
  const [card] = pipelineCards([{ repo: "inkwell/folio", pr, stale: false }], [], NOW);
  const live: LiveMergeFacts = { state: "OPEN", isDraft: false, reviewDecision: pr.reviewDecision, mergeStateStatus: pr.mergeStateStatus as LiveMergeFacts["mergeStateStatus"],
    headRefOid: pr.headRefOid ?? null, stackedAbove: [], unresolvedThreads: 0, unresolvedAtLeast: false, approvalNotes: [], approvalNotesMore: 0,
    approvalNotesComplete: true, approvalFeedback: pr.approvalFeedback!, reviewFeedback: pr.reviewFeedback };
  return { reasons: reasons.map((reason) => reason.kind), status: line.status, primary: line.primary, lineMerge: line.actions.some((action) => action.id === "merge"),
    yourTurn: row.yourTurn?.text ?? null, section: deck!.row.section, lifecycle: prLifecycle(pr), board: card!.blocker.label, boardAction: card!.action?.kind ?? null,
    preview: mergeVerdict(live, record).refusals };
}
const WAITS = "An approval comment waits on your answer: reply on the PR or confirm it.";

describe("feedback to address holds a PR from ready and from merge", () => {
  it("holds an approval whose body asks for more, with no reply, over a worker's evidence, in every view", () => {
    expect(views(bodyComment())).toEqual({ reasons: ["approval-note"], status: "Approval comment to address", primary: "confirm-handled", lineMerge: false,
      yourTurn: "Approval comment to address", section: "confirm", lifecycle: "approved-with-note", board: "Approval comment to address", boardAction: "advance",
      preview: [WAITS] });
  });

  it("names a conditional approval beside red CI after a push, and keeps it on Your turn", () => {
    expect(views(conditional())).toEqual({ reasons: ["approval-note", "ci-red"], status: "CI failing · approval comment to address", primary: "confirm-handled",
      lineMerge: false, yourTurn: "Approval comment to address", section: "confirm", lifecycle: "blocked", board: "CI failing · approval comment to address",
      boardAction: "advance", preview: ["Approval feedback needs verified follow-up on the current head.", WAITS] });
    // Green again on that head, with the worker's evidence carried to it, it still waits on the condition: nothing offers the merge.
    const green = conditional({ checkConclusions: ["SUCCESS"], mergeStateStatus: "CLEAN" });
    const carried = { ...green, record: worker(361, PUSHED), pr: verified(green.pr, worker(361, PUSHED)), since: {} };
    expect(views(carried)).toMatchObject({ status: "Approval comment to address", section: "confirm", lifecycle: "approved-with-note", lineMerge: false,
      boardAction: "advance", preview: [WAITS] });
  });

  // Commits say nothing to a reviewer: a push, even one that fixes the code, leaves the note waiting.
  it("never clears on a push alone", () => {
    const pushed = bodyComment();
    const later = { ...pushed, record: worker(360, PUSHED), pr: verified({ ...pushed.pr, headRefOid: PUSHED, headCommittedAt: iso(NOW - HOUR) }, worker(360, PUSHED)) };
    expect(views(later)).toMatchObject({ reasons: ["approval-note"], status: "Approval comment to address", section: "confirm", preview: [WAITS] });
  });

  it("clears with your reply after the note, and the PR reads ready and merges through its preview", () => {
    const { pr, record } = bodyComment();
    const replied = { pr: { ...pr, reviewFeedback: { ...pr.reviewFeedback!, repliedAt: iso(NOW - 2 * HOUR) } }, record, since: {} };
    expect(views(replied)).toMatchObject({ reasons: ["merge-waiting"], status: "Ready to merge", primary: "merge", lineMerge: true, yourTurn: null, section: "merge",
      lifecycle: "awaiting-merge", board: "Clear", boardAction: "merge", preview: [] });
  });

  /**
   * The third: a conditional approval, then, hours later, the rest of its stack: folio #362 on main and catalog #97 in a sibling
   * repository, whose bodies mention this PR. GitHub cross-references each from ana-w, and the approval dropped off Your turn as if they
   * answered it, with no reply on the PR. Only ana-w's reply on the PR after the note does.
   */
  it("keeps a conditional approval on Your turn when the rest of its stack mentions the PR, until you reply on it", () => {
    const green = conditional({ checkConclusions: ["SUCCESS"], mergeStateStatus: "CLEAN" });
    const mention = (hours: number, repo: string, number: number) => ({ createdAt: iso(NOW - hours * HOUR), isCrossRepository: repo !== "inkwell/folio",
      actor: { __typename: "User", login: "ana-w" }, source: { __typename: "PullRequest", number, baseRefName: "main", repository: { nameWithOwner: repo } } });
    const read = (reply: { comments?: unknown[]; reviews?: unknown[] } = {}) => reviewFeedbackOf({ author: { login: "ana-w" }, baseRefName: "main",
      reviews: { nodes: [{ id: "review-361", state: "APPROVED", body: STACKED_CONDITION, submittedAt: iso(NOW - 30 * HOUR),
        author: { __typename: "User", login: "theo-k" } }, ...reply.reviews ?? []] }, comments: { nodes: reply.comments ?? [] },
      timelineItems: { nodes: [mention(6, "inkwell/folio", 362), mention(5, "inkwell/catalog", 97)] } },
      [], { reviewIds: new Set(["review-361"]), threads: new Map(), at: iso(NOW - 30 * HOUR) });
    const shown = (reviewFeedback: Pr["reviewFeedback"]) =>
      views({ pr: verified({ ...green.pr, reviewFeedback }, worker(361, PUSHED)), record: worker(361, PUSHED), since: {} });
    // The read still dates the stack's mentions, for the confirm to show; they answer nothing.
    const mentioned = read();
    expect(mentioned).toMatchObject({ repliedAt: null, noteAt: iso(NOW - 30 * HOUR), followUpAt: iso(NOW - 5 * HOUR) });
    expect(shown(mentioned)).toEqual({ reasons: ["approval-note"], status: "Approval comment to address", primary: "confirm-handled", lineMerge: false,
      yourTurn: "Approval comment to address", section: "confirm", lifecycle: "approved-with-note", board: "Approval comment to address", boardAction: "advance",
      preview: [WAITS] });
    // ana-w's reply after the note, in the conversation or as a review, answers it.
    const ready = { status: "Ready to merge", yourTurn: null, section: "merge", lineMerge: true, preview: [] };
    expect(shown(read({ comments: [{ createdAt: iso(NOW - 2 * HOUR), author: { __typename: "User", login: "ana-w" } }] }))).toMatchObject(ready);
    expect(shown(read({ reviews: [{ id: "review-362", state: "COMMENTED", body: "Series-aware ordering is catalog #97.", submittedAt: iso(NOW - 2 * HOUR),
      author: { __typename: "User", login: "ana-w" } }] }))).toMatchObject(ready);
  });

  // A deploy preview's or a tracker's comment is no reviewer's word: it neither holds a ready PR nor answers a waiting note.
  it("never counts a bot's comment, as feedback or as an answer", () => {
    const { pr, record } = bodyComment();
    const withBots = (replied: boolean) => reviewFeedbackOf({ author: { login: "ana-w" }, baseRefName: "main",
      reviews: { nodes: [{ id: "review-360", state: "APPROVED", body: "listSeriesNames still returns every name.", submittedAt: iso(NOW - 30 * HOUR),
        author: { __typename: "User", login: "mira-l" } }] },
      comments: { nodes: [{ createdAt: iso(NOW - 4 * HOUR), author: { __typename: "Bot", login: "vercel" } },
        { createdAt: iso(NOW - 3 * HOUR), author: { __typename: "Bot", login: "linear" } },
        ...replied ? [{ createdAt: iso(NOW - 2 * HOUR), author: { __typename: "User", login: "ana-w" } }] : []] }, timelineItems: { nodes: [] } },
      [], { reviewIds: new Set(["review-360"]), threads: new Map(), at: iso(NOW - 30 * HOUR) });
    expect(views({ pr: { ...pr, reviewFeedback: withBots(false) }, record, since: {} })).toMatchObject({ status: "Approval comment to address", preview: [WAITS] });
    expect(views({ pr: { ...pr, reviewFeedback: withBots(true) }, record, since: {} })).toMatchObject({ status: "Ready to merge", preview: [] });
  });

  // Another person's question holds the merge the same way, until you answer it.
  it("holds a reviewer's comment after the approval until you reply", () => {
    const { pr, record } = bodyComment();
    const asked = { ...pr.reviewFeedback!, repliedAt: iso(NOW - 20 * HOUR), comment: { login: "pia-r", at: iso(NOW - 5 * HOUR) } };
    expect(views({ pr: { ...pr, reviewFeedback: asked }, record, since: {} })).toMatchObject({ reasons: ["review-comments"], status: "Comment to address",
      primary: "thread", section: "work", lineMerge: false, lifecycle: "approved-with-comments", boardAction: "advance",
      preview: ["A comment from @pia-r waits on your answer."] });
    expect(views({ pr: { ...pr, reviewFeedback: { ...asked, repliedAt: iso(NOW - HOUR) } }, record, since: {} }))
      .toMatchObject({ status: "Ready to merge", section: "merge", preview: [] });
  });
});
