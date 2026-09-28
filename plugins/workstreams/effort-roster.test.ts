import { describe, expect, it } from "vitest";
import type { Pr } from "./contract.js";
import { effortRoster, type RosterSources } from "./effort-roster.js";
import { cheapSignature } from "./effort-roster-store.js";
import type { EstablishedEffort } from "./effort-store.js";
import type { StoredAttempt, WorkRow, WorkRowBody } from "./effort-work-store.js";
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
    now: Date.UTC(2026, 8, 28), groups: null, holds: {}, legacy: new Map(), runs: [], dispatch: [], threads: [], full: () => null,
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
  it("is Doing only while a legacy worker, an action or dispatch on the PR or in its checkout, or an active checkout thread writes the PR", () => {
    const ticketRun = "https://github.com/inkwell/atlas/pull/418";
    const [queued, launching, verifying, running, idleRun, dispatched, verified, threaded] = urls;
    const job = (status: string, prUrl: string) => ({ ...legacy.get(INKWELL_ADVANCE_EFFORTS["Reader accounts"][0]!)!,
      ...{ cause: status === "queued" ? "queued" as const : "running" as const, label: status === "verifying" ? "Verifying the worker's result" : "Worker running" },
      job: { ...legacy.get(INKWELL_ADVANCE_EFFORTS["Reader accounts"][0]!)!.job, prUrl, status: status as "queued" } });
    const rows = byTarget(roster([...urls, ticketRun], {
      legacy: new Map([[queued!, job("queued", queued!)], [launching!, job("launching", launching!)], [verifying!, job("verifying", verifying!)]]),
      runs: [{ id: 1, path: "/Users/reader/src/413", prUrl: running!, status: "running", action: "resolve-conflicts" },
        { id: 2, path: "/Users/reader/src/414", prUrl: idleRun!, status: "needs-you", action: "address-review" },
        { id: 3, path: "/Users/reader/src/414", prUrl: idleRun!, status: "done", action: "investigate-ci" },
        // A ticket's run names no PR, but it writes in this PR's checkout.
        { id: 4, path: "/Users/reader/src/418", prUrl: null, status: "running", action: "investigate-ci" }],
      dispatch: [{ id: 1, path: "/Users/reader/src/415", prUrl: dispatched!, status: "launching", action: "address-comments" },
        { id: 2, path: "/Users/reader/src/416", prUrl: verified!, status: "verified", action: "address-comments" }],
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
      [ticketRun, "doing", "worker", "run"],
    ]);
  });

  it("files an uncertain legacy launch as a system issue, and a merged PR as Done even with a writer left over", () => {
    const [uncertain, merged] = urls;
    const base = legacy.get(INKWELL_ADVANCE_EFFORTS["Reader accounts"][0]!)!;
    const result = roster([uncertain!, merged!], {
      legacy: new Map([[uncertain!, { ...base, cause: "uncertain", label: "Launch outcome uncertain" }], [merged!, { ...base, cause: "running" }]]),
    }, { [merged!]: pr(merged!, { state: "MERGED" }) });
    expect(result.rows.map((row) => [row.state, row.cause])).toEqual([["issue", "legacy-uncertain"], ["done", "merged"]]);
    expect(result.issues).toEqual([{ ref: null, cause: "legacy-uncertain", label: expect.any(String), detail: null, numbers: [1], raisedAt: null, recovery: [], likelyThreadId: null }]);
  });

  it("groups a failure several instructed PRs share into one system issue naming each, though each PR's detail names its own head", () => {
    const [first, second, third, fourth] = urls;
    const issue = (target: string, n: number, cause: string, detail: string): WorkRow => ({ target, effortId: "reader", instructionId: "I-reader-r1", phase: "repair-needed",
      revision: 1, dueAt: null, body: { n, cause, detail, userState: "issue", modifiers: [], nextAction: null, owner: { kind: "user", ref: null }, wake: null, decision: null,
        recovery: ["retry N"], offers: [], retryEpoch: 0, observedHead: null, observedAt: null, gates: null, tickets: [] } });
    // As decide() writes them: the rerun's detail names the head it reran.
    const rerun = (head: string) => `Checks still fail on this head after its one rerun (Reran the failed jobs of 1 GitHub Actions run on ${head}.)`;
    const unrepairable = "The worker's report still can't be read after 2 corrections in its thread";
    const rows = [issue(first!, 1, "ci-infrastructure", rerun("3333333")), issue(second!, 2, "report-unrepairable", unrepairable),
      issue(third!, 3, "ci-infrastructure", rerun("4444444")), issue(fourth!, 4, "report-unrepairable", unrepairable)];
    const sources: RosterSources = { now: Date.UTC(2026, 8, 28), groups: null, holds: {}, legacy: new Map(), runs: [], dispatch: [], threads: [], full: () => null,
      work: { items: new Map(), ownerForPr: () => null }, facts: (url) => pr(url), observation: () => null, feedback: () => null, tickets: () => new Map() };
    const targets = [first!, second!, third!, fourth!];
    const result = effortRoster({ effort: effort(targets), redirectedFrom: null, sources,
      number: (list) => ({ snapshotId: null, rows: list.map((target) => ({ n: targets.indexOf(target) + 1, target, provisional: false })) }),
      v2: { rows: new Map(rows.map((row) => [row.target, row])), included: new Set(targets), scope: null, claims: new Map(), active: null, rollup: null, contract: null, decisions: [],
        attempts: () => 0 } });
    // Details that differ only in each PR's own facts label the issue by its cause, and each PR's detail follows; a detail every PR shares labels it.
    // Each lists the recovery its rows name, for all of them at once.
    expect(result.issues).toEqual([
      { ref: null, cause: "ci-infrastructure", label: "ci-infrastructure", detail: `1: ${rerun("3333333")}; 3: ${rerun("4444444")}`, numbers: [1, 3], raisedAt: null,
        recovery: [{ command: "retry 1, 3", label: "Retry 1, 3", confirm: false }], likelyThreadId: null },
      { ref: null, cause: "report-unrepairable", label: unrepairable, detail: null, numbers: [2, 4], raisedAt: null,
        recovery: [{ command: "retry 2, 4", label: "Retry 2, 4", confirm: false }], likelyThreadId: null }]);
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

  it("keeps a full read's proof through unchanged cheap reads, and drops it once a cheap read shows a change", () => {
    const [target] = urls;
    const cheap = pr(target!, { reviewDecision: "APPROVED", approvalFeedback: { status: "none", fingerprint: null, sourceIds: [] } });
    const facts = { prUrl: target!, number: cheap.number, title: cheap.title, repo: "inkwell/atlas", headRefName: cheap.headRefName!, baseRefName: "main",
      headOid: cheap.headRefOid!, baseOid: "b".repeat(40), state: "OPEN" as const, isDraft: false, isCrossRepository: false, reviewDecision: "APPROVED",
      mergeStateStatus: "CLEAN", mergeable: "MERGEABLE", needsPreparation: false, readiness: "ready" as const, detail: "", unresolvedThreads: 0,
      threadsComplete: true, checks: "passed" as const, basePrNumber: null, approvalFeedback: cheap.approvalFeedback! };
    // The poll read the PR again a minute after the refresh.
    const later = { observation: () => ({ checkedAt: "2026-09-28T00:01:00.000Z", failedAt: null }) };
    const row = (current: Pr, signature: string) => roster([target!], { ...later,
      full: () => ({ facts, fullAt: Date.parse("2026-09-28T00:00:00.000Z"), failedAt: null, error: null, signature }) }, { [target!]: current }).rows[0]!;
    expect(row(cheap, cheapSignature(cheap))).toMatchObject({ cause: "merge-candidate", gates: { "threads-resolved": true } });
    const pushed = { ...cheap, headRefOid: "d".repeat(40) };
    expect(row(pushed, cheapSignature(cheap))).toMatchObject({ cause: "observe", head: pushed.headRefOid, gates: { "threads-resolved": null } });
    // Only the full read tells merged from closed; a later cheap read that finds the PR gone agrees with it.
    const merged = roster([target!], { ...later, full: () => ({ facts: { ...facts, state: "MERGED" }, fullAt: Date.parse("2026-09-28T00:00:00.000Z"),
      failedAt: null, error: null, signature: cheapSignature(null) }) }, { [target!]: null }).rows[0]!;
    expect(merged).toMatchObject({ state: "done", cause: "merged" });
  });

  it("carries tickets, lists uncovered ticket members unnumbered, and counts legacy jobs as history", () => {
    const reader = INKWELL_ADVANCE_EFFORTS["Reader accounts"];
    const result = effortRoster({ effort: { ...effort(reader), members: { tickets: ["ABC-205", "ABC-299"], prUrls: reader } }, redirectedFrom: null,
      number: (targets) => ({ snapshotId: "S-000000000000", rows: targets.map((target, index) => ({ n: index + 1, target, provisional: false })) }),
      sources: { now: 0, groups: null, holds: {}, legacy, runs: [], dispatch: [], threads: [], facts: () => null, full: () => null, observation: () => null, feedback: () => null,
        work: { items: new Map([[reader[0]!, { paths: [], tickets: ["ABC-205"] }]]), ownerForPr: () => null },
        tickets: (ids) => new Map(ids.filter((id) => id === "ABC-205").map((id) => [id, { title: "Let readers update their email", url: `https://linear.app/inkwell/issue/${id}` }])) } });
    expect(result.rows[0]!.tickets).toEqual([{ id: "ABC-205", title: "Let readers update their email", url: "https://linear.app/inkwell/issue/ABC-205" }]);
    expect(result.ticketsWithoutPrs).toEqual([{ id: "ABC-299", title: null, url: null }]);
    // Six job rows across two batches describe three current PRs.
    expect(result.history).toEqual({ legacyJobs: 6, legacyPrs: 3, v2Attempts: 0 });
  });
});

describe("roster presentation facts", () => {
  const NOW = Date.UTC(2026, 8, 28, 11, 30);
  const MINUTE = 60_000;
  const url = (repo: string, number: number) => `https://github.com/inkwell/${repo}/pull/${number}`;
  const body = (n: number, patch: Partial<WorkRowBody> = {}): WorkRowBody => ({ n, cause: "ci", detail: "Checks running", userState: "waiting", modifiers: [],
    nextAction: null, owner: { kind: "ci", ref: null }, wake: { event: "check results change", ref: null, dueAt: NOW + 2 * MINUTE }, decision: null, recovery: [], offers: [],
    retryEpoch: 0, observedHead: null, observedAt: null, gates: null, tickets: [], ...patch });
  const workRow = (target: string, phase: WorkRow["phase"], rowBody: WorkRowBody): WorkRow =>
    ({ target, effortId: "reader", instructionId: "I-reader-r1", phase, revision: 1, dueAt: null, body: rowBody });
  const attempt = (target: string, status: StoredAttempt["status"], resource: Pick<StoredAttempt["body"]["resource"], "kind" | "threadId" | "reason">): StoredAttempt =>
    ({ id: `A-${target.split("/").at(-1)}`, target, effortId: "reader", instructionId: "I-reader-r1", launchKey: "key", status, threadId: resource.threadId, hostId: "host-inkwell",
      path: null, createdAt: NOW - 3 * MINUTE, body: { instructionRevision: 1, recipes: ["address_review_feedback"], role: "code", retryEpoch: 0, retryIndex: 0,
        start: { headOid: "a".repeat(40), baseOid: "b".repeat(40), fingerprint: null, sourceIds: [] },
        resource: { ...resource, path: null, hostId: "host-inkwell", projectId: "project", workspace: null }, mode: resource.threadId ? "send" : "spawn", marker: "[attempt]",
        settledAt: null, uncertainAt: null, emptyReadbackAt: null, failure: null, error: null, releasedReason: null } });
  /** An effort on its roster whose instruction includes every target, with these v2 rows and claims. */
  function instructed(targets: string[], rows: WorkRow[], options: { claims?: StoredAttempt[]; sources?: Partial<RosterSources>; facts?: Record<string, Pr | null> } = {}) {
    const sources: RosterSources = { now: NOW, groups: null, holds: {}, legacy: new Map(), runs: [], dispatch: [], threads: [], full: () => null,
      work: { items: new Map(targets.map((target) => [target, { paths: [], tickets: [] }])), ownerForPr: () => null },
      facts: (target) => target in (options.facts ?? {}) ? options.facts![target]! : pr(target), observation: () => ({ checkedAt: new Date(NOW - MINUTE).toISOString(), failedAt: null }),
      feedback: () => null, tickets: () => new Map(), ...options.sources };
    return effortRoster({ effort: effort(targets), redirectedFrom: null, sources, execution: { mode: "v2", revision: 1 }, v2Execution: "dry-run",
      number: (list) => ({ snapshotId: null, rows: list.map((target) => ({ n: targets.indexOf(target) + 1, target, provisional: false })) }),
      v2: { rows: new Map(rows.map((row) => [row.target, row])), included: new Set(targets), claims: new Map((options.claims ?? []).map((item) => [item.target, item])), active: null,
        rollup: null, contract: null, decisions: [], scope: { revision: 1, include: targets.map((target, index) => ({ target, n: index + 1, outsideMembership: false, work: [], effects: [], reviewers: [],
          addedInRevision: 1 })), exclude: [], removed: [], stopAt: "prepared", reportMode: "changes", outcome: null, criteria: [], answers: [] }, attempts: () => 0 } });
  }

  it("carries each v2 row's wake and next step, and none once the row is done, so the pane never guesses when a row looks again", () => {
    const [waiting, merged] = [url("spine", 214), url("catalog", 899)];
    const result = instructed([waiting, merged], [workRow(waiting, "waiting", body(1)),
      workRow(merged, "finished", body(2, { cause: "merged", detail: "Merged", userState: "done", owner: null, wake: null }))],
    { facts: { [merged]: pr(merged, { state: "MERGED" }) } });
    expect(result.rows.map((row) => [row.n, row.state, row.wake, row.nextAction])).toEqual([
      [1, "waiting", { event: "check results change", dueAt: NOW + 2 * MINUTE }, null], [2, "done", null, null]]);
  });

  it("says who performs each step and where: the dry run's planned launch with its reason, the running claim's reused thread, a code action, or a code procedure", () => {
    const [entryForm, checksum, verify, rereview] = [url("folio", 412), url("quill", 188), url("catalog", 903), url("atlas", 85)];
    const reason = "the only quill thread is busy on #185";
    const running = attempt(entryForm, "running", { kind: "reuse", threadId: "thr_folio_entry", reason: null });
    const result = instructed([entryForm, checksum, verify, rereview], [
      workRow(entryForm, "executing", body(1, { cause: "worker", userState: "doing", nextAction: "attach", owner: { kind: "v2-attempt", ref: running.id } })),
      workRow(checksum, "queued", body(2, { cause: "launching", userState: "waiting", modifiers: ["plan only"], nextAction: ["fix_failing_checks"], owner: null,
        plan: { recipes: ["fix_failing_checks"], role: "code", launchKey: "key", resource: { kind: "spawn", threadId: null, path: "/Users/reader/src/quill-188", hostId: "host-inkwell", reason } } })),
      workRow(verify, "verifying", body(3, { cause: "observe", userState: "doing", nextAction: "observe", owner: null })),
      workRow(rereview, "queued", body(4, { cause: "code-action", userState: "waiting", modifiers: ["plan only"], nextAction: ["request_rereview"], owner: null })),
    ], { claims: [running] });
    expect(result.rows.map((row) => row.work)).toEqual([
      { executor: "worker", recipes: ["address_review_feedback"], resource: { kind: "reuse", threadId: "thr_folio_entry", reason: null }, planned: false },
      { executor: "worker", recipes: ["fix_failing_checks"], resource: { kind: "spawn", threadId: null, reason }, planned: true },
      { executor: "procedure", recipes: [], resource: null, planned: false },
      { executor: "code", recipes: ["request_rereview"], resource: null, planned: true },
    ]);
    expect(result.rows[0]!.claim).toEqual({ attemptId: running.id, status: "running", threadId: "thr_folio_entry", since: NOW - 3 * MINUTE });
    expect(result.rows.slice(1).map((row) => row.claim)).toEqual([null, null, null]);
    // A row outside the instruction has no v2 step at all.
    expect(roster([entryForm]).rows[0]).toMatchObject({ work: null, wake: null, nextAction: null, claim: null });
  });

  it("nests a PR under the roster PR it is stacked on, from a full read's parent or a cheap read's base branch, and names a parent off the roster without a number", () => {
    const [parent, fullChild, cheapChild, orphan] = [url("spine", 212), url("spine", 215), url("spine", 217), url("spine", 219)];
    const facts = (target: string, basePrNumber: number | null) => ({ facts: { prUrl: target, number: Number(target.split("/").at(-1)), title: "Shelf location", repo: "inkwell/spine",
      headRefName: "abc-215", baseRefName: "abc-212", headOid: "d".repeat(40), baseOid: "b".repeat(40), state: "OPEN" as const, isDraft: false, isCrossRepository: false,
      reviewDecision: null, mergeStateStatus: "CLEAN", mergeable: "MERGEABLE", needsPreparation: false, readiness: "ready" as const, detail: "", unresolvedThreads: 0,
      threadsComplete: true, checks: "passed" as const, basePrNumber, approvalFeedback: { status: "none" as const, fingerprint: null, sourceIds: [] } },
      fullAt: NOW - MINUTE, failedAt: null, error: null, signature: null });
    const result = roster([parent, fullChild, cheapChild, orphan], {
      full: (target) => target === fullChild ? facts(fullChild, 212) : target === orphan ? facts(orphan, 190) : null,
      observation: () => ({ checkedAt: new Date(Date.UTC(2026, 8, 28) - 2 * MINUTE).toISOString(), failedAt: null }),
    }, { [parent]: pr(parent, { headRefName: "abc-212" }), [cheapChild]: pr(cheapChild, { headRefName: "abc-217", baseRefName: "abc-212" }) });
    expect(result.rows.map((row) => [row.n, row.stack])).toEqual([
      [1, null],
      [2, { parentTarget: parent, parentN: 1 }],
      [3, { parentTarget: parent, parentN: 1 }],
      [4, { parentTarget: url("spine", 190), parentN: null }],
    ]);
  });

  it("counts CI for the chip from the board's read: a check still running isn't done, and a failure is counted", () => {
    const [target] = urls;
    expect(roster([target!], {}, { [target!]: pr(target!, { checkConclusions: ["SUCCESS", "FAILURE", "PENDING"] }) }).rows[0]!.checkCounts).toEqual({ done: 2, total: 3, failed: 1 });
    expect(roster([target!], {}, { [target!]: null }).rows[0]!.checkCounts).toBeNull();
  });

  it("dates a PR the board doesn't track from the reconciler's cheap read that confirmed its full read, never from one that saw a change", () => {
    const teammate = url("catalog", 362);
    const facts = { prUrl: teammate, number: 362, title: "Shelf labels", repo: "inkwell/catalog", headRefName: "abc-362", baseRefName: "main", headOid: "d".repeat(40),
      baseOid: "b".repeat(40), state: "OPEN" as const, isDraft: false, isCrossRepository: false, reviewDecision: "REVIEW_REQUIRED", mergeStateStatus: "BLOCKED",
      mergeable: "MERGEABLE", needsPreparation: false, readiness: "needs-attention" as const, detail: "", unresolvedThreads: 0, threadsComplete: true, checks: "passed" as const,
      basePrNumber: null, approvalFeedback: { status: "none" as const, fingerprint: null, sourceIds: [] } };
    const reviewWait = body(1, { cause: "review", owner: { kind: "reviewer", ref: "ines-v" }, wake: { event: "the review decision changes", ref: null, dueAt: NOW } });
    // No checkout and not yours: the board never reads it, and the reconciler reads it cheaply at its review poll.
    const read = (cheapAt: number) => instructed([teammate], [workRow(teammate, "waiting", reviewWait)], { facts: { [teammate]: null }, sources: { observation: () => null,
      full: () => ({ facts, fullAt: NOW - 40 * MINUTE, failedAt: null, error: null, signature: "unchanged", cheapAt }) } }).rows[0]!;
    expect(read(NOW - MINUTE)).toMatchObject({ observedAt: NOW - MINUTE, stale: false, staleAt: NOW + 29 * MINUTE });
    // The pr_facts store keeps no time for a cheap read that saw a change, so the 40-minute-old full read shows its age until it is read again.
    expect(read(NOW - 41 * MINUTE)).toMatchObject({ observedAt: NOW - 40 * MINUTE, stale: true });
  });

  it("marks a row stale once its observation is older than twice its poll, or a failed read is newer than the last success, and never a done row", () => {
    const [review, ci, board, failed, merged] = [url("catalog", 907), url("spine", 214), url("quill", 93), url("folio", 418), url("catalog", 899)];
    const seen: Record<string, { checkedAt: string; failedAt: string | null }> = {
      // A review wait polls every 15 minutes: 29 minutes is fresh, 31 stale.
      [review]: { checkedAt: new Date(NOW - 31 * MINUTE).toISOString(), failedAt: null },
      // A CI wait polls every 2 minutes, but no v2 step looks more often than every 5, so 9 minutes is fresh.
      [ci]: { checkedAt: new Date(NOW - 9 * MINUTE).toISOString(), failedAt: null },
      // A PR with no v2 step yet is read by the board's 10-minute refresh.
      [board]: { checkedAt: new Date(NOW - 21 * MINUTE).toISOString(), failedAt: null },
      [failed]: { checkedAt: new Date(NOW - MINUTE).toISOString(), failedAt: new Date(NOW - 30_000).toISOString() },
      [merged]: { checkedAt: new Date(NOW - 600 * MINUTE).toISOString(), failedAt: null },
    };
    const reviewWait = body(1, { cause: "review", owner: { kind: "reviewer", ref: "ines-v" }, wake: { event: "the review decision changes", ref: null, dueAt: NOW } });
    const rows = [workRow(review, "waiting", reviewWait), workRow(ci, "waiting", body(2)), workRow(failed, "waiting", body(4)),
      workRow(merged, "finished", body(5, { cause: "merged", userState: "done", wake: null }))];
    const read = (observation: (target: string) => { checkedAt: string; failedAt: string | null }) => instructed([review, ci, board, failed, merged], rows,
      { sources: { observation }, facts: { [merged]: pr(merged, { state: "MERGED" }) } });
    const result = read((target) => seen[target]!);
    // Each row goes stale at twice its poll past its last read, a failed read's row at once, and a done row never.
    expect(result.rows.map((row) => [row.n, row.stale, row.staleAt])).toEqual([[1, true, NOW - MINUTE], [2, false, NOW + MINUTE], [3, true, NOW - MINUTE],
      [4, true, NOW - 30_000], [5, false, null]]);
    // Two minutes earlier the review wait was 29 minutes old: fresh.
    expect(read((target) => target === review ? { ...seen[review]!, checkedAt: new Date(NOW - 29 * MINUTE).toISOString() } : seen[target]!).rows[0]!.stale).toBe(false);
  });

  it("raises one issue for launches paused while outcomes are uncertain, naming this effort's uncertain launches and how each recovers", () => {
    const [series, duplicated] = [url("folio", 421), url("quill", 191)];
    const uncertain = { ...attempt(series, "uncertain", { kind: "spawn", threadId: "thr_folio_421", reason: null }), body: {
      ...attempt(series, "uncertain", { kind: "spawn", threadId: "thr_folio_421", reason: null }).body, uncertainAt: NOW - 3 * MINUTE } };
    const rows = [workRow(series, "repair-needed", body(1, { cause: "launch-uncertain", userState: "doing", modifiers: ["recovering"], recovery: [] })),
      workRow(duplicated, "repair-needed", body(2, { cause: "duplicate-writer", detail: "More than one BB thread answers to attempt A-191", userState: "issue",
        recovery: ["reset N release"] }))];
    const read = (breakerOpen: boolean) => effortRoster({ effort: effort([series, duplicated]), redirectedFrom: null, execution: { mode: "v2", revision: 1 }, v2Execution: "on",
      sources: { now: NOW, groups: null, holds: {}, legacy: new Map(), runs: [], dispatch: [], threads: [], full: () => null, facts: (target) => pr(target), feedback: () => null,
        observation: () => null, tickets: () => new Map(), work: { items: new Map(), ownerForPr: () => null } },
      number: (list) => ({ snapshotId: null, rows: list.map((target) => ({ n: target === series ? 17 : 8, target, provisional: false })) }),
      launches: { breakerOpen, capacityFull: false, uncertain: [uncertain] },
      v2: { rows: new Map(rows.map((row) => [row.target, row])), included: new Set([series, duplicated]), scope: null, claims: new Map([[series, uncertain]]), active: null,
        rollup: null, contract: null, decisions: [], attempts: () => 0 } });
    const open = read(true);
    expect(open.launches).toEqual({ breakerOpen: true, capacityFull: false,
      uncertain: [{ n: 17, target: series, attemptId: uncertain.id, threadId: "thr_folio_421", since: NOW - 3 * MINUTE }] });
    expect(open.issues).toEqual([
      { ref: null, cause: "duplicate-writer", label: "More than one BB thread answers to attempt A-191", detail: null, numbers: [8], raisedAt: null, likelyThreadId: null,
        recovery: [{ command: "reset 8 release", label: "Reset 8…", confirm: true }] },
      { ref: null, cause: "launch-breaker", label: "Launch outcomes uncertain; new launches paused", numbers: [17], raisedAt: null, likelyThreadId: "thr_folio_421",
        detail: "Readback hasn't found the worker for 17 or ruled one out; running work continues",
        recovery: [{ command: "recheck launches", label: "Recheck launches", confirm: false }, { command: "reset 17 release", label: "Reset 17…", confirm: true }] },
    ]);
    // 17 stays Doing while it recovers; only the open breaker makes it an issue for you.
    expect(open.rows.find((row) => row.n === 17)).toMatchObject({ state: "doing", modifiers: ["recovering"], claim: { status: "uncertain" } });
    expect(read(false).issues.map((issue) => issue.cause)).toEqual(["duplicate-writer"]);
  });
});
