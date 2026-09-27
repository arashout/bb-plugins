import { describe, expect, it } from "vitest";
import { advancePreviewAction, advancePreviewSummary, advanceScope } from "./bulk-advance-preview";

const job = (patch: Partial<Parameters<typeof advancePreviewAction>[0]> = {}) => ({ repo: "acme/app", eligible: true, needsPreparation: false, needsFeedback: false, needsChecks: false, ...patch });

describe("advance preview scope", () => {
  it("requires renewed review when the scoped direction changes", () => {
    const plan = { token: "first", expiresAt: 1, instruction: "Check the fallback.", jobs: [] };
    expect(advanceScope({ ...plan, token: "second", expiresAt: 2 })).toBe(advanceScope(plan));
    expect(advanceScope({ ...plan, instruction: "Check the retry." })).not.toBe(advanceScope(plan));
    expect(advanceScope({ ...plan, instruction: "" })).toBe(advanceScope({ ...plan, instruction: undefined }));
  });

  it("requires an agent and explicit feedback scope even when the branch is current", () => {
    const feedback = job({ needsFeedback: true });
    expect(advancePreviewAction(feedback)).toBe("Address feedback + verify");
    expect(advancePreviewSummary([feedback])).toEqual({ agentJobs: 1, verifyJobs: 0, skipped: 0, workers: 1, hasFeedback: true, hasPreparation: false, hasChecks: false });
  });
  it("counts failed CI as work, but leaves waiting PRs in the readiness-only group", () => {
    const jobs = [job({ needsFeedback: true, needsPreparation: true, needsChecks: true }), job({ needsFeedback: true }), job({ needsPreparation: true }), job({ needsChecks: true }), job(), job({ eligible: false, needsFeedback: true, repo: "acme/skipped" })];
    expect(advancePreviewSummary(jobs)).toEqual({ agentJobs: 4, verifyJobs: 1, skipped: 1, workers: 1, hasFeedback: true, hasPreparation: true, hasChecks: true });
    expect(jobs.map(advancePreviewAction)).toEqual(["Address feedback + prepare branch + fix failed checks + verify", "Address feedback + verify", "Prepare branch + verify", "Fix failed checks + verify", "Check readiness", "Skip"]);
  });
  it("keeps legacy preparation-only previews and true read-only readiness distinct", () => {
    const legacy = { repo: "acme/app", eligible: true, needsPreparation: true };
    expect(advancePreviewAction(legacy)).toBe("Prepare branch + verify");
    expect(advancePreviewSummary([legacy]).hasFeedback).toBe(false);
    expect(advancePreviewSummary([job()])).toMatchObject({ agentJobs: 0, verifyJobs: 1, workers: 0 });
  });
});
