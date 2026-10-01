// Your turn: your open PRs where a person's feedback waits on your move, as the Reviews plugin reads it, from facts the inventory already
// keeps. A PR is on it when any of these waits: an approval's note no reply of yours followed (attention's approval-note reason), changes a
// person asked for that neither a push nor a reply of yours followed, an open thread where another person had the last word (the review
// read skips bots' words, and your reply last is the reviewer's turn), or another person's comment no reply of yours on the PR followed.
// A bot (Claude, Codex, Copilot, CI) never puts a PR on it; a batch still addresses every comment, bots' included. A push answers no
// comment or thread, and neither does a PR that mentions this one. A PR you hold is never on it; a draft is, as Reviews counts drafts. Pure:
// the server computes it per row; the badge and the list only count and show it.
import { z } from "zod";
import type { Pr } from "./contract.js";
import type { AttentionReason } from "./pr-attention.js";
import { feedbackToAddress, isBot } from "./feedback-to-address.js";
import { answeredSince, awaitingRerequest } from "./pr-gates.js";

export const yourTurnSchema = z.object({
  /** Why, in one line: "Changes requested by @otto · Approval comment from @mira". */
  why: z.string(),
  /** When the oldest feedback it names arrived, and the newest a person left, in epoch ms; null when nothing dates it. */
  since: z.number().nullable(), latest: z.number().nullable(),
}).strict();
export type YourTurn = z.infer<typeof yourTurnSchema>;

export type YourTurnFacts = Pick<Pr, "state" | "reviewRequests" | "latestReviews" | "reviewFeedback" | "headCommittedAt">;

const time = (value: string | null | undefined): number | null => {
  const at = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(at) ? null : at;
};
const mentions = (logins: readonly string[]) => logins.map((login) => `@${login}`).join(", ");
const dates = (values: readonly (number | null)[]) => values.filter((value): value is number => value !== null && Number.isFinite(value));

/** Whether a person's feedback waits on you on this PR, and why. `reasons` is its attention; `held`: you hold the PR. */
export function yourTurn(pr: YourTurnFacts, reasons: readonly Pick<AttentionReason, "kind" | "since">[], held: boolean): YourTurn | null {
  if (held || pr.state !== "OPEN") return null;
  const people = pr.latestReviews.filter((review) => !isBot(review.login));
  const parts: { text: string; since: number | null }[] = [];
  // A person's change request that no push or reply of yours followed. Answered, it waits on your re-request, which attention offers.
  const changes = awaitingRerequest({ ...pr, latestReviews: people }).filter((review) => review.state === "CHANGES_REQUESTED" && !answeredSince(review, pr));
  if (changes.length) parts.push({ text: `Changes requested by ${mentions(changes.map((review) => review.login))}`,
    since: Math.min(...changes.map((review) => time(review.submittedAt) ?? Number.POSITIVE_INFINITY)) });
  // Only a note no reply of yours followed: notes you answered wait on the row's Confirm, which still holds the merge.
  const approval = reasons.find((reason) => reason.kind === "approval-note");
  const approvers = people.filter((review) => review.state === "APPROVED").map((review) => review.login);
  if (approval) parts.push({ text: approvers.length ? `Approval comment from ${mentions(approvers)}` : "Approval comment", since: approval.since });
  const read = pr.reviewFeedback;
  // Another person's comment no reply on the PR answered; a change request's reviewer is named once.
  const comment = feedbackToAddress({ reviewFeedback: read }, false).find((item) => item.kind === "comment");
  if (comment && !changes.some((review) => review.login === comment.login)) parts.push({ text: `Comment from @${comment.login}`, since: comment.since });
  const open = read?.openThreads ?? 0;
  if (open > 0) parts.push({ text: `${open} open ${open === 1 ? "thread" : "threads"}`, since: null });
  if (!parts.length) return null;
  const oldest = dates(parts.map((part) => part.since));
  // The newest a person said, which Dismiss compares: their approval or change request, their comment, or the approval's note.
  const newest = dates([...people.filter((review) => review.state !== "COMMENTED").map((review) => time(review.submittedAt)), time(read?.comment?.at), time(read?.noteAt)]);
  return { why: parts.map((part) => part.text).join(" · "), since: oldest.length ? Math.min(...oldest) : null, latest: newest.length ? Math.max(...newest) : null };
}

/** A Dismiss, kept per PR: the head and the newest word its row showed, so a word read after the click still brings it back. */
export const dismissalSchema = z.object({ head: z.string(), latest: z.number().nullable() }).strict();
export type Dismissal = z.infer<typeof dismissalSchema>;
/** Dismissed holds until the head moves or a person says something newer than the row showed. */
export const dismissed = (dismissal: Dismissal | null | undefined, head: string | null, turn: Pick<YourTurn, "latest"> | null): boolean =>
  !!dismissal && !!turn && dismissal.head === head && (turn.latest ?? 0) <= (dismissal.latest ?? 0);

/**
 * Where the newest Address batch sent a PR, and how its thread stands now: waiting out its Undo window, refused by dispatch, or its
 * thread's live status. The link stays for as long as the PR is open, a refusal's included, until a newer batch's thread takes it.
 */
export const SENT_STATES = ["sending", "refused", "working", "needs-you", "idle"] as const;
export const sentSchema = z.object({
  state: z.enum(SENT_STATES), threadId: z.string().nullable(), title: z.string().nullable(),
  /** Why dispatch refused it. */
  detail: z.string().nullable(),
  /** The batch still in its Undo window, which Undo takes back. */
  batchId: z.string().nullable(),
}).strict();
export type Sent = z.infer<typeof sentSchema>;
/** The PR's newest Address item: its state, the batch's, and when the batch was confirmed. */
export type SentItem = { state: "queued" | "sending" | "sent" | "refused" | "unknown"; detail: string | null; batchId: string; confirmedAt: number };
/** The PR's newest batch-thread claim, and its thread as BB lists it now. */
export type SentRun = { threadId: string | null; status: string; startedAt: number };

/** A PR's Sent from its newest Address item, its newest claim, and that claim's thread. */
export function sentState(item: SentItem | null, run: SentRun | null, thread: { title: string | null; active: boolean } | null): Sent | null {
  const none = { threadId: null, title: null, detail: null, batchId: null };
  if (item?.state === "queued" || item?.state === "sending") return { ...none, state: "sending", batchId: item.state === "queued" ? item.batchId : null };
  // A claim started after the batch was confirmed is this batch's; without one, dispatch refused it or was cut off before claiming.
  // A refusal keeps an older claim's thread linked.
  const claimed = run !== null && (!item || run.startedAt >= item.confirmedAt);
  const link = { threadId: run?.threadId ?? null, title: thread?.title ?? null };
  if (item && !claimed && (item.state === "refused" || item.state === "unknown")) return { ...none, ...link, state: "refused", detail: item.detail };
  if (!run) return null;
  // An open claim is its thread at work or asking you; once it ends, BB's own word for the thread.
  const state = run.status === "needs-you" ? "needs-you" : run.status === "running" || thread?.active ? "working" : "idle";
  return { ...none, ...link, state };
}

/** A Sent's words. Sending's Undo is the row's own button. */
export function sentText(sent: Sent): string {
  switch (sent.state) {
    case "sending": return "Sending";
    case "refused": return `Not sent: ${sent.detail ?? "refused"}`;
    case "working": return "Working";
    case "needs-you": return "Needs you";
    case "idle": return "Idle";
  }
}
