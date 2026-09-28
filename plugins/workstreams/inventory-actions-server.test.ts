import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdvanceFacts } from "./advance-contract.js";
import { advancePreviewJobSchema } from "./bulk-advance.js";
import type { Pr, RawUnit } from "./contract.js";
import { createEffortStore } from "./effort-store.js";
import { createEffortWorkStore, type AttemptBody } from "./effort-work-store.js";
import { parsePrList } from "./gh.js";
import type { InventoryView } from "./inventory-view.js";
import plugin from "./server.js";

const HOST = "host-inkwell";
const HEAD = "a".repeat(40);
const url = (number: number) => `https://github.com/inkwell/folio/pull/${number}`;
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const pr = (number: number, extra: Record<string, unknown> = {}): Pr => parsePrList(JSON.stringify([{ number, url: url(number), state: "OPEN",
  title: `ABC-${number} Keep shelf order`, isDraft: false, reviewDecision: "REVIEW_REQUIRED", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
  headRefName: `branch-${number}`, baseRefName: "main", headRefOid: HEAD, latestReviews: [], reviewRequests: [], statusCheckRollup: [{ conclusion: "SUCCESS" }],
  createdAt: daysAgo(12), ...extra }]))!.pr;
const UNIT: RawUnit = { path: "/p/folio", dirName: "folio", repo: "folio", githubRepo: "inkwell/folio", branch: "main", dirty: false, ahead: 0, behind: 0,
  lastCommitAt: null, defaultBranch: "main", pr: null, shipped: null, changedPaths: [], observed: { status: true, pr: true } };
const BATCH = "00000000-0000-4000-8000-000000000091", JOB = "00000000-0000-4000-8000-000000000092";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

/**
 * You author a green draft (#313), a PR no one was asked to review (#314), a PR mira was asked to review ten days ago (#315), and a PR
 * whose change request from otto a push yesterday answered (#318). mira and otto reviewed #316 and #317. #313 carries a legacy Advance
 * job that never launched.
 */
async function setup() {
  const calls: { method: string; input: unknown }[] = [];
  const current = new Map<number, Pr>([
    [313, pr(313, { isDraft: true })], [314, pr(314)],
    [315, { ...pr(315, { reviewRequests: [{ login: "mira" }] }), reviewRequestedAt: [{ reviewer: "mira", at: daysAgo(10) }] }],
    [316, pr(316, { reviewDecision: "APPROVED", latestReviews: [{ author: { login: "mira" }, state: "APPROVED", submittedAt: daysAgo(1) }] })],
    [317, pr(317, { latestReviews: [{ author: { login: "otto" }, state: "COMMENTED", submittedAt: daysAgo(3) }] })],
    [318, { ...pr(318, { reviewDecision: "CHANGES_REQUESTED", latestReviews: [{ author: { login: "otto" }, state: "CHANGES_REQUESTED", submittedAt: daysAgo(3) }] }),
      reviewFollowupPosted: true, unresolvedReviewThreads: 0, resolvedReviewThreads: 1, headCommittedAt: daysAgo(1) }],
  ]);
  const spawn = vi.fn(async () => { throw new Error("An inventory action starts no thread."); });
  const { bb, harness } = createFakePluginHost({ pluginId: "workstreams", settings: { scanRoots: "/p" }, sdk: {
    system: { config: async () => ({ primaryHostId: HOST }) as never },
    projects: { list: async () => [{ id: "project-folio", name: "Folio", sources: [{ hostId: HOST, path: "/p" }] }] as never },
    threads: { list: async () => [] as never, getPluginMetadata: async () => ({}) as never, events: { list: async () => [] }, spawn },
  }, experimental_callHostRpc: async ({ method, input }) => {
    calls.push({ method, input });
    if (method === "scan" || method === "inspectPaths") return { units: [UNIT], warnings: [] };
    if (method === "authoredPrs") return { owners: ["inkwell"], entries: [...current.values()].map((entry) => ({ repo: "inkwell/folio", pr: entry })),
      discoveryComplete: true, repositories: [{ repo: "inkwell/folio", complete: true }], complete: true, warnings: [] };
    if (method === "inspectPrs") return { entries: (input as { prUrls: string[] }).prUrls.map((prUrl) => ({ repo: "inkwell/folio", pr: current.get(Number(prUrl.split("/").pop()))! })),
      closed: [], failed: [], warnings: [] };
    if (method === "prWrite") {
      const request = input as { kind: string; prUrl: string };
      if (request.kind === "ready") current.set(313, { ...current.get(313)!, isDraft: false });
      return { ok: true, detail: `Wrote ${request.kind}.` };
    }
    if (method === "advanceInspect") return { ok: false, error: "Not read in this test." };
    throw new Error(`Unexpected host method ${method}`);
  } });
  const facts: AdvanceFacts = { prUrl: url(313), number: 313, title: "ABC-313 Keep shelf order", repo: "inkwell/folio", headRefName: "branch-313", baseRefName: "main",
    headOid: HEAD, baseOid: "d".repeat(40), state: "OPEN", isDraft: true, isCrossRepository: false, reviewDecision: "REVIEW_REQUIRED", mergeStateStatus: "CLEAN",
    mergeable: "MERGEABLE", needsPreparation: false, readiness: "needs-attention", detail: "Draft", unresolvedThreads: 0, threadsComplete: true,
    checks: "passed", basePrNumber: null, approvalFeedback: { status: "none", fingerprint: null, sourceIds: [] } };
  const db = bb.storage.database();
  db.prepare("CREATE TABLE IF NOT EXISTS advance_batches (id TEXT PRIMARY KEY, body TEXT NOT NULL)").run();
  const job = { ...advancePreviewJobSchema.parse({ ...facts, eligible: true, workspace: "create" }), id: JOB, hiddenFromProgress: false, status: "needs-attention",
    attemptId: null, dedicated: false, previousAttempts: [], threadId: null, path: null, checkedHeadOid: null, updatedAt: Date.now(), uncertain: false };
  db.prepare("INSERT INTO advance_batches (id, body) VALUES (?, ?)").run(BATCH, JSON.stringify({ id: BATCH, token: "00000000-0000-4000-8000-000000000093",
    createdAt: Date.now(), cancelled: false, jobs: [job], facts: { [JOB]: { ...facts, eligible: true, workspace: "create", projectId: "project-folio", hostId: HOST,
      sourcePath: null, path: null, effortId: null, effortKey: null, effortMembers: null, needsFeedback: false, needsChecks: false, blockedBy: null } },
    pollUntil: Date.now() + 60_000, prepared: {}, repairs: {} }));
  await plugin(bb);
  cleanups.push(() => harness.lifecycle.dispose());
  expect((await harness.runCli(["refresh"])).exitCode).toBe(0);
  const since = () => { const at = calls.length; return () => calls.slice(at); };
  const row = async (number: number) => ((await harness.callRpc("inventory_get", {})) as InventoryView).groups.flatMap((group) => group.rows).find((entry) => entry.number === number)!;
  return { harness, calls, current, spawn, db, since, row, rpc: (method: string, input: unknown) => harness.callRpc(method as never, input as never) };
}

describe("inventory actions on the server", () => {
  it("marks a draft ready from its row: reads first, writes on the shown head, reads back without rechecking Advance, and records it", async () => {
    const env = await setup();
    const after = env.since();
    expect(await env.rpc("inventory_mark_ready", { prUrl: url(313), headOid: (await env.row(313)).head })).toEqual({ ok: true, detail: "Wrote ready." });
    expect(after().map((call) => call.method)).toEqual(["inspectPrs", "prWrite", "inspectPrs"]);
    expect(after().find((call) => call.method === "prWrite")?.input).toEqual({ kind: "ready", prUrl: url(313), headOid: HEAD });
    // Ready now, it asks the next question: who reviews it.
    expect(await env.row(313)).toMatchObject({ draft: false, attention: [{ question: "missing-reviewer" }],
      lastAction: { action: "mark-ready", ok: true, detail: "Wrote ready." } });
    expect(env.spawn).not.toHaveBeenCalled();
    // The next legacy refresh still rechecks #313's Advance job on the change the click's read stored first.
    const refresh = env.since();
    expect((await env.harness.runCli(["refresh"])).exitCode).toBe(0);
    expect(refresh().map((call) => call.method)).toContain("advanceInspect");
  });

  it("tells a roster that numbers the PR what the click's read-back saw, since the roster shows the same PR", async () => {
    const env = await setup();
    const effort = createEffortStore(env.db).establish({ sourceKey: "pr:313", name: "Shelf order", goal: "Keep shelves in order", projectId: "project-folio",
      coordinatorState: "none", members: { tickets: [], prUrls: [url(313)] } });
    await env.rpc("effort_roster_get", { effortId: effort.id });
    expect((await env.harness.runCli(["refresh"])).exitCode).toBe(0);
    const signals = () => env.harness.inspection.realtimeSignals.filter((signal) => signal.channel === "effort-roster-changed").map((signal) => signal.payload);
    const before = signals().length;
    expect(await env.rpc("inventory_mark_ready", { prUrl: url(313), headOid: HEAD })).toEqual({ ok: true, detail: "Wrote ready." });
    expect(signals().slice(before)).toEqual([{ effortId: effort.id }]);
  });

  it("refuses on the facts its row showed, even after a board read already stored newer ones", async () => {
    const env = await setup();
    const shown = await env.row(313);
    env.current.set(313, { ...env.current.get(313)!, headRefOid: "b".repeat(40) });
    // A board read (the poll, a scan, a Refresh) lands between the row and the click.
    expect((await env.harness.runCli(["refresh"])).exitCode).toBe(0);
    const after = env.since();
    expect(await env.rpc("inventory_mark_ready", { prUrl: url(313), headOid: shown.head }))
      .toMatchObject({ ok: false, error: expect.stringContaining("New commits landed") });
    expect(after().map((call) => call.method)).not.toContain("prWrite");
  });

  it("suggests reviewers from the repository's reviews and requests the ones you choose", async () => {
    const env = await setup();
    expect(await env.row(314)).toMatchObject({ attention: [{ action: "request-review" }], suggestedReviewers: ["mira", "otto"] });
    const after = env.since();
    expect(await env.rpc("inventory_request_review", { prUrl: url(314), logins: ["mira"], shown: (await env.row(314)).reviewers })).toMatchObject({ ok: true });
    expect(after().find((call) => call.method === "prWrite")?.input).toEqual({ kind: "nudge", prUrl: url(314), reviewers: ["mira"], comment: null });
  });

  it("nudges the reviewer an overdue request names", async () => {
    const env = await setup();
    expect(await env.row(315)).toMatchObject({ attention: [{ action: "nudge", reviewers: ["mira"] }] });
    const after = env.since();
    expect(await env.rpc("inventory_nudge", { prUrl: url(315), reviewers: ["mira"] })).toMatchObject({ ok: true });
    expect(after().find((call) => call.method === "prWrite")?.input).toEqual({ kind: "nudge", prUrl: url(315), reviewers: ["mira"], comment: null });
  });

  it("re-requests the reviewer whose change request a push answered, even when the click's read can't date that push", async () => {
    const env = await setup();
    expect(await env.row(318)).toMatchObject({ attention: [{ kind: "rereview-needed", action: "rerequest", reviewers: ["otto"] }] });
    // GitHub's ages read failed on the click: the read has no push date, and the row's stored one still describes this head.
    const { headCommittedAt: _undated, ...undated } = env.current.get(318)!;
    env.current.set(318, undated);
    const after = env.since();
    expect(await env.rpc("inventory_nudge", { prUrl: url(318), reviewers: ["otto"] })).toMatchObject({ ok: true });
    expect(after().find((call) => call.method === "prWrite")?.input).toEqual({ kind: "nudge", prUrl: url(318), reviewers: ["otto"], comment: null });
  });

  it("refuses under a hold or an active v2 claim, writes nothing, and says why on the row", async () => {
    const env = await setup();
    await env.rpc("pr_hold_set", { prUrl: url(313), held: true, reason: "Store layout first" });
    const held = env.since();
    expect(await env.rpc("inventory_mark_ready", { prUrl: url(313), headOid: HEAD })).toEqual({ ok: false, error: "On hold: Store layout first. Release the hold first; nothing was written." });
    expect(held()).toEqual([]);
    const body: AttemptBody = { instructionRevision: 1, recipes: ["integrate_base"], role: "code", retryEpoch: 0, retryIndex: 0,
      start: { headOid: HEAD, baseOid: "d".repeat(40), fingerprint: null, sourceIds: [] },
      resource: { kind: "spawn", threadId: null, path: null, hostId: HOST, projectId: "project-folio", reason: null, workspace: null },
      mode: "spawn", marker: "[Workstreams attempt A-1 · inkwell/folio#314 · instruction r1]", settledAt: Date.now(), uncertainAt: null,
      emptyReadbackAt: null, failure: null, error: null, releasedReason: null };
    createEffortWorkStore(env.db).claim({ id: "A-1", target: url(314), effortId: "effort-shelf", instructionId: "I-effort-shelf-r1", launchKey: "key-A-1",
      threadId: null, hostId: HOST, path: null, body });
    const claimed = env.since();
    expect(await env.rpc("inventory_request_review", { prUrl: url(314), logins: ["mira"], shown: { requested: [], reviewed: [] } }))
      .toMatchObject({ ok: false, error: expect.stringContaining("A worker from the effort-shelf roster is writing this PR") });
    expect(claimed()).toEqual([]);
    expect(await env.row(314)).toMatchObject({ lastAction: { action: "request-review", ok: false } });
  });
});
