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
  return { bb, harness, efforts, shelf, call, grouped };
}

describe("Assigning PRs to an effort", () => {
  // You author #313 and #321 on ABC-350 (a lowercase key in their branches) and #316; Shelf order owns #314 through ABC-341.
  const authored = [{ ...pr(313, "Update the footer year"), headRefName: "reader/abc-350-footer" }, pr(314, "ABC-341 Group shelves by genre"),
    pr(316, "Remove an unused import"), { ...pr(321, "Footer links"), headRefName: "reader/abc-350-links" }];

  it("assigns PRs, and with their ticket, every later PR on that ticket joins without another click", async () => {
    const prs = [...authored];
    const env = await setup(prs);
    expect(await env.call("classify_assign", { effortKey: env.shelf.key, prUrls: [url(316)] })).toMatchObject({ ok: true, added: 1, effort: { name: "Shelf order" } });
    expect(await env.grouped()).toEqual({ "Shelf order": [314, 316], "No effort": [313, 321] });
    // A ticket brings every PR on it, so each open one must be in the selection: nothing moves that you didn't choose.
    expect(await env.call("classify_assign", { effortKey: env.shelf.key, prUrls: [url(313)], tickets: ["ABC-350"] }))
      .toEqual({ ok: false, error: "ABC-350 is also on inkwell/folio #321. Choose it too, or leave ABC-350 out." });
    const withTicket = await env.call("classify_assign", { effortKey: env.shelf.key, prUrls: [url(313), url(321)], tickets: ["ABC-350"] });
    expect(withTicket).toMatchObject({ ok: true, added: 2 });
    prs.push({ ...pr(325, "Footer social links"), headRefName: "reader/abc-350-social" });
    expect((await env.harness.runCli(["refresh"])).exitCode).toBe(0);
    expect(await env.grouped()).toEqual({ "Shelf order": [313, 314, 316, 321, 325] });
    // Undo takes back the ticket too, so the later #325 is to sort again.
    await env.call("classify_undo", { actionId: withTicket.actionId });
    expect(await env.grouped()).toEqual({ "Shelf order": [314, 316], "No effort": [313, 321, 325] });
  });

  // #314 is in Shelf order through ABC-341 and also names ABC-350. Another effort owning ABC-350 would give #314 two owners, which leaves it in neither.
  it("refuses a ticket that a PR in another effort carries, and a refused new effort is removed again", async () => {
    const env = await setup(authored.map((entry) => entry.number === 314 ? pr(314, "ABC-341 ABC-350 Group shelves by genre") : entry));
    const pickup = env.efforts.establish({ sourceKey: "ticket:ABC-330", name: "Store pickup", goal: "", projectId: "", coordinatorState: "none",
      members: { tickets: ["ABC-330"], prUrls: [] } });
    const refusal = { ok: false, error: "inkwell/folio #314 carries ABC-350 and is in Shelf order. Leave ABC-350 out." };
    expect(await env.call("classify_assign", { effortKey: pickup.key, prUrls: [url(313), url(321)], tickets: ["ABC-350"] })).toEqual(refusal);
    const count = env.efforts.listAll().length;
    expect(await env.call("classify_new_effort", { name: "Footer refresh", goal: "", prUrls: [url(313), url(321)], tickets: ["ABC-350"],
      requestId: "66666666-6666-4666-8666-666666666666" })).toEqual(refusal);
    expect(env.efforts.listAll().length).toBe(count);
    expect(await env.grouped()).toEqual({ "Shelf order": [314], "No effort": [313, 316, 321] });
    expect(await env.call("classify_assign", { effortKey: pickup.key, prUrls: [url(313), url(321)] })).toMatchObject({ ok: true, added: 2 });
    expect(await env.grouped()).toEqual({ "Shelf order": [314], "Store pickup": [313, 321], "No effort": [316] });
  });

  it("refuses tickets the PRs don't carry, PRs another effort owns, and an effort that is done, and changes nothing", async () => {
    const env = await setup(authored);
    expect(await env.call("classify_assign", { effortKey: env.shelf.key, prUrls: [url(316)], tickets: ["ABC-350"] }))
      .toEqual({ ok: false, error: "These PRs don't carry ABC-350." });
    const pickup = env.efforts.establish({ sourceKey: "ticket:ABC-330", name: "Store pickup", goal: "", projectId: "", coordinatorState: "none",
      members: { tickets: ["ABC-330"], prUrls: [] } });
    expect(await env.call("classify_assign", { effortKey: pickup.key, prUrls: [url(313), url(314)] }))
      .toEqual({ ok: false, error: "inkwell/folio #314 isn't unclassified now. Refresh and try again." });
    createEffortPileStore(env.bb.storage.database()).move(pickup, "complete");
    expect(await env.call("classify_assign", { effortKey: pickup.key, prUrls: [url(313)] })).toEqual({ ok: false, error: "Reopen this effort first." });
    // Automatic dispatch works its effort's PRs unasked, and an archived effort is out of use.
    const vault = env.efforts.establish({ sourceKey: "ticket:ABC-360", name: "Vault audits", goal: "", projectId: "", coordinatorState: "none",
      members: { tickets: ["ABC-360"], prUrls: [] } });
    env.bb.storage.database().prepare("INSERT OR REPLACE INTO dispatch_policy (id, mode, effort_key) VALUES (1, 'auto', ?)").run(vault.key);
    expect(await env.call("classify_assign", { effortKey: vault.key, prUrls: [url(313)] }))
      .toEqual({ ok: false, error: "Turn off automatic dispatch for this effort before adding work." });
    env.efforts.setArchived(vault.id, true);
    expect(await env.call("classify_assign", { effortKey: vault.key, prUrls: [url(313)] })).toEqual({ ok: false, error: "Restore this effort first." });
    expect(await env.grouped()).toEqual({ "Shelf order": [314], "No effort": [313, 316, 321] });
  });

  it("starts a new effort from a selection, and undoing it removes the effort so its name is free again", async () => {
    const env = await setup(authored);
    const requestId = "22222222-2222-4222-8222-222222222222";
    const created = await env.call("classify_new_effort", { name: " Footer  refresh ", goal: "A footer readers can use", prUrls: [url(313), url(321)],
      tickets: ["ABC-350"], requestId });
    expect(created).toMatchObject({ ok: true, added: 2, effort: { name: "Footer refresh" } });
    expect(env.efforts.get(created.effort.id)).toMatchObject({ goal: "A footer readers can use", members: { tickets: ["ABC-350"] } });
    expect(await env.grouped()).toEqual({ "Footer refresh": [313, 321], "Shelf order": [314], "No effort": [316] });
    expect(await env.call("classify_new_effort", { name: "Footer refresh", goal: "", prUrls: [url(316)], requestId }))
      .toEqual({ ok: false, error: "This effort was already created. Refresh the deck." });
    expect(await env.call("classify_undo", { actionId: created.actionId })).toEqual({ ok: true });
    expect(env.efforts.get(created.effort.id)).toBeNull();
    expect(await env.grouped()).toEqual({ "Shelf order": [314], "No effort": [313, 316, 321] });
    expect(await env.call("classify_new_effort", { name: "Footer refresh", goal: "", prUrls: [url(313)], requestId: "33333333-3333-4333-8333-333333333333" }))
      .toMatchObject({ ok: true, effort: { name: "Footer refresh" } });
  });

  // Undo removes a new effort only while nothing has made it real since: a v2 roster of its own keeps it.
  it("keeps a new effort that has moved to its roster when you undo its creation", async () => {
    const env = await setup(authored);
    const created = await env.call("classify_new_effort", { name: "Footer refresh", goal: "", prUrls: [url(316)], requestId: "77777777-7777-4777-8777-777777777777" });
    env.bb.storage.database().prepare("INSERT INTO effort_execution (effort_id, mode, revision, updated_at) VALUES (?, 'v2', 1, 0)").run(created.effort.id);
    expect(await env.call("classify_undo", { actionId: created.actionId })).toEqual({ ok: true });
    expect(env.efforts.get(created.effort.id)).toMatchObject({ name: "Footer refresh", members: { prUrls: [] } });
    expect(await env.grouped()).toMatchObject({ "No effort": [313, 316, 321] });
  });

  it("creates no effort when the name is taken or a PR has an owner", async () => {
    const env = await setup(authored);
    const count = () => env.efforts.listAll().length;
    const before = count();
    expect(await env.call("classify_new_effort", { name: "shelf ORDER", goal: "", prUrls: [url(313)], requestId: "44444444-4444-4444-8444-444444444444" }))
      .toEqual({ ok: false, error: "An effort with that name already exists." });
    expect(await env.call("classify_new_effort", { name: "Shelving", goal: "", prUrls: [url(314)], requestId: "55555555-5555-4555-8555-555555555555" }))
      .toMatchObject({ ok: false });
    expect(count()).toBe(before);
  });
});

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
