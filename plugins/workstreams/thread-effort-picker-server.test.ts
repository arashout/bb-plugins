import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { Pr } from "./contract.js";
import { createEffortPileStore } from "./effort-piles.js";
import { createEffortStore } from "./effort-store.js";
import { parsePrList } from "./gh.js";
import plugin from "./server.js";
import { threadEffortAssignmentScope, type ThreadEffortPicker, type ThreadEffortReady } from "./thread-effort.js";

const HOST = "host-inkwell";
const url = (number: number) => `https://github.com/inkwell/folio/pull/${number}`;
const pr = (number: number, title: string, headRefName = `reader/change${number}`): Pr => parsePrList(JSON.stringify([{ number, url: url(number), state: "OPEN", title,
  isDraft: false, reviewDecision: "REVIEW_REQUIRED", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefName, baseRefName: "main", headRefOid: "a".repeat(40),
  latestReviews: [], reviewRequests: [], statusCheckRollup: [{ conclusion: "SUCCESS" }], createdAt: "2026-09-21T15:00:00Z" }]))!.pr;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

/**
 * You author #313, #314, #316, #317, and #318. Shelf order has #314 through ABC-341; the done Quill export has #318; Gift cards is on hold
 * and Store pickup is empty. "Direct work" links #313 and #314 through its own metadata. "Checkout work" links #314 and runs in #316's
 * checkout, so its effort takes #316 in. "Branch work" runs elsewhere on #316's branch name, which says nothing about #316. "Footer
 * year" links only #317; "Fix ABC-341 shelf gaps" links nothing; "Pickup follow-up" is a child of a thread whose effort is Store pickup.
 */
async function setup() {
  const thread = (id: string, title: string, extra: Record<string, unknown> = {}) => ({ ...makeThreadResponse({ id, title, projectId: "project-folio",
    originPluginId: "workstreams", ...extra }), environmentPath: null, environmentBranchName: null, queuedWork: "none", hasPendingInteraction: false,
    activity: { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activeGoalCount: 0, activePlanModeCount: 0, activeWorkflowCount: 0 }, ...extra });
  const threads = [thread("thr-direct", "Direct work"),
    thread("thr-checkout", "Checkout work", { environmentPath: "/p/folio-316", environmentBranchName: "abc-316-sort", environment: { path: "/p/folio-316" } }),
    thread("thr-branch", "Branch work", { environmentPath: "/p/elsewhere", environmentBranchName: "abc-316-sort", environment: { path: "/p/elsewhere" } }),
    thread("thr-service", "Footer year"), thread("thr-title", "Fix ABC-341 shelf gaps"), thread("thr-parent", "Pickup"),
    thread("thr-child", "Pickup follow-up", { parentThreadId: "thr-parent" })];
  const metadata: Record<string, Record<string, unknown>> = { "thr-direct": { linkedPrUrl: url(313), prUrl: url(314) }, "thr-checkout": { linkedPrUrl: url(314) },
    "thr-service": { linkedPrUrl: url(317) } };
  const authored = [pr(313, "Update the footer year"), pr(314, "ABC-341 Group shelves by genre"), pr(316, "Sort shelves by author", "abc-316-sort"),
    pr(317, "Remove an unused import"), pr(318, "ABC-900 Export notes as EPUB")];
  const { bb, harness } = createFakePluginHost({ pluginId: "workstreams", settings: { scanRoots: "/p" }, sdk: {
    system: { config: async () => ({ primaryHostId: HOST }) as never },
    projects: { list: async () => [{ id: "project-folio", name: "Folio", sources: [{ hostId: HOST, path: "/p" }] }] as never },
    threads: {
      list: async () => threads as never,
      get: async ({ threadId }: { threadId: string }) => threads.find((item) => item.id === threadId) ?? Promise.reject(new Error("missing thread")),
      getPluginMetadata: async ({ threadId }: { threadId: string }) => (metadata[threadId] ?? {}) as never, events: { list: async () => [] },
      updatePluginMetadata: async ({ threadId, set }: { threadId: string; set?: Record<string, unknown> }) => {
        metadata[threadId] = { ...metadata[threadId], ...set }; return metadata[threadId] as never;
      },
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
  const db = bb.storage.database();
  const efforts = createEffortStore(db);
  const piles = createEffortPileStore(db);
  const establish = (sourceKey: string, name: string, members: { tickets: string[]; prUrls: string[] }) =>
    efforts.establish({ sourceKey, name, goal: "", projectId: "project-folio", coordinatorState: "none", members });
  const shelf = establish("ticket:ABC-341", "Shelf order", { tickets: ["ABC-341"], prUrls: [] });
  piles.move(establish("pr:318", "Quill export", { tickets: [], prUrls: [url(318)] }), "complete");
  const gifts = establish("gifts", "Gift cards", { tickets: [], prUrls: [] });
  piles.move(gifts, "hold", "Waiting on the card vendor");
  const pickup = establish("pickup", "Store pickup", { tickets: [], prUrls: [] });
  metadata["thr-parent"] = { workEffortId: pickup.id };
  expect((await harness.runCli(["refresh"])).exitCode).toBe(0);
  const context = async (threadId: string) => await harness.callRpc("thread_effort_context", { threadId, seen: {} }) as ThreadEffortReady;
  const picker = async (threadId: string) => (await context(threadId)).picker!;
  return { harness, metadata, efforts, shelf, gifts, pickup, context, picker };
}
const signals = (picker: ThreadEffortPicker) => picker.choices.map((choice) => [choice.name, choice.signal]);

describe("the thread effort chip and popover's read", () => {
  it("names the effort the thread's own linked PRs are in, with its card's Needs you, and lists only efforts the deck draws", async () => {
    const env = await setup();
    const direct = await env.picker("thr-direct");
    expect(direct.chip).toEqual({ kind: "effort", effortId: env.shelf.id, name: "Shelf order", oneOff: false, needsYou: 1, card: env.shelf.id });
    expect(direct.linked.map((item) => [item.ref, item.effortName, item.sourceIds])).toEqual([
      ["folio #313", null, [`pr:${url(313)}`]], ["folio #314", "Shelf order", ["ticket:ABC-341"]]]);
    // The done Quill export takes no work, so it isn't offered; held Gift cards is, marked held.
    expect(direct.choices.map((choice) => [choice.name, choice.held])).toEqual([["Gift cards", true], ["Shelf order", false], ["Store pickup", false]]);
    // Shelf order holds #314, and the classifier also points #313 at it through this thread.
    expect(direct.choices.find((choice) => choice.name === "Shelf order")).toMatchObject({ signal: "has folio #314", score: 5 });
    // Each choice's key is one the thread can be set to.
    const context = await env.context("thr-direct");
    expect(direct.choices.every((choice) => context.efforts.some((effort) => effort.key === choice.key))).toBe(true);
  });

  it("lists the PR in the thread's own checkout, which a pick takes in, and none it reaches only by branch name, which a pick leaves", async () => {
    const env = await setup();
    const checkout = await env.picker("thr-checkout");
    expect(checkout.linked.map((item) => item.ref)).toEqual(["folio #314", "folio #316"]);
    expect(checkout.chip.name).toBe("Shelf order");
    expect((await env.picker("thr-branch")).linked).toEqual([]);
    // A pick takes in what the popover listed, and nothing it didn't.
    const pick = async (threadId: string) => {
      const context = await env.context(threadId);
      const key = context.picker!.choices.find((choice) => choice.name === "Store pickup")!.key;
      expect(await env.harness.callRpc("thread_effort_set", { threadId, destinationKey: key, expectedScope: threadEffortAssignmentScope(context, key) }))
        .toMatchObject({ ok: true });
    };
    await pick("thr-branch");
    expect(env.efforts.owner("prUrl", url(316))).toBeNull();
    await pick("thr-checkout");
    expect(env.efforts.owner("prUrl", url(316))?.id).toBe(env.pickup.id);
  });

  it("falls back to the repository's service card, and opens it with its Needs you: #313, #316, and #317, which no effort has, each want a reviewer", async () => {
    const env = await setup();
    expect((await env.picker("thr-service")).chip).toEqual({ kind: "service", effortId: null, name: "folio · service", oneOff: false, needsYou: 3,
      card: "service:inkwell/folio" });
  });

  it("suggests from a ticket in the title and from the parent thread's effort, and says No effort with nothing linked", async () => {
    const env = await setup();
    const titled = await env.picker("thr-title");
    expect(titled.chip).toMatchObject({ kind: "none", name: "No effort", card: null });
    expect(signals(titled)).toEqual([["Gift cards", null], ["Shelf order", "ABC-341 in the title"], ["Store pickup", null]]);
    expect(signals(await env.picker("thr-child"))).toEqual([["Gift cards", null], ["Shelf order", null], ["Store pickup", "parent thread's effort"]]);
  });

  it("names the thread's own effort first, and offers Jev only with a TypeSafe key", async () => {
    const env = await setup();
    env.metadata["thr-direct"] = { ...env.metadata["thr-direct"], workEffortId: env.pickup.id };
    const own = await env.picker("thr-direct");
    expect(own.chip).toMatchObject({ kind: "effort", name: "Store pickup", needsYou: 0, card: env.pickup.id });
    expect(own.jev).toBe(false);
    await env.harness.behavior.setSettings({ typesafeApiKey: "synthetic-test-value" });
    expect((await env.picker("thr-direct")).jev).toBe(true);
  });
});
