import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AdvanceFacts } from "./advance-contract.js";
import { DEFAULT_EFFECTS, VERBS, type InstructionScope } from "./effort-command.js";
import { decide } from "./effort-phase.js";
import { evidenceContract, pendingCriteria, type ContractRow, type CriterionEvidence, type RowStep } from "./outcome-evidence.js";
import { GATE_IDS, type GateId, type Gates } from "./pr-gates.js";

const NOW = Date.UTC(2026, 8, 28, 12);
const pr = (repo: string, number: number) => `https://github.com/inkwell/${repo}/pull/${number}`;
const TARGETS = [pr("folio", 313), pr("folio", 314), pr("spine", 150), pr("atlas", 401), pr("quill", 208)];
const head = (n: number) => String(n).repeat(40);
const NEW_HEAD = "a".repeat(40);
const green = Object.fromEntries(GATE_IDS.map((gate) => [gate, true])) as Gates;
const failing = (...gates: GateId[]): Gates => ({ ...green, ...Object.fromEntries(gates.map((gate) => [gate, false])) });
const wake = (event: string) => ({ event, ref: null, dueAt: NOW });
const step = (phase: RowStep["phase"], cause: string, more: Partial<RowStep> = {}): RowStep =>
  ({ phase, cause, modifiers: [], nextAction: null, owner: null, wake: wake("the next reconciler pass"), decision: null, ...more });
const READY = step("prepared", "merge-candidate", { owner: { kind: "user", ref: null }, wake: wake("the PR changes or merges") });
const CI = step("waiting", "ci", { owner: { kind: "ci", ref: null }, wake: wake("check results change") });
const MERGED = step("finished", "merged", { wake: null });
const FIX_CHECKS = step("queued", "launching", { nextAction: ["fix_failing_checks"] });
const AUTHORITY = step("decision-needed", "authority", { owner: { kind: "user", ref: null }, wake: wake("an answer, or the PR merging"),
  decision: { key: "authority:folio-313:push", kind: "authority", subkind: null, question: "Allow v2 to push to inkwell/folio #313?", options: [{ id: "allow", label: "Allow" }], grants: { work: [], effects: ["push"] }, answer: "command" } });

type Row = ContractRow & { step: RowStep };
const row = (n: number, overrides: Partial<Row> = {}): Row =>
  ({ target: TARGETS[n - 1]!, n, state: "OPEN", heads: [head(n)], checkout: true, tickets: [], gates: green, step: READY, ...overrides });
const merged = (n: number, overrides: Partial<Row> = {}) => row(n, { state: "MERGED", step: MERGED, ...overrides });
type UserCriterion = InstructionScope["criteria"][number];
const criterion = (id: string, text: string, binding: number[] | "effort"): UserCriterion =>
  ({ id, text, binding: binding === "effort" ? { kind: "effort" } : { kind: "targets", n: binding }, addedInRevision: 1, droppedInRevision: null });
const scope = (rows: readonly Row[], criteria: UserCriterion[] = [], outcome: string | null = null): InstructionScope => ({
  revision: 1, stopAt: "prepared", reportMode: "changes", outcome, criteria, exclude: [], removed: [], answers: [],
  include: rows.map((item) => ({ target: item.target, n: item.n, outsideMembership: false, work: [...VERBS["move forward"].work], effects: [...DEFAULT_EFFECTS], reviewers: [], addedInRevision: 1 })),
});
const proof = (id: string, n: number, headOid = head(n), more: Partial<CriterionEvidence> = {}): CriterionEvidence =>
  ({ criterion: id, target: TARGETS[n - 1]!, headOid, outcome: "passed", accepted: true, revision: 1, ...more });
const contract = (rows: Row[], criteria: UserCriterion[] = [], evidence: CriterionEvidence[] = [], outcome: string | null = null) =>
  evidenceContract({ scope: scope(rows, criteria, outcome), goal: "Readers keep their shelves in order", rows, evidence });
const find = (result: ReturnType<typeof contract>, id: string) => result.criteria.find((item) => item.id === id)!;
const numbers = (result: ReturnType<typeof contract>, id: string) => find(result, id).affected.map((item) => item.n);

describe("outcome evidence contract", () => {
  it("aggregates the stopping point's gates by family, listing the PRs each still waits on, with finished PRs exempt", () => {
    const result = contract([row(1), row(2, { gates: failing("checks-green"), step: FIX_CHECKS }),
      row(3, { gates: failing("checks-settled", "checks-green", "parent-merged"), step: CI }), merged(4, { gates: failing("checks-green", "approved") })]);
    expect(result.criteria.filter((item) => item.source === "gate").map((item) => [item.id, item.status, item.affected.map((target) => target.n)])).toEqual([
      ["branch", "satisfied", []], ["checks", "missing", [2, 3]], ["feedback", "satisfied", []], ["review", "satisfied", []],
      ["dependencies", "missing", [3]], ["merge", "satisfied", []]]);
    // Our own queued work moves checks first; the CI wait on 3 is named after it.
    expect(find(result, "checks").next).toEqual({ action: "fix_failing_checks (2); also 3", owner: "v2", wake: "the next reconciler pass" });
    // PRs with the same step group into one next action, like "2 CI runs (2, 5)".
    const waits = contract([row(1), row(2, { gates: failing("checks-settled", "checks-green"), step: CI }), row(5, { gates: failing("checks-settled", "checks-green"), step: CI })]);
    expect(find(waits, "checks").next).toEqual({ action: "wait: ci (2, 5)", owner: "CI", wake: "check results change" });
    // An unread PR can't prove any family; a draft waits under review.
    const unread = contract([row(1, { gates: null, state: null, heads: [], step: step("verifying", "observe", { nextAction: "observe" }) }), row(2, { gates: failing("not-draft") })]);
    expect(unread.criteria.filter((item) => item.source === "gate").map((item) => [item.id, numbers(unread, item.id)])).toEqual([
      ["branch", [1]], ["checks", [1]], ["feedback", [1]], ["review", [1, 2]], ["dependencies", [1]], ["merge", [1]]]);
  });

  it("satisfies a ticket only when every included PR implementing it is Ready or merged, never by the ticket's presence", () => {
    const shelf = { id: "ABC-340", title: "Keep shelf order on reload" };
    const genre = { id: "ABC-341", title: "Group shelves by genre" };
    // A worker can report a ticket as supporting evidence; it proves nothing.
    const evidence = [proof("ticket:ABC-340", 2)];
    const waiting = contract([row(1, { tickets: [shelf] }), row(2, { tickets: [shelf], gates: failing("checks-settled", "checks-green"), step: CI }), row(3, { tickets: [genre] })], [], evidence);
    expect(find(waiting, "ticket:ABC-340")).toMatchObject({ status: "missing", label: "ABC-340 Keep shelf order on reload", affected: [{ n: 2 }],
      next: { action: "wait: ci (2)", owner: "CI" } });
    expect(find(waiting, "ticket:ABC-341").status).toBe("satisfied");
    // Green gates alone are not Ready: a held PR still leaves its ticket short.
    const held = contract([row(1, { tickets: [shelf], step: step("paused", "hold", { owner: { kind: "user", ref: null }, wake: wake("the hold is released") }) })]);
    expect(find(held, "ticket:ABC-340")).toMatchObject({ status: "missing", next: { action: "paused: hold (1)", owner: "you" } });
    expect(find(contract([row(1, { tickets: [shelf] }), merged(2, { tickets: [shelf] })]), "ticket:ABC-340").status).toBe("satisfied");
    // A PR closed without merging never implements it.
    const closed = contract([row(1, { tickets: [shelf], state: "CLOSED", step: step("finished", "closed", { wake: null }) })]);
    expect(find(closed, "ticket:ABC-340")).toMatchObject({ status: "missing", next: { action: "closed (1)", owner: "you" } });
  });

  it("accepts a user criterion only from an accepted report on its PR's current head, and a head change invalidates only that PR's proof", () => {
    const criteria = [criterion("c1", "the shelf order test passes", [1]), criterion("c2", "genre shelves render", [2])];
    const evidence = [proof("c1", 1), proof("c2", 2)];
    const both = contract([row(1), row(2)], criteria, evidence);
    expect([find(both, "c1").status, find(both, "c2").status]).toEqual(["satisfied", "satisfied"]);
    const moved = contract([row(1, { heads: [NEW_HEAD] }), row(2)], criteria, evidence);
    expect(find(moved, "c1")).toMatchObject({ status: "invalidated", affected: [{ n: 1 }] });
    expect(find(moved, "c2").status).toBe("satisfied");
    // A new head with the same tree keeps the proof.
    expect(find(contract([row(1, { heads: [NEW_HEAD, head(1)] }), row(2)], criteria, evidence), "c1").status).toBe("satisfied");
    // A rejected report proves nothing, and proof on another PR doesn't count.
    expect(find(contract([row(1), row(2)], criteria, [proof("c1", 1, head(1), { accepted: false }), proof("c1", 2, head(2))]), "c1").status).toBe("missing");
    // The newest result on the head wins; a failure needs your call.
    const failed = contract([row(1), row(2)], criteria, [proof("c1", 1, head(1), { outcome: "failed" }), ...evidence]);
    expect(find(failed, "c1")).toMatchObject({ status: "blocked", next: { action: "authorize a fix on 1, or drop c1", owner: "you", wake: "your answer" } });
    // A criterion bound to a PR that left the instruction can't hold until it returns or is dropped.
    expect(find(contract([row(2)], criteria, evidence), "c1")).toMatchObject({ status: "missing",
      next: { action: "1 left the instruction: include it again, or drop c1", owner: "you" } });
    // A dropped criterion is gone from the contract.
    expect(contract([row(1)], [{ ...criteria[0]!, droppedInRevision: 2 }]).criteria.map((item) => item.id)).not.toContain("c1");
  });

  it("never takes a report on another instruction's criterion as proof: ids restart at c1 after a cancel, so only a work order that had it counts", () => {
    // r2's c1 passed, then r2 was cancelled; r4 added its own c1 on the same PR and head.
    const audit = { ...criterion("c1", "the audit log records every checkout", [1]), addedInRevision: 4 };
    const earlier = [proof("c1", 1, head(1), { revision: 2 })];
    expect(find(contract([row(1)], [audit], earlier), "c1").status).toBe("missing");
    expect(pendingCriteria(scope([row(1)], [audit]), [row(1)], earlier)).toEqual(new Map([[TARGETS[0], ["c1"]]]));
    // A report on r4's own work order, or a later revision's that still carries c1, proves it.
    for (const revision of [4, 5]) expect(find(contract([row(1)], [audit], [proof("c1", 1, head(1), { revision })]), "c1").status).toBe("satisfied");
  });

  it("assigns an effort-wide criterion to the lowest-numbered open PR, preferring one with a checkout, unless a PR already proves it", () => {
    const effortWide = [criterion("c1", "readers can reorder shelves end to end", "effort")];
    const rows = [row(1, { checkout: false }), row(2), row(3), merged(4)];
    expect(pendingCriteria(scope(rows, effortWide), rows, [])).toEqual(new Map([[TARGETS[1], ["c1"]]]));
    expect(find(contract(rows, effortWide), "c1").affected).toEqual([{ target: TARGETS[1], n: 2 }]);
    expect(pendingCriteria(scope(rows, effortWide), rows, [proof("c1", 3)])).toEqual(new Map());
    expect(find(contract(rows, effortWide, [proof("c1", 3)]), "c1").status).toBe("satisfied");
    // A missing checkout is mechanical: resource selection makes a worktree, so the lowest-numbered open PR takes it, not you.
    const validate = step("queued", "launching", { nextAction: ["validate_criteria"] });
    const bare = [merged(1), row(2, { checkout: false, step: validate }), row(3, { checkout: false })];
    expect(pendingCriteria(scope(bare, effortWide), bare, [])).toEqual(new Map([[TARGETS[1], ["c1"]]]));
    expect(find(contract(bare, effortWide), "c1")).toMatchObject({ status: "missing", affected: [{ n: 2 }], next: { action: "validate_criteria (2)", owner: "v2" } });
    // Only when no included PR is open is the criterion yours to place.
    expect(find(contract([merged(1)], effortWide), "c1")).toMatchObject({ status: "missing",
      next: { action: "no included PR is open to validate it in", owner: "you", wake: "a command that includes an open one" } });
  });

  it("names validate_criteria for a pending criterion when no other work is due, and rides other work when it is", () => {
    const criteria = [criterion("c1", "the shelf order test passes", [1])];
    const pending = pendingCriteria(scope([row(1)], criteria), [row(1)], []);
    expect(pending.get(TARGETS[0]!)).toEqual(["c1"]);
    const clear = contract([row(1, { step: decided(pending.has(TARGETS[0]!), false) })], criteria);
    expect(find(clear, "c1")).toMatchObject({ status: "missing", next: { action: "validate_criteria (1)", owner: "v2" } });
    const feedback = contract([row(1, { gates: failing("feedback-verified"), step: decided(true, true) })], criteria);
    expect(find(feedback, "c1").next!.action).toBe("address_review_feedback (1)");
  });

  it("gives every short criterion exactly one next action, owner, and wake condition, and a satisfied one none", () => {
    const shelf = { id: "ABC-340", title: null };
    const result = contract([
      row(1, { gates: failing("checks-green"), step: AUTHORITY, tickets: [shelf] }),
      row(2, { gates: failing("checks-settled", "checks-green"), step: CI, tickets: [shelf] }),
      row(3, { step: step("paused", "hold", { owner: { kind: "user", ref: null }, wake: wake("the hold is released") }) }),
      row(4, { gates: null, state: null, heads: [], step: step("verifying", "observe", { nextAction: "observe" }) }),
    ], [criterion("c1", "the shelf order test passes", [3]), criterion("c2", "genres render", "effort")]);
    for (const item of result.criteria) {
      if (item.status === "satisfied") expect(item.next, item.id).toBeNull();
      else expect(item.next, item.id).toEqual({ action: expect.stringMatching(/\S/u), owner: expect.stringMatching(/\S/u), wake: expect.stringMatching(/\S/u) });
    }
    // A decision on an affected PR blocks the family and comes first; the CI wait and the unread PR are named after it.
    expect(find(result, "checks")).toMatchObject({ status: "blocked", next: { action: "decide: Allow v2 to push to inkwell/folio #313? (1); also 2, 4", owner: "you" } });
    expect(find(result, "ticket:ABC-340").status).toBe("blocked");
    expect(result.criteria.filter((item) => item.status !== "satisfied").length).toBeGreaterThan(5);
  });

  it("rolls up into four lines in order: outcome, validated, still needed, and decisions", () => {
    const shelf = { id: "ABC-340", title: "Keep shelf order on reload" };
    const result = contract([row(1, { tickets: [shelf] }), row(2, { gates: failing("checks-settled", "checks-green"), step: CI }),
      row(3, { gates: failing("checks-settled", "checks-green"), step: CI }), row(4, { gates: failing("checks-green"), step: AUTHORITY })],
    [criterion("c1", "the shelf order test passes", [1])], [proof("c1", 1)], "Shelves keep their order across reloads");
    expect(result.rollup).toEqual([
      "Outcome: Shelves keep their order across reloads · 4 PRs: 1-4",
      "Validated: branch current, review feedback addressed, approved, dependencies merged, mergeable on 4 PRs; tickets ABC-340; the shelf order test passes (c1)",
      "Still needed: checks: decide: Allow v2 to push to inkwell/folio #313? (4); also 2, 3 · you · wake: an answer, or the PR merging",
      "Needs a decision: Allow v2 to push to inkwell/folio #313? (4)",
    ]);
    // Without an outcome command the effort's goal stands in; many tickets compress to a count.
    const tickets = ["ABC-1", "ABC-2", "ABC-3", "ABC-4"].map((id) => ({ id, title: null }));
    const quiet = contract([row(1, { tickets }), row(2, { tickets, gates: failing("approved"), step: step("waiting", "review", { owner: { kind: "reviewer", ref: "ada" }, wake: wake("reviews change") }) })]);
    expect(quiet.rollup).toEqual([
      "Outcome: Readers keep their shelves in order · 2 PRs: 1, 2",
      "Validated: branch current, checks green, review feedback addressed, dependencies merged, mergeable on 2 PRs",
      "Still needed: review: wait: review (2) · @ada · wake: reviews change; 4 tickets: their PRs (2)",
      "Needs a decision: none",
    ]);
    // Tickets waiting on different PRs still take one segment, pointing at those PRs.
    const running = { step: CI, gates: failing("checks-settled", "checks-green") };
    const spread = contract([row(1, { tickets: [{ id: "ABC-5", title: null }], ...running }), row(2, { tickets: [{ id: "ABC-6", title: null }], ...running })]);
    expect(spread.rollup[2]).toBe("Still needed: checks: wait: ci (1, 2) · CI · wake: check results change; ABC-5, ABC-6: their PRs (1, 2)");
  });

  it("reports the outcome validated while PRs are Ready, and the instruction completed only once every PR is finished", () => {
    const criteria = [criterion("c1", "the shelf order test passes", [1])];
    const ready = contract([row(1), merged(2)], criteria, [proof("c1", 1)]);
    expect([ready.outcomeValidated, ready.completed]).toEqual([true, false]);
    // One unproven criterion, or one PR short of Ready, and nothing is validated.
    expect(contract([row(1), merged(2)], criteria).outcomeValidated).toBe(false);
    expect(contract([row(1, { step: CI, gates: failing("checks-settled", "checks-green") })], criteria, [proof("c1", 1)]).outcomeValidated).toBe(false);
    // A merged head is final, so proof on it completes the instruction.
    const done = contract([merged(1), row(2, { state: "CLOSED", step: step("finished", "closed", { wake: null }) })], criteria, [proof("c1", 1)]);
    expect(done.completed).toBe(true);
    expect(contract([merged(1), merged(2)], criteria).completed).toBe(false);
    // An instruction with nothing in it proves nothing.
    expect(contract([])).toMatchObject({ outcomeValidated: false, completed: false });
  });

  it("evaluates from its inputs alone: no model, SDK, host, or store", () => {
    const imports = [...readFileSync(new URL("./outcome-evidence.ts", import.meta.url), "utf8").matchAll(/^import .* from "(.+)";$/gmu)].map((match) => match[1]);
    expect(imports).toEqual(["./effort-command.js", "./effort-phase.js", "./pr-gates.js", "./work-item-index.js"]);
    const result = contract([row(1)]);
    expect(result).not.toBeInstanceOf(Promise);
    expect(result.criteria.every((item) => item.status === "satisfied")).toBe(true);
  });
});

/** decide()'s step for folio #313 when every gate is green: criteria pending or not, and feedback awaiting a verified follow-up or not. */
function decided(criteriaPending: boolean, feedbackOpen: boolean): RowStep {
  const target = TARGETS[0]!;
  const checkout = "/Users/reader/src/folio-abc-340";
  const facts: AdvanceFacts = { prUrl: target, number: 313, title: "ABC-340 Keep shelf order on reload", repo: "inkwell/folio", headRefName: "abc-340", baseRefName: "main",
    headOid: head(1), baseOid: "b".repeat(40), state: "OPEN", isDraft: false, isCrossRepository: false, reviewDecision: "APPROVED", mergeStateStatus: "CLEAN",
    mergeable: "MERGEABLE", needsPreparation: false, readiness: "ready", detail: "", unresolvedThreads: 0, threadsComplete: true, checks: "passed", basePrNumber: null,
    approvalFeedback: feedbackOpen ? { status: "present", fingerprint: "e".repeat(64), sourceIds: ["review:811"] } : { status: "none", fingerprint: null, sourceIds: [] } };
  const codex = (reasoningLevel: "high" | "medium") => ({ providerId: "codex", model: "gpt-6-sol", reasoningLevel });
  return decide({ now: NOW, target, effort: { id: "e-shelving", mode: "v2", archived: false }, ownerId: "e-shelving", instruction: scope([row(1)]), held: false,
    full: { facts, at: NOW - 30_000 }, feedback: null, reviewers: { reviewRequests: [], latestReviews: [{ login: "ada", state: "APPROVED" }] }, attempts: [], codeActions: [],
    retryEpoch: 0, decision: null, declined: [], criteriaPending, settledDependencies: new Set(), admission: { capacityFull: false, breakerOpen: false },
    models: { code: codex("high"), planning: codex("medium") },
    resources: { hostId: "host_reader", origin: "thr_origin", linked: [], writers: [], legacy: null, unpushedAllowed: false,
      units: [{ path: checkout, githubRepo: "inkwell/folio", branch: "abc-340", prUrl: target, projectId: "proj_folio", hostId: "host_reader" }],
      inspections: new Map([[checkout, { ok: true, head: head(1), branch: "abc-340", clean: true, commonDir: `${checkout}/.git`, relation: "at-head" }]]),
      threads: [{ id: "thr_origin", providerId: "codex", status: "idle", archived: false, projectId: "proj_folio", hostId: "host_reader", environmentPath: checkout, updatedAt: 1, contextUsed: 0.3 }] } });
}
