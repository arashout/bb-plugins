import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { AdvanceFacts } from "./advance-contract.js";
import { advancePreviewJobSchema } from "./bulk-advance.js";
import type { Pr, RawUnit } from "./contract.js";
import { createEffortStore } from "./effort-store.js";
import { parsePrList } from "./gh.js";
import type { InventoryView } from "./inventory-view.js";
import { createPrHoldStore } from "./pr-hold-store.js";
import plugin from "./server.js";

const HOST = "host-inkwell";
const url = (number: number) => `https://github.com/inkwell/folio/pull/${number}`;
const pr = (number: number, title: string, extra: Record<string, unknown> = {}): Pr => parsePrList(JSON.stringify([{ number, url: url(number), state: "OPEN", title,
  isDraft: false, reviewDecision: "REVIEW_REQUIRED", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefName: `branch-${number}`, baseRefName: "main",
  headRefOid: "a".repeat(40), latestReviews: [], reviewRequests: [], statusCheckRollup: [{ conclusion: "SUCCESS" }], createdAt: "2026-09-21T15:00:00Z", ...extra }]))!.pr;
const unit = (path: string, value: Pr | null): RawUnit => ({ path, dirName: path.split("/").pop()!, repo: "folio", githubRepo: "inkwell/folio", branch: value?.headRefName ?? "main",
  dirty: false, ahead: 0, behind: 0, lastCommitAt: null, defaultBranch: "main", pr: value, shipped: null, changedPaths: [], observed: { status: true, pr: true } });
const BATCH = "00000000-0000-4000-8000-000000000081", JOB = "00000000-0000-4000-8000-000000000082";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

/**
 * You author #313 (a green draft), #314 (ABC-341, no reviewer yet, with a legacy Advance worker), and #315 (held). A teammate's #400 is
 * checked out; #401 was never read; #402 belongs to an archived effort; #403 merged.
 */
async function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId: "workstreams", settings: { scanRoots: "/p" }, sdk: {
    system: { config: async () => ({ primaryHostId: HOST }) as never },
    projects: { list: async () => [{ id: "project-folio", name: "Folio", sources: [{ hostId: HOST, path: "/p" }] }] as never },
    threads: {
      list: async () => [{ ...makeThreadResponse({ id: "thr-worker", title: "Advance worker for #314", projectId: "project-folio", status: "idle" }),
        queuedWork: "none", hasPendingInteraction: false, activity: { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activeGoalCount: 0,
          activePlanModeCount: 0, activeWorkflowCount: 0 } }] as never,
      get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, projectId: "project-folio", status: "idle" }) as never,
      getPluginMetadata: async () => ({}) as never, events: { list: async () => [] }, output: async () => ({ output: "" }),
    },
  }, experimental_callHostRpc: async ({ method }) => {
    if (method === "scan" || method === "inspectPaths") return { units: [unit("/p/folio", null), unit("/p/folio-400", pr(400, "Shelve box sets together")),
      unit("/p/folio-403", pr(403, "Shelve atlases flat", { state: "MERGED" }))], warnings: [] };
    if (method === "authoredPrs") return { owners: ["inkwell"], entries: [
      pr(313, "Keep shelf order on reload", { isDraft: true }), pr(314, "ABC-341 Group shelves by genre"), pr(315, "Sort shelves by author"),
    ].map((entry) => ({ repo: "inkwell/folio", pr: entry })), discoveryComplete: true, repositories: [{ repo: "inkwell/folio", complete: true }], complete: true, warnings: [] };
    if (method === "advanceInspect") return { ok: false, error: "Not read in this test." };
    throw new Error(`Unexpected host method ${method}`);
  } });
  const facts: AdvanceFacts = { prUrl: url(314), number: 314, title: "ABC-341 Group shelves by genre", repo: "inkwell/folio", headRefName: "branch-314", baseRefName: "main",
    headOid: "a".repeat(40), baseOid: "d".repeat(40), state: "OPEN", isDraft: false, isCrossRepository: false, reviewDecision: "REVIEW_REQUIRED", mergeStateStatus: "CLEAN",
    mergeable: "MERGEABLE", needsPreparation: false, readiness: "needs-attention", detail: "Needs a review", unresolvedThreads: 0, threadsComplete: true,
    checks: "passed", basePrNumber: null, approvalFeedback: { status: "none", fingerprint: null, sourceIds: [] } };
  const db = bb.storage.database();
  db.prepare("CREATE TABLE IF NOT EXISTS advance_batches (id TEXT PRIMARY KEY, body TEXT NOT NULL)").run();
  const job = { ...advancePreviewJobSchema.parse({ ...facts, eligible: true, workspace: "create" }), id: JOB, hiddenFromProgress: false, status: "needs-attention",
    attemptId: null, dedicated: false, previousAttempts: [], threadId: "thr-worker", path: null, checkedHeadOid: null, updatedAt: Date.now(), uncertain: false };
  db.prepare("INSERT INTO advance_batches (id, body) VALUES (?, ?)").run(BATCH, JSON.stringify({ id: BATCH, token: "00000000-0000-4000-8000-000000000083",
    createdAt: Date.now(), cancelled: false, jobs: [job], facts: { [JOB]: { ...facts, eligible: true, workspace: "create", projectId: "project-folio", hostId: HOST,
      sourcePath: null, path: null, effortId: null, effortKey: null, effortMembers: null, needsFeedback: false, needsChecks: false, blockedBy: null } },
    pollUntil: Date.now() + 60_000, prepared: {}, repairs: {} }));
  await plugin(bb);
  cleanups.push(() => harness.lifecycle.dispose());
  const efforts = createEffortStore(db);
  const shelf = efforts.establish({ sourceKey: "ticket:ABC-341", name: "Shelf order", goal: "Keep shelves in order", projectId: "project-folio",
    coordinatorState: "none", members: { tickets: ["ABC-341"], prUrls: [url(400), url(401), url(403)] } });
  const old = efforts.establish({ sourceKey: "pr:402", name: "Old shelving", goal: "Retired", projectId: "project-folio", coordinatorState: "none",
    members: { tickets: [], prUrls: [url(402)] } });
  efforts.setArchived(old.id, true);
  createPrHoldStore(db).set(url(315), true, "Waiting on the store layout review");
  expect((await harness.runCli(["refresh"])).exitCode).toBe(0);
  return { harness, db, shelf, get: async (input: object = {}) => await harness.callRpc("inventory_get", input) as InventoryView };
}

describe("the PR inventory read model", () => {
  it("lists your open PRs and every open PR an effort names, under the effort that owns each, explicitly or by ticket", async () => {
    const env = await setup();
    const view = await env.get();
    expect(view.groups.map((group) => [group.effort?.name ?? null, group.rows.map((row) => row.number)])).toEqual([
      // #402's effort is archived and #403 merged, so neither is open work here.
      ["Shelf order", [314, 400, 401]], [null, [313, 315]]]);
    const rows = new Map(view.groups.flatMap((group) => group.rows).map((row) => [row.number, row]));
    expect(rows.get(313)).toMatchObject({ authored: true, draft: true, status: "Draft", attention: [{ question: "forgotten-draft", action: "mark-ready", owner: "you" }],
      checkedAt: expect.any(String), failure: null });
    expect(rows.get(314)).toMatchObject({ authored: true, status: "No reviewer", attention: [{ question: "missing-reviewer", nextStep: "Request a review" }],
      threads: { origin: null, executor: { id: "thr-worker", active: false } }, managed: null });
    // Held: every step would be refused, so none is offered.
    expect(rows.get(315)).toMatchObject({ hold: { reason: "Waiting on the store layout review" }, status: "On hold", attention: [] });
    // A teammate's PR reads its checkout and asks nothing of you.
    expect(rows.get(400)).toMatchObject({ authored: false, title: "Shelve box sets together", status: "No reviewer", attention: [] });
    expect(rows.get(401)).toMatchObject({ authored: false, title: "", status: "Not read yet", checkedAt: null });
    expect(view.counts).toEqual({ "forgotten-draft": 1, "missing-reviewer": 1, "needs-nudge": 0 });
    expect(view).toMatchObject({ checkedAt: expect.any(String), refreshing: false, rateLimitedUntil: null });
  });

  it("marks a PR a v2 roster manages with its roster state, and filters by question while still counting every row", async () => {
    const env = await setup();
    env.db.prepare("INSERT INTO effort_execution (effort_id, mode, revision, updated_at) VALUES (?, 'v2', 1, 0)").run(env.shelf.id);
    env.db.prepare("INSERT INTO effort_v2_targets (target, effort_id, source, resolved_at) VALUES (?, ?, 'ticket', 0)").run(url(314), env.shelf.id);
    const reviewer = await env.get({ attention: "missing-reviewer" });
    expect(reviewer.groups.flatMap((group) => group.rows)).toMatchObject([{ number: 314, status: "Not in instruction",
      managed: { effortId: env.shelf.id, effortName: "Shelf order", label: "Not in instruction" } }]);
    expect(reviewer.counts).toEqual({ "forgotten-draft": 1, "missing-reviewer": 1, "needs-nudge": 0 });
  });

  it("prints the inventory from the CLI, filters it, and signals each change", async () => {
    const env = await setup();
    const text = await env.harness.runCli(["inventory"]);
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain("1 forgotten in draft · 1 missing a reviewer · 0 need a nudge");
    expect(text.stdout).toContain("  inkwell/folio #314 · ABC-341 Group shelves by genre · no reviewer · No reviewer · Request a review (you, ");
    const drafts = JSON.parse((await env.harness.runCli(["inventory", "--attention", "draft", "--json"])).stdout) as InventoryView;
    expect(drafts.groups.flatMap((group) => group.rows.map((row) => row.number))).toEqual([313]);
    const before = env.harness.inspection.realtimeSignals.length;
    await env.harness.callRpc("pr_hold_set", { prUrl: url(313), held: true });
    expect(env.harness.inspection.realtimeSignals.slice(before).map((signal) => signal.channel)).toContain("inventory-changed");
  });
});
