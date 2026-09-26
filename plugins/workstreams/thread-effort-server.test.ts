import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, it } from "vitest";
import type { RawUnit } from "./contract.js";
import { parsePrList } from "./gh.js";
import { createEffortStore } from "./effort-store.js";
import { createRunStore } from "./runstore.js";
import plugin, { type Board } from "./server.js";
import { threadEffortMoveScope, type ThreadEffortReady } from "./thread-effort.js";

const a = "https://github.com/inkwell/folio/pull/42";
const b = "https://github.com/inkwell/folio/pull/43";
const makePr = (number: number, ticket: string) => parsePrList(JSON.stringify([{ number, url: number === 42 ? a : b,
  state: "OPEN", title: `${ticket} Improve manuscript review`, headRefName: `${ticket.toLowerCase()}-review` }]))!.pr;
const units: RawUnit[] = [42, 43].map((number) => ({ path: `/p/folio-${number}`, dirName: `folio-${number}`, repo: "folio",
  githubRepo: "inkwell/folio", branch: number === 42 ? "abc-101-review" : "abc-202-review", dirty: false,
  ahead: 0, behind: 0, lastCommitAt: null, defaultBranch: "main", pr: makePr(number, number === 42 ? "ABC-101" : "ABC-202"),
  shipped: null, changedPaths: [], observed: { status: true, pr: true } }));
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });

async function setup(options: { shared?: boolean; ticketless?: boolean; remoteDestination?: boolean } = {}) {
  const metadata = new Map<string, Record<string, unknown>>();
  let localEnabled = true;
  const { bb, harness } = createFakePluginHost({ pluginId: "workstreams", settings: { scanRoots: "/p" }, sdk: {
    system: { config: async () => ({ primaryHostId: "host-inkwell" }) as never },
    projects: { list: async () => [{ id: "proj", name: "Folio", sources: [{ hostId: "host-inkwell", path: "/p" }] }] as never },
    threads: { list: async () => [] as never,
      get: async ({ threadId }: { threadId: string }) => threadId === "thread" ? makeThreadResponse({ id: "thread", projectId: "proj" }) as never : Promise.reject(new Error("missing thread")),
      getPluginMetadata: async ({ threadId }: { threadId: string }) => (metadata.get(threadId) ?? {}) as never,
      updatePluginMetadata: async ({ threadId, set }: { threadId: string; set?: Record<string, unknown> }) => { metadata.set(threadId, { ...metadata.get(threadId), ...set }); return metadata.get(threadId) as never; },
      events: { list: async () => [] }, interactions: { list: async () => [] as never } },
  }, experimental_callHostRpc: ({ method }) => {
    if (method === "scan" || method === "inspectPaths") return { units: localEnabled ? [
      options.shared ? { ...units[0]!, pr: { ...units[0]!.pr!, title: "ABC-101 ABC-202 Improve manuscript review" } } :
        options.ticketless ? { ...units[0]!, path: "/p/plain-checkout", dirName: "plain-checkout", branch: "topic", pr: { ...units[0]!.pr!, title: "Improve manuscript review", headRefName: "topic" } } : units[0]!,
      ...(options.remoteDestination ? [] : [units[1]!]),
    ] : [], warnings: [] };
    if (method === "authoredPrs") {
      const remote = options.remoteDestination ? [44, 45].map((number) => ({ repo: "inkwell/atlas", pr: parsePrList(JSON.stringify([{
        number, url: `https://github.com/inkwell/atlas/pull/${number}`, state: "OPEN", title: `ABC-202 Improve atlas review ${number}`,
        headRefName: `abc-202-${number}` }]))!.pr })) : [];
      return { owners: ["inkwell"], entries: remote, discoveryComplete: true, complete: true,
        repositories: options.remoteDestination ? [{ repo: "inkwell/atlas", complete: true }] : [], warnings: [] };
    }
    throw new Error(`Unexpected host call ${method}`);
  } });
  await plugin(bb); cleanup.push(() => harness.lifecycle.dispose());
  await harness.runCli(["refresh"]);
  const context = async () => await harness.callRpc("thread_effort_context", { threadId: "thread" }) as ThreadEffortReady;
  const board = async () => await harness.callRpc("board_get", null) as Board;
  const db = bb.storage.database();
  return { harness, metadata, context, board, store: createEffortStore(db), db, clearLocal: () => { localEnabled = false; } };
}

it("requires an explicit known PR link, then moves its ticket and PR without spawning a coordinator", async () => {
  const { harness, metadata, context, board } = await setup();
  expect((await context()).sources).toEqual([]);
  expect(await harness.callRpc("thread_effort_link_pr", { threadId: "thread", prUrl: "https://github.com/inkwell/folio/pull/99" })).toMatchObject({ ok: false });
  metadata.set("thread", { role: "worker", effortId: "historical", prUrl: b });
  const linked = await harness.callRpc("thread_effort_link_pr", { threadId: "thread", prUrl: a }) as ThreadEffortReady;
  expect(metadata.get("thread")).toMatchObject({ role: "worker", effortId: "historical", prUrl: b, linkedPrUrl: a });
  expect(linked.sources.map((source) => source.id)).toEqual(["ticket:ABC-101", "ticket:ABC-202"]);
  const destination = linked.efforts.find((effort) => effort.key === linked.sources[1]!.effortKey)!;
  const input = { threadId: "thread", sourceIds: ["ticket:ABC-101"], destinationKey: destination.key,
    expectedScope: threadEffortMoveScope(linked, ["ticket:ABC-101"], destination.key) };
  expect(await harness.callRpc("thread_effort_move", { ...input, sourceIds: ["ticket:FORGED"] })).toMatchObject({ ok: false });
  expect(await harness.callRpc("thread_effort_move", input)).toMatchObject({ ok: true });
  const established = (await board()).efforts;
  expect(established).toHaveLength(1);
  expect(established[0]).toMatchObject({ name: destination.name, coordinatorState: "none", coordinatorThreadId: null,
    members: { tickets: ["ABC-101", "ABC-202"], prUrls: [a, b] } });
  expect(await harness.callRpc("thread_effort_move", input)).toMatchObject({ ok: false, error: expect.stringContaining("changed") });
  expect(harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
});

it("rejects a missing thread before resolving or linking work", async () => {
  const { harness } = await setup();
  expect(await harness.callRpc("thread_effort_context", { threadId: "missing" })).toMatchObject({ ok: false });
  expect(await harness.callRpc("thread_effort_link_pr", { threadId: "missing", prUrl: a })).toMatchObject({ ok: false });
});

it("resolves a prior Workstreams run's PR without reading thread transcripts", async () => {
  const { context, db } = await setup();
  const runs = createRunStore(db);
  const id = runs.begin({ action: "review", path: "/p/folio-42", ticket: "ABC-101", prUrl: a, prNumber: 42,
    mode: "continue", threadId: "thread" });
  runs.settle(id, true, "Review complete");
  expect(runs.openIn("thread")).toEqual([]);
  expect((await context()).sources.map((source) => source.id)).toContain("ticket:ABC-101");
});

it("offers a shared PR's other ticket and refuses to move only one side", async () => {
  const { harness } = await setup({ shared: true });
  const linked = await harness.callRpc("thread_effort_link_pr", { threadId: "thread", prUrl: a }) as ThreadEffortReady;
  expect(linked.sources.map((source) => source.id)).toEqual(["ticket:ABC-101", "ticket:ABC-202"]);
  const target = linked.efforts.find((effort) => effort.key === linked.sources[1]!.effortKey)!;
  expect(await harness.callRpc("thread_effort_move", { threadId: "thread", sourceIds: ["ticket:ABC-101"],
    destinationKey: target.key, expectedScope: threadEffortMoveScope(linked, ["ticket:ABC-101"], target.key) }))
    .toMatchObject({ ok: false, error: expect.stringContaining("both tickets") });
});

it("keeps a ticketless checkout as a standalone PR source", async () => {
  const { harness, board } = await setup({ ticketless: true });
  const linked = await harness.callRpc("thread_effort_link_pr", { threadId: "thread", prUrl: a }) as ThreadEffortReady;
  expect(linked.sources).toMatchObject([{ id: `pr:${a}`, kind: "pr", ticket: null, prUrls: [a] }]);
  const destination = linked.efforts.find((effort) => effort.name.includes("ABC-202"))!;
  expect(destination).toBeDefined();
  expect(await harness.callRpc("thread_effort_move", { threadId: "thread", sourceIds: [`pr:${a}`], destinationKey: destination.key,
    expectedScope: threadEffortMoveScope(linked, [`pr:${a}`], destination.key) })).toMatchObject({ ok: true });
  expect((await board()).efforts[0]?.members).toEqual({ tickets: ["ABC-202"], prUrls: [a, b] });
});

it("offers an explicit project choice when a promoted remote effort has no local checkout", async () => {
  const { harness, board, clearLocal } = await setup({ remoteDestination: true });
  const linked = await harness.callRpc("thread_effort_link_pr", { threadId: "thread", prUrl: a }) as ThreadEffortReady;
  const destination = linked.efforts.find((effort) => effort.key === "ticket:ABC-202")!;
  expect(destination).toBeDefined();
  expect(await harness.callRpc("thread_effort_move", { threadId: "thread", sourceIds: ["ticket:ABC-101"],
    destinationKey: destination.key, expectedScope: threadEffortMoveScope(linked, ["ticket:ABC-101"], destination.key) })).toMatchObject({ ok: true });
  const effort = (await board()).efforts[0]!;
  expect(effort.members.prUrls).toEqual([a, "https://github.com/inkwell/atlas/pull/44", "https://github.com/inkwell/atlas/pull/45"].sort());
  clearLocal();
  await harness.runCli(["refresh"]);
  expect(await harness.callRpc("effort_plan", { groupKey: effort.key })).toMatchObject({ ok: true,
    projects: [{ id: "proj", name: "Folio" }] });
});

it("shows a remote-only ticket's inferred effort before any explicit ownership", async () => {
  const { harness } = await setup({ remoteDestination: true });
  const preview = await harness.callRpc("thread_effort_link_pr", { threadId: "thread", prUrl: "https://github.com/inkwell/atlas/pull/44" }) as ThreadEffortReady;
  expect(preview.sources).toMatchObject([{ id: "ticket:ABC-202", effortKey: "ticket:ABC-202", explicit: false }]);
  expect(preview.sources[0]?.effortName).toBeTruthy();
});

it("pins an unowned PR when its ticket already belongs to the destination", async () => {
  const { harness, context, store } = await setup();
  const ticketOwner = store.establish({ sourceKey: "ticket-owner", name: "Editorial", goal: "", projectId: "", coordinatorState: "none",
    members: { tickets: ["ABC-101"], prUrls: [] } });
  await harness.callRpc("thread_effort_link_pr", { threadId: "thread", prUrl: a });
  const preview = await context();
  expect(preview.sources[0]).toMatchObject({ effortKey: ticketOwner.key, explicit: false });
  expect(await harness.callRpc("thread_effort_move", { threadId: "thread", sourceIds: ["ticket:ABC-101"],
    destinationKey: ticketOwner.key, expectedScope: threadEffortMoveScope(preview, ["ticket:ABC-101"], ticketOwner.key) })).toMatchObject({ ok: true });
  expect(store.owner("prUrl", a)?.id).toBe(ticketOwner.id);
  expect((await context()).sources[0]?.explicit).toBe(true);
});

it("reconciles a ticket owner and a different PR owner into the selected effort", async () => {
  const { harness, context, store } = await setup();
  const ticketOwner = store.establish({ sourceKey: "ticket-owner", name: "Editorial", goal: "", projectId: "", coordinatorState: "none",
    members: { tickets: ["ABC-101"], prUrls: [] } });
  store.establish({ sourceKey: "pr-owner", name: "Review", goal: "", projectId: "", coordinatorState: "none",
    members: { tickets: [], prUrls: [a] } });
  await harness.callRpc("thread_effort_link_pr", { threadId: "thread", prUrl: a });
  const preview = await context();
  expect(preview.sources[0]).toMatchObject({ effortKey: ticketOwner.key, explicit: false });
  expect(await harness.callRpc("thread_effort_move", { threadId: "thread", sourceIds: ["ticket:ABC-101"],
    destinationKey: ticketOwner.key, expectedScope: threadEffortMoveScope(preview, ["ticket:ABC-101"], ticketOwner.key) })).toMatchObject({ ok: true });
  expect(store.owner("prUrl", a)?.id).toBe(ticketOwner.id);
  expect((await context()).sources[0]?.explicit).toBe(true);
});

it("pins an unowned ticket beside its already owned PR", async () => {
  const { harness, context, store } = await setup();
  const prOwner = store.establish({ sourceKey: "pr-owner", name: "Review", goal: "", projectId: "", coordinatorState: "none",
    members: { tickets: [], prUrls: [a] } });
  await harness.callRpc("thread_effort_link_pr", { threadId: "thread", prUrl: a });
  const preview = await context();
  expect(preview.sources[0]).toMatchObject({ effortKey: prOwner.key, explicit: false });
  expect(await harness.callRpc("thread_effort_move", { threadId: "thread", sourceIds: ["ticket:ABC-101"],
    destinationKey: prOwner.key, expectedScope: threadEffortMoveScope(preview, ["ticket:ABC-101"], prOwner.key) })).toMatchObject({ ok: true });
  expect(store.owner("ticket", "ABC-101")?.id).toBe(prOwner.id);
  expect((await context()).sources[0]?.explicit).toBe(true);
});

it("refuses a mixed-owner move while either exact owner has automatic dispatch enabled", async () => {
  const { harness, context, store } = await setup();
  const ticketOwner = store.establish({ sourceKey: "ticket-owner", name: "Editorial", goal: "", projectId: "", coordinatorState: "none",
    members: { tickets: ["ABC-101"], prUrls: [] } });
  const prOwner = store.establish({ sourceKey: "pr-owner", name: "Review", goal: "", projectId: "", coordinatorState: "none",
    members: { tickets: [], prUrls: [a] } });
  await harness.callRpc("thread_effort_link_pr", { threadId: "thread", prUrl: a });
  const preview = await context();
  await harness.callRpc("dispatch_set", { mode: "auto", effortKey: prOwner.key });
  expect(await harness.callRpc("thread_effort_move", { threadId: "thread", sourceIds: ["ticket:ABC-101"],
    destinationKey: ticketOwner.key, expectedScope: threadEffortMoveScope(preview, ["ticket:ABC-101"], ticketOwner.key) }))
    .toMatchObject({ ok: false, error: expect.stringContaining("automatic dispatch") });
  expect(store.owner("prUrl", a)?.id).toBe(prOwner.id);
});
