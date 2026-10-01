import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { advanceJobSchema, type AdvanceBatch } from "./bulk-advance.js";
import { INKWELL_ADVANCE_BATCHES as batches, INKWELL_ADVANCE_EFFORTS, INKWELL_ADVANCE_PR_URLS as urls } from "./inkwell-fixtures.js";
import { currentLegacyAttempts, legacyCause, type LegacyCause } from "./legacy-history.js";

const count = <T,>(values: readonly T[]) => values.reduce((totals, value) => totals.set(value, (totals.get(value) ?? 0) + 1), new Map<T, number>());
const continuation = batches.find((batch) => batch.jobs.length === 15)!;
// The fixed text of each needs-attention detail legacy Advance wrote, with the module that
// still writes it. Stored batches keep old wording, so a producer that rewords a detail fails
// here until the classifier types the new wording as well. Null: the removed engine wrote it.
const WRITTEN: [module: string | null, detail: string, cause: LegacyCause][] = [
  [null, "No worker exists for this launch. Requested work did not start; fix this item with an agent.", "not-started"],
  ["server.ts", "On hold", "hold"],
  ["advance-host.ts", "The base branch belongs to another open PR; advance that dependency first.", "parent"],
  [null, "The PR below this one needs attention first", "parent"],
  [null, "Stack dependency cycle; prepare this stack manually", "parent"],
  ["advance-host.ts", "Waiting for approval on the current PR.", "review"],
  ["advance-host.ts", "Review still requests changes; wait for a new approval after follow-up.", "review"],
  ["advance-host.ts", "Waiting for checks on the current head commit.", "ci"],
  ["advance-host.ts", "Check results are incomplete or unknown.", "ci"],
  ["advance-host.ts", "Draft PR: finish the work and mark it ready for review.", "draft"],
  ["advance-host.ts", "GitHub has not confirmed that all merge requirements are satisfied.", "merge-requirements"],
  [null, "Another thread or action is working on this PR or checkout", "writer-available"],
  ["advance-host.ts", "Resolve conflicts, test, and push the prepared branch.", "branch"],
  ["advance-host.ts", "Update the branch against its base, test, and push.", "branch"],
  ["advance-host.ts", "One or more checks failed.", "checks-failed"],
  ["advance-host.ts", " unresolved review threads need attention.", "review-feedback"],
  ["advance-host.ts", "Review threads are incomplete; readiness needs another check.", "review-feedback"],
  ["advance-host.ts", "Review requests changes without a verified author follow-up.", "review-feedback"],
  ["advance-host.ts", "Review follow-up could not be verified; inspect the review discussion.", "review-feedback"],
  [null, "Approval feedback evidence is missing, incomplete, or stale for the current head and review.", "feedback-evidence"],
  [null, "Approval feedback history is incomplete; refresh and verify the current review.", "feedback-evidence"],
  [null, "Approval feedback needs code and validation evidence for the current head.", "feedback-evidence"],
  [null, "Worker reported incomplete work or failed validation; inspect its result", "worker-blocked"],
  [null, "PR head, approval, feedback, base, or workspace changed since preview. Preview it again.", "preview-stale"],
  [null, "Selected parent advanced; preview this PR again for branch preparation", "preview-stale"],
  [null, "PR state changed since verification. Recheck its current state.", "preview-stale"],
  [null, "Fork PRs need manual preparation and review follow-up in this version", "fork"],
  [null, "No matching scanned repository in a BB project; add it and rescan", "no-clone"],
  [null, "Verification failed: ", "verification-failed"],
  [null, "Inspection failed: ", "verification-failed"],
  [null, "GitHub inspection failed", "verification-failed"],
];

describe("legacy Advance history", () => {
  it("mirrors the recorded failure shape", () => {
    expect([...count(batches.map((batch) => batch.jobs.length))].sort()).toEqual([[1, 13], [15, 1], [9, 1]]);
    const jobs = batches.flatMap((batch) => batch.jobs);
    expect(jobs).toHaveLength(37);
    expect(new Set(jobs.map((job) => job.prUrl)).size).toBe(22);
    const older = batches.filter((batch) => batch !== continuation);
    const nine = batches.find((batch) => batch.jobs.length === 9)!;
    expect(continuation.jobs.every((job) => older.some((batch) => batch.jobs.some((item) => item.prUrl === job.prUrl)))).toBe(true);
    expect(continuation.jobs.filter((job) => nine.jobs.some((item) => item.prUrl === job.prUrl))).toHaveLength(6);
    const worktrees = jobs.filter((job) => job.path?.includes("/.bb/plugins/workstreams/worktrees/"));
    expect([worktrees.length, worktrees.filter((job) => job.threadId).length]).toEqual([23, 21]);
    expect(Object.values(INKWELL_ADVANCE_EFFORTS).map((members) => members.length)).toEqual([3, 1, 3]);
    expect(urls.filter((url) => !Object.values(INKWELL_ADVANCE_EFFORTS).flat().includes(url))).toHaveLength(15);
  });

  it("counts each PR once from the newest batch that contains it", () => {
    const current = currentLegacyAttempts(batches);
    expect(current.size).toBe(22);
    expect([...current.values()].reduce((total, attempt) => total + attempt.jobs, 0)).toBe(37);
    expect(Object.fromEntries(count([...current.values()].map((attempt) => attempt.job.status))))
      .toEqual({ "needs-attention": 11, "waiting-review": 7, ready: 2, running: 2 });
    for (const job of continuation.jobs) expect(current.get(job.prUrl)?.batchId).toBe(continuation.id);
    expect(currentLegacyAttempts([...batches].reverse())).toEqual(current);
  });

  it("never lets a recheck's later update promote an older batch", () => {
    const bumped = continuation.jobs.filter((job) => batches.some((batch) => batch !== continuation &&
      batch.jobs.some((item) => item.prUrl === job.prUrl && item.updatedAt > job.updatedAt)));
    expect(bumped.length).toBeGreaterThan(0);
    const current = currentLegacyAttempts(batches);
    for (const job of bumped) expect(current.get(job.prUrl)?.job).toBe(job);
  });

  it("labels waits, unstarted work, and each needs-attention detail by cause", () => {
    const needsAttention = (detail: string) => legacyCause({ status: "needs-attention", detail, uncertain: false }).cause;
    expect(legacyCause({ status: "waiting-review", detail: "Waiting for approval on the current PR.", uncertain: false }).cause).toBe("review");
    expect(needsAttention("Requested work was not confirmed. GitHub: Waiting for approval on the current PR.")).toBe("review");
    expect(needsAttention("The base branch belongs to another open PR; advance that dependency first.")).toBe("parent");
    expect(needsAttention("No worker exists for this launch. Requested work did not start; fix this item with an agent.")).toBe("not-started");
    // Every other needs-attention detail in the recorded batches has its own typed cause.
    const others = [...new Set(batches.flatMap((batch) => batch.jobs).filter((job) => job.status === "needs-attention").map((job) => job.detail))]
      .map((detail) => [detail, needsAttention(detail)] as const).filter(([, cause]) => cause !== "parent" && cause !== "review");
    expect(new Map(others)).toEqual(new Map<string, LegacyCause>([
      ["Requested work was not confirmed. GitHub: Approval feedback needs code and validation evidence for the current head.", "feedback-evidence"],
      ["Requested work was not confirmed. GitHub: One or more checks failed.", "checks-failed"],
      ["Requested work was not confirmed. GitHub: Resolve conflicts, test, and push the prepared branch.", "branch"],
      ["Approval feedback evidence is missing, incomplete, or stale for the current head and review.", "feedback-evidence"],
      ["Requested work was not confirmed. GitHub: 1 unresolved review threads need attention.", "review-feedback"],
      ["Worker reported incomplete work or failed validation; inspect its result", "worker-blocked"],
      ["One or more checks failed.", "checks-failed"],
      ["PR head, approval, feedback, base, or workspace changed since preview. Preview it again.", "preview-stale"],
    ]));
    expect(legacyCause({ status: "needs-attention", detail: "Worker stopped; inspect its thread before retrying", uncertain: true }).cause).toBe("uncertain");
  });

  it("types every detail legacy Advance wrote and every job status", () => {
    for (const [module, detail, cause] of WRITTEN) {
      if (module) expect(readFileSync(new URL(module, import.meta.url), "utf8"), module).toContain(detail);
      expect(legacyCause({ status: "needs-attention", detail, uncertain: false }).cause, detail).toBe(cause);
    }
    // A status alone types every job except needs-attention, which needs its detail.
    expect(Object.fromEntries(advanceJobSchema.shape.status.options.map((status) => [status, legacyCause({ status, detail: "", uncertain: false }).cause])))
      .toEqual({ queued: "queued", launching: "running", running: "running", verifying: "running", ready: "ready", "waiting-checks": "ci",
        "waiting-review": "review", "needs-attention": "unclassified", cancelled: "cancelled", merged: "merged", closed: "closed" });
  });

  it("offers the newest settled job's Advance worktree and threads for reuse, never a live, uncertain, or author checkout", () => {
    const current = currentLegacyAttempts(batches);
    const reusable = (index: number, attempts = current) => attempts.get(urls[index]!)?.reusable;
    // Settled in the continuation: its own worktree, keyed so advanceWorkspace recomputes that path, and its worker.
    expect(reusable(0)).toEqual({ path: expect.stringMatching(/\/worktrees\/batch-15\/inkwell--folio\/batch-15-job-0$/u),
      batchId: "batch-15", jobId: "batch-15-job-0", threadIds: ["thr_ink_15_0"] });
    // Still running in the continuation, and the older job worked in the author's own checkout.
    expect(reusable(11)).toBeNull();
    // The newest job never had a checkout: the first batch's repair worktree, keyed by its attempt, and the worker it replaced.
    expect(reusable(18)).toEqual({ path: expect.stringContaining("/worktrees/batch-01/"),
      batchId: "batch-01", jobId: "batch-01-job-18-attempt", threadIds: ["thr_ink_1_18_0"] });
    expect(reusable(5)).toBeNull();
    const uncertain: AdvanceBatch[] = batches.map((batch) => batch !== continuation ? batch :
      { ...batch, jobs: batch.jobs.map((job) => job.prUrl === urls[0] ? { ...job, uncertain: true } : job) });
    expect(currentLegacyAttempts(uncertain).get(urls[0]!)).toMatchObject({ cause: "uncertain",
      reusable: { path: expect.stringContaining("/worktrees/batch-14/"), batchId: "batch-14", threadIds: ["thr_ink_14_0"] } });
    // A newer preview that carried the author's checkout never hides the older worktree and its worker.
    const job = continuation.jobs.find((item) => item.prUrl === urls[0])!;
    const preview: AdvanceBatch = { ...continuation, id: "batch-16", createdAt: continuation.createdAt + 60_000,
      jobs: [{ ...job, id: "batch-16-job-0", status: "needs-attention", detail: "PR head, approval, feedback, base, or workspace changed since preview. Preview it again.",
        threadId: null, path: "/Users/reader/src/folio" }] };
    expect(currentLegacyAttempts([preview, ...batches]).get(urls[0]!)).toMatchObject({ batchId: "batch-16", cause: "preview-stale", reusable: reusable(0) });
  });
});
