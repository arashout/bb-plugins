import { describe, expect, it } from "vitest";
import type { AdvanceFacts } from "./advance-contract.js";
import { batchResults, parseCompletion, type ExpectedReport } from "./completion-envelope.js";
import { DEFAULT_EFFECTS, VERBS } from "./effort-command.js";
import { decide, type Attempt, type DecideInput } from "./effort-phase.js";
import { RESULT_PREFIX } from "./effort-recipes.js";
import { evidenceContract } from "./outcome-evidence.js";

const NOW = Date.UTC(2026, 8, 28, 12);
const PR_URL = "https://github.com/inkwell/folio/pull/313";
const HEAD = "3".repeat(40);
const LATER = "4".repeat(40);
const BASE = "b".repeat(40);
const FINGERPRINT = "e".repeat(64);
const SNAPSHOT = { status: "present" as const, fingerprint: FINGERPRINT, sourceIds: ["review:811", "thread:812"] };
const expected = (fresh: Partial<ExpectedReport["fresh"]> = {}): ExpectedReport =>
  ({ attemptId: "A-7", target: PR_URL, fresh: { headOid: HEAD, baseOid: BASE, approvalFeedback: SNAPSHOT, ...fresh } });
const findings = SNAPSHOT.sourceIds.map((sourceId) => ({ sourceId, resolution: "fixed", evidence: "Shelf order now survives a reload",
  validation: { outcome: "passed", detail: "npm test -- shelf" } }));
const envelope = (patch: Record<string, unknown> = {}) => ({ attemptId: "A-7", target: PR_URL, actions: ["address_review_feedback"], outcome: "changed",
  headOid: HEAD, baseOid: BASE, commits: [HEAD], validation: [{ command: "npm test -- shelf", result: "passed", detail: "12 passed" }],
  feedback: { fingerprint: FINGERPRINT, findings }, criteria: [], blockers: [], ...patch });
const v1 = (body: unknown) => `Addressed both review comments and pushed.\n${RESULT_PREFIX}${JSON.stringify(body)}\nDone.`;
/** Legacy Advance output: prose, the feedback evidence line, and the completion marker last. */
const legacy = (evidence: Record<string, unknown> | null, marker = "prepared", attemptId = "A-7") => [
  "Rebased on main, answered the reviewer, and pushed.",
  ...evidence ? [`Workstreams approval feedback evidence: ${JSON.stringify({ attemptId, headOid: HEAD, fingerprint: FINGERPRINT, findings, blockers: [], ...evidence })}`] : [],
  `Workstreams job ${attemptId} complete: ${marker}`,
].join("\n");
/** The two report shapes older workers wrote, each with one field under its older name (JSON drops the undefined canonical field). */
const withFingerprintAlias = (value = FINGERPRINT) => ({ fingerprint: undefined, approvalFeedbackFingerprint: value });
const withHeadAlias = (value = HEAD) => ({ headOid: undefined, finalHeadOid: value });

describe("completion envelope v1", () => {
  it("reads one strict result line, and rejects undocumented fields while keeping the raw output", () => {
    expect(parseCompletion(v1(envelope()), expected())).toMatchObject({ source: "v1", rejection: null, key: "changed", headOid: HEAD, compat: [],
      feedback: { attemptId: "A-7", headOid: HEAD, fingerprint: FINGERPRINT }, baseMoved: false });
    const extra = v1(envelope({ summary: "All green, ready to merge" }));
    expect(parseCompletion(extra, expected())).toMatchObject({ source: "v1", key: "report-invalid", envelope: null, feedback: null, raw: extra,
      rejection: expect.stringContaining("Unrecognized key") });
    expect(parseCompletion(`${v1(envelope())}\n${RESULT_PREFIX}${JSON.stringify(envelope())}`, expected()))
      .toMatchObject({ key: "report-invalid", rejection: "The output has 2 result lines; a report has exactly one." });
    expect(parseCompletion(`${RESULT_PREFIX}${JSON.stringify(envelope({ validation: [{ command: "npm test", result: "passed", detail: "x".repeat(50_000) }] }))}`, expected()))
      .toMatchObject({ key: "report-invalid", rejection: "The result line is over 50 KB." });
    // A report is for one attempt on one PR.
    expect(parseCompletion(v1(envelope({ attemptId: "A-6" })), expected()).rejection).toBe("The report is for attempt A-6, not A-7.");
    expect(parseCompletion(v1(envelope({ target: "https://github.com/inkwell/quill/pull/313" })), expected()).rejection).toContain("not https://github.com/inkwell/folio/pull/313");
    // Prose that says ready to merge is not a report.
    const prose = "Everything is done. Ready to merge.";
    expect(parseCompletion(prose, expected())).toEqual({ raw: prose, source: null, envelope: null, compat: [], rejection: "The output has no Workstreams result line.",
      key: "report-invalid", headOid: null, feedback: null, criteria: [], blocker: null, baseMoved: false });
  });

  it("keeps only the output's last 64 KB", () => {
    const output = `${"x".repeat(70_000)}\n${v1(envelope())}`;
    const { raw } = parseCompletion(output, expected());
    expect([raw.length, output.endsWith(raw)]).toEqual([64 * 1024, true]);
  });

  it("accepts feedback evidence only from a report that succeeded, for the live head and fingerprint, and never lets it clear the report's blockers", () => {
    // The worker pushed and GitHub moved on since: the report stands, its feedback evidence doesn't.
    expect(parseCompletion(v1(envelope()), expected({ headOid: LATER }))).toMatchObject({ rejection: null, key: "changed", feedback: null });
    expect(parseCompletion(v1(envelope()), expected({ approvalFeedback: { ...SNAPSHOT, fingerprint: "f".repeat(64) } })).feedback).toBeNull();
    expect(parseCompletion(v1(envelope({ feedback: { fingerprint: FINGERPRINT, findings: findings.slice(1) } })), expected()).feedback).toBeNull();
    // A worker that reports failure doesn't vouch for its evidence, however complete it looks; one that changed nothing does.
    expect(parseCompletion(v1(envelope({ outcome: "failed" })), expected())).toMatchObject({ rejection: null, key: "failed", feedback: null });
    expect(parseCompletion(v1(envelope({ outcome: "no-change", commits: [] })), expected()).feedback).toMatchObject({ headOid: HEAD, fingerprint: FINGERPRINT });
  });

  it("asks for reverification, not rejection, when the base moved after the worker read it", () => {
    expect(parseCompletion(v1(envelope()), expected({ baseOid: "c".repeat(40) }))).toMatchObject({ rejection: null, key: "changed", baseMoved: true });
  });

  it("routes a report by its first blocker, and never reads a report with a blocker as changed", () => {
    const product = { kind: "product-decision", summary: "Which result should an ineligible reader see?", question: "Show the waitlist or hide the shelf?",
      options: [{ id: "a", label: "Show the waitlist" }, { id: "b", label: "Hide the shelf" }], recommendation: "a" };
    const blocked = parseCompletion(v1(envelope({ outcome: "changed", blockers: [product, { kind: "environment", summary: "Sandbox down" }] })), expected());
    expect(blocked).toMatchObject({ key: "blocked:product-decision", rejection: null, feedback: null,
      blocker: { summary: product.summary, question: product.question, options: product.options, prUrl: null } });
    expect(parseCompletion(v1(envelope({ outcome: "blocked" })), expected())).toMatchObject({ key: "report-invalid", rejection: "A blocked report names its blocker." });
    expect(parseCompletion(v1(envelope({ outcome: "failed", feedback: undefined })), expected()).key).toBe("failed");
  });

  it("keeps why a worker recommends an option and what each option means, for the decision card, while the routed blocker stays options and labels", () => {
    const product = { kind: "product-decision", summary: "Out-of-print titles", question: "Allow out-of-print ISBNs at entry?", recommendation: "a",
      recommendationReason: "It matches the ABC-318 acceptance note", evidence: ["ABC-318 acceptance note"],
      options: [{ id: "a", label: "Allow with a badge", consequence: "One more check on entry" }, { id: "b", label: "Block at entry" }] };
    const report = parseCompletion(v1(envelope({ outcome: "blocked", feedback: undefined, blockers: [product] })), expected());
    expect(report.envelope!.blockers[0]).toMatchObject({ recommendation: "a", recommendationReason: product.recommendationReason, evidence: product.evidence,
      options: [{ id: "a", label: "Allow with a badge", consequence: "One more check on entry" }, { id: "b", label: "Block at entry", consequence: null }] });
    expect(report.blocker!.options).toEqual([{ id: "a", label: "Allow with a badge" }, { id: "b", label: "Block at entry" }]);
    // Still only the documented fields.
    expect(parseCompletion(v1(envelope({ outcome: "blocked", feedback: undefined, blockers: [{ ...product, confidence: "high" }] })), expected()).key).toBe("report-invalid");
  });

  it("gives a product blocker with checks running a decision, then a named CI wait, and never Ready", () => {
    const product = { kind: "product-decision", summary: "Waitlist copy is undecided", question: "Show the waitlist or hide the shelf?",
      options: [{ id: "a", label: "Show the waitlist" }, { id: "b", label: "Hide the shelf" }] };
    // The worker pushed a new head, whose checks are still running, and stopped on the product choice.
    const report = parseCompletion(v1(envelope({ outcome: "blocked", headOid: LATER, feedback: undefined, blockers: [product] })), expected({ headOid: LATER }));
    const attempt: Attempt = { id: "A-7", status: "completed", threadId: "thr_worker", path: "/Users/reader/src/folio-abc-340", workspace: null,
      recipes: ["address_review_feedback"], retryEpoch: 0, headOid: HEAD, fingerprint: FINGERPRINT, endedAt: NOW - 120_000, result: report.key, blocker: report.blocker,
      failure: null, releasedReason: null, interactionPending: false, stopRequested: false, turnFailed: false, turnRetries: 0, readbackFailures: 0 };
    const facts: AdvanceFacts = { prUrl: PR_URL, number: 313, title: "ABC-340 Keep shelf order on reload", repo: "inkwell/folio", headRefName: "abc-340", baseRefName: "main",
      headOid: LATER, baseOid: BASE, state: "OPEN", isDraft: false, isCrossRepository: false, reviewDecision: "APPROVED", mergeStateStatus: "CLEAN", mergeable: "MERGEABLE",
      needsPreparation: false, readiness: "ready", detail: "", unresolvedThreads: 0, threadsComplete: true, checks: "pending", basePrNumber: null,
      approvalFeedback: { status: "none", fingerprint: null, sourceIds: [] } };
    const input: DecideInput = { now: NOW, target: PR_URL, effort: { id: "e-shelving", mode: "v2", archived: false }, ownerId: "e-shelving",
      instruction: { revision: 1, include: [{ target: PR_URL, n: 4, outsideMembership: false, work: [...VERBS["move forward"].work], effects: [...DEFAULT_EFFECTS], reviewers: [], addedInRevision: 1 }],
        exclude: [], removed: [], stopAt: "prepared", reportMode: "changes", outcome: null, criteria: [], answers: [] },
      held: false, full: { facts, at: NOW - 30_000 }, feedback: null, reviewers: { reviewRequests: [], latestReviews: [{ login: "ada", state: "APPROVED" }] },
      attempts: [attempt], codeActions: [], retryEpoch: 0, decision: null, declined: [], criteriaPending: false, settledDependencies: new Set(),
      admission: { capacityFull: false, breakerOpen: false }, models: { code: { providerId: "codex", model: "gpt-6-sol", reasoningLevel: "high" },
        planning: { providerId: "codex", model: "gpt-6-sol", reasoningLevel: "medium" } }, resources: { legacy: null, writers: [], inspections: null } };
    expect(decide(input)).toMatchObject({ phase: "decision-needed", cause: "product", decision: { question: product.question, options: product.options } });
    // Once the answer starts a new epoch, the running checks are the named wait.
    expect(decide({ ...input, retryEpoch: 1 })).toMatchObject({ phase: "waiting", cause: "ci", owner: { kind: "ci" } });
  });

  it("binds criteria evidence to the head the report names, so a later head sees it as stale proof", () => {
    const report = parseCompletion(v1(envelope({ criteria: [{ id: "c1", outcome: "passed", evidence: "npm test -- waitlist: 4 passed" },
      { id: "ticket:ABC-340", outcome: "passed", evidence: "Matches the ticket's acceptance notes" }] })), expected({ headOid: LATER }));
    expect(report.criteria).toEqual([{ criterion: "c1", target: PR_URL, headOid: HEAD, outcome: "passed", accepted: true },
      { criterion: "ticket:ABC-340", target: PR_URL, headOid: HEAD, outcome: "passed", accepted: true }]);
    const scope = { revision: 1, include: [], exclude: [], removed: [], stopAt: "prepared" as const, reportMode: "changes" as const, outcome: null, answers: [],
      criteria: [{ id: "c1", text: "The waitlist shows for ineligible readers", binding: { kind: "targets" as const, n: [4] }, addedInRevision: 1, droppedInRevision: null }] };
    const step = { phase: "waiting" as const, cause: "ci", modifiers: [], nextAction: null, owner: { kind: "ci" as const, ref: null }, wake: null, decision: null };
    const row = (heads: string[]) => ({ target: PR_URL, n: 4, state: "OPEN" as const, heads, checkout: true, tickets: [{ id: "ABC-340", title: "Keep shelf order" }], gates: null, step });
    const evidence = report.criteria.map((item) => ({ ...item, revision: 1 }));
    const status = (heads: string[]) => Object.fromEntries(evidenceContract({ scope, goal: "", rows: [row(heads)], evidence }).criteria
      .filter((item) => item.source !== "gate").map((item) => [item.id, item.status]));
    expect(status([HEAD])).toEqual({ c1: "satisfied", "ticket:ABC-340": "missing" });
    // On a later head the proof is stale, and a passing ticket entry never proves the ticket.
    expect(status([LATER])).toEqual({ c1: "invalidated", "ticket:ABC-340": "missing" });
  });
});

describe("compatibility adapter v0", () => {
  it("reads legacy completion markers, and never turns a legacy block into a decision", () => {
    expect(parseCompletion(legacy({}), expected())).toMatchObject({ source: "legacy", rejection: null, key: "changed", headOid: HEAD,
      feedback: { attemptId: "A-7", headOid: HEAD }, compat: ["legacy completion marker: prepared", "legacy feedback evidence line"] });
    expect(parseCompletion(legacy(null, "blocked"), expected({ approvalFeedback: { status: "none", fingerprint: null, sourceIds: [] } })))
      .toMatchObject({ source: "legacy", key: "blocked:other", blocker: { question: null, options: [] }, compat: ["legacy completion marker: blocked"] });
    expect(parseCompletion(legacy({}, "prepared", "A-6"), expected())).toMatchObject({ key: "report-invalid", rejection: "The completion marker is for attempt A-6, not A-7." });
    // The marker counts only as the last line, as legacy Advance read it.
    expect(parseCompletion(`${legacy({})}\nAnything else?`, expected()).key).toBe("report-invalid");
  });

  it("accepts legacy feedback evidence only from a prepared job, for the live head and fingerprint, with no blocker", () => {
    expect(parseCompletion(legacy({}), expected()).feedback).toMatchObject({ headOid: HEAD, fingerprint: FINGERPRINT });
    // Each of these reads as a report, as legacy Advance read it, but its evidence doesn't count.
    expect(parseCompletion(legacy({ headOid: LATER }), expected())).toMatchObject({ rejection: null, key: "changed", feedback: null });
    expect(parseCompletion(legacy({}), expected({ approvalFeedback: { ...SNAPSHOT, fingerprint: "f".repeat(64) } })).feedback).toBeNull();
    expect(parseCompletion(legacy({ blockers: ["The catalog owner hasn't said which shelf order wins"] }), expected()).feedback).toBeNull();
    expect(parseCompletion(legacy({}, "blocked"), expected())).toMatchObject({ rejection: null, key: "blocked:other", feedback: null });
  });

  it.each([
    ["approvalFeedbackFingerprint", withFingerprintAlias(), withFingerprintAlias("f".repeat(64)), "approvalFeedbackFingerprint → fingerprint"],
    ["finalHeadOid", withHeadAlias(), withHeadAlias(LATER), "finalHeadOid → headOid"],
  ])("maps %s only when it equals the live fact it names", (_name, live, stale, mapping) => {
    const accepted = parseCompletion(legacy(live), expected());
    expect(accepted).toMatchObject({ rejection: null, key: "changed", headOid: HEAD, feedback: { headOid: HEAD, fingerprint: FINGERPRINT } });
    expect(accepted.compat).toEqual(["legacy completion marker: prepared", "legacy feedback evidence line", mapping]);
    expect(parseCompletion(legacy(stale), expected())).toMatchObject({ key: "report-invalid", feedback: null, rejection: expect.stringContaining("isn't the live") });
  });

  it("maps the same older names in a v1 report, recording each", () => {
    const report = parseCompletion(v1(envelope({ headOid: undefined, finalHeadOid: HEAD, feedback: { approvalFeedbackFingerprint: FINGERPRINT, findings } })), expected());
    expect(report).toMatchObject({ rejection: null, key: "changed", headOid: HEAD, feedback: { fingerprint: FINGERPRINT } });
    expect(report.compat).toEqual(["finalHeadOid → headOid", "approvalFeedbackFingerprint → fingerprint"]);
    expect(parseCompletion(v1(envelope({ headOid: undefined, finalHeadOid: LATER })), expected()).rejection).toBe(`finalHeadOid ${LATER.slice(0, 12)} isn't the live headOid ${HEAD.slice(0, 12)}.`);
  });

  it("rejects a report that names both a field and its older name", () => {
    expect(parseCompletion(legacy({ finalHeadOid: HEAD }), expected())).toMatchObject({ key: "report-invalid", rejection: "The report has both finalHeadOid and headOid." });
    expect(parseCompletion(legacy({ approvalFeedbackFingerprint: FINGERPRINT }), expected()).rejection).toBe("The report has both approvalFeedbackFingerprint and fingerprint.");
    expect(parseCompletion(v1(envelope({ finalHeadOid: HEAD })), expected()).rejection).toBe("The report has both finalHeadOid and headOid.");
  });
});

describe("a batch thread's result lines", () => {
  const other = "https://github.com/inkwell/quill/pull/9";
  const line = (patch: Record<string, unknown>) => `${RESULT_PREFIX}${JSON.stringify(envelope({ feedback: undefined, ...patch }))}`;
  // One thread answers for several claims: each PR's line is found by its claim's id, read strictly, and never taken for another PR's.
  it("reads each PR's line by its claim, and says why one can't be read", () => {
    const output = ["Worked #313 then #9.", line({ attemptId: "address-1" }), line({ attemptId: "address-2", target: other, outcome: "blocked",
      blockers: [{ kind: "product-decision", summary: "The sort order needs a call" }] }), line({ attemptId: "address-3", target: other }),
      line({ attemptId: "address-4" }), line({ attemptId: "address-4" }), `${RESULT_PREFIX}{"attemptId":"address-5"}`].join("\n");
    const read = batchResults(output, [{ attemptId: "address-1", target: PR_URL }, { attemptId: "address-2", target: other }, { attemptId: "address-3", target: PR_URL },
      { attemptId: "address-4", target: PR_URL }, { attemptId: "address-5", target: PR_URL }, { attemptId: "address-6", target: PR_URL }]);
    expect([...read].map(([id, result]) => [id, result.ok, result.ok && result.changed, result.text])).toEqual([
      ["address-1", true, true, `Reported changed at ${HEAD.slice(0, 7)}`],
      ["address-2", true, false, "Blocked: The sort order needs a call"],
      ["address-3", false, false, `Its result line is for ${other}.`],
      ["address-4", false, false, "2 result lines for this PR; a report has one."],
      ["address-5", false, false, expect.stringContaining("Its result line doesn't read:")],
      ["address-6", false, false, "No result line for this PR."]]);
  });
});
