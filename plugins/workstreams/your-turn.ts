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
  /** Each kind in a few words, first kind first: "Changes requested by @mira · 2 open threads". */
  text: z.string(),
  /** When the oldest feedback it names arrived, in epoch ms; null when nothing dates it. */
  since: z.number().nullable(),
}).strict();
export type YourTurn = z.infer<typeof yourTurnSchema>;

export type YourTurnFacts = Pick<Pr, "state" | "isDraft" | "reviewRequests" | "latestReviews" | "reviewFeedback">;

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
export function yourTurn(pr: YourTurnFacts, reasons: readonly Pick<AttentionReason, "kind" | "since">[], held: boolean): YourTurn | null {
  if (held || pr.state !== "OPEN") return null;
  const parts: { kind: YourTurnKind; text: string; since: number | null }[] = [];
  // Asked again, the next move is theirs; a verified follow-up still leaves asking them yours.
  const changes = pr.isDraft ? [] : awaitingRerequest(pr).filter((review) => review.state === "CHANGES_REQUESTED");
  if (changes.length) parts.push({ kind: "changes", text: `Changes requested by ${mentions(changes.map((review) => review.login))}`,
    since: Math.min(...changes.map((review) => time(review.submittedAt) ?? Number.POSITIVE_INFINITY)) });
  const note = reasons.find((reason) => reason.kind === "approval-note");
  const approval = note ?? reasons.find((reason) => reason.kind === "approval-comments");
  if (approval) parts.push({ kind: "approval", text: note ? "Approval comment to address" : "Approved with comments", since: approval.since });
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
