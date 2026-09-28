import { describe, expect, it } from "vitest";
import type { Pr } from "./contract.js";
import { effortRoster, type RosterSources } from "./effort-roster.js";
import type { EstablishedEffort } from "./effort-store.js";
import { INKWELL_ADVANCE_BATCHES, INKWELL_ADVANCE_EFFORTS, INKWELL_ROSTER } from "./inkwell-fixtures.js";
import type { PrObservation } from "./inventory-store.js";
import { currentLegacyAttempts } from "./legacy-history.js";

const effort = (prUrls: string[]): EstablishedEffort => ({ id: "reader", key: "effort:reader", name: "Reader accounts", goal: "", projectId: "project",
  coordinatorThreadId: null, coordinatorState: "none", members: { tickets: [], prUrls }, createdAt: 1, updatedAt: 1 });
const open = INKWELL_ROSTER.inventory[0]!.pr;
const pr = (url: string, patch: Partial<Pr> = {}): Pr => ({ ...open, url, number: Number(url.split("/").at(-1)), ...patch });
const legacy = currentLegacyAttempts(INKWELL_ADVANCE_BATCHES);

function roster(prUrls: string[], patch: Partial<RosterSources> = {}, facts: Record<string, Pr | null> = {}) {
  const sources: RosterSources = {
    now: Date.UTC(2026, 8, 28), groups: null, holds: {}, legacy: new Map(), runs: [], dispatch: [], threads: [],
    work: { items: new Map(prUrls.map((url) => [url, { paths: [`/Users/reader/src/${url.split("/").at(-1)}`], tickets: [] }])), ownerForPr: () => null },
    facts: (url) => url in facts ? facts[url]! : pr(url), observation: () => ({ checkedAt: "2026-09-28T00:00:00.000Z", failedAt: null }),
    feedback: () => null, tickets: () => new Map(), ...patch,
  };
  return effortRoster({ effort: effort(prUrls), redirectedFrom: null, sources,
    number: (targets) => ({ snapshotId: null, rows: targets.map((target, index) => ({ n: index + 1, target, provisional: true })) }) });
}
const urls = Array.from({ length: 8 }, (_, index) => `https://github.com/inkwell/atlas/pull/${410 + index}`);
const byTarget = (rows: ReturnType<typeof roster>["rows"]) => new Map(rows.map((row) => [row.target, row]));

describe("effort roster rows", () => {
  it("is Doing only while a legacy worker, running action, dispatch, or active checkout thread writes the PR", () => {
    const [queued, launching, verifying, running, idleRun, dispatched, verified, threaded] = urls;
    const job = (status: string, prUrl: string) => ({ ...legacy.get(INKWELL_ADVANCE_EFFORTS["Reader accounts"][0]!)!,
      ...{ cause: status === "queued" ? "queued" as const : "running" as const, label: status === "verifying" ? "Verifying the worker's result" : "Worker running" },
      job: { ...legacy.get(INKWELL_ADVANCE_EFFORTS["Reader accounts"][0]!)!.job, prUrl, status: status as "queued" } });
    const rows = byTarget(roster(urls, {
      legacy: new Map([[queued!, job("queued", queued!)], [launching!, job("launching", launching!)], [verifying!, job("verifying", verifying!)]]),
      runs: [{ prUrl: running!, status: "running", action: "resolve-conflicts" }, { prUrl: idleRun!, status: "needs-you", action: "address-review" },
        { prUrl: idleRun!, status: "done", action: "investigate-ci" }],
      dispatch: [{ prUrl: dispatched!, status: "launching", action: "address-comments" }, { prUrl: verified!, status: "verified", action: "address-comments" }],
      threads: [{ id: "thr_idle", status: "idle", environmentPath: "/Users/reader/src/414" },
        { id: "thr_writer", status: "active", environmentPath: "/Users/reader/src/417/" }],
    }).rows);
    expect([...rows.values()].map((row) => [row.target, row.state, row.cause, row.owner])).toEqual([
      [queued, "not-in-instruction", "capacity", "legacy-job"],
      [launching, "doing", "worker", "legacy-job"],
      [verifying, "doing", "verifying", "legacy-job"],
      [running, "doing", "worker", "run"],
      [idleRun, "not-in-instruction", "review", "you"],
      [dispatched, "doing", "worker", "dispatch"],
      [verified, "not-in-instruction", "review", "you"],
      [threaded, "doing", "worker", "thread"],
    ]);
  });

  it("files an uncertain legacy launch as a system issue, and a merged PR as Done even with a writer left over", () => {
    const [uncertain, merged] = urls;
    const base = legacy.get(INKWELL_ADVANCE_EFFORTS["Reader accounts"][0]!)!;
    const result = roster([uncertain!, merged!], {
      legacy: new Map([[uncertain!, { ...base, cause: "uncertain", label: "Launch outcome uncertain" }], [merged!, { ...base, cause: "running" }]]),
    }, { [merged!]: pr(merged!, { state: "MERGED" }) });
    expect(result.rows.map((row) => [row.state, row.cause])).toEqual([["issue", "legacy-uncertain"], ["done", "merged"]]);
    expect(result.issues).toEqual([{ cause: "legacy-uncertain", label: expect.any(String), numbers: [1] }]);
  });

  it("asks for a read of a PR the board read and then dropped, instead of calling it unobserved", () => {
    // A merged PR without a checkout leaves every board store, but the board did read it.
    const [dropped, unread, failed] = urls;
    const read = { checkedAt: "2026-09-28T00:00:00.000Z", failedAt: null };
    const observations: Record<string, PrObservation> = { [dropped!]: read, [failed!]: { ...read, failedAt: "2026-09-28T00:01:00.000Z" } };
    const rows = roster([dropped!, unread!, failed!], { observation: (url) => observations[url] ?? null }, { [dropped!]: null, [unread!]: null, [failed!]: null }).rows;
    expect(rows.map((row) => [row.state, row.cause, row.label, row.owner])).toEqual([
      ["not-in-instruction", "observe", "No longer on the board; refresh to read it", null],
      ["not-in-instruction", "source-unavailable", "Not observed yet", "github"],
      ["not-in-instruction", "source-unavailable", "GitHub read failed", "github"],
    ]);
  });

  it("names a cheap read's need but never calls a PR a merge candidate from a cheap read", () => {
    const [conflicted, failing, feedback, pending, requested, clean, unobserved, held] = urls;
    const approved = { reviewDecision: "APPROVED", unresolvedReviewThreads: 0, resolvedReviewThreads: 3,
      approvalFeedback: { status: "none" as const, fingerprint: null, sourceIds: [] } };
    const rows = byTarget(roster(urls, { holds: { [held!]: { reason: "Waiting on legal", heldAt: 1 } },
      observation: (url) => url === unobserved ? null : { checkedAt: "2026-09-28T00:00:00.000Z", failedAt: null } }, {
      [conflicted!]: pr(conflicted!, { ...approved, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }),
      [failing!]: pr(failing!, { ...approved, checkConclusions: ["SUCCESS", "FAILURE"] }),
      [feedback!]: pr(feedback!, { ...approved, unresolvedReviewThreads: 2 }),
      [pending!]: pr(pending!, { ...approved, checkConclusions: ["PENDING"] }),
      [requested!]: pr(requested!, { reviewRequests: ["folio-editor"] }),
      [clean!]: pr(clean!, approved),
      [unobserved!]: null,
      [held!]: pr(held!, approved),
    }).rows);
    expect([...rows.values()].map((row) => [row.cause, row.owner])).toEqual([
      ["branch", "you"], ["checks-failed", "you"], ["review-feedback", "you"], ["ci", "ci"],
      ["review", "reviewer"], ["observe", null], ["source-unavailable", "github"], ["hold", "you"],
    ]);
    expect(rows.get(requested!)?.label).toBe("Waiting for review from @folio-editor");
    // Only a full read proves the stack parent, so an otherwise clean PR asks for one.
    expect(rows.get(clean!)?.label).toBe("Refresh to verify parent-merged");
    expect([...rows.values()].every((row) => row.state === "not-in-instruction")).toBe(true);
  });

  it("carries tickets, lists uncovered ticket members unnumbered, and counts legacy jobs as history", () => {
    const reader = INKWELL_ADVANCE_EFFORTS["Reader accounts"];
    const result = effortRoster({ effort: { ...effort(reader), members: { tickets: ["ABC-205", "ABC-299"], prUrls: reader } }, redirectedFrom: null,
      number: (targets) => ({ snapshotId: "S-000000000000", rows: targets.map((target, index) => ({ n: index + 1, target, provisional: false })) }),
      sources: { now: 0, groups: null, holds: {}, legacy, runs: [], dispatch: [], threads: [], facts: () => null, observation: () => null, feedback: () => null,
        work: { items: new Map([[reader[0]!, { paths: [], tickets: ["ABC-205"] }]]), ownerForPr: () => null },
        tickets: (ids) => new Map(ids.filter((id) => id === "ABC-205").map((id) => [id, { title: "Let readers update their email", url: `https://linear.app/inkwell/issue/${id}` }])) } });
    expect(result.rows[0]!.tickets).toEqual([{ id: "ABC-205", title: "Let readers update their email", url: "https://linear.app/inkwell/issue/ABC-205" }]);
    expect(result.ticketsWithoutPrs).toEqual([{ id: "ABC-299", title: null, url: null }]);
    // Six job rows across two batches describe three current PRs.
    expect(result.history).toEqual({ legacyJobs: 6, legacyPrs: 3 });
  });
});
