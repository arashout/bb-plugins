import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { Pr } from "./contract.js";
import { ONE_OFFS_SOURCE } from "./effort-assignments.js";
import type { SuggestionGroup } from "./effort-classify.js";
import { createEffortPileStore } from "./effort-piles.js";
import { createEffortStore } from "./effort-store.js";
import { parsePrList } from "./gh.js";
import type { InventoryView } from "./inventory-view.js";
import plugin from "./server.js";

const HOST = "host-inkwell";
const url = (number: number) => `https://github.com/inkwell/folio/pull/${number}`;
const pr = (number: number, title: string): Pr => parsePrList(JSON.stringify([{ number, url: url(number), state: "OPEN", title, isDraft: false,
  reviewDecision: "REVIEW_REQUIRED", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefName: `reader/change${number}`, baseRefName: "main",
  headRefOid: "a".repeat(40), latestReviews: [], reviewRequests: [], statusCheckRollup: [{ conclusion: "SUCCESS" }], createdAt: "2026-09-21T15:00:00Z" }]))!.pr;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

const DEFAULT_AUTHORED = [pr(313, "Update the footer year"), pr(314, "ABC-341 Group shelves by genre"), pr(316, "Remove an unused import")];
/** By default you author #313 and #316, which no effort owns, and #314, which Shelf order owns through ABC-341. */
async function setup(authored: Pr[] = DEFAULT_AUTHORED) {
  const { bb, harness } = createFakePluginHost({ pluginId: "workstreams", settings: { scanRoots: "/p" }, sdk: {
    system: { config: async () => ({ primaryHostId: HOST }) as never },
    projects: { list: async () => [{ id: "project-folio", name: "Folio", sources: [{ hostId: HOST, path: "/p" }] }] as never },
    threads: { list: async () => [] as never, getPluginMetadata: async () => ({}) as never, events: { list: async () => [] } },
  }, experimental_callHostRpc: async ({ method }) => {
    if (method === "scan" || method === "inspectPaths") return { units: [], warnings: [] };
    if (method === "authoredPrs") return { owners: ["inkwell"], entries: authored.map((entry) => ({ repo: "inkwell/folio", pr: entry })), discoveryComplete: true,
      repositories: [{ repo: "inkwell/folio", complete: true }], complete: true, warnings: [] };
    throw new Error(`Unexpected host method ${method}`);
  } });
  await plugin(bb);
  cleanups.push(() => harness.lifecycle.dispose());
  const efforts = createEffortStore(bb.storage.database());
  const shelf = efforts.establish({ sourceKey: "ticket:ABC-341", name: "Shelf order", goal: "Keep shelves in order", projectId: "project-folio",
    coordinatorState: "none", members: { tickets: ["ABC-341"], prUrls: [] } });
  expect((await harness.runCli(["refresh"])).exitCode).toBe(0);
  const call = (method: string, input: unknown) => harness.callRpc(method as never, input as never) as Promise<any>;
  const grouped = async () => Object.fromEntries((await call("inventory_get", {}) as InventoryView).groups
    .map((group) => [group.effort?.name ?? "No effort", group.rows.map((row) => row.number)]));
  return { bb, efforts, shelf, call, grouped };
}

describe("One-offs", () => {
  it("creates One-offs on first use, reuses it after, and undoes a mark back to No effort", async () => {
    const env = await setup();
    const first = await env.call("classify_one_off", { prUrls: [url(313)] });
    expect(first).toEqual({ ok: true, actionId: expect.any(String), effort: { id: expect.any(String), key: expect.any(String), name: "One-offs" }, added: 1 });
    expect(env.efforts.source(ONE_OFFS_SOURCE)?.id).toBe(first.effort.id);
    expect(await env.grouped()).toEqual({ "One-offs": [313], "Shelf order": [314], "No effort": [316] });
    expect((await env.call("classify_one_off", { prUrls: [url(316)] })).effort.id).toBe(first.effort.id);
    expect(await env.call("classify_undo", { actionId: first.actionId })).toEqual({ ok: true });
    expect(await env.grouped()).toEqual({ "One-offs": [316], "Shelf order": [314], "No effort": [313] });
  });

  // Owning through a ticket is still owning: marking #314 one-off would silently take it from Shelf order.
  it("marks only PRs no effort owns, and a refused first use creates nothing", async () => {
    const env = await setup();
    expect(await env.call("classify_one_off", { prUrls: [url(313), url(314)] }))
      .toEqual({ ok: false, error: "inkwell/folio #314 isn't unclassified now. Refresh and try again." });
    expect(env.efforts.source(ONE_OFFS_SOURCE)).toBeNull();
    expect(await env.grouped()).toEqual({ "Shelf order": [314], "No effort": [313, 316] });
  });

  it("keeps One-offs on the active pile", async () => {
    const env = await setup();
    const { effort } = await env.call("classify_one_off", { prUrls: [url(313)] });
    for (const method of ["effort_hold", "effort_complete"]) expect(await env.call(method, { effortKey: effort.key }))
      .toEqual({ ok: false, error: "One-offs stays active: each one-off merges on its own." });
  });

  // One-offs holds unrelated PRs, so a ticket a one-off shares with a PR to sort says nothing about where that PR belongs.
  it("is never suggested as an effort to join", async () => {
    const env = await setup([{ ...pr(313, "Update the footer year"), headRefName: "reader/abc-350-footer" }, pr(314, "ABC-341 Group shelves by genre"),
      { ...pr(321, "Footer links"), headRefName: "reader/abc-350-links" }]);
    await env.call("classify_one_off", { prUrls: [url(313)] });
    const { groups } = await env.call("classify_get", null) as { groups: SuggestionGroup[] };
    expect(groups.map((group) => [group.key, group.prs.map((row) => row.number)])).toEqual([["none", [321]]]);
  });
});

/**
 * You author #313, #316, #317, #320, and #318 (in the done Quill export). #314 is in Shelf order through ABC-341. "Direct work" links #313
 * and #314 through its own metadata; "Checkout work" names #314 too, but reaches #316 only by running in #316's checkout.
 */
async function setupSuggestions() {
  const thread = (id: string, title: string, extra: Record<string, unknown> = {}) => ({ ...makeThreadResponse({ id, title, projectId: "project-folio",
    originPluginId: "workstreams" }), environmentPath: null, environmentBranchName: null, queuedWork: "none", hasPendingInteraction: false,
    activity: { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activeGoalCount: 0, activePlanModeCount: 0, activeWorkflowCount: 0 }, ...extra });
  const metadata: Record<string, Record<string, unknown>> = { "thr-direct": { linkedPrUrl: url(313), prUrl: url(314) }, "thr-checkout": { linkedPrUrl: url(314) } };
  const authored = [pr(313, "Update the footer year"), pr(314, "ABC-341 Group shelves by genre"), { ...pr(316, "Sort shelves by author"), headRefName: "abc-316-sort" },
    pr(317, "Remove an unused import"), pr(318, "ABC-900 Export notes as EPUB"), { ...pr(320, "EPUB cover images"), headRefName: "abc-900-covers" }];
  const { bb, harness } = createFakePluginHost({ pluginId: "workstreams", settings: { scanRoots: "/p" }, sdk: {
    system: { config: async () => ({ primaryHostId: HOST }) as never },
    projects: { list: async () => [{ id: "project-folio", name: "Folio", sources: [{ hostId: HOST, path: "/p" }] }] as never },
    threads: {
      list: async () => [thread("thr-direct", "Direct work"), thread("thr-checkout", "Checkout work", { environmentPath: "/p/folio-316", environmentBranchName: "abc-316-sort" })] as never,
      get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, projectId: "project-folio" }) as never,
      getPluginMetadata: async ({ threadId }: { threadId: string }) => (metadata[threadId] ?? {}) as never, events: { list: async () => [] },
    },
  }, experimental_callHostRpc: async ({ method }) => {
    if (method === "scan" || method === "inspectPaths") return { units: [{ path: "/p/folio-316", dirName: "folio-316", repo: "folio", githubRepo: "inkwell/folio",
      branch: "abc-316-sort", dirty: false, ahead: 0, behind: 0, lastCommitAt: null, defaultBranch: "main", pr: authored[2], shipped: null, changedPaths: [],
      observed: { status: true, pr: true } }], warnings: [] };
    if (method === "authoredPrs") return { owners: ["inkwell"], entries: authored.map((entry) => ({ repo: "inkwell/folio", pr: entry })), discoveryComplete: true,
      repositories: [{ repo: "inkwell/folio", complete: true }], complete: true, warnings: [] };
    throw new Error(`Unexpected host method ${method}`);
  } });
  await plugin(bb);
  cleanups.push(() => harness.lifecycle.dispose());
  const efforts = createEffortStore(bb.storage.database());
  const shelf = efforts.establish({ sourceKey: "ticket:ABC-341", name: "Shelf order", goal: "Keep shelves in order", projectId: "project-folio",
    coordinatorState: "none", members: { tickets: ["ABC-341"], prUrls: [] } });
  const quill = efforts.establish({ sourceKey: "pr:318", name: "Quill export", goal: "Export notes", projectId: "project-folio",
    coordinatorState: "none", members: { tickets: [], prUrls: [url(318)] } });
  createEffortPileStore(bb.storage.database()).move(quill, "complete");
  expect((await harness.runCli(["refresh"])).exitCode).toBe(0);
  return { shelf, get: async () => await harness.callRpc("classify_get" as never, null as never) as { groups: SuggestionGroup[]; oneOffsId: string | null } };
}

describe("suggestions over RPC", () => {
  it("suggests only for your PRs no effort owns, from threads' own links, never into a done effort", async () => {
    const env = await setupSuggestions();
    const { groups, oneOffsId } = await env.get();
    expect(oneOffsId).toBeNull();
    expect(groups.map((group) => [group.key, group.prs.map((row) => row.number), group.prs.map((row) => row.signals.map((signal) => signal.text))])).toEqual([
      [`effort:${env.shelf.id}:medium`, [313], [["thread “Direct work”"]]],
      // "Checkout work" names Shelf order's #314, but only runs in #316's checkout, so #316 stays standalone.
      ["one-off", [316], [["ticket ABC-316"]]],
      // #320 shares ABC-900 with the done Quill export, which takes no new work.
      ["none", [317, 320], [[], []]],
    ]);
  });
});
