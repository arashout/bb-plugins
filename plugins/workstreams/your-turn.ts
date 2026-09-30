// Your turn: your open PRs where a reviewer's feedback waits on your move,
// from facts the inventory already keeps. Feedback to address, whatever CI
// says: an approval that said something, as attention's approval-note reason
// names it, and another person's comment, that neither your reply on the PR
// nor your confirmation answered. Then changes someone asked for that you
// haven't asked them to review again, review threads someone else opened
// that are still open, and notes you answered that attention asks you to
// confirm. A push answers none of it, and neither does an issue or a PR that
// mentions this one. A PR you hold, and one waiting only on CI or on
// reviewers, are not your turn; a draft is only for its feedback to address.
// Pure: the server computes it per row; the badge and the list only count
// and show it.
import { z } from "zod";
import type { Pr } from "./contract.js";
import type { AttentionReason } from "./pr-attention.js";
import { feedbackToAddress } from "./feedback-to-address.js";
import { awaitingRerequest } from "./pr-gates.js";

export const YOUR_TURN_KINDS = ["changes", "approval", "threads", "comments"] as const;
export type YourTurnKind = (typeof YOUR_TURN_KINDS)[number];
export const yourTurnSchema = z.object({
  kinds: z.array(z.enum(YOUR_TURN_KINDS)).min(1),
  /** Each kind in a few words, first kind first: "Changes requested by @mira · 2 open threads", or "Answered @mira · re-request review" once you have. */
  text: z.string(),
  /** When the oldest feedback it names arrived, in epoch ms; null when nothing dates it. */
  since: z.number().nullable(),
}).strict();
export type YourTurn = z.infer<typeof yourTurnSchema>;

export type YourTurnFacts = Pick<Pr, "state" | "isDraft" | "reviewRequests" | "latestReviews" | "reviewFeedback">;

/** The approval's part as yourTurn words it: a listing finds it by these words, since another part holds a " · " of its own. */
const APPROVAL_NOTE = "Approval comment to address";
const APPROVAL_COMMENTS = "Approved with comments";

const time = (value: string | null | undefined): number | null => {
  const at = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(at) ? null : at;
};
const mentions = (logins: readonly string[]) => logins.map((login) => `@${login}`).join(", ");

/**
 * Whether reviewer feedback waits on you on this PR, and which. `reasons` is its attention: its approval-note reason asks whatever CI says,
 * and its approval-comments reason, for notes you answered, only once nothing else holds the merge. `held`: you hold the PR, which parks it
 * until you release it.
 */
export function yourTurn(pr: YourTurnFacts, reasons: readonly Pick<AttentionReason, "kind" | "since" | "reviewers">[], held: boolean): YourTurn | null {
  if (held || pr.state !== "OPEN") return null;
  const parts: { kind: YourTurnKind; text: string; since: number | null }[] = [];
  // Asked again, the next move is theirs; a verified follow-up still leaves asking them yours.
  const changes = pr.isDraft ? [] : awaitingRerequest(pr).filter((review) => review.state === "CHANGES_REQUESTED");
  // A change request you answered, which attention says to ask again, waits on your re-request, not on changes.
  const asking = new Set(reasons.filter((reason) => reason.kind === "rereview-needed").flatMap((reason) => reason.reviewers.map((login) => login.toLowerCase())));
  const answered = changes.filter((review) => asking.has(review.login.toLowerCase()));
  const unanswered = changes.filter((review) => !asking.has(review.login.toLowerCase()));
  if (changes.length) parts.push({ kind: "changes", since: Math.min(...changes.map((review) => time(review.submittedAt) ?? Number.POSITIVE_INFINITY)),
    text: [...unanswered.length ? [`Changes requested by ${mentions(unanswered.map((review) => review.login))}`] : [],
      ...answered.length ? [`Answered ${mentions(answered.map((review) => review.login))} · re-request review`] : []].join(" · ") });
  const note = reasons.find((reason) => reason.kind === "approval-note");
  const approval = note ?? reasons.find((reason) => reason.kind === "approval-comments");
  if (approval) parts.push({ kind: "approval", text: note ? APPROVAL_NOTE : APPROVAL_COMMENTS, since: approval.since });
  const open = pr.isDraft ? 0 : pr.reviewFeedback?.openThreads ?? 0;
  if (open > 0) parts.push({ kind: "threads", text: `${open} open ${open === 1 ? "thread" : "threads"}`, since: null });
  // Another person's comment that no reply on the PR answered; a push or a PR that mentions this one never does.
  const comment = feedbackToAddress({ reviewFeedback: pr.reviewFeedback }, false).find((item) => item.kind === "comment");
  // A reviewer whose change request it names already has their say there: their review is a comment too, and naming it twice says nothing.
  if (comment && !changes.some((review) => review.login === comment.login)) parts.push({ kind: "comments", text: `New comments from @${comment.login}`, since: comment.since });
  if (!parts.length) return null;
  const dated = parts.flatMap((part) => part.since !== null && Number.isFinite(part.since) ? [part.since] : []);
  return { kinds: parts.map((part) => part.kind), text: parts.map((part) => part.text).join(" · "), since: dated.length ? Math.min(...dated) : null };
}

/**
 * Your turn's feedback as a listing names it, with who left each: "Approval comment from @mira-l · 3 open threads". `reviewed` is the PR's
 * latest review per reviewer, whose approvers the approval's part names.
 */
export function turnSummary(turn: Pick<YourTurn, "text">, reviewed: readonly { login: string; state: string }[]): string {
  const approvers = reviewed.filter((review) => review.state.toUpperCase() === "APPROVED").map((review) => review.login);
  return turn.text.split(" · ").map((part) => approvers.length && (part === APPROVAL_NOTE || part === APPROVAL_COMMENTS) ? `Approval comment from ${mentions(approvers)}` : part).join(" · ");
}

/**
 * Where the last Address batch sent a PR, and how that stands now: waiting out its Undo window, its thread working or waiting on you, what
 * the thread reported once it ended (done, blocked, or no report at all), or why dispatch refused it. It keeps the thread's link however
 * the thread ends, until a newer batch takes the PR, or feedback newer than the thread's end replaces what it answered.
 */
export const SENT_STATES = ["sending", "working", "needs-you", "done", "blocked", "no-report", "refused"] as const;
export type SentState = (typeof SENT_STATES)[number];
export const sentSchema = z.object({
  state: z.enum(SENT_STATES), threadId: z.string().nullable(), title: z.string().nullable(),
  /** The report in a word ("pushed", "replied"), a blocker's summary, or why dispatch refused it. */
  detail: z.string().nullable(),
  /** The batch still in its Undo window, which Undo takes back. */
  batchId: z.string().nullable(),
}).strict();
export type Sent = z.infer<typeof sentSchema>;
/** The PR's newest Address item: its state, the batch's, and when the batch was confirmed. */
export type SentItem = { state: "queued" | "sending" | "sent" | "refused" | "unknown"; detail: string | null; batchId: string; confirmedAt: number };
/** The PR's newest batch-thread claim in the board's run record. */
export type SentRun = { threadId: string | null; status: "running" | "needs-you" | "done" | "failed" | "succeeded"; startedAt: number; finishedAt: number | null;
  result: string | null; error: string | null };
/** How a claim settles when the thread gave no report: none in its output, or it went before its output was read. */
const NO_REPORT = /^No result line for this PR\.|report was never read/u;

/** A PR's Sent from its newest Address item and newest claim; `since` is when the feedback now waiting on you arrived, if dated. */
export function sentState(item: SentItem | null, run: SentRun | null, title: string | null, since: number | null): Sent | null {
  const none = { threadId: null, title: null, detail: null, batchId: null };
  if (item?.state === "queued" || item?.state === "sending") return { ...none, state: "sending", batchId: item.state === "queued" ? item.batchId : null };
  // A claim started after the batch was confirmed is this batch's; without one, dispatch refused it or was cut off before claiming.
  const claimed = run !== null && (!item || run.startedAt >= item.confirmedAt);
  if (item && !claimed && (item.state === "refused" || item.state === "unknown")) return { ...none, state: "refused", detail: item.detail };
  if (!run) return null;
  const thread = { threadId: run.threadId, title, batchId: null };
  if (run.status === "running" || run.status === "needs-you") return { ...thread, state: run.status === "running" ? "working" : "needs-you", detail: null };
  if (since !== null && run.finishedAt !== null && since > run.finishedAt) return null;
  const text = run.result ?? run.error ?? "";
  if (run.status === "done") return { ...thread, state: "done", detail: /no-change/u.test(text) ? "replied" : "pushed" };
  if (NO_REPORT.test(text)) return { ...thread, state: "no-report", detail: null };
  return { ...thread, state: "blocked", detail: text.replace(/^Blocked: /u, "").replace(/^Reported (\S+) at \S+$/u, "reported $1") || null };
}

/** A Sent's chip: its words, and how it reads. Sending's Undo is the row's own button. */
export function sentChip(sent: Sent): { text: string; tone: "blue" | "amber" | "green" | "red" | "gray" } {
  switch (sent.state) {
    case "sending": return { text: "Sending", tone: "gray" };
    case "working": return { text: sent.threadId ? "Working" : "Starting", tone: "blue" };
    case "needs-you": return { text: "Needs you", tone: "amber" };
    case "done": return { text: `Done · ${sent.detail ?? "pushed"}`, tone: "green" };
    case "blocked": return { text: `Blocked: ${sent.detail ?? "see its thread"}`, tone: "red" };
    case "no-report": return { text: "Ended without a report", tone: "red" };
    case "refused": return { text: `Not sent: ${sent.detail ?? "refused"}`, tone: "red" };
  }
}
