import { describe, expect, it } from "vitest";
import type { AdvancePreview } from "./bulk-advance";
import { advanceScope } from "./bulk-advance-preview";

const plan: AdvancePreview = {
  token: "first", expiresAt: 1,
  jobs: [{ prUrl: "https://github.com/inkwell/editor/pull/42", repo: "inkwell/editor", number: 42,
    title: "Prepare editor release", headOid: "a".repeat(40), baseRefName: "main", headRefName: "release",
    needsPreparation: false, needsFeedback: false, needsChecks: false, eligible: true, detail: "Ready to verify", workspace: "existing" }],
};

describe("advance token renewal", () => {
  it("keeps the same approval when only the token and expiry change", () => {
    expect(advanceScope({ ...plan, token: "second", expiresAt: 500 })).toBe(advanceScope(plan));
  });

  it("requires review if a readiness check gains agent work", () => {
    expect(advanceScope({ ...plan, jobs: [{ ...plan.jobs[0]!, needsFeedback: true }] })).not.toBe(advanceScope(plan));
    expect(advanceScope({ ...plan, jobs: [{ ...plan.jobs[0]!, needsChecks: true }] })).not.toBe(advanceScope(plan));
  });

  it("requires review if the checked commit or workspace changes", () => {
    expect(advanceScope({ ...plan, jobs: [{ ...plan.jobs[0]!, headOid: "b".repeat(40) }] })).not.toBe(advanceScope(plan));
    expect(advanceScope({ ...plan, jobs: [{ ...plan.jobs[0]!, workspace: "create" }] })).not.toBe(advanceScope(plan));
  });
});
