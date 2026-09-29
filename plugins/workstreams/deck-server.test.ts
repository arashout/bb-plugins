import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pr, RawUnit } from "./contract.js";
import type { DeckView } from "./deck.js";
import { createEffortStore } from "./effort-store.js";
import { parsePrList } from "./gh.js";
import plugin from "./server.js";

const HOST = "host-inkwell";
const HEAD = "a".repeat(40);
const url = (number: number) => `https://github.com/inkwell/folio/pull/${number}`;
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const pr = (number: number, title: string, extra: Record<string, unknown> = {}): Pr => parsePrList(JSON.stringify([{ number, url: url(number), state: "OPEN", title,
  isDraft: false, reviewDecision: "REVIEW_REQUIRED", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefName: `branch-${number}`, baseRefName: "main",
  headRefOid: HEAD, latestReviews: [], reviewRequests: [], statusCheckRollup: [{ conclusion: "SUCCESS" }], createdAt: daysAgo(4), ...extra }]))!.pr;
const UNIT: RawUnit = { path: "/p/folio", dirName: "folio", repo: "folio", githubRepo: "inkwell/folio", branch: "main", dirty: false, ahead: 0, behind: 0,
  lastCommitAt: null, defaultBranch: "main", pr: null, shipped: null, changedPaths: [], observed: { status: true, pr: true } };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

/** Shelf order owns ABC-500 and folio #401, a green draft; #402 carries ABC-500; #402 and #403 have no reviewer, and #403 has no effort. */
async function setup() {
  const current = new Map<number, Pr>([
    [401, pr(401, "ABC-501 Store shelf order", { isDraft: true })],
    [402, pr(402, "ABC-500 Read shelf order back")],
    [403, pr(403, "ABC-610 Fix the footer year")],
  ]);
  const { bb, harness } = createFakePluginHost({ pluginId: "workstreams", settings: { scanRoots: "/p" }, sdk: {
    system: { config: async () => ({ primaryHostId: HOST }) as never },
    projects: { list: async () => [{ id: "project-folio", name: "Folio", sources: [{ hostId: HOST, path: "/p" }] }] as never },
    threads: { list: async () => [] as never, getPluginMetadata: async () => ({}) as never, events: { list: async () => [] },
      spawn: async () => { throw new Error("The deck starts no thread."); } },
  }, experimental_callHostRpc: async ({ method, input }) => {
    if (method === "scan" || method === "inspectPaths") return { units: [UNIT], warnings: [] };
    if (method === "authoredPrs") return { owners: ["inkwell"], entries: [...current.values()].filter((entry) => entry.state === "OPEN")
      .map((entry) => ({ repo: "inkwell/folio", pr: entry })), discoveryComplete: true, repositories: [{ repo: "inkwell/folio", complete: true }], complete: true, warnings: [] };
    if (method === "inspectPrs") {
      const read = (input as { prUrls: string[] }).prUrls.map((prUrl) => current.get(Number(prUrl.split("/").pop()))!);
      const open = read.filter((entry) => entry.state === "OPEN"), merged = read.filter((entry) => entry.state === "MERGED");
      return { entries: open.map((entry) => ({ repo: "inkwell/folio", pr: entry })), closed: merged.map((entry) => entry.url), failed: [], warnings: [],
        merged: merged.map((entry) => ({ url: entry.url, at: entry.mergedAt!, title: entry.title, headRefName: entry.headRefName })) };
    }
    if (method === "advanceInspect") return { ok: false, error: "Not read in this test." };
    throw new Error(`Unexpected host method ${method}`);
  } });
  await plugin(bb);
  cleanups.push(() => harness.lifecycle.dispose());
  const effort = createEffortStore(bb.storage.database()).establish({ sourceKey: "ticket:ABC-500", name: "Shelf order", goal: "Keep shelves in order",
    projectId: "project-folio", coordinatorState: "none", members: { tickets: ["ABC-500"], prUrls: [url(401)] } });
  expect((await harness.runCli(["refresh"])).exitCode).toBe(0);
  const deck = async () => await harness.callRpc("deck_get", {}) as DeckView;
  const signals = () => harness.inspection.realtimeSignals.filter((signal) => signal.channel === "deck-changed").length;
  return { harness, current, effort, deck, signals, rpc: (method: string, value: unknown) => harness.callRpc(method as never, value as never) };
}

describe("the effort deck on the server", () => {
  it("draws each effort's card from the inventory's rows by the move each needs, and leaves the PRs no effort owns to sort", async () => {
    const env = await setup();
    const view = await env.deck();
    expect(view.active.map((card) => ({ name: card.name, needsYou: card.needsYou,
      sections: card.sections.map((section) => [section.key, section.rows.map((row) => row.number)]) }))).toEqual([
      { name: "Shelf order", needsYou: 2, sections: [["request", [402]], ["ready", [401]]] }]);
    // #403 has a move of yours too, but a PR no effort owns is to sort before it counts.
    expect(view.unclassified.rows.map((row) => [row.number, row.section])).toEqual([[403, "request"]]);
    expect(view.counts).toEqual({ needsYou: 2, toSort: 1, held: 0, done: 0 });
  });

  it("counts a merge a read saw on the card of the effort whose ticket it carries, after the PR leaves the inventory", async () => {
    const env = await setup();
    env.current.set(402, { ...env.current.get(402)!, state: "MERGED", mergedAt: daysAgo(1) });
    expect(await env.rpc("pr_refresh", { prUrl: url(402) })).toMatchObject({ status: "checked" });
    const card = (await env.deck()).active[0]!;
    expect(card).toMatchObject({ name: "Shelf order", stats: { open: 1, mergedWeek: 1 }, progress: { merged: 1, open: 1 } });
    expect(card.activity.filter((item) => item.kind === "merged")).toEqual([{ kind: "merged", prUrl: url(402), ref: "folio #402", who: null,
      at: Date.parse(env.current.get(402)!.mergedAt!) }]);
  });

  it("tells the deck when an inventory read lands and when an effort moves piles, and files a held effort's card on hold", async () => {
    const env = await setup();
    const before = env.signals();
    expect(await env.rpc("inventory_refresh", null)).toEqual({ started: true });
    await vi.waitFor(() => expect(env.signals()).toBeGreaterThan(before));
    const moved = env.signals();
    expect(await env.rpc("effort_hold", { effortKey: env.effort.id, reason: "Design review" })).toMatchObject({ ok: true });
    expect(env.signals()).toBeGreaterThan(moved);
    expect(await env.deck()).toMatchObject({ active: [], held: [{ name: "Shelf order", needsYou: 0, status: { text: "On hold: Design review" } }],
      counts: { needsYou: 0, held: 1 } });
  });

  it("keeps an archived effort's open PRs on the deck with the done efforts, and tells the deck it was archived", async () => {
    const env = await setup();
    const { scopes } = await env.rpc("effort_admin_list", null) as { scopes: Record<string, string> };
    const before = env.signals();
    expect(await env.rpc("effort_admin_archive", { effortKey: env.effort.key, archived: true, expectedScope: scopes[env.effort.key] })).toMatchObject({ ok: true });
    expect(env.signals()).toBeGreaterThan(before);
    // #401 and #402 pause, as a done effort's PRs do, and #403 is still the one to sort.
    expect(await env.deck()).toMatchObject({ active: [], done: [{ name: "Shelf order", archived: true, open: 2 }],
      counts: { needsYou: 0, toSort: 1, held: 0, done: 1 } });
  });
});
