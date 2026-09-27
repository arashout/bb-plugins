import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, it } from "vitest";
import { parsePrList } from "./gh.js";
import type { RawUnit } from "./contract.js";
import { createEffortStore } from "./effort-store.js";
import plugin, { type Board } from "./server.js";
import { cardEffortMoveScope, type CardEffortReady } from "./card-effort.js";

const path = "/p/folio-draft";
const prUrl = "https://github.com/inkwell/folio/pull/42";
const destinationUrl = "https://github.com/inkwell/folio/pull/43";
const pr = (number: number, ticket: string | null) => parsePrList(JSON.stringify([{ number,
  url: number === 42 ? prUrl : destinationUrl, state: "OPEN",
  title: `${ticket ? `${ticket} ` : ""}Improve manuscript review`, headRefName: ticket?.toLowerCase() ?? "manuscript-review" }]))!.pr;
const remotePr = (number: number, ticket: string) => parsePrList(JSON.stringify([{ number,
  url: `https://github.com/inkwell/atlas/pull/${number}`, state: "OPEN",
  title: `${ticket} Improve atlas review ${number}`, headRefName: ticket.toLowerCase() }]))!.pr;
const base: RawUnit = { path, dirName: "folio-draft", repo: "folio", githubRepo: "inkwell/folio", branch: "manuscript-review",
  dirty: false, ahead: 0, behind: 0, lastCommitAt: null, defaultBranch: "main", pr: null,
  shipped: null, changedPaths: ["src/review.ts"], observed: { status: true, pr: true } };
const destination: RawUnit = { ...base, path: "/p/folio-43", dirName: "folio-43", branch: "abc-202-review", pr: pr(43, "ABC-202") };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const stop of cleanup.splice(0)) await stop(); });

async function setup() {
  let draft: RawUnit = base;
  let remote: ReturnType<typeof pr>[] = [];
  let contextWorkspaces = 0;
  const spawned: { id: string; args: Record<string, any> }[] = [];
  const { bb, harness } = createFakePluginHost({ pluginId: "workstreams", settings: { scanRoots: "/p" }, sdk: {
    system: { config: async () => ({ primaryHostId: "host-inkwell" }) as never },
    projects: { list: async () => [{ id: "project", name: "Folio", sources: [{ hostId: "host-inkwell", path: "/p" }] }] as never },
    threads: { list: async () => spawned.map(({ id, args }) => makeThreadResponse({ id, title: args.title ?? null,
      projectId: "project", parentThreadId: args.parentThreadId ?? null,
      environment: { hostId: args.environment.hostId } } as never) as never) as never,
      get: async ({ threadId }: { threadId: string }) => {
        const found = spawned.find(({ id }) => id === threadId);
        if (!found) throw new Error("missing thread");
        return { ...makeThreadResponse({ id: threadId, title: found.args.title ?? null, projectId: "project",
          parentThreadId: found.args.parentThreadId ?? null, environment: { hostId: found.args.environment.hostId } } as never), canSpawnChild: true } as never;
      },
      spawn: async (args: Record<string, any>) => {
        const id = `thread-${spawned.length + 1}`;
        spawned.push({ id, args });
        return { ...makeThreadResponse({ id, title: args.title ?? null, projectId: "project",
          parentThreadId: args.parentThreadId ?? null }), canSpawnChild: true,
          environment: { hostId: args.environment.hostId } } as never;
      },
      getPluginMetadata: async () => ({}), updatePluginMetadata: async () => ({}),
      events: { list: async () => [] }, interactions: { list: async () => [] as never } },
  }, experimental_callHostRpc: ({ method }) => {
    if (method === "contextWorkspace") return { path: `/synthetic/workstreams/context/${++contextWorkspaces}` };
    if (method === "scan" || method === "inspectPaths") return { units: [draft, destination], warnings: [] };
    if (method === "authoredPrs") return { owners: ["inkwell"], entries: remote.map((item) => ({ repo: "inkwell/folio", pr: item })),
      discoveryComplete: true, complete: true, repositories: [{ repo: "inkwell/folio", complete: true }], warnings: [] };
    throw new Error(`Unexpected host call ${method}`);
  } });
  await plugin(bb); cleanup.push(() => harness.lifecycle.dispose());
  await harness.runCli(["refresh"]);
  const board = async () => await harness.callRpc("board_get", null) as Board;
  const context = async (target: { path: string } | { prUrl: string }) => await harness.callRpc("card_effort_context", target) as CardEffortReady;
  const move = async (target: { path: string } | { prUrl: string }, destinationKey: string, preview: CardEffortReady) =>
    await harness.callRpc("card_effort_move", { target, destinationKey, expectedScope: cardEffortMoveScope(preview, destinationKey) });
  return { harness, board, context, move, spawned, store: createEffortStore(bb.storage.database()), db: bb.storage.database(),
    setDraft: (next: RawUnit) => { draft = next; }, setRemote: (next: ReturnType<typeof pr>[]) => { remote = next; },
    refresh: async () => { await harness.runCli(["refresh"]); } };
}

it("moves a pre-PR checkout into an effort and projects its owner when the PR appears", async () => {
  const env = await setup();
  const target = { path };
  const before = await env.context(target);
  expect(before).toMatchObject({ ok: true, source: { kind: "checkout", explicit: false },
    affected: { tickets: [], prUrls: [], checkoutPaths: [path] } });
  const destinationEffort = before.efforts.find((item) => item.key !== before.source.effortKey)!;
  expect(await env.move(target, destinationEffort.key, before)).toMatchObject({ ok: true });
  expect(env.store.owner("checkoutPath", path)?.name).toBe(destinationEffort.name);
  expect((await env.board()).groups.find((group) => group.key === env.store.owner("checkoutPath", path)?.key)?.clusters
    .some((cluster) => cluster.units.some((unit) => unit.path === path))).toBe(true);

  env.setDraft({ ...base, pr: pr(42, null) });
  env.setRemote([pr(42, null)]);
  await env.refresh();
  expect((await env.board()).prInventory.entries.find((entry) => entry.pr.number === 42)?.effortKey)
    .toBe(env.store.owner("checkoutPath", path)?.key);
  const discovered = await env.context({ prUrl });
  expect(discovered.source.effortKey).toBe(env.store.owner("checkoutPath", path)?.key);
  expect(discovered.source.explicit).toBe(false);
  expect(await env.move({ prUrl }, env.store.owner("checkoutPath", path)!.key, discovered)).toMatchObject({ ok: true });
  expect(env.store.owner("prUrl", prUrl)?.key).toBe(env.store.owner("checkoutPath", path)?.key);
});

it("rejects a stale branch and unknown card without writing membership", async () => {
  const env = await setup();
  const target = { path };
  const preview = await env.context(target);
  const destinationEffort = preview.efforts.find((item) => item.key !== preview.source.effortKey)!;
  expect(await env.harness.callRpc("card_effort_context", { path: "/p/unknown" })).toMatchObject({ ok: false });
  expect(await env.harness.callRpc("card_effort_context", { prUrl: "https://github.com/inkwell/folio/pull/999" })).toMatchObject({ ok: false });
  env.setDraft({ ...base, branch: "a-new-branch" });
  await env.refresh();
  expect(await env.move(target, destinationEffort.key, preview)).toMatchObject({ ok: false, error: expect.stringContaining("changed") });
  expect(env.store.owner("checkoutPath", path)).toBeNull();
});

it("keeps explicit PR ownership ahead of a checkout owner and previews both owners", async () => {
  const env = await setup();
  const before = await env.context({ path });
  const destinationEffort = before.efforts.find((item) => item.key !== before.source.effortKey)!;
  await env.move({ path }, destinationEffort.key, before);
  const other = env.store.establish({ sourceKey: "other", name: "Other review", goal: "", projectId: "project",
    coordinatorState: "none", members: { tickets: [], prUrls: [prUrl] } });
  env.setDraft({ ...base, pr: pr(42, null) });
  env.setRemote([pr(42, null)]);
  await env.refresh();
  const preview = await env.context({ prUrl });
  expect(preview.source.effortKey).toBe(other.key);
  expect(preview.source.explicit).toBe(false);
  expect((await env.board()).prInventory.entries.find((entry) => entry.pr.number === 42)?.effortKey).toBe(other.key);
  expect(env.store.owner("checkoutPath", path)?.key).not.toBe(other.key);
});

it("moves the whole ticket cohort from remote-only PR inventory and rejects a stale ownership preview", async () => {
  const env = await setup();
  const one = remotePr(44, "ABC-303");
  const two = remotePr(45, "ABC-303");
  env.setRemote([one, two]);
  await env.refresh();
  const target = { prUrl: `${one.url}/?tab=files` };
  const preview = await env.context(target);
  expect(preview).toMatchObject({ ok: true, affected: { tickets: ["ABC-303"], prUrls: [one.url, two.url], checkoutPaths: [] } });
  expect(preview.prTitles[one.url]).toContain("Improve atlas review");
  const destinationEffort = preview.efforts.find((item) => item.key !== preview.source.effortKey)!;
  expect(await env.harness.callRpc("card_effort_move", { target, destinationKey: "unknown", expectedScope: "stale" }))
    .toMatchObject({ ok: false });
  expect(env.store.owner("prUrl", one.url)).toBeNull();
  expect(await env.move(target, destinationEffort.key, preview)).toMatchObject({ ok: true });
  expect(env.store.owner("ticket", "ABC-303")?.members.prUrls).toEqual([destinationUrl, one.url, two.url].sort());
  expect(await env.move(target, destinationEffort.key, preview)).toMatchObject({ ok: false, error: expect.stringContaining("changed") });
});

it("blocks a move during automatic dispatch without changing the checkout owner", async () => {
  const env = await setup();
  const target = { path };
  const preview = await env.context(target);
  const destinationEffort = preview.efforts.find((item) => item.key !== preview.source.effortKey)!;
  env.db.prepare(`INSERT OR REPLACE INTO dispatch_policy (id, mode, effort_key) VALUES (1, 'auto', ?)`).run(destinationEffort.key);
  expect(await env.move(target, destinationEffort.key, preview)).toMatchObject({ ok: false, error: expect.stringContaining("automatic dispatch") });
  expect(env.store.owner("checkoutPath", path)).toBeNull();
});

it("starts a pre-PR checkout thread beneath its effort repository controller", async () => {
  const env = await setup();
  const preview = await env.context({ path });
  const destinationEffort = preview.efforts.find((item) => item.key !== preview.source.effortKey)!;
  expect(await env.move({ path }, destinationEffort.key, preview)).toMatchObject({ ok: true });
  expect(env.spawned).toEqual([]);
  expect(await env.harness.callRpc("thread_start", { path, prompt: "Review the manuscript changes." })).toMatchObject({ ok: true });
  expect(env.spawned).toHaveLength(3);
  expect(env.spawned[0]?.args.environment).toMatchObject({ type: "host", hostId: "host-inkwell",
    workspace: { type: "unmanaged", path: "/synthetic/workstreams/context/1" } });
  expect(env.spawned[1]?.args.parentThreadId).toBe(env.spawned[0]?.id);
  expect(env.spawned[1]?.args.environment).toMatchObject({ type: "host", hostId: "host-inkwell",
    workspace: { type: "unmanaged", path: "/synthetic/workstreams/context/2" } });
  expect(env.spawned[2]?.args.parentThreadId).toBe(env.spawned[1]?.id);
  expect(env.spawned[2]?.args.environment).toMatchObject({ workspace: { path } });
  expect(env.spawned[2]?.args.pluginMetadata).toMatchObject({ role: "checkout", effortId: env.store.owner("checkoutPath", path)?.id });
});
