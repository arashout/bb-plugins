import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdvanceFacts } from "./advance-contract.js";
import { advancePreviewJobSchema } from "./bulk-advance.js";
import type { Pr, RawUnit } from "./contract.js";
import { createEffortStore } from "./effort-store.js";
import { parsePrList } from "./gh.js";
import type { InventoryInspection, InventoryResult } from "./inventory.js";
import plugin, { type Board } from "./server.js";

const HOST = "host-inkwell";
const url = (number: number) => `https://github.com/inkwell/folio/pull/${number}`;
const HEAD = "a".repeat(40), NEXT = "b".repeat(40);
const BATCH = "00000000-0000-4000-8000-000000000071", JOB = "00000000-0000-4000-8000-000000000072";
const pr = (number: number, extra: Record<string, unknown> = {}): Pr => parsePrList(JSON.stringify([{ number, url: url(number), state: "OPEN",
  title: `ABC-${number} Keep shelf order on reload`, isDraft: false, reviewDecision: "REVIEW_REQUIRED", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
  headRefName: `abc-${number}-shelves`, baseRefName: "main", headRefOid: HEAD, latestReviews: [], reviewRequests: [], statusCheckRollup: [{ conclusion: "SUCCESS" }],
  createdAt: "2026-09-21T15:00:00Z", updatedAt: "2026-09-25T11:00:00Z", ...extra }]))!.pr;
const listing = (prs: Pr[], extra: Partial<InventoryResult> = {}): InventoryResult => ({ owners: ["inkwell"], entries: prs.map((entry) => ({ repo: "inkwell/folio", pr: entry })),
  discoveryComplete: true, repositories: prs.length ? [{ repo: "inkwell/folio", complete: true }] : [], complete: true, warnings: [], ...extra });
const UNIT: RawUnit = { path: "/p/folio", dirName: "folio", repo: "folio", githubRepo: "inkwell/folio", branch: "abc-42-shelves", dirty: false,
  ahead: 0, behind: 0, lastCommitAt: null, defaultBranch: "main", pr: null, shipped: null, changedPaths: [], observed: { status: true, pr: true } };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

/**
 * PR #42 is checked out and authored; #43 is authored only. #42 carries a legacy Advance job that never launched, which the legacy
 * refresh rechecks whenever the PR's facts change.
 */
async function setup(options: { advanceJob?: boolean } = {}) {
  const calls: { method: string; input: unknown }[] = [];
  const state = {
    scanned: pr(42), authored: [pr(42), pr(43)],
    polled: listing([pr(42), pr(43)]),
    inspection: (urls: string[]): InventoryInspection => ({ entries: [], closed: urls, failed: [], warnings: [] }),
    resetAt: null as number | null,
  };
  const spawn = vi.fn(async () => { throw new Error("The poll must start no thread."); });
  const send = vi.fn(async () => { throw new Error("The poll must message no thread."); });
  const { bb, harness } = createFakePluginHost({ pluginId: "workstreams", settings: { scanRoots: "/p" }, sdk: {
    system: { config: async () => ({ primaryHostId: HOST }) as never },
    projects: { list: async () => [{ id: "project-folio", name: "Folio", sources: [{ hostId: HOST, path: "/p" }] }] as never },
    threads: { list: async () => [] as never, getPluginMetadata: async () => ({}) as never, events: { list: async () => [] }, spawn, send },
  }, experimental_callHostRpc: async ({ method, input }) => {
    calls.push({ method, input });
    if (method === "scan" || method === "inspectPaths") return { units: [{ ...UNIT, pr: state.scanned }], warnings: [] };
    if (method === "authoredPrs") return listing(state.authored);
    if (method === "pollAuthoredPrs") return state.polled;
    if (method === "inspectPrs") return state.inspection((input as { prUrls: string[] }).prUrls);
    if (method === "githubRateLimit") return { resetAt: state.resetAt };
    if (method === "advanceInspect") return { ok: false, error: "Not read in this test." };
    throw new Error(`Unexpected host method ${method}`);
  } });
  if (options.advanceJob) {
    const facts: AdvanceFacts = { prUrl: url(42), number: 42, title: pr(42).title, repo: "inkwell/folio", headRefName: "abc-42-shelves", baseRefName: "main",
      headOid: HEAD, baseOid: "d".repeat(40), state: "OPEN", isDraft: false, isCrossRepository: false, reviewDecision: "REVIEW_REQUIRED", mergeStateStatus: "CLEAN",
      mergeable: "MERGEABLE", needsPreparation: false, readiness: "needs-attention", detail: "Needs a review", unresolvedThreads: 0, threadsComplete: true,
      checks: "passed", basePrNumber: null, approvalFeedback: { status: "none", fingerprint: null, sourceIds: [] } };
    const db = bb.storage.database();
    db.prepare("CREATE TABLE IF NOT EXISTS advance_batches (id TEXT PRIMARY KEY, body TEXT NOT NULL)").run();
    const job = { ...advancePreviewJobSchema.parse({ ...facts, eligible: true, workspace: "create" }), id: JOB, hiddenFromProgress: false, status: "needs-attention",
      attemptId: null, dedicated: false, previousAttempts: [], threadId: null, path: UNIT.path, checkedHeadOid: null, updatedAt: Date.now(), uncertain: false };
    db.prepare("INSERT INTO advance_batches (id, body) VALUES (?, ?)").run(BATCH, JSON.stringify({ id: BATCH, token: "00000000-0000-4000-8000-000000000073",
      createdAt: Date.now(), cancelled: false, jobs: [job], facts: { [JOB]: { ...facts, eligible: true, workspace: "create", projectId: "project-folio", hostId: HOST,
        sourcePath: UNIT.path, path: UNIT.path, effortId: null, effortKey: null, effortMembers: null, needsFeedback: false, needsChecks: false, blockedBy: null } },
      pollUntil: Date.now() + 60_000, prepared: {}, repairs: {} }));
  }
  await plugin(bb);
  cleanups.push(() => harness.lifecycle.dispose());
  expect((await harness.runCli(["refresh"])).exitCode).toBe(0);
  /** One pass of the inventory-poll service: it polls at once, then the test stops it before its next wait ends. */
  const poll = async () => {
    const before = calls.length;
    const { controller, done } = harness.runService("inventory-poll");
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(before));
    controller.abort();
    await done;
    return calls.slice(before).map((call) => call.method);
  };
  return { harness, calls, state, spawn, send, poll, db: bb.storage.database(), board: async () => await harness.callRpc("board_get", null) as Board };
}

describe("the inventory poll", () => {
  it("writes one batched read through the board's stores, so the inventory, checkouts, and roster agree, and never rechecks Advance or writes", async () => {
    const env = await setup({ advanceJob: true });
    const effort = createEffortStore(env.db).establish({ sourceKey: "pr:42", name: "Shelf order", goal: "Keep shelves in order", projectId: "project-folio",
      coordinatorState: "none", members: { tickets: [], prUrls: [url(42)] } });
    const checkedAt = (await env.board()).prObservations[url(42)]?.checkedAt;
    const failing = pr(42, { headRefOid: NEXT, statusCheckRollup: [{ conclusion: "FAILURE" }] });
    env.state.polled = listing([failing, pr(43)]);
    await new Promise((resolve) => setTimeout(resolve, 2));
    // Nothing else: no discovery, no listing per repository, no Advance recheck (which ends by pumping queued legacy work), no write.
    expect(await env.poll()).toEqual(["pollAuthoredPrs"]);
    const board = await env.board();
    expect(board.prInventory.entries.find((entry) => entry.pr.number === 42)?.pr).toMatchObject({ headRefOid: NEXT, checkConclusions: ["FAILURE"] });
    expect(board.groups.flatMap((group) => group.clusters.flatMap((cluster) => cluster.units)).find((unit) => unit.path === UNIT.path)?.pr)
      .toMatchObject({ headRefOid: NEXT, checkConclusions: ["FAILURE"] });
    expect(board.prObservations[url(42)]?.checkedAt).not.toBe(checkedAt);
    const roster = await env.harness.callRpc("effort_roster_get", { effortId: effort.id }) as { rows: { number: number; checks: string | null; head: string | null }[] };
    expect(roster.rows).toMatchObject([{ number: 42, checks: "failed", head: NEXT }]);
    expect(env.spawn).not.toHaveBeenCalled();
    expect(env.send).not.toHaveBeenCalled();
    // The next legacy refresh sees the facts the poll already stored, yet rechecks the job on the change the poll saw first: the poll
    // leaves that recheck to it rather than dropping it, and the one after has nothing new to recheck.
    env.state.scanned = failing;
    env.state.authored = [failing, pr(43)];
    for (const expected of [true, false]) {
      const before = env.calls.length;
      expect((await env.harness.runCli(["refresh"])).exitCode).toBe(0);
      expect(env.calls.slice(before).map((call) => call.method).includes("advanceInspect")).toBe(expected);
    }
  });

  it("tells a roster when a poll reads a change to one of its PRs, so its pane needn't refetch on every board signal, and says nothing when a poll finds none", async () => {
    const env = await setup();
    const effort = createEffortStore(env.db).establish({ sourceKey: "pr:42", name: "Shelf order", goal: "Keep shelves in order", projectId: "project-folio",
      coordinatorState: "none", members: { tickets: [], prUrls: [url(42)] } });
    await env.harness.callRpc("effort_roster_get", { effortId: effort.id });
    const signals = () => env.harness.inspection.realtimeSignals.filter((signal) => signal.channel === "effort-roster-changed").map((signal) => signal.payload);
    await env.poll();
    const before = signals().length;
    await env.poll();
    expect(signals().length).toBe(before);
    env.state.polled = listing([pr(42, { statusCheckRollup: [{ conclusion: "FAILURE" }] }), pr(43)]);
    await env.poll();
    expect(signals().slice(before)).toEqual([{ effortId: effort.id }]);
  });

  it("reads a PR the search stopped listing before letting it go, since the search index can lag", async () => {
    const env = await setup();
    env.state.polled = listing([pr(42)]);
    // The index lagged: #43 is still open, so it stays.
    env.state.inspection = (urls) => ({ entries: urls.map((prUrl) => ({ repo: "inkwell/folio", pr: pr(Number(prUrl.split("/").pop())) })), closed: [], failed: [], warnings: [] });
    expect(await env.poll()).toEqual(["pollAuthoredPrs", "inspectPrs"]);
    expect(env.calls.at(-1)?.input).toEqual({ prUrls: [url(43)] });
    expect((await env.board()).prInventory.entries.map((entry) => [entry.pr.number, entry.stale])).toEqual([[42, false], [43, false]]);
    // GitHub couldn't say: #43 stays, stale, with the reason.
    env.state.inspection = (urls) => ({ entries: [], closed: [], failed: urls, warnings: ["inkwell/folio #43: PR refresh failed: HTTP 502"] });
    await env.poll();
    let board = await env.board();
    expect(board.prInventory.entries.map((entry) => [entry.pr.number, entry.stale])).toEqual([[42, false], [43, true]]);
    expect(board.prObservations[url(43)]).toMatchObject({ failedAt: expect.any(String), error: "inkwell/folio #43: PR refresh failed: HTTP 502" });
    // It closed: now it goes, even while #42's own read failing leaves the repository's membership partial.
    env.state.polled = listing([pr(42, { reviewDecision: "APPROVED" })]);
    env.state.inspection = (urls) => ({ entries: [], closed: urls.filter((prUrl) => prUrl === url(43)), failed: urls.filter((prUrl) => prUrl !== url(43)), warnings: [] });
    await env.poll();
    board = await env.board();
    expect(board.prInventory.entries.map((entry) => [entry.pr.number, entry.stale])).toEqual([[42, true]]);
  });

  it("reads a PR's review threads again only when its reviews moved, and otherwise carries their evidence", async () => {
    const env = await setup();
    const approved = (extra: Record<string, unknown> = {}): Pr => ({ ...pr(43, { reviewDecision: "APPROVED",
      latestReviews: [{ author: { login: "mira" }, state: "APPROVED", submittedAt: "2026-09-24T09:00:00Z" }], ...extra }), unresolvedReviewThreads: 0, resolvedReviewThreads: 1 });
    const evidence = { status: "none" as const, fingerprint: null, sourceIds: [] };
    env.state.inspection = (urls) => ({ entries: urls.map((prUrl) => ({ repo: "inkwell/folio", pr: { ...approved(), url: prUrl, approvalFeedback: evidence } })),
      closed: [], failed: [], warnings: [] });
    env.state.polled = listing([pr(42), approved()]);
    expect(await env.poll()).toEqual(["pollAuthoredPrs", "inspectPrs"]);
    expect((await env.board()).prInventory.entries[1]?.pr).toMatchObject({ approvalFeedback: evidence, approvalFeedbackVerified: true });
    // Nothing moved: no read, and the evidence stays.
    expect(await env.poll()).toEqual(["pollAuthoredPrs"]);
    expect((await env.board()).prInventory.entries[1]?.pr).toMatchObject({ approvalFeedback: evidence, approvalFeedbackVerified: true });
    // A new comment moved GitHub's update time: the evidence may no longer hold, so it is read again.
    env.state.polled = listing([pr(42), approved({ updatedAt: "2026-09-26T09:00:00Z" })]);
    expect(await env.poll()).toEqual(["pollAuthoredPrs", "inspectPrs"]);
    // That read failed: the PR keeps the read that proved its evidence, stale, with why, rather than reading as fresh without it.
    env.state.polled = listing([pr(42), approved({ updatedAt: "2026-09-27T09:00:00Z" })]);
    env.state.inspection = (urls) => ({ entries: [], closed: [], failed: urls, warnings: ["inkwell/folio #43: PR refresh failed: HTTP 502"] });
    expect(await env.poll()).toEqual(["pollAuthoredPrs", "inspectPrs"]);
    const board = await env.board();
    expect(board.prInventory.entries.find((entry) => entry.pr.number === 43)).toMatchObject({ stale: true,
      pr: { approvalFeedback: evidence, approvalFeedbackVerified: true, updatedAt: "2026-09-25T11:00:00Z" } });
    expect(board.prObservations[url(43)]).toMatchObject({ failedAt: expect.any(String), error: "inkwell/folio #43: PR refresh failed: HTTP 502" });
  });

  it("stops at GitHub's rate limit until its reset, and names the reset in each PR's failure", async () => {
    const env = await setup();
    const resetAt = Date.now() + 15 * 60_000;
    env.state.resetAt = resetAt;
    env.state.polled = listing([], { complete: false, discoveryComplete: false, warnings: ["Authored PR poll failed: GraphQL: API rate limit exceeded for user ID 1."] });
    expect(await env.poll()).toEqual(["pollAuthoredPrs", "githubRateLimit"]);
    const board = await env.board();
    expect(board.prInventory.entries.map((entry) => entry.stale)).toEqual([true, true]);
    expect(board.prObservations[url(42)]?.error).toContain(new Date(resetAt + 30_000).toISOString());
    // The next pass reads nothing before the reset.
    const before = env.calls.length;
    const { controller, done } = env.harness.runService("inventory-poll");
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await done;
    expect(env.calls.slice(before)).toEqual([]);
  });
});
