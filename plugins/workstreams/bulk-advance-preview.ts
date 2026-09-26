import type { AdvancePreview } from "./bulk-advance";

type PlannedWork = { repo: string; eligible: boolean; needsPreparation: boolean; needsFeedback?: boolean };

/** Work that needs renewed review if an advance preview token expires. */
export function advanceScope(plan: AdvancePreview): string {
  return JSON.stringify(plan.jobs.map((job) => [job.prUrl, job.eligible, job.needsFeedback, job.needsPreparation, job.workspace, job.headOid, job.baseRefName, job.headRefName]));
}

export function advancePreviewAction(job: PlannedWork): string {
  if (!job.eligible) return "Skip";
  if (job.needsFeedback && job.needsPreparation) return "Address feedback + prepare + verify";
  if (job.needsFeedback) return "Address feedback + verify";
  return job.needsPreparation ? "Prepare branch + verify" : "Verify only";
}

/** A PR needing both feedback and branch work still has one job and one worker. */
export function advancePreviewSummary(jobs: readonly PlannedWork[]) {
  const eligible = jobs.filter((job) => job.eligible);
  const work = eligible.filter((job) => job.needsPreparation || job.needsFeedback);
  return {
    agentJobs: work.length,
    verifyJobs: eligible.length - work.length,
    skipped: jobs.length - eligible.length,
    workers: new Set(work.map((job) => job.repo)).size,
    hasFeedback: work.some((job) => job.needsFeedback),
    hasPreparation: work.some((job) => job.needsPreparation),
  };
}
