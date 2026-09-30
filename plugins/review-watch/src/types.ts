// Shared vocabulary for review-watch. Everything the GitHub layer produces and
// every surface consumes is described here, so the poller, the queue, the CLI,
// and the page cannot drift apart.
import { z } from "zod";

/** Why an item is in the queue. One rule, one reason a human must act. */
export const ruleSchema = z.enum([
  // Someone named me as a reviewer and I have not reviewed this head commit.
  "review-requested",
  // I reviewed an earlier commit; the author has pushed since.
  "review-followup",
  // My own pull request carries review feedback I have not answered.
  "feedback-to-address",
]);
export type Rule = z.infer<typeof ruleSchema>;

/**
 * Queue rows are never deleted on sight of the same pull request again:
 * `dismissed` and `started` must survive a poll, or the watcher nags forever.
 */
export const itemStateSchema = z.enum(["queued", "started", "dismissed"]);
export type ItemState = z.infer<typeof itemStateSchema>;

/** A pull request as review-watch needs it, flattened out of GraphQL. */
export const pullRequestSchema = z.object({
  nodeId: z.string(),
  repo: z.string(), // "owner/name"
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  author: z.string(),
  isDraft: z.boolean(),
  baseBranch: z.string(),
  headBranch: z.string(),
  headSha: z.string(),
  /** When the head commit landed — the clock followup detection compares against. */
  headCommittedAt: z.string(),
  updatedAt: z.string(),
  /** GitHub's own verdict: null until someone reviews. */
  reviewDecision: z
    .enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"])
    .nullable(),
  /**
   * When the most recent CHANGES_REQUESTED review was submitted, if the pull
   * request currently carries one. Rule 3 dates the review decision against my
   * last push with this; without it a standing CHANGES_REQUESTED re-fires on
   * every commit.
   */
  changesRequestedAt: z.string().nullable(),
  /** Logins GitHub currently lists as requested reviewers (users only). */
  requestedReviewers: z.array(z.string()),
  /** My own most recent submitted review, if any. */
  myLastReview: z
    .object({
      state: z.enum([
        "APPROVED",
        "CHANGES_REQUESTED",
        "COMMENTED",
        "DISMISSED",
        "PENDING",
      ]),
      submittedAt: z.string(),
    })
    .nullable(),
  /** Unresolved review threads, with the timestamp of each one's last comment. */
  unresolvedThreads: z.array(
    z.object({ lastCommentAt: z.string(), author: z.string() }),
  ),
});
export type PullRequest = z.infer<typeof pullRequestSchema>;

export const queueItemSchema = z.object({
  /** `${rule}:${nodeId}:${headSha}` — the whole dedup story lives in this key. */
  key: z.string(),
  rule: ruleSchema,
  state: itemStateSchema,
  repo: z.string(),
  number: z.number().int().positive(),
  title: z.string(),
  author: z.string(),
  url: z.string(),
  baseBranch: z.string(),
  headBranch: z.string(),
  headSha: z.string(),
  nodeId: z.string(),
  /** One line a human reads to decide whether to open it. */
  reason: z.string(),
  /** When review-watch first saw this item. */
  noticedAt: z.string(),
  /** The pull request's own updatedAt, for sorting. */
  updatedAt: z.string(),
  /** Set once a thread has been started for this item. */
  threadId: z.string().optional(),
});
export type QueueItem = z.infer<typeof queueItemSchema>;

export function itemKey(rule: Rule, nodeId: string, headSha: string): string {
  return `${rule}:${nodeId}:${headSha}`;
}
