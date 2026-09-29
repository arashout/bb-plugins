import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { Pr } from "./contract.js";
import { ONE_OFFS_SOURCE } from "./effort-assignments.js";
import { createEffortStore } from "./effort-store.js";
import { parsePrList } from "./gh.js";
import type { InventoryView } from "./inventory-view.js";
import plugin from "./server.js";

const HOST = "host-inkwell";
const url = (number: number) => `https://github.com/inkwell/folio/pull/${number}`;
const pr = (number: number, title: string): Pr => parsePrList(JSON.stringify([{ number, url: url(number), state: "OPEN", title, isDraft: false,
  reviewDecision: "REVIEW_REQUIRED", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefName: `branch-${number}`, baseRefName: "main",
  headRefOid: "a".repeat(40), latestReviews: [], reviewRequests: [], statusCheckRollup: [{ conclusion: "SUCCESS" }], createdAt: "2026-09-21T15:00:00Z" }]))!.pr;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

/** You author #313 and #316, which no effort owns, and #314, which Shelf order owns through ABC-341. */
async function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId: "workstreams", settings: { scanRoots: "/p" }, sdk: {
    system: { config: async () => ({ primaryHostId: HOST }) as never },
    projects: { list: async () => [{ id: "project-folio", name: "Folio", sources: [{ hostId: HOST, path: "/p" }] }] as never },
    threads: { list: async () => [] as never, getPluginMetadata: async () => ({}) as never, events: { list: async () => [] } },
  }, experimental_callHostRpc: async ({ method }) => {
    if (method === "scan" || method === "inspectPaths") return { units: [], warnings: [] };
    if (method === "authoredPrs") return { owners: ["inkwell"], entries: [pr(313, "Update the footer year"), pr(314, "ABC-341 Group shelves by genre"),
      pr(316, "Remove an unused import")].map((entry) => ({ repo: "inkwell/folio", pr: entry })), discoveryComplete: true,
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
  return { efforts, shelf, call, grouped };
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
});
