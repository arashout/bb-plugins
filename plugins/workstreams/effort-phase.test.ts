import { describe, expect, it } from "vitest";
import type { AdvanceFacts } from "./advance-contract.js";
import type { ApprovalFeedbackRecord } from "./approval-feedback.js";
import { DEFAULT_EFFECTS, VERBS, type InstructionScope } from "./effort-command.js";
import { decide, type Attempt, type DecideInput, type Next } from "./effort-phase.js";
import type { ResourceInput } from "./effort-resources.js";

const NOW = Date.UTC(2026, 8, 28, 12);
const MINUTE = 60_000;
const PR_URL = "https://github.com/inkwell/folio/pull/313";
const HEAD = "3".repeat(40);
const OLD_HEAD = "2".repeat(40);
const FINGERPRINT = "e".repeat(64);
const EFFORT = "e-shelving";
const HOST = "host_reader";
const SOURCE = "/Users/reader/src/folio";
const AUTHOR = "/Users/reader/src/folio-abc-340";

const facts = (overrides: Partial<AdvanceFacts> = {}): AdvanceFacts => ({
  prUrl: PR_URL, number: 313, title: "ABC-340 Keep shelf order on reload", repo: "inkwell/folio", headRefName: "abc-340", baseRefName: "main",
  headOid: HEAD, baseOid: "b".repeat(40), state: "OPEN", isDraft: false, isCrossRepository: false, reviewDecision: "APPROVED",
  mergeStateStatus: "CLEAN", mergeable: "MERGEABLE", needsPreparation: false, readiness: "ready", detail: "", unresolvedThreads: 0, threadsComplete: true,
  checks: "passed", basePrNumber: null, approvalFeedback: { status: "none", fingerprint: null, sourceIds: [] }, ...overrides,
});
/** Approval feedback that needs verified follow-up. */
const FEEDBACK = { approvalFeedback: { status: "present" as const, fingerprint: FINGERPRINT, sourceIds: ["review:811"] } };
const verified = (headOid: string): ApprovalFeedbackRecord => ({ attemptId: "A-0", headOid, fingerprint: FINGERPRINT, blockers: [], prUrl: PR_URL,
  threadId: "thr_origin", verifiedAt: NOW - 5 * MINUTE,
  findings: [{ sourceId: "review:811", resolution: "fixed", evidence: "Shelf order now survives a reload", validation: { outcome: "passed", detail: "npm test -- shelf" } }] });
const grant = (overrides: Partial<InstructionScope["include"][number]> = {}): InstructionScope["include"][number] =>
  ({ target: PR_URL, n: 4, outsideMembership: false, work: [...VERBS["move forward"].work], effects: [...DEFAULT_EFFECTS], reviewers: [], addedInRevision: 1, ...overrides });
const scope = (include = [grant()], removed: InstructionScope["removed"] = []): InstructionScope =>
  ({ revision: 1, include, exclude: [], removed, stopAt: "prepared", reportMode: "changes", outcome: null, criteria: [], answers: [] });
const attempt = (overrides: Partial<Attempt> = {}): Attempt => ({
  id: "A-1", status: "completed", threadId: "thr_origin", path: AUTHOR, workspace: null, recipes: ["address_review_feedback"], retryEpoch: 0,
  headOid: HEAD, fingerprint: FINGERPRINT, endedAt: NOW - 2 * MINUTE, result: "changed", blocker: null, failure: null, releasedReason: null,
  interactionPending: false, turnFailed: false, turnRetries: 0, ...overrides,
});
const author = { path: AUTHOR, githubRepo: "inkwell/folio", branch: "abc-340", prUrl: PR_URL, projectId: "proj_folio", hostId: HOST };
const source = { ...author, path: SOURCE, branch: "main", prUrl: null };
const codex = (reasoningLevel: "high" | "medium") => ({ providerId: "codex", model: "gpt-6-sol", reasoningLevel });

/** The author's clean checkout at the head, with the idle origin thread in it. */
const RESOURCES: Omit<ResourceInput, "effortId" | "pr" | "model" | "attempt"> = {
  hostId: HOST, units: [source, author], origin: "thr_origin", linked: [], writers: [], legacy: null, unpushedAllowed: false,
  inspections: new Map([[SOURCE, { ok: true, head: "a".repeat(40), branch: "main", clean: true, commonDir: `${SOURCE}/.git`, relation: "diverged" }],
    [AUTHOR, { ok: true, head: HEAD, branch: "abc-340", clean: true, commonDir: `${AUTHOR}/.git`, relation: "at-head" }]]),
  threads: [{ id: "thr_origin", providerId: "codex", status: "idle", archived: false, projectId: "proj_folio", hostId: HOST, environmentPath: AUTHOR, updatedAt: 1, contextUsed: 0.3 }],
};
function row(overrides: Partial<DecideInput> = {}, pr: Partial<AdvanceFacts> = {}): DecideInput {
  return {
    now: NOW, target: PR_URL, effort: { id: EFFORT, mode: "v2", archived: false }, ownerId: EFFORT, instruction: scope(), held: false,
    full: { facts: facts(pr), at: NOW - 30_000 }, feedback: null, reviewers: { reviewRequests: [], latestReviews: [{ login: "ada", state: "APPROVED" }] },
    attempts: [], codeActions: [], retryEpoch: 0, decision: null, declined: [], criteriaPending: false, settledDependencies: new Set(),
    admission: { capacityFull: false, breakerOpen: false }, models: { code: codex("high"), planning: codex("medium") },
    resources: RESOURCES,
    ...overrides,
  };
}
const state = (next: Next) => `${next.phase}:${next.cause}`;
/** Another PR in the same instruction. */
const SPINE = "https://github.com/inkwell/spine/pull/150";
const spine = (overrides: Partial<DecideInput> = {}, pr: Partial<AdvanceFacts> = {}) =>
  row({ target: SPINE, instruction: scope([grant(), grant({ target: SPINE, n: 5 })]), ...overrides }, { prUrl: SPINE, repo: "inkwell/spine", number: 150, ...pr });

/** Every row names what happens next: an action, a wait with its wake, a decision with an answer route, or a repair with its recovery. */
function accountable(next: Next): boolean {
  if (next.phase === "finished" || next.phase === "prepared") return true;
  if (next.nextAction !== null) return next.wake !== null;
  if (next.phase === "waiting" || next.phase === "paused") return next.owner !== null && next.wake !== null && next.wake.event !== "" && next.wake.dueAt > NOW;
  if (next.phase === "decision-needed") return (next.decision?.options.length ?? 0) > 0 && next.decision?.answer !== undefined;
  return next.phase === "repair-needed" && next.recovery.length > 0;
}

describe("decide()", () => {
  const scenarios: [string, DecideInput, string][] = [
    ["ambiguous origin: recorded as history, never a repair", row({ resources: { ...RESOURCES, origin: null, threads: [] } }, FEEDBACK), "queued:launching"],
    ["missing checkout: a worktree with its reason", row({ resources: { ...RESOURCES, units: [source] } }, FEEDBACK), "queued:launching"],
    ["active writer", row({ resources: { ...RESOURCES, writers: [{ owner: "thread", ref: "thr_teammate", path: null }] } }, FEEDBACK), "waiting:writer-available"],
    ["archived effort", row({ effort: { id: EFFORT, mode: "v2", archived: true } }, FEEDBACK), "paused:archived"],
    ["merge redirect: another effort owns it now", row({ ownerId: "e-destination" }, FEEDBACK), "paused:membership-moved"],
    ["stack parent open", row({}, { basePrNumber: 312 }), "waiting:parent"],
    ["hold", row({ held: true }, FEEDBACK), "paused:hold"],
    ["CI running", row({}, { checks: "pending" }), "waiting:ci"],
    ["CI completed green", row(), "prepared:merge-candidate"],
    ["feedback", row({}, FEEDBACK), "queued:launching"],
    ["head change after verified feedback", row({ feedback: verified(OLD_HEAD) }, FEEDBACK), "queued:launching"],
    ["malformed report", row({ attempts: [attempt({ result: "report-invalid" })] }, FEEDBACK), "queued:report-repair"],
    ["retry exhaustion", row({ attempts: [attempt({ id: "A-2", result: "failed" }), attempt({ result: "failed" })] }, FEEDBACK), "repair-needed:retry-exhausted"],
    ["restart during launch", row({ attempts: [attempt({ status: "launching", result: null, endedAt: null })] }, FEEDBACK), "executing:launching"],
    ["restart with an uncertain launch", row({ attempts: [attempt({ status: "uncertain", result: null, endedAt: null })] }, FEEDBACK), "repair-needed:launch-uncertain"],
    ["worker slots full", row({ admission: { capacityFull: true, breakerOpen: false } }, FEEDBACK), "waiting:capacity"],
    ["launch breaker open", row({ admission: { capacityFull: false, breakerOpen: true } }, FEEDBACK), "waiting:launch-breaker"],
    ["reviewers not read yet", row({ reviewers: null }, { reviewDecision: null }), "waiting:review"],
    ["feedback history unreadable on a fresh read", row({}, { approvalFeedback: { status: "unknown", fingerprint: null, sourceIds: [] } }), "repair-needed:feedback-unreadable"],
    ["merged", row({}, { state: "MERGED" }), "finished:merged"],
    ["dropped", row({ instruction: scope([], [{ target: PR_URL, n: 4, reason: "dropped", revision: 2 }]) }), "finished:cancelled"],
  ];
  it.each(scenarios)("%s", (_name, input, expected) => {
    const next = decide(input);
    expect(state(next)).toBe(expected);
    expect(accountable(next), JSON.stringify(next)).toBe(true);
  });

  it("launches work that reuses the checkout and thread, or names why it allocates one", () => {
    expect(decide(row({}, FEEDBACK))).toMatchObject({ nextAction: ["address_review_feedback"], resource: { kind: "reuse", threadId: "thr_origin" } });
    expect(decide(row({ resources: { ...RESOURCES, units: [source] } }, FEEDBACK)))
      .toMatchObject({ resource: { kind: "worktree", reason: `no checkout on ${HOST}`, workspace: { batchId: `effort-${EFFORT}`, jobId: "pr-313" } } });
  });

  it("gives an open stack parent's child its preparation work, then waits on the parent, never Ready", () => {
    const parent = { basePrNumber: 312, ...FEEDBACK };
    expect(decide(row({}, parent))).toMatchObject({ phase: "queued", nextAction: ["address_review_feedback"] });
    expect(decide(row({ feedback: verified(HEAD) }, parent))).toMatchObject({ phase: "waiting", cause: "parent", owner: { kind: "pr", ref: "inkwell/folio#312" } });
    expect(decide(row({ feedback: verified(HEAD) }, FEEDBACK)).phase).toBe("prepared");
  });

  it("lets a hold win over every instruction and every step after it", () => {
    const everything = scope([grant({ effects: [...DEFAULT_EFFECTS, "mark-ready", "request-review"], reviewers: ["ada"] })]);
    expect(state(decide(row({ held: true, instruction: everything })))).toBe("paused:hold");
    expect(state(decide(row({ held: true, instruction: everything }, FEEDBACK)))).toBe("paused:hold");
    expect(state(decide(row({ held: true, attempts: [attempt({ result: "blocked:product-decision" })] }, FEEDBACK)))).toBe("paused:hold");
    expect(state(decide(row({ held: true, instruction: everything }, { isDraft: true })))).toBe("paused:hold");
  });

  it("drains a running turn when a hold arrives, offering Stop, and starts nothing new", () => {
    const running = attempt({ status: "running", result: null, endedAt: null });
    expect(decide(row({ held: true, attempts: [running] }, FEEDBACK)))
      .toMatchObject({ phase: "executing", modifiers: ["draining"], offers: ["stop"], nextAction: "attach", owner: { kind: "v2-attempt", ref: "A-1" } });
    // Superseded while running: the turn drains before the row finishes.
    const superseded = scope([], [{ target: PR_URL, n: 4, reason: "superseded", revision: 2 }]);
    expect(decide(row({ instruction: superseded, attempts: [running] }))).toMatchObject({ phase: "executing", modifiers: ["draining"] });
    expect(state(decide(row({ instruction: superseded })))).toBe("finished:superseded");
    // A PR that merges mid-turn drains too, and an uncertain launch on it is still read back, so it can't hold the launch breaker open.
    expect(decide(row({ attempts: [running] }, { state: "MERGED" }))).toMatchObject({ phase: "executing", modifiers: ["draining"], offers: ["stop"] });
    expect(decide(row({ attempts: [attempt({ status: "uncertain", result: null, endedAt: null })] }, { state: "CLOSED" })))
      .toMatchObject({ phase: "repair-needed", cause: "launch-uncertain", modifiers: ["recovering", "draining"], nextAction: "recover-launch" });
  });

  it("never retries a failed turn once a hold, archive, or drop arrives: the retry is the next action they block", () => {
    const failed = attempt({ status: "running", result: null, endedAt: null, turnFailed: true, turnRetries: 0 });
    expect(decide(row({ held: true, attempts: [failed] }))).toMatchObject({ phase: "paused", cause: "hold", nextAction: null });
    expect(decide(row({ effort: { id: EFFORT, mode: "v2", archived: true }, attempts: [failed] }))).toMatchObject({ phase: "paused", cause: "archived", nextAction: null });
    expect(decide(row({ instruction: scope([], [{ target: PR_URL, n: 4, reason: "dropped", revision: 2 }]), attempts: [failed] })))
      .toMatchObject({ phase: "finished", cause: "cancelled", nextAction: null });
    // Released, the row retries the turn within its bound.
    expect(decide(row({ attempts: [failed] }))).toMatchObject({ cause: "turn-retry", nextAction: "retry-turn" });
  });

  it("pauses a row whose PR another effort now owns, even while its instruction still includes it", () => {
    expect(decide(row({ ownerId: "e-reader-accounts" }))).toMatchObject({ phase: "paused", cause: "membership-moved", owner: { kind: "user" } });
    // An unowned PR included from outside membership keeps working.
    expect(state(decide(row({ ownerId: null, instruction: scope([grant({ outsideMembership: true })]) }, FEEDBACK)))).toBe("queued:launching");
  });

  it("invalidates only head-bound proof when the head changes", () => {
    const exhausted = [attempt({ id: "A-2", headOid: OLD_HEAD, result: "failed" }), attempt({ headOid: OLD_HEAD, result: "failed" })];
    expect(state(decide(row({ attempts: exhausted }, { ...FEEDBACK, headOid: OLD_HEAD })))).toBe("repair-needed:retry-exhausted");
    // A new head resets the bound and the feedback proof, and nothing else.
    expect(decide(row({ attempts: exhausted, feedback: verified(OLD_HEAD) }, FEEDBACK))).toMatchObject({ phase: "queued", nextAction: ["address_review_feedback"] });
    // New feedback on the same head is new work, and so is a retry: each resets the bound.
    const onHead = [attempt({ id: "A-2", result: "failed" }), attempt({ result: "failed" })];
    expect(state(decide(row({ attempts: onHead }, FEEDBACK)))).toBe("repair-needed:retry-exhausted");
    expect(state(decide(row({ attempts: onHead }, { approvalFeedback: { ...FEEDBACK.approvalFeedback, fingerprint: "f".repeat(64) } })))).toBe("queued:launching");
    expect(state(decide(row({ attempts: onHead, retryEpoch: 1 }, FEEDBACK)))).toBe("queued:launching");
    expect(state(decide(row({ feedback: verified(OLD_HEAD) }, { ...FEEDBACK, headOid: OLD_HEAD })))).toBe("prepared:merge-candidate");
    const decision = { key: "product:keep shelf order per reader?", kind: "product", subkind: null, question: "Keep shelf order per reader?", options: [{ id: "a", label: "Per reader" }], grants: null };
    expect(decide(row({ decision, feedback: verified(OLD_HEAD) }, FEEDBACK))).toMatchObject({ phase: "decision-needed", cause: "product", decision: { key: decision.key } });
  });

  it("asks the worker's own thread to re-emit a missing report, and names an issue when the correction fails too", () => {
    expect(decide(row({ attempts: [attempt({ result: "report-invalid" })] }, FEEDBACK)))
      .toMatchObject({ nextAction: ["repair_report"], resource: { kind: "same-thread", threadId: "thr_origin" } });
    const correction = attempt({ id: "A-2", recipes: ["repair_report"], result: "report-invalid" });
    expect(decide(row({ attempts: [correction, attempt({ result: "report-invalid" })] }, FEEDBACK)))
      .toMatchObject({ phase: "repair-needed", cause: "report-unrepairable", recovery: ["retry N"] });
    // A report not parsed yet is read first; prose alone never makes a row Ready.
    expect(state(decide(row({ attempts: [attempt({ result: null })] })))).toBe("verifying:parse-report");
  });

  it("reverifies a changed report on a read taken after the turn, never before it", () => {
    const changed = [attempt({ endedAt: NOW - 10_000 })];
    expect(state(decide(row({ attempts: changed }, FEEDBACK)))).toBe("verifying:observe");
    expect(state(decide(row({ attempts: changed, full: { facts: facts({ checks: "pending" }), at: NOW - 5_000 } })))).toBe("waiting:ci");
  });

  it("routes blockers: a dependency waits on its PR, a question asks once across PRs, and a new epoch reopens work", () => {
    const blocked = (blocker: Attempt["blocker"], result: Attempt["result"]) => row({ attempts: [attempt({ result, blocker })] }, FEEDBACK);
    const dependency = { summary: "Needs the catalog API change", question: null, options: [], prUrl: "https://github.com/inkwell/catalog/pull/96" };
    expect(decide(blocked(dependency, "blocked:dependency"))).toMatchObject({ phase: "waiting", cause: "dependency", owner: { kind: "pr", ref: dependency.prUrl } });
    expect(state(decide({ ...blocked(dependency, "blocked:dependency"), settledDependencies: new Set([dependency.prUrl]) }))).toBe("queued:launching");
    expect(state(decide(blocked({ ...dependency, prUrl: null }, "blocked:dependency")))).toBe("decision-needed:worker-question");
    // Authority is granted per target, so the same scope question from two PRs asks twice.
    const widen = { summary: "Needs a schema migration", question: "Allow a schema migration?", options: [], prUrl: null };
    expect(decide(blocked(widen, "blocked:scope")).decision?.key).not.toBe(decide(spine({ attempts: [attempt({ result: "blocked:scope", blocker: widen })] }, FEEDBACK)).decision?.key);
    const product = { summary: "Shelf order scope", question: "Keep shelf order per reader or per store?", options: [{ id: "a", label: "Per reader" }, { id: "b", label: "Per store" }], prUrl: null };
    const asked = decide(blocked(product, "blocked:product-decision"));
    expect(asked).toMatchObject({ phase: "decision-needed", cause: "product", decision: { options: product.options, answer: "command" } });
    expect(decide(spine({ attempts: [attempt({ result: "blocked:product-decision", blocker: product })] }, FEEDBACK)).decision?.key).toBe(asked.decision?.key);
    // An answer starts a new epoch: the old report no longer routes, and the work resumes with the answer.
    expect(state(decide({ ...blocked(product, "blocked:product-decision"), retryEpoch: 1 }))).toBe("queued:launching");
  });

  it("backs off an environment blocker, then retries within the bound", () => {
    const environment = { summary: "The shelf service sandbox was down", question: null, options: [], prUrl: null };
    const blocked = row({ attempts: [attempt({ recipes: ["integrate_base"], result: "blocked:environment", blocker: environment, endedAt: NOW - 30_000 })] }, { mergeStateStatus: "BEHIND" });
    expect(decide(blocked)).toMatchObject({ phase: "waiting", cause: "source-unavailable", wake: { dueAt: NOW + 30_000 } });
    expect(state(decide({ ...blocked, now: NOW + 31_000, full: { facts: facts({ mergeStateStatus: "BEHIND" }), at: NOW + 30_000 } }))).toBe("queued:launching");
  });

  it("reruns failing checks once per head after an environment blocker, then names a CI issue", () => {
    const environment = { summary: "Runner lost its cache", question: null, options: [], prUrl: null };
    const reported = row({ attempts: [attempt({ recipes: ["fix_failing_checks"], result: "blocked:environment", blocker: environment })] }, { checks: "failed" });
    expect(decide(reported)).toMatchObject({ phase: "queued", cause: "code-action", nextAction: ["rerun_failed_checks"] });
    expect(state(decide({ ...reported, codeActions: [{ recipe: "rerun_failed_checks", headOid: HEAD, status: "done" }] }))).toBe("repair-needed:ci-infrastructure");
    // In a composed order, the recipe's own route wins over the shared backoff.
    const composed = row({ attempts: [attempt({ recipes: ["integrate_base", "fix_failing_checks"], result: "blocked:environment", blocker: environment })] },
      { checks: "failed", mergeStateStatus: "BEHIND" });
    expect(decide(composed)).toMatchObject({ phase: "queued", nextAction: ["rerun_failed_checks"] });
    // The blocker speaks for the checks on its own head: a new head's failures get a fresh fix, and running checks aren't rerun.
    const older = row({ attempts: [attempt({ recipes: ["fix_failing_checks"], headOid: OLD_HEAD, result: "blocked:environment", blocker: environment })] }, { checks: "failed" });
    expect(decide(older)).toMatchObject({ phase: "queued", nextAction: ["fix_failing_checks"] });
    expect(state(decide({ ...reported, full: { facts: facts({ checks: "pending" }), at: NOW - 30_000 } }))).toBe("waiting:ci");
  });

  it("joins drafts with settled mechanics to one grouped decision, and a kept draft waits on you without asking again", () => {
    const draft = { isDraft: true, reviewDecision: null };
    const asked = decide(row({}, draft));
    expect(asked).toMatchObject({ phase: "decision-needed", cause: "lifecycle", decision: { key: "lifecycle:mark-ready", subkind: "mark-ready" } });
    // Another PR's draft asks the identical question, so the effort holds one decision for both.
    const other = decide(spine({}, draft));
    expect([other.decision?.key, other.decision?.question]).toEqual([asked.decision?.key, asked.decision?.question]);
    expect(decide(row({ declined: ["mark-ready"] }, draft))).toMatchObject({ phase: "waiting", cause: "draft", owner: { kind: "user" }, decision: null });
    expect(state(decide(row({}, { ...draft, checks: "pending" })))).toBe("waiting:ci");
    expect(decide(row({ instruction: scope([grant({ effects: [...DEFAULT_EFFECTS, "mark-ready"] })]) }, draft))).toMatchObject({ phase: "queued", nextAction: ["mark_ready_for_review"] });
  });

  it("gives a draft only branch and check mechanics", () => {
    expect(decide(row({}, { isDraft: true, reviewDecision: null, checks: "failed" }))).toMatchObject({ nextAction: ["fix_failing_checks"] });
    expect(decide(row({}, { isDraft: true, reviewDecision: null, ...FEEDBACK })).decision?.subkind).toBe("mark-ready");
  });

  it("asks once per effort whom to request review from when none is requested", () => {
    const none = { reviewRequests: [], latestReviews: [] };
    const asked = decide(row({ reviewers: none }, { reviewDecision: null }));
    expect(asked).toMatchObject({ phase: "decision-needed", cause: "lifecycle", decision: { key: "lifecycle:request-review", subkind: "request-review" } });
    expect(decide(spine({ reviewers: none }, { reviewDecision: null })).decision).toEqual(asked.decision);
    expect(decide(row({ reviewers: none, declined: ["request-review"] }, { reviewDecision: null }))).toMatchObject({ phase: "waiting", cause: "review", owner: { kind: "user" } });
    const granted = scope([grant({ effects: [...DEFAULT_EFFECTS, "request-review"], reviewers: ["ada"] })]);
    expect(decide(row({ reviewers: none, instruction: granted }, { reviewDecision: null }))).toMatchObject({ phase: "queued", nextAction: ["request_review"] });
    // Once requested, the row waits on the reviewer even before a read shows the request.
    expect(decide(row({ reviewers: none, instruction: granted, codeActions: [{ recipe: "request_review", headOid: HEAD, status: "done" }] }, { reviewDecision: null })))
      .toMatchObject({ phase: "waiting", cause: "review", detail: "Waiting for review from @ada", owner: { kind: "reviewer", ref: "ada" } });
  });

  it("re-requests review from a reviewer who asked for changes once the follow-up is verified, once per head", () => {
    const changes = { reviewDecision: "CHANGES_REQUESTED", reviewFollowupPosted: true };
    const reviewers = { reviewRequests: [], latestReviews: [{ login: "ada", state: "CHANGES_REQUESTED" }] };
    expect(decide(row({ reviewers }, changes))).toMatchObject({ phase: "queued", cause: "code-action", nextAction: ["request_rereview"] });
    // Code actions use no worker slot.
    expect(state(decide(row({ reviewers, admission: { capacityFull: true, breakerOpen: true } }, changes)))).toBe("queued:code-action");
    expect(state(decide(row({ reviewers, instruction: scope([grant({ effects: DEFAULT_EFFECTS.filter((effect) => effect !== "request-rereview") })]) }, changes))))
      .toBe("decision-needed:authority");
    const done = decide(row({ reviewers, codeActions: [{ recipe: "request_rereview", headOid: HEAD, status: "done" }] }, changes));
    expect(done).toMatchObject({ phase: "waiting", cause: "review" });
    expect(state(decide(row({ reviewers, codeActions: [{ recipe: "request_rereview", headOid: HEAD, status: "pending" }] }, changes)))).toBe("executing:code-action");
    // A rate limit waits for its reset, then the action runs again on the same head.
    const limited = [{ recipe: "request_rereview" as const, headOid: HEAD, status: "rate-limited" as const, retryAt: NOW + 10 * MINUTE }];
    expect(decide(row({ reviewers, codeActions: limited }, changes))).toMatchObject({ phase: "waiting", cause: "rate-limit", wake: { dueAt: NOW + 10 * MINUTE } });
    expect(state(decide(row({ now: NOW + 10 * MINUTE, reviewers, codeActions: limited, full: { facts: facts(changes), at: NOW + 9 * MINUTE } }, changes)))).toBe("queued:code-action");
    // A GitHub write needs a read under two minutes old.
    expect(state(decide(row({ reviewers, full: { facts: facts(changes), at: NOW - 5 * MINUTE } }, changes)))).toBe("verifying:observe");
  });

  it("answers a waiting worker in its thread, and pauses a deleted work order until a retry", () => {
    expect(decide(row({ attempts: [attempt({ status: "running", result: null, endedAt: null, interactionPending: true })] })))
      .toMatchObject({ phase: "decision-needed", cause: "worker-interaction", decision: { answer: "open-thread", options: [{ id: "open", label: "Open thread" }] } });
    const deleted = attempt({ status: "released", releasedReason: "user-cancelled", result: null });
    expect(decide(row({ attempts: [deleted] }, FEEDBACK))).toMatchObject({ phase: "paused", cause: "user-cancelled", owner: { kind: "user" } });
    expect(state(decide(row({ attempts: [deleted], retryEpoch: 1 }, FEEDBACK)))).toBe("queued:launching");
  });

  it("retries a failed turn twice, then names the failure with an attempt that ended, so retry N can start a new one", () => {
    const failed = (turnRetries: number) => decide(row({ attempts: [attempt({ status: "running", result: null, endedAt: null, turnFailed: true, turnRetries })] }));
    expect(failed(1)).toMatchObject({ phase: "repair-needed", cause: "turn-retry", modifiers: ["recovering"], nextAction: "retry-turn" });
    // Past the bound the runner still takes the step: it ends the attempt, which releases the claim.
    expect(failed(2)).toMatchObject({ phase: "repair-needed", cause: "turn-retry", nextAction: "retry-turn", detail: "The worker's turn failed 3 times; ending the attempt" });
    const ended = [attempt({ status: "failed", result: null, failure: "turn-failed" })];
    const CONFLICT = { mergeStateStatus: "DIRTY", mergeable: "CONFLICTING" };
    expect(decide(row({ attempts: ended }, CONFLICT))).toMatchObject({ phase: "repair-needed", cause: "turn-failed", recovery: ["retry N"], nextAction: null });
    expect(decide(row({ attempts: ended, retryEpoch: 1 }, CONFLICT))).toMatchObject({ phase: "queued", cause: "launching", nextAction: ["integrate_base"] });
  });

  it("waits on branch protection and other merge requirements by name", () => {
    expect(decide(row({}, { mergeStateStatus: "BLOCKED" }))).toMatchObject({ phase: "waiting", cause: "merge-blocked", owner: { kind: "github" } });
    expect(state(decide(row({}, { mergeStateStatus: "UNSTABLE" })))).toBe("waiting:merge-requirements");
    expect(state(decide(row({}, { mergeStateStatus: "UNKNOWN", mergeable: "UNKNOWN" })))).toBe("verifying:observe");
  });

  it("plans a launch's recipes before its checkout is read, never inventing a checkout, and still waits on the PR's other writers and repairs a fork", () => {
    const unread = { legacy: null, writers: [], inspections: null };
    expect(decide(row({ resources: unread }, FEEDBACK))).toMatchObject({ phase: "queued", cause: "launching", nextAction: ["address_review_feedback"], resource: null,
      detail: "address_review_feedback once its checkout and thread are read" });
    expect(state(decide(row({ resources: { ...unread, writers: [{ owner: "run", ref: "run-7", path: null }] } }, FEEDBACK)))).toBe("waiting:writer-available");
    expect(state(decide(row({ resources: unread, admission: { capacityFull: true, breakerOpen: false } }, FEEDBACK)))).toBe("waiting:capacity");
    // The full read already says a fork's branch can't be pushed, so no launch is planned for it.
    expect(decide(row({ resources: unread }, { ...FEEDBACK, isCrossRepository: true }))).toMatchObject({ phase: "repair-needed", cause: "fork", nextAction: null });
  });

  it("honors an answer that allows work beside the author's unpushed commits", () => {
    const ahead: { resources: typeof RESOURCES } = { resources: { ...RESOURCES, inspections: new Map([...RESOURCES.inspections,
      [AUTHOR, { ok: true as const, head: "9".repeat(40), branch: "abc-340", clean: true, commonDir: `${AUTHOR}/.git`, relation: "diverged" as const }]]) } };
    expect(decide(row(ahead, FEEDBACK))).toMatchObject({ phase: "decision-needed", cause: "authority", decision: { key: `authority:${PR_URL}:checkout` } });
    expect(decide(row({ resources: { ...ahead.resources, unpushedAllowed: true } }, FEEDBACK)))
      .toMatchObject({ phase: "queued", resource: { kind: "worktree", reason: `unpushed commits in ${AUTHOR}` } });
  });

  it("names a system issue when feedback history stays unreadable on a fresh read, and reads again only when stale", () => {
    const unknown = { approvalFeedback: { status: "unknown" as const, fingerprint: null, sourceIds: [] } };
    expect(decide(row({}, unknown))).toMatchObject({ phase: "repair-needed", cause: "feedback-unreadable", recovery: ["refresh N"], wake: { dueAt: NOW + 15 * MINUTE } });
    expect(state(decide(row({ full: { facts: facts(unknown), at: NOW - 5 * MINUTE } })))).toBe("verifying:observe");
  });

  it("asks for authority when the instruction doesn't grant what the failing gates need, naming everything allow would grant", () => {
    const noPush = decide(row({ instruction: scope([grant({ effects: DEFAULT_EFFECTS.filter((effect) => effect !== "push") })]) }, FEEDBACK));
    expect(noPush).toMatchObject({ phase: "decision-needed", cause: "authority", decision: { key: `authority:${PR_URL}:push`, grants: { work: [], effects: ["push"] } } });
    expect(decide(row({ instruction: scope([grant({ work: ["fix_failing_checks"] })]) }, { mergeStateStatus: "BEHIND" })))
      .toMatchObject({ detail: expect.stringContaining("needs integrate base,"), decision: { grants: { work: ["integrate_base"], effects: [] } } });
    // Work the verb didn't grant, on a PR its push was taken from: allow grants both, so the question names both.
    const narrowed = grant({ work: ["fix_failing_checks"], effects: ["code-fix", "test", "rerun-checks"] });
    expect(decide(row({ instruction: scope([narrowed]) }, { mergeStateStatus: "BEHIND" })).decision)
      .toMatchObject({ question: "inkwell/folio #313 needs integrate base, push, which this instruction doesn't grant. Allow it?", grants: { work: ["integrate_base"], effects: ["push"] } });
    // Criteria run alone only when nothing else is due, and only when the instruction covers them.
    expect(decide(row({ criteriaPending: true }))).toMatchObject({ nextAction: ["validate_criteria"] });
    expect(decide(row({ criteriaPending: true }, FEEDBACK))).toMatchObject({ nextAction: ["address_review_feedback"] });
  });

  it("holds launches for capacity, the breaker, and a stale read, but never waits on freshness", () => {
    expect(decide(row({ admission: { capacityFull: true, breakerOpen: false } }, FEEDBACK))).toMatchObject({ cause: "capacity", owner: { kind: "v2-attempt" } });
    expect(decide(row({ admission: { capacityFull: false, breakerOpen: true } }, FEEDBACK))).toMatchObject({ cause: "launch-breaker", owner: { kind: "v2-attempt" } });
    const stale = { at: NOW - 5 * MINUTE };
    expect(state(decide(row({ full: { facts: facts(FEEDBACK), ...stale } })))).toBe("verifying:observe");
    expect(state(decide(row({ full: { facts: facts(), ...stale } })))).toBe("verifying:observe");
    expect(state(decide(row({ full: { facts: facts({ checks: "pending" }), ...stale } })))).toBe("waiting:ci");
  });

  it("is deterministic", () => {
    for (const [, input] of scenarios) expect(decide(input)).toEqual(decide(input));
  });
});

describe("decide() with launch readback", () => {
  const lost = (id: string) => attempt({ id, status: "released", releasedReason: "no-worker", result: null, endedAt: null });
  it("counts no launch that readback proved never started a worker, and requeues such a launch only once", () => {
    // One lost launch beside one finished attempt: the bound of two attempts on this head still has room.
    expect(state(decide(row({ attempts: [attempt({ id: "A-2" }), lost("A-1")] }, FEEDBACK)))).toBe("queued:launching");
    const twice = decide(row({ attempts: [lost("A-2"), lost("A-1")] }, FEEDBACK));
    expect([state(twice), twice.detail]).toEqual(["repair-needed:retry-exhausted", "address_review_feedback launched twice on this head and readback found no worker either time"]);
    // A new epoch (retry N, reset N) starts the count over.
    expect(state(decide(row({ attempts: [lost("A-2"), lost("A-1")], retryEpoch: 1 }, FEEDBACK)))).toBe("queued:launching");
  });

  it("keeps an uncertain claim whose readback found several workers or couldn't read BB, as a named issue or a wait", () => {
    const uncertain = (failure: string | null) => decide(row({ attempts: [attempt({ status: "uncertain", result: null, endedAt: null, failure })] }, FEEDBACK));
    expect(state(uncertain(null))).toBe("repair-needed:launch-uncertain");
    expect(uncertain("duplicate-writer")).toMatchObject({ phase: "repair-needed", cause: "duplicate-writer", recovery: ["reset N release"], owner: { kind: "v2-attempt", ref: "A-1" } });
    expect(uncertain("source-unavailable")).toMatchObject({ phase: "waiting", cause: "source-unavailable", owner: { kind: "v2-attempt", ref: "A-1" } });
  });
});
