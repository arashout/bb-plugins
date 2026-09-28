import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { InstructionScope } from "./effort-command.js";
import { createEffortWorkStore, decisionId, EFFORT_DECISION_MIGRATIONS, EFFORT_EXECUTION_MIGRATIONS, EFFORT_INSTRUCTION_MIGRATIONS, type DecisionBody, type DecisionWrite,
  type RowWrite, type V2Target, type WorkRowBody } from "./effort-work-store.js";

const databases: Database.Database[] = [];
afterEach(() => { databases.splice(0).forEach((db) => db.close()); });
const pr = (repo: string, number: number) => `https://github.com/inkwell/${repo}/pull/${number}`;
const [folio, quill, atlas] = [pr("folio", 12), pr("quill", 14), pr("atlas", 16)];

function open() {
  const db = new Database(":memory:");
  databases.push(db);
  [...EFFORT_EXECUTION_MIGRATIONS, ...EFFORT_INSTRUCTION_MIGRATIONS, ...EFFORT_DECISION_MIGRATIONS].forEach((sql) => db.exec(sql));
  let clock = 1_000;
  return { db, work: createEffortWorkStore(db, () => ++clock) };
}
/** The roster ownership a server read would resolve. */
const rosters: Record<string, V2Target[]> = {
  returns: [{ target: folio, source: "ticket" }, { target: quill, source: "pr" }],
  gifts: [{ target: atlas, source: "pr" }],
};
const targetsOf = (effortId: string) => rosters[effortId] ?? [];

describe("effort execution mode", () => {
  it("starts every effort on legacy with nothing fenced", () => {
    const { work } = open();
    expect(work.execution("returns")).toEqual({ mode: "legacy", revision: 0 });
    expect(work.managedBy(folio)).toBeNull();
    expect(work.active()).toBe(false);
  });

  it("changes mode only at the revision the caller saw, so a stale opt-in or opt-out changes nothing", () => {
    const { work } = open();
    expect(work.setMode("returns", "v2", 0, targetsOf)).toEqual({ mode: "v2", revision: 1 });
    expect(() => work.setMode("returns", "legacy", 0, targetsOf)).toThrow("execution mode changed");
    expect(work.execution("returns")).toEqual({ mode: "v2", revision: 1 });
    expect(work.managedBy(folio)).toBe("returns");
    expect(work.setMode("returns", "legacy", 1, targetsOf)).toEqual({ mode: "legacy", revision: 2 });
  });

  it("fences a v2 effort's roster PRs with the mode, including PRs it owns only through a ticket", () => {
    const { db, work } = open();
    work.setMode("returns", "v2", 0, targetsOf);
    expect(db.prepare("SELECT target, effort_id AS effortId, source FROM effort_v2_targets ORDER BY target").all()).toEqual([
      { target: folio, effortId: "returns", source: "ticket" }, { target: quill, effortId: "returns", source: "pr" }]);
    // Copied URL variants resolve to the same fenced PR.
    expect(work.managedBy("https://github.com/Inkwell/Folio/pull/12/")).toBe("returns");
    // A legacy effort's PRs are never written, even when a resolver would return them.
    expect(work.managedBy(atlas)).toBeNull();
  });

  it("never leaves a v2 effort unfenced: a failed target read rolls back the mode", () => {
    const { work } = open();
    expect(() => work.setMode("returns", "v2", 0, () => { throw new Error("board unavailable"); })).toThrow("board unavailable");
    expect(work.execution("returns")).toEqual({ mode: "legacy", revision: 0 });
    expect(work.active()).toBe(false);
  });

  it("rewrites every v2 effort's targets at once, and opting out clears only that effort's fence", () => {
    const { work } = open();
    work.setMode("returns", "v2", 0, targetsOf);
    work.setMode("gifts", "v2", 0, targetsOf);
    // Membership moved quill out of Returns desk: the rewrite drops it and keeps the rest.
    work.rewriteTargets((effortId) => targetsOf(effortId).filter((target) => target.target !== quill));
    expect([folio, quill, atlas].map(work.managedBy)).toEqual(["returns", null, "gifts"]);
    work.setMode("returns", "legacy", 1, targetsOf);
    expect([folio, quill, atlas].map(work.managedBy)).toEqual([null, null, "gifts"]);
    work.setMode("gifts", "legacy", 1, targetsOf);
    expect(work.active()).toBe(false);
  });
});

describe("effort instructions and rows", () => {
  const scope = (revision: number, targets: string[]): InstructionScope => ({ revision, stopAt: "prepared", reportMode: "changes", outcome: null, criteria: [], answers: [],
    exclude: [], removed: [], include: targets.map((target, index) => ({ target, n: index + 1, outsideMembership: false, work: ["integrate_base"],
      effects: ["code-fix", "test", "push"], reviewers: [], addedInRevision: revision })) });
  const source = { kind: "panel" as const, threadId: null, eventId: null };
  const revise = (revision: number, targets: string[], requestId = `req-${revision}`) =>
    ({ scope: scope(revision, targets), text: `move ${targets.length} forward`, source, snapshotId: "S-000000000001", requestId });
  const body = (cause: string, patch: Partial<WorkRowBody> = {}): WorkRowBody => ({ n: 1, cause, detail: cause, userState: "waiting", modifiers: [],
    nextAction: null, owner: null, wake: null, decision: null, recovery: [], offers: [], retryEpoch: 0, observedHead: null, observedAt: null, gates: null, tickets: [], ...patch });
  const write = (target: string, expectedRevision: number, phase: RowWrite["phase"], cause: string): RowWrite =>
    ({ target, expectedRevision, phase, body: body(cause), dueAt: null });
  const counts = (db: Database.Database) => ["effort_instructions", "effort_pr_work", "effort_transitions"]
    .map((table) => (db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count);

  it("admits each revision only at the revision its command read, and keeps one active instruction per effort", () => {
    const { db, work } = open();
    work.commit({ effortId: "returns", baseRevision: 0, source: "command", instruction: revise(1, [folio]), rows: [], journal: null });
    // A second command read r0 too: it must not land as another r1 or on top of r1.
    expect(() => work.commit({ effortId: "returns", baseRevision: 0, source: "command", instruction: revise(1, [quill], "req-late"), rows: [], journal: null }))
      .toThrow("instruction changed");
    work.commit({ effortId: "returns", baseRevision: 1, source: "command", instruction: revise(2, [folio, quill]), rows: [], journal: null });
    expect(work.instruction("returns")).toMatchObject({ revision: 2, status: "active", scope: { revision: 2, include: [{ target: folio }, { target: quill }] } });
    expect(db.prepare(`SELECT revision, status FROM effort_instructions ORDER BY revision`).all()).toEqual([
      { revision: 1, status: "superseded" }, { revision: 2, status: "active" }]);
    // The database refuses a second active instruction for the effort, whoever writes it.
    expect(() => db.prepare(`INSERT INTO effort_instructions (id, effort_id, revision, status, request_id, body, created_at, updated_at)
      VALUES ('rogue', 'returns', 3, 'active', 'rogue', '{}', 0, 0)`).run()).toThrow(/UNIQUE/u);
    work.commit({ effortId: "returns", baseRevision: 2, source: "command", instruction: "cancel", rows: [], journal: null });
    expect([work.instruction("returns"), work.lastRevision("returns")]).toEqual([null, 2]);
    expect(() => work.commit({ effortId: "returns", baseRevision: 2, source: "command", instruction: "cancel", rows: [], journal: null })).toThrow("nothing to cancel");
    // Another effort numbers its own revisions.
    work.commit({ effortId: "gifts", baseRevision: 0, source: "command", instruction: revise(1, [atlas], "req-gifts"), rows: [], journal: null });
    expect(work.instruction("gifts")?.revision).toBe(1);
  });

  it("writes the revision, rows, transitions, and journal together, or nothing when a write throws mid-transaction", () => {
    const { db, work } = open();
    // folio is written with its transition before quill's stale revision throws.
    expect(() => work.commit({ effortId: "returns", baseRevision: 0, source: "command", instruction: revise(1, [folio, quill]),
      rows: [write(folio, 0, "verifying", "observe"), write(quill, 3, "verifying", "observe")], journal: { requestId: "req-1", text: "move 1, 2 forward", result: {} } }))
      .toThrow("changed while this command was read");
    expect(counts(db)).toEqual([0, 0, 0]);
    expect(() => work.commit({ effortId: "returns", baseRevision: 0, source: "command", instruction: revise(1, [folio]), rows: [write(folio, 0, "verifying", "observe")],
      journal: null, also: () => { throw new Error("hold write failed"); } })).toThrow("hold write failed");
    expect(counts(db)).toEqual([0, 0, 0]);
  });

  it("advances a row's revision by one per write, journals each transition from its old phase, and finds a command by its request", () => {
    const { db, work } = open();
    const result = { kind: "admit", acknowledgment: ["Instruction r1 · 1 PRs · stops at Ready · reports changes"] };
    work.commit({ effortId: "returns", baseRevision: 0, source: "command", instruction: revise(1, [folio]), rows: [write(folio, 0, "verifying", "observe")],
      journal: { requestId: "req-1", text: "move 1 forward", result } });
    work.commit({ effortId: "returns", baseRevision: 1, source: "archive", instruction: null, rows: [write("https://github.com/Inkwell/Folio/pull/12/", 1, "paused", "archived")], journal: null });
    expect(work.row(folio)).toMatchObject({ effortId: "returns", instructionId: "I-returns-r1", phase: "paused", revision: 2, body: { cause: "archived" } });
    expect(db.prepare(`SELECT target, row_revision AS revision, from_phase AS "from", to_phase AS "to", cause, source FROM effort_transitions ORDER BY seq`).all()).toEqual([
      { target: folio, revision: 1, from: null, to: "verifying", cause: "observe", source: "command" },
      { target: null, revision: null, from: null, to: null, cause: "command", source: "command" },
      { target: folio, revision: 2, from: "verifying", to: "paused", cause: "archived", source: "archive" }]);
    expect(work.command("returns", "req-1")).toEqual(result);
    expect([work.command("returns", "req-2"), work.command("gifts", "req-1")]).toEqual([null, null]);
    expect(() => work.commit({ effortId: "returns", baseRevision: 1, source: "command", instruction: null, rows: [write(folio, 1, "waiting", "ci")], journal: null }))
      .toThrow("changed while this command was read");
  });

  it("fences a PR included from outside membership while its row holds it, and lets another effort take it once it finishes or pauses for another owner", () => {
    const { work } = open();
    work.setMode("returns", "v2", 0, () => []);
    work.commit({ effortId: "returns", baseRevision: 0, source: "command", instruction: revise(1, [atlas]), rows: [write(atlas, 0, "verifying", "observe")], journal: null });
    expect(work.managedBy(atlas)).toBe("returns");
    work.commit({ effortId: "gifts", baseRevision: 0, source: "command", instruction: revise(1, [quill], "req-gifts"), rows: [], journal: null });
    expect(() => work.commit({ effortId: "gifts", baseRevision: 1, source: "command", instruction: null, rows: [write(atlas, 1, "verifying", "observe")], journal: null }))
      .toThrow("in another effort's instruction");
    work.commit({ effortId: "returns", baseRevision: 1, source: "command", instruction: null, rows: [write(atlas, 1, "finished", "cancelled")], journal: null });
    expect(work.managedBy(atlas)).toBeNull();
    work.commit({ effortId: "gifts", baseRevision: 1, source: "command", instruction: null, rows: [write(atlas, 2, "verifying", "observe")], journal: null });
    expect(work.row(atlas)).toMatchObject({ effortId: "gifts", instructionId: "I-gifts-r1", revision: 3 });
    // A hold pauses a row and keeps its PR. A pause because another effort owns the PR, or its effort left v2, lets it go.
    work.commit({ effortId: "returns", baseRevision: 1, source: "hold", instruction: null, rows: [write(folio, 0, "paused", "hold")], journal: null });
    expect(work.managedBy(folio)).toBe("returns");
    expect(() => work.commit({ effortId: "gifts", baseRevision: 1, source: "command", instruction: null, rows: [write(folio, 1, "verifying", "observe")], journal: null }))
      .toThrow("in another effort's instruction");
    work.commit({ effortId: "returns", baseRevision: 1, source: "command", instruction: null,
      rows: [write(folio, 1, "paused", "membership-moved"), write(quill, 0, "paused", "v2-off")], journal: null });
    expect([folio, quill].map(work.managedBy)).toEqual([null, null]);
    work.commit({ effortId: "gifts", baseRevision: 1, source: "command", instruction: null,
      rows: [write(folio, 2, "verifying", "observe"), write(quill, 1, "verifying", "observe")], journal: null });
    expect([folio, quill].map((target) => work.row(target)?.effortId)).toEqual(["gifts", "gifts"]);
  });
});

describe("effort decisions", () => {
  const question: DecisionBody = { kind: "lifecycle", subkind: "mark-ready", question: "Mark these drafts ready for review?", grants: { work: [], effects: ["mark-ready"] },
    options: [{ id: "ready", label: "Mark ready" }, { id: "keep", label: "Keep as draft" }], targets: [{ target: folio, n: 1, head: "a".repeat(40) }], answer: null, answeredVia: null };
  const decide = (n: number, patch: Partial<DecisionWrite> = {}): DecisionWrite =>
    ({ id: decisionId("returns", n), n, key: "lifecycle:mark-ready", status: "open", body: question, expectedRevision: 0, ...patch });
  const commit = (work: ReturnType<typeof open>["work"], decisions: DecisionWrite[]) =>
    work.commit({ effortId: "returns", baseRevision: 0, source: "command", instruction: null, rows: [], decisions, journal: null });

  it("keeps one open decision per question, changes one only at the revision it was read at, and never reuses a number", () => {
    const { db, work } = open();
    commit(work, [decide(1)]);
    expect(work.decisions("returns")).toEqual([{ id: decisionId("returns", 1), effortId: "returns", n: 1, key: "lifecycle:mark-ready", status: "open", revision: 1, body: question }]);
    // The same question can't open twice: rows that ask it join D1 instead.
    expect(() => commit(work, [decide(2)])).toThrow(/UNIQUE/u);
    const joined = { ...question, targets: [...question.targets, { target: quill, n: 2, head: "b".repeat(40) }] };
    commit(work, [decide(1, { body: joined, expectedRevision: 1 })]);
    // A writer that read D1 before that change changes nothing.
    expect(() => commit(work, [decide(1, { status: "withdrawn", expectedRevision: 1 })])).toThrow("D1 changed while this command was read");
    commit(work, [decide(1, { status: "answered", body: { ...joined, answer: "mark ready 1, 2", answeredVia: "panel" }, expectedRevision: 2 })]);
    expect(work.decision(decisionId("returns", 1))).toMatchObject({ status: "answered", revision: 3, body: { answer: "mark ready 1, 2" } });
    // An answered decision is closed for good; the same question asked again is a new number.
    expect(() => commit(work, [decide(1, { status: "withdrawn", expectedRevision: 3 })])).toThrow("D1 changed");
    expect([work.decisions("returns"), work.nextDecision("returns"), work.nextDecision("gifts")]).toEqual([[], 2, 1]);
    commit(work, [decide(2)]);
    expect(work.decisions("returns").map((decision) => decision.n)).toEqual([2]);
    expect(db.prepare(`SELECT ordinal, status, resolved_at IS NOT NULL AS resolved FROM effort_decisions ORDER BY ordinal`).all())
      .toEqual([{ ordinal: 1, status: "answered", resolved: 1 }, { ordinal: 2, status: "open", resolved: 0 }]);
  });
});
