import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { Pr, RawUnit } from "./contract.js";
import { createEffortStore } from "./effort-store.js";
import { parsePrList } from "./gh.js";
import { createPrHoldStore } from "./pr-hold-store.js";
import plugin, { type Board } from "./server.js";

const url = (number: number) => `https://github.com/inkwell/folio/pull/${number}`;
const pr = (number: number, title: string, extra: Record<string, unknown> = {}): Pr => parsePrList(JSON.stringify([{ number, url: url(number),
  state: "OPEN", title, isDraft: false, reviewDecision: "REVIEW_REQUIRED", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", latestReviews: [],
  reviewRequests: [], statusCheckRollup: [{ conclusion: "SUCCESS" }], createdAt: "2026-09-21T15:00:00Z", ...extra }]))!.pr;
const UNIT: RawUnit = { path: "/p/folio", dirName: "folio", repo: "folio", githubRepo: "inkwell/folio", branch: "main", dirty: false,
  ahead: 0, behind: 0, lastCommitAt: null, defaultBranch: "main", pr: null, shipped: null, changedPaths: [], observed: { status: true, pr: true } };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function setup(prs: Pr[]) {
  const { bb, harness } = createFakePluginHost({ pluginId: "workstreams", settings: { scanRoots: "/p" }, sdk: {
    system: { config: async () => ({ primaryHostId: "host-inkwell" }) as never },
    projects: { list: async () => [{ id: "project-folio", name: "Folio", sources: [{ hostId: "host-inkwell", path: "/p" }] }] as never },
    threads: { list: async () => [] as never, getPluginMetadata: async () => ({}) as never, events: { list: async () => [] } },
  }, experimental_callHostRpc: async ({ method }) => {
    if (method === "scan") return { units: [UNIT], warnings: [] };
    if (method === "authoredPrs") return { owners: ["inkwell"], entries: prs.map((entry) => ({ repo: "inkwell/folio", pr: entry })),
      discoveryComplete: true, repositories: [{ repo: "inkwell/folio", complete: true }], complete: true, warnings: [] };
    throw new Error(`Unexpected host method ${method}`);
  } });
  await plugin(bb);
  cleanups.push(() => harness.lifecycle.dispose());
  expect((await harness.runCli(["refresh"])).exitCode).toBe(0);
  const attention = async () => new Map(((await harness.callRpc("board_get", null)) as Board).prInventory.entries
    .map((entry) => [entry.pr.number, entry.attention]));
  return { db: bb.storage.database(), attention };
}

describe("PR attention on the board", () => {
  it("answers each authored PR's questions under the effort that owns it, and keeps held PRs quiet", async () => {
    const env = await setup([
      pr(313, "ABC-340 Keep shelf order on reload", { isDraft: true }),
      pr(314, "ABC-341 Group shelves by genre"),
      pr(315, "ABC-342 Sort shelves by author"),
    ]);
    // Owned through its ticket, not a PR link, exactly as the roster reads ownership.
    const effort = createEffortStore(env.db).establish({ sourceKey: "ticket:ABC-340", name: "Shelf order", goal: "Keep shelves in order",
      projectId: "project-folio", coordinatorState: "none", members: { tickets: ["ABC-340"], prUrls: [] } });
    createPrHoldStore(env.db).set(url(315), true, "Waiting on the store layout review");
    const attention = await env.attention();
    expect(attention.get(313)).toMatchObject({ effort: { id: effort.id, name: "Shelf order" }, held: false,
      reasons: [{ kind: "draft-ready", action: "mark-ready", owner: "you" }] });
    expect(attention.get(314)).toMatchObject({ effort: null, held: false,
      reasons: [{ kind: "missing-reviewer", action: "request-review", owner: "you", since: Date.parse("2026-09-21T15:00:00Z") }] });
    expect(attention.get(315)).toEqual({ effort: null, held: true, reasons: [] });
  });
});
