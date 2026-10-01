import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ADVANCE_MIGRATIONS, createAdvanceHistory, type AdvanceJob } from "./bulk-advance.js";

const url = (number: number) => `https://github.com/inkwell/folio/pull/${number}`;
const job = (number: number, patch: Partial<AdvanceJob> = {}): AdvanceJob => ({
  prUrl: url(number), repo: "inkwell/folio", number, title: `ABC-${number} Keep shelf order`, headOid: "a".repeat(40), baseOid: "b".repeat(40),
  baseRefName: "main", headRefName: `abc-${number}`, needsPreparation: true, needsFeedback: false, needsChecks: false, eligible: true,
  detail: "Resolve branch conflicts", workspace: "create", id: `job-${number}`, hiddenFromProgress: false, status: "needs-attention",
  attemptId: null, dedicated: false, previousAttempts: [], threadId: null, path: null, checkedHeadOid: null, updatedAt: 1_000, uncertain: false, ...patch,
});

/** Batches as the removed engine saved them: each job's routing facts, its preview token, and its poll window beside the public batch. */
function history(saved: { id: string; createdAt: number; jobs: AdvanceJob[]; checkouts?: Record<string, string> }[]) {
  const db = new Database(":memory:");
  for (const migration of ADVANCE_MIGRATIONS) db.prepare(migration).run();
  for (const batch of saved) db.prepare("INSERT INTO advance_batches (id, body) VALUES (?, ?)").run(batch.id, JSON.stringify({
    id: batch.id, createdAt: batch.createdAt, cancelled: false, instruction: "", jobs: batch.jobs, token: `token-${batch.id}`, pollUntil: 0, prepared: {}, repairs: {},
    facts: Object.fromEntries(batch.jobs.map((entry) => [entry.id, { prUrl: entry.prUrl, path: batch.checkouts?.[entry.id] ?? null, projectId: "proj-inkwell" }])) }));
  const rows = () => db.prepare("SELECT id, body FROM advance_batches ORDER BY id").all();
  return { db, rows, advance: createAdvanceHistory(db) };
}

describe("legacy Advance history", () => {
  it("lists every saved batch newest first, as the board and roster read it, and writes nothing", () => {
    const { advance, rows } = history([{ id: "batch-1", createdAt: 1_000, jobs: [job(12, { status: "merged" })] },
      { id: "batch-2", createdAt: 2_000, jobs: [job(14, { threadId: "thr-worker", path: "/worktrees/batch-2/job-14" })] }]);
    const before = rows();
    expect(advance.list()).toEqual([
      { id: "batch-2", createdAt: 2_000, cancelled: false, instruction: "", jobs: [job(14, { threadId: "thr-worker", path: "/worktrees/batch-2/job-14" })] },
      { id: "batch-1", createdAt: 1_000, cancelled: false, instruction: "", jobs: [job(12, { status: "merged" })] }]);
    expect(rows()).toEqual(before);
  });

  it("loads a batch saved without routing facts", () => {
    const db = new Database(":memory:");
    for (const migration of ADVANCE_MIGRATIONS) db.prepare(migration).run();
    db.prepare("INSERT INTO advance_batches (id, body) VALUES (?, ?)").run("batch-1", JSON.stringify({ id: "batch-1", createdAt: 1_000, cancelled: false, jobs: [job(12)] }));
    expect(createAdvanceHistory(db).list()).toMatchObject([{ id: "batch-1", jobs: [{ prUrl: url(12) }] }]);
  });

  it("keeps a job that never settled fencing its PR and both its checkouts, since no worker's outcome was confirmed", () => {
    const unsettled = (["queued", "launching", "running", "verifying"] as const).map((status, index) => job(20 + index, { status, id: `job-${status}` }));
    const { advance } = history([{ id: "batch-1", createdAt: 1_000, jobs: [...unsettled, job(30, { uncertain: true, path: "/worktrees/batch-1/job-30" }),
      job(31), job(32, { status: "ready" }), job(33, { status: "merged" })], checkouts: { "job-30": "/p/folio-30", "job-31": "/p/folio-31" } }]);
    for (const entry of unsettled) expect(advance.reserved(entry.prUrl, null), entry.status).toBe(true);
    expect(advance.reserved(url(30).toUpperCase(), null)).toBe(true);
    // The checkout it was routed from and the worktree it ran in are both held, under any PR.
    expect([advance.reserved(url(99), "/p/folio-30"), advance.reserved(url(99), "/worktrees/batch-1/job-30")]).toEqual([true, true]);
    // A settled job holds nothing, whatever its status says about the PR.
    expect([url(31), url(32), url(33)].map((prUrl) => advance.reserved(prUrl, null))).toEqual([false, false, false]);
    expect(advance.reserved(url(99), "/p/folio-31")).toBe(false);
  });
});
