import type { AdvancePreview } from "./bulk-advance";

type PlannedWork = { repo: string; eligible: boolean; needsPreparation: boolean; needsFeedback?: boolean; needsChecks?: boolean };

/** Work that needs renewed review if an advance preview token expires. */
export function advanceScope(plan: AdvancePreview): string {
  return JSON.stringify(plan.jobs.map((job) => [job.prUrl, job.eligible, job.needsFeedback, job.needsPreparation, job.needsChecks, job.workspace, job.headOid, job.baseRefName, job.headRefName]));
}

export function advancePreviewAction(job: PlannedWork): string {
  if (!job.eligible) return "Skip";
  const work = [job.needsFeedback && "address feedback", job.needsPreparation && "prepare branch", job.needsChecks && "fix failed checks"].filter(Boolean);
  return work.length ? `${work.join(" + ").replace(/^./u, (letter) => letter.toUpperCase())} + verify` : "Check readiness";
}

/** A PR needing both feedback and branch work still has one job and one worker. */
export function advancePreviewSummary(jobs: readonly PlannedWork[]) {
  const eligible = jobs.filter((job) => job.eligible);
  const work = eligible.filter((job) => job.needsPreparation || job.needsFeedback || job.needsChecks);
  return {
    agentJobs: work.length,
    verifyJobs: eligible.length - work.length,
    skipped: jobs.length - eligible.length,
    workers: new Set(work.map((job) => job.repo)).size,
    hasFeedback: work.some((job) => job.needsFeedback),
    hasPreparation: work.some((job) => job.needsPreparation),
    hasChecks: work.some((job) => job.needsChecks),
  };
}
