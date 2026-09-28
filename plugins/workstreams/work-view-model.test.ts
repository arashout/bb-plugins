import { describe, expect, it } from "vitest";
import type { AdvanceBatch, AdvanceJob } from "./bulk-advance.js";
import type { PipelineCard } from "./pipeline.js";
import type { WorkConversation } from "./work-conversation.js";
import { workRequests } from "./work-view-model.js";

const pr = (number: number) => `https://github.com/example/widgets/pull/${number}`;
const job = (number: number, status: AdvanceJob["status"], updatedAt: number, patch: Partial<AdvanceJob> = {}): AdvanceJob => ({
  id: `job-${number}-${updatedAt}`, prUrl: pr(number), repo: "example/widgets", number, title: `Widget ${number}`,
  headOid: "head", baseRefName: "main", headRefName: `work-${number}`, needsPreparation: true,
  needsFeedback: false, needsChecks: false, eligible: true, detail: `Saved ${status} result`, workspace: "existing",
  hiddenFromProgress: false, status, attemptId: null, dedicated: false, previousAttempts: [], threadId: null,
  path: null, checkedHeadOid: null, updatedAt, uncertain: false, ...patch,
});
const batch = (id: string, jobs: AdvanceJob[], createdAt = 1): AdvanceBatch => ({ id, createdAt, cancelled: false, instruction: "", jobs });
const conversation = (scope: number[], batchIds: string[] = [], patch: Partial<WorkConversation> = {}): WorkConversation => ({
  id: "conversation", scopePrUrls: scope.map(pr), threadId: "thread-conversation", projectId: "project", revision: 0,
  instruction: "Plan widget delivery", proposal: null, batchIds, createdAt: 1, updatedAt: 2, ...patch,
});
const card = (number: number, action: PipelineCard["action"], patch: Partial<PipelineCard> = {}): PipelineCard => ({
  key: pr(number), repo: "example/widgets", title: `Widget ${number}`, pr: { url: pr(number) } as PipelineCard["pr"],
  local: null, backlog: null, effortKey: null, effortName: null, hold: null, stage: "review",
  blocker: { label: "Awaiting review", tone: "wait" }, activity: { state: "none", detail: "", threadId: null, source: null },
  action, nextStep: "Wait for the reviewer.", ageSince: null, stale: false, ...patch,
});

describe("Work request presentation", () => {
  it("keeps immutable conversation scope, exclusions, holds, and linked batches in one row", () => {
    const linked = batch("linked", [job(1, "waiting-review", 5)]);
    const held = card(2, { kind: "release", label: "Release" }, { hold: { reason: "Decision", heldAt: 3 },
      blocker: { label: "On hold", tone: "wait" }, nextStep: "Release the hold when work can resume." });
    const rows = workRequests([conversation([1, 2, 3], [linked.id], { proposal: {
      revision: 1, selectedPrUrls: [pr(1)], instruction: "Prepare one", exclusions: [
        { prUrl: pr(2), reason: "Held" }, { prUrl: pr(3), reason: "Out of scope for this pass" }],
      previewToken: null, previewExpiresAt: null,
    } })], [linked], [held]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "conversation:conversation", title: "Plan widget delivery", conversationId: "conversation",
      threadId: "thread-conversation", prUrls: [pr(1), pr(2), pr(3)], batches: [linked], status: "waiting" });
  });

  it("selects the active attempt for a PR and keeps preparation history without duplicate rows", () => {
    const older = batch("older", [job(1, "needs-attention", 20)]);
    const newer = batch("newer", [job(1, "running", 10, { threadId: "thread-worker" })], 5);
    const [row] = workRequests([conversation([1], [older.id, newer.id])], [older, newer], []);
    expect(row?.jobs).toEqual([{ batchId: "newer", job: newer.jobs[0] }]);
    expect(row?.batches).toEqual([older, newer]);
    expect(row?.status).toBe("working");
    expect(row?.nextStep).toMatch(/active preparation thread/u);
  });

  it("marks a fully superseded standalone failure finished without claiming the PR succeeded", () => {
    const old = batch("old", [job(1, "needs-attention", 10)]);
    const current = batch("current", [job(1, "waiting-review", 20)], 15);
    const rows = workRequests([], [old, current], []);
    expect(rows.find((row) => row.id === "batch:old")).toMatchObject({ status: "finished", nextStep: expect.stringMatching(/superseded/u) });
    expect(rows.find((row) => row.id === "batch:current")?.status).toBe("waiting");
  });

  it("uses the current merge action over an old failed result, but never trusts a saved ready result alone", () => {
    const failed = batch("failed", [job(1, "needs-attention", 10)]);
    const ready = card(1, { kind: "merge", label: "Merge" }, { stage: "ready", blocker: { label: "Clear", tone: "clear" },
      nextStep: "Review the merge preview, then merge." });
    expect(workRequests([], [failed], [ready])[0]).toMatchObject({ status: "ready", nextStep: ready.nextStep });
    const savedReady = batch("saved-ready", [job(2, "ready", 20)]);
    expect(workRequests([], [savedReady], [])[0]).toMatchObject({ status: "attention",
      nextStep: expect.stringMatching(/Refresh live PR status/u) });
  });

  it("treats a current parent dependency as waiting even after a saved needs-attention result", () => {
    const stopped = batch("blocked", [job(1, "needs-attention", 10)]);
    const dependent = card(1, { kind: "fix", label: "Review blocker" }, {
      stage: "ready", blocker: { label: "Behind #2", tone: "wait" }, activity: { state: "needs-you", detail: "Old result", threadId: "worker", source: "advance" },
      nextStep: "Review the agent result and remaining blocker.",
    });
    expect(workRequests([], [stopped], [dependent])[0]).toMatchObject({ status: "waiting",
      nextStep: "Parent PR #2 must merge before this PR can merge." });
  });

  it("distinguishes cancelled and hidden preparation from completed PR work", () => {
    const cancelled = batch("cancelled", [job(1, "cancelled", 10)]);
    const hidden = batch("hidden", [job(2, "needs-attention", 11, { hiddenFromProgress: true })]);
    const rows = workRequests([], [cancelled, hidden], []);
    expect(rows.find((row) => row.id === "batch:cancelled")).toMatchObject({ status: "finished",
      nextStep: expect.stringMatching(/stopped/u) });
    expect(rows.find((row) => row.id === "batch:hidden")).toMatchObject({ status: "finished",
      nextStep: expect.stringMatching(/removed from progress/u) });
  });

  it("does not invent readiness or supervision for a conversation without observed PR facts", () => {
    const [row] = workRequests([conversation([1], [], { instruction: "", proposal: null })], [], []);
    expect(row).toMatchObject({ title: "Plan selected PRs", status: "not-started",
      nextStep: "Review the selected PRs and propose preparation." });
  });
  it("keeps excluded ready PRs from changing a linked batch status and keeps rows stable as jobs update", () => {
    const first = batch("first", [job(1, "waiting-review", 30)], 1);
    const second = batch("second", [job(3, "running", 100)], 2);
    const readyExcluded = card(2, { kind: "merge", label: "Merge" }, {
      stage: "ready", blocker: { label: "Clear", tone: "clear" }, nextStep: "Review the merge preview, then merge.",
    });
    const rows = workRequests([conversation([1, 2], [first.id])], [first, second], [readyExcluded]);
    expect(rows.map((row) => row.id)).toEqual(["batch:second", "conversation:conversation"]);
    expect(rows[1]).toMatchObject({ prUrls: [pr(1), pr(2)], status: "waiting" });
  });

  it("does not let a partially superseded job control its old request", () => {
    const old = batch("old", [job(1, "needs-attention", 10), job(2, "waiting-review", 11)]);
    const newer = batch("newer", [job(1, "running", 20)], 20);
    const rows = workRequests([], [old, newer], []);
    expect(rows.find((row) => row.id === "batch:old")?.status).toBe("waiting");
    expect(rows.find((row) => row.id === "batch:old")?.jobs.map(({ job }) => job.prUrl)).toEqual([pr(2)]);
    expect(rows.find((row) => row.id === "batch:old")?.batches[0]?.jobs).toHaveLength(2);
    expect(rows.find((row) => row.id === "batch:newer")?.status).toBe("working");
  });

  it("treats current merged facts as finished even when saved work was waiting", () => {
    const waiting = batch("waiting", [job(1, "waiting-review", 10)]);
    const merged = card(1, null, { stage: "merged", blocker: { label: "Clear", tone: "clear" },
      nextStep: "Check release status when needed." });
    expect(workRequests([], [waiting], [merged])[0]).toMatchObject({ status: "finished", nextStep: merged.nextStep });
  });

  it("keeps an uncertain worker attempt in attention despite a fresh merge action", () => {
    const uncertain = batch("uncertain", [job(1, "needs-attention", 10, { uncertain: true })]);
    const ready = card(1, { kind: "merge", label: "Merge" }, { stage: "ready",
      blocker: { label: "Clear", tone: "clear" }, nextStep: "Review the merge preview, then merge." });
    expect(workRequests([], [uncertain], [ready])[0]).toMatchObject({ status: "attention",
      nextStep: expect.stringMatching(/Inspect the worker thread/u) });
  });

  it("keeps a new conversation in planning despite current PR feedback", () => {
    const feedback = card(1, { kind: "advance", label: "Advance" }, { stage: "feedback",
      blocker: { label: "Changes requested", tone: "warn" }, nextStep: "Advance to address review feedback." });
    const noProposal = workRequests([conversation([1])], [], [feedback])[0];
    expect(noProposal).toMatchObject({ status: "not-started", nextStep: "Review the selected PRs and propose preparation." });
    const withProposal = workRequests([conversation([1], [], { proposal: { revision: 1, selectedPrUrls: [pr(1)],
      instruction: "Prepare feedback", exclusions: [], previewToken: null, previewExpiresAt: null } })], [], [feedback])[0];
    expect(withProposal).toMatchObject({ status: "not-started", nextStep: "Review the proposal and start preparation when ready." });
  });

});
