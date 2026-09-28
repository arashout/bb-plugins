// Legacy Advance keeps every batch, and one PR can sit in several. Only the
// newest batch that contains a PR describes its current legacy attempt; older
// batches stay history, even when a recheck bumped their jobs later, so they
// never inflate current counts.
import type { AdvanceBatch, AdvanceJob } from "./bulk-advance.js";
import { canonicalPrUrl } from "./pr-holds.js";

export type LegacyCause =
  | "queued" | "running" | "uncertain" | "ready" | "merged" | "closed" | "cancelled" | "not-started"
  | "review" | "ci" | "parent" | "draft" | "merge-requirements" | "writer-available" | "hold"
  | "branch" | "checks-failed" | "review-feedback" | "feedback-evidence" | "worker-blocked" | "preview-stale"
  | "verification-failed" | "fork" | "no-clone" | "unclassified";

export type LegacyAttempt = {
  batchId: string;
  job: AdvanceJob;
  cause: LegacyCause;
  label: string;
  /** Job rows for this PR across every batch: history, not current work. */
  jobs: number;
  /**
   * The newest settled job's Advance worktree, keyed as `advanceWorkspace` recomputes
   * its path (a repair keys it by attempt), with that job's worker threads, newest
   * first. An author checkout is no legacy worktree; resource selection judges it
   * by the author-checkout rules.
   */
  reusable: { path: string; batchId: string; jobId: string; threadIds: string[] } | null;
};

const ACTIVE = new Set<AdvanceJob["status"]>(["queued", "launching", "running", "verifying"]);
// advanceWorkspace creates each worktree at <root>/<batchId>/<owner>--<name>/<jobId>.
const WORKTREE = /\/\.bb\/plugins\/workstreams\/worktrees\/([\w-]+)\/[^/]+\/([\w-]+)$/u;
const BY_STATUS: Partial<Record<AdvanceJob["status"], [LegacyCause, string]>> = {
  queued: ["queued", "Queued"], launching: ["running", "Worker running"], running: ["running", "Worker running"],
  verifying: ["running", "Verifying the worker's result"], ready: ["ready", "Ready to merge"],
  "waiting-review": ["review", "Waiting for review"], "waiting-checks": ["ci", "Waiting for checks"],
  merged: ["merged", "Merged"], closed: ["closed", "Closed"], cancelled: ["cancelled", "Cancelled before work started"],
};
// Needs-attention details, after the "not confirmed" prefix that only says the worker's claim failed verification.
const NOT_CONFIRMED = "Requested work was not confirmed. GitHub: ";
const BY_DETAIL: [RegExp, LegacyCause, string][] = [
  [/^No worker exists/u, "not-started", "Not started: no worker was launched"],
  [/^On hold/u, "hold", "On hold"],
  [/base branch belongs to another open PR|^The PR below this one|^Stack dependency cycle/u, "parent", "Waiting for the parent PR"],
  [/^Waiting for approval|^Review still requests changes/u, "review", "Waiting for review"],
  [/^Waiting for checks|^Check results are incomplete/u, "ci", "Waiting for checks"],
  [/^Draft PR/u, "draft", "Draft"],
  [/^GitHub has not confirmed that all merge requirements/u, "merge-requirements", "Waiting for merge requirements"],
  [/^Another thread or action/u, "writer-available", "Another writer is active"],
  [/^Resolve conflicts|^Update the branch/u, "branch", "Branch needs updating"],
  [/^One or more checks failed/u, "checks-failed", "Checks failed"],
  [/unresolved review threads|^Review threads are incomplete|^Review requests changes|^Review follow-up could not/u, "review-feedback", "Review feedback open"],
  [/^Approval feedback/u, "feedback-evidence", "Approval feedback not verified"],
  [/^Worker reported incomplete work/u, "worker-blocked", "Worker reported incomplete work"],
  [/changed since preview|^Selected parent advanced|^PR state changed since verification/u, "preview-stale", "Changed since its preview; not started"],
  [/^Fork PRs/u, "fork", "Fork needs manual preparation"],
  [/^No matching scanned repository/u, "no-clone", "No local clone"],
  [/^Verification failed|^Inspection failed|^GitHub inspection failed/u, "verification-failed", "Verification failed"],
];

export function legacyCause(job: Pick<AdvanceJob, "status" | "detail" | "uncertain">): { cause: LegacyCause; label: string } {
  if (job.uncertain) return { cause: "uncertain", label: "Launch outcome uncertain" };
  const byStatus = BY_STATUS[job.status];
  if (byStatus) return { cause: byStatus[0], label: byStatus[1] };
  const detail = job.detail.startsWith(NOT_CONFIRMED) ? job.detail.slice(NOT_CONFIRMED.length) : job.detail;
  const match = BY_DETAIL.find(([pattern]) => pattern.test(detail));
  return match ? { cause: match[1], label: match[2] } : { cause: "unclassified", label: job.detail.slice(0, 120) };
}

/** One current legacy attempt per canonical PR URL. */
export function currentLegacyAttempts(batches: readonly AdvanceBatch[]): Map<string, LegacyAttempt> {
  const current = new Map<string, LegacyAttempt>();
  const newestFirst = [...batches].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  for (const batch of newestFirst) for (const job of batch.jobs) {
    const key = canonicalPrUrl(job.prUrl) ?? job.prUrl.toLowerCase();
    let attempt = current.get(key);
    if (!attempt) current.set(key, attempt = { batchId: batch.id, job, ...legacyCause(job), jobs: 0, reusable: null });
    attempt.jobs++;
    const worktree = !attempt.reusable && job.path && !ACTIVE.has(job.status) && !job.uncertain ? WORKTREE.exec(job.path) : null;
    if (worktree) {
      const threadIds = [job.threadId, ...job.previousAttempts.map((prior) => prior.threadId).reverse()].filter((id) => id !== null);
      attempt.reusable = { path: job.path!, batchId: worktree[1]!, jobId: worktree[2]!, threadIds: [...new Set(threadIds)] };
    }
  }
  return current;
}
