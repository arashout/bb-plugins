// Your turn: your open PRs where a reviewer's feedback waits on your move,
// from facts the inventory already keeps. Changes someone asked for that you
// haven't asked them to review again, an approval whose comments aren't
// verified handled, review threads someone else opened that are still open,
// and a reviewer's comments newer than your last push and your last reply.
// A draft, a PR you hold, and a PR waiting only on CI or on reviewers are not
// your turn. Pure: the server computes it per row; the badge and the list
// only count and show it.
import { z } from "zod";
import type { Pr } from "./contract.js";
import { awaitingRerequest } from "./pr-gates.js";

/**
 * What a PR's own review read shows of feedback on it (inventory.ts): open threads someone else started, the newest comment from a
 * reviewer who hasn't approved it, and its author's newest reply. An approver's notes are its approval feedback, so they never count here.
 */
export const reviewFeedbackSchema = z.object({
  openThreads: z.number().int().min(0).max(2_000),
  comment: z.object({ login: z.string().max(140), at: z.string().max(40) }).strict().nullable(),
  repliedAt: z.string().max(40).nullable(),
}).strict();
export type ReviewFeedback = z.infer<typeof reviewFeedbackSchema>;

export const YOUR_TURN_KINDS = ["changes", "approval", "threads", "comments"] as const;
export type YourTurnKind = (typeof YOUR_TURN_KINDS)[number];
export const yourTurnSchema = z.object({
  kinds: z.array(z.enum(YOUR_TURN_KINDS)).min(1),
  /** Each kind in a few words, first kind first: "Changes requested by @mira · 2 open threads". */
  text: z.string(),
  /** When the oldest feedback it names arrived, in epoch ms; null when nothing dates it. */
  since: z.number().nullable(),
}).strict();
export type YourTurn = z.infer<typeof yourTurnSchema>;

export type YourTurnFacts = Pick<Pr, "state" | "isDraft" | "reviewDecision" | "reviewRequests" | "latestReviews" | "approvalFeedback" |
  "approvalFeedbackVerified" | "headCommittedAt" | "reviewFeedback">;

const time = (value: string | null | undefined): number | null => {
  const at = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(at) ? null : at;
};
const mentions = (logins: readonly string[]) => logins.map((login) => `@${login}`).join(", ");

/** A reviewer's comment newer than your last push and your last reply, or null. An undated push leaves it unknown, so it asks nothing. */
export function commentsSince(pr: Pick<Pr, "headCommittedAt" | "reviewFeedback">): { login: string; at: number } | null {
  const comment = pr.reviewFeedback?.comment;
  const at = time(comment?.at), pushed = time(pr.headCommittedAt);
  if (!comment || at === null || pushed === null) return null;
  return at > Math.max(pushed, time(pr.reviewFeedback!.repliedAt) ?? Number.NEGATIVE_INFINITY) ? { login: comment.login, at } : null;
}

/** Whether reviewer feedback waits on you on this PR, and which. `held`: you hold the PR, which parks it until you release it. */
export function yourTurn(pr: YourTurnFacts, held: boolean): YourTurn | null {
  if (held || pr.state !== "OPEN" || pr.isDraft) return null;
  const parts: { kind: YourTurnKind; text: string; since: number | null }[] = [];
  // Asked again, the next move is theirs; a verified follow-up still leaves asking them yours.
  const changes = awaitingRerequest(pr).filter((review) => review.state === "CHANGES_REQUESTED");
  if (changes.length) parts.push({ kind: "changes", text: `Changes requested by ${mentions(changes.map((review) => review.login))}`,
    since: Math.min(...changes.map((review) => time(review.submittedAt) ?? Number.POSITIVE_INFINITY)) });
  if (pr.reviewDecision === "APPROVED" && pr.approvalFeedback?.status === "present" && pr.approvalFeedbackVerified !== true) {
    const approved = pr.latestReviews.filter((review) => review.state === "APPROVED").map((review) => time(review.submittedAt) ?? Number.POSITIVE_INFINITY);
    parts.push({ kind: "approval", text: "Approved with comments", since: approved.length ? Math.max(...approved) : null });
  }
  const open = pr.reviewFeedback?.openThreads ?? 0;
  if (open > 0) parts.push({ kind: "threads", text: `${open} open ${open === 1 ? "thread" : "threads"}`, since: null });
  const comment = commentsSince(pr);
  if (comment) parts.push({ kind: "comments", text: `New comments from @${comment.login}`, since: comment.at });
  if (!parts.length) return null;
  const dated = parts.flatMap((part) => part.since !== null && Number.isFinite(part.since) ? [part.since] : []);
  return { kinds: parts.map((part) => part.kind), text: parts.map((part) => part.text).join(" · "), since: dated.length ? Math.min(...dated) : null };
}
