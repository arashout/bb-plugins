// Card messages use synthetic work and fake BB threads; no agent runs in these tests.
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, it, vi } from "vitest";
import type { RawUnit } from "./contract.js";
import { createEffortStore } from "./effort-store.js";
import { parsePrList } from "./gh.js";
import plugin, { type Board } from "./server.js";

const PATH = "/p/inkwell-draft";
const REPO = "inkwell/folio";
const URL = "https://github.com/inkwell/folio/pull/42";
const HOST = "host-inkwell";
const PROJECT = "proj-inkwell";
const linearUrl = "https://linear.app/inkwell/issue/INK-42/review-manuscript";
const pr = (state: "OPEN" | "MERGED" = "OPEN") => parsePrList(JSON.stringify([{ number: 42, url: URL, state,
  title: "INK-42 Improve manuscript review", headRefName: "ink-42-review", baseRefName: "main",
  reviewDecision: "APPROVED", mergeStateStatus: "CLEAN" }]))!.pr;
const base: RawUnit = { path: PATH, dirName: "inkwell-draft", repo: REPO, githubRepo: REPO,
  branch: "ink-42-review", dirty: false, ahead: 0, behind: 0, lastCommitAt: null, defaultBranch: "main",
  pr: null, shipped: null, changedPaths: ["src/review.ts"], observed: { status: true, pr: true } };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function setup(options: { remoteOnly?: boolean; state?: "OPEN" | "MERGED"; noProject?: boolean;
  initialThreads?: { id: string; patch: Record<string, unknown>; metadata: Record<string, unknown> }[] } = {}) {
  let raw: RawUnit = { ...base, pr: options.remoteOnly ? null : pr(options.state) };
  let remote = options.remoteOnly ? [pr(options.state)] : [];
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const metadata = new Map<string, Record<string, unknown>>();
  const add = (id: string, patch: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) => {
    const row = makeThreadResponse({ id, projectId: PROJECT, title: id, status: "idle",
      originPluginId: "workstreams", ...patch } as never);
    threads.set(id, row); metadata.set(id, meta); return row;
  };
  for (const row of options.initialThreads ?? []) add(row.id, row.patch, row.metadata);
  const spawn = vi.fn(async (args: Record<string, any>) => {
    const id = `thr-context-${threads.size + 1}`;
    add(id, { projectId: args.projectId, title: args.title, parentThreadId: args.parentThreadId ?? null,
      providerId: args.providerId, environmentPath: args.environment.workspace.path ?? null,
      environmentHostId: args.environment.hostId ?? HOST }, args.pluginMetadata);
    return { ...threads.get(id)!, canSpawnChild: true } as never;
  });
  const send = vi.fn(async (_args: Record<string, any>) => ({ ok: true as const, delivery: "sent" as const }));
  const output = vi.fn(async () => ({ output: "The manuscript is ready for review." }));
  const { bb, harness } = createFakePluginHost({ pluginId: "workstreams", settings: { scanRoots: "/p" }, sdk: {
    system: { config: async () => ({ primaryHostId: HOST }) as never },
    projects: { list: async () => options.noProject ? [] as never :
      [{ id: PROJECT, name: "Folio", sources: [{ hostId: HOST, path: "/p" }] }] as never },
    threads: { list: async () => [...threads.values()] as never,
      get: async ({ threadId }: { threadId: string }) => {
        const row = threads.get(threadId); if (!row) throw new Error("Unknown synthetic thread");
        return { ...row, canSpawnChild: true, environment: { hostId: HOST } } as never;
      },
      getPluginMetadata: async ({ threadId }: { threadId: string }) => metadata.get(threadId) ?? {},
      spawn, send, output, context: async () => ({ usage: null }) as never,
      events: { list: async () => [] }, interactions: { list: async () => [] as never },
    },
  }, experimental_callHostRpc: ({ method }) => {
    if (method === "scan" || method === "inspectPaths") return { units: [raw], warnings: [] };
    if (method === "authoredPrs") return { owners: ["inkwell"], entries: remote.map((item) => ({ repo: REPO, pr: item })),
      discoveryComplete: true, repositories: [{ repo: REPO, complete: true }], complete: true, warnings: [] };
    if (method === "contextWorkspace") return { path: `/scratch/context-${threads.size + 1}` };
    throw new Error(`Unexpected host call ${method}`);
  } });
  await plugin(bb); cleanups.push(() => harness.lifecycle.dispose());
  expect((await harness.runCli(["refresh"])).exitCode).toBe(0);
  const message = (target: { prUrl: string } | { path: string }, threadId: string | null, text = "Where are we with this?") =>
    harness.callRpc("card_thread_message", { target, threadId, message: text });
  const board = () => harness.callRpc("board_get", null) as Promise<Board>;
  return { bb, harness, threads, metadata, add, spawn, send, output, message, board,
    store: createEffortStore(bb.storage.database()), setRaw: (next: RawUnit) => { raw = next; },
    setRemote: (next: ReturnType<typeof pr>[]) => { remote = next; },
    refresh: async () => { expect((await harness.runCli(["refresh"])).exitCode).toBe(0); } };
}

it("starts a remote PR context only on Send, links it to the board, and keeps follow-ups outside writer runs", async () => {
  const env = await setup({ remoteOnly: true });
  expect(env.spawn).not.toHaveBeenCalled();
  expect(await env.message({ prUrl: "https://github.com/inkwell/folio/pull/999" }, null)).toMatchObject({ ok: false });
  expect(env.spawn).not.toHaveBeenCalled();
  const created = await env.message({ prUrl: URL }, null) as { ok: true; threadId: string; created: boolean };
  expect(created).toMatchObject({ ok: true, created: true });
  expect(env.spawn).toHaveBeenCalledTimes(3);
  expect(env.spawn.mock.calls[0]?.[0]).toMatchObject({ pluginMetadata: { role: "coordinator" } });
  expect(env.spawn.mock.calls[1]?.[0]).toMatchObject({ title: REPO, parentThreadId: "thr-context-1", pluginMetadata: { role: "repo" } });
  const args = env.spawn.mock.calls[2]?.[0];
  expect(args).toMatchObject({ projectId: PROJECT,
    parentThreadId: "thr-context-2",
    environment: { type: "host", workspace: { type: "unmanaged" } },
    pluginMetadata: { role: "context", linkedPrUrl: URL } });
  expect(args?.environment.workspace.path).toMatch(/^\/scratch\/context-/);
  expect((await env.board()).prThreadLinks[URL]).toContain(created.threadId);
  await env.refresh();
  expect((await env.board()).prThreadLinks[URL]).toContain(created.threadId);
  expect(await env.harness.callRpc("card_thread_update", { target: { prUrl: URL }, threadId: created.threadId }))
    .toEqual({ lastLine: "The manuscript is ready for review." });
  expect(await env.message({ prUrl: URL }, created.threadId, "Is Workstreams data corrupt?"))
    .toMatchObject({ ok: true, created: false });
  expect(await env.harness.callRpc("runs_open", null)).toEqual([]);
  expect(env.send).toHaveBeenCalledTimes(1);
  expect(env.send.mock.calls[0]?.[0].input[0].text).toContain("authorizes inspection and reporting, not a repair");
});

it("keeps a legacy provider thread as history and refuses to send another turn through Workstreams", async () => {
  const env = await setup({ remoteOnly: true });
  const created = await env.message({ prUrl: URL }, null) as { ok: true; threadId: string };
  env.threads.set(created.threadId, { ...env.threads.get(created.threadId)!, providerId: "claude-code" });
  expect(await env.message({ prUrl: URL }, created.threadId)).toMatchObject({ ok: false,
    error: expect.stringContaining("Choose New agent") });
  expect(env.send).not.toHaveBeenCalled();
});

it("starts and messages context agents on the configured planning model, whatever its provider", async () => {
  const env = await setup({ remoteOnly: true });
  await expect(env.harness.behavior.setSettings({ planningModel: "claude-opus/max" })).rejects.toThrow();
  await env.harness.behavior.setSettings({ planningModel: "claude-code/claude-opus/max" });
  const created = await env.message({ prUrl: URL }, null) as { ok: true; threadId: string };
  expect(env.spawn.mock.calls.map(([args]) => [args.pluginMetadata.role, args.providerId, args.model, args.reasoningLevel])).toEqual([
    ["coordinator", "claude-code", "claude-opus", "max"], ["repo", "codex", "gpt-6-sol", "high"], ["context", "claude-code", "claude-opus", "max"],
  ]);
  expect(await env.message({ prUrl: URL }, created.threadId)).toMatchObject({ ok: true, created: false });
  expect(env.send).toHaveBeenCalledWith(expect.objectContaining({ threadId: created.threadId, model: "claude-opus", reasoningLevel: "max" }));
});

it("keeps a newly created PR context in the first twenty links while thread facts catch up", async () => {
  const initialThreads = Array.from({ length: 24 }, (_, index) => ({ id: `thr-history-${index}`,
    patch: { status: "active" }, metadata: { linkedPrUrl: URL } }));
  const env = await setup({ remoteOnly: true, initialThreads });
  const created = await env.message({ prUrl: URL }, null) as { ok: true; threadId: string };
  const links = (await env.board()).prThreadLinks[URL];
  expect(links).toHaveLength(20);
  expect(links?.[0]).toBe(created.threadId);
});

it("keeps a closed PR context available for diagnosis without creating a writer run", async () => {
  const env = await setup({ state: "MERGED" });
  const created = await env.message({ prUrl: URL }, null) as { ok: true; threadId: string };
  expect(await env.message({ prUrl: URL }, created.threadId, "What happened?"))
    .toMatchObject({ ok: true, created: false });
  expect(env.send.mock.calls[0]?.[0].input[0].text).toContain("Diagnose and report only");
  expect(await env.harness.callRpc("runs_open", null)).toEqual([]);
});

it("starts a pre-PR checkout context with an exact branch link and refuses a stale branch", async () => {
  const env = await setup();
  env.setRaw({ ...base }); await env.refresh();
  const created = await env.message({ path: PATH }, null) as { ok: true; threadId: string };
  expect(env.metadata.get(created.threadId)).toMatchObject({ role: "context", linkedCheckoutPath: PATH,
    linkedCheckoutBranch: "ink-42-review" });
  expect(await env.message({ path: PATH }, created.threadId)).toMatchObject({ ok: true, created: false });
  env.setRaw({ ...base, branch: "different-review" }); await env.refresh();
  expect(await env.message({ path: PATH }, created.threadId)).toMatchObject({ ok: false });
  expect(env.send).toHaveBeenCalledTimes(1);
});

it("places a context beneath scratch effort parents without claiming new work membership", async () => {
  const env = await setup();
  const effort = env.store.establish({ sourceKey: "ticket:INK-42", name: "Manuscript review",
    goal: "Finish the review", projectId: PROJECT, coordinatorState: "none",
    members: { tickets: ["INK-42"], prUrls: [] } });
  const before = env.store.owner("prUrl", URL);
  expect(before).toBeNull();
  expect(await env.harness.callRpc("card_effort_context", { prUrl: URL }))
    .toMatchObject({ ok: true, source: { effortKey: effort.key } });
  const created = await env.message({ prUrl: URL }, null) as { ok: true; threadId: string };
  expect(env.spawn.mock.calls[0]?.[0].prompt).not.toContain("Effort parent unavailable");
  expect(env.spawn).toHaveBeenCalledTimes(3);
  const [coordinator, repository, context] = env.spawn.mock.calls.map((call) => call[0]);
  expect(repository?.parentThreadId).toBe("thr-context-1");
  expect(context?.parentThreadId).toBe("thr-context-2");
  for (const args of [coordinator, repository, context]) {
    expect(args?.environment).toMatchObject({ type: "host", workspace: { type: "unmanaged" } });
    expect(args?.environment.workspace.path).toMatch(/^\/scratch\/context-/);
  }
  expect(env.metadata.get(created.threadId)).toMatchObject({ role: "context", workEffortId: effort.id });
  expect(env.store.owner("prUrl", URL)).toBeNull();
  expect((env.bb.storage.database() as any).prepare("SELECT 1 FROM thread_work_intent_ids WHERE thread_id = ?")
    .get(created.threadId)).toBeUndefined();
});

it("uses a personal context when no matching project exists", async () => {
  const env = await setup({ remoteOnly: true, noProject: true });
  expect(await env.message({ prUrl: URL }, null)).toMatchObject({ ok: true, created: true });
  expect(env.spawn.mock.calls[0]?.[0]).toMatchObject({ title: "Unassigned work", projectId: "proj_personal", pluginMetadata: { role: "unassigned-root" } });
  expect(env.spawn.mock.calls[1]?.[0]).toMatchObject({ title: REPO, parentThreadId: "thr-context-1", pluginMetadata: { role: "unassigned-repo" } });
  expect(env.spawn.mock.calls.at(-1)?.[0]).toMatchObject({ projectId: "proj_personal", parentThreadId: "thr-context-2",
    environment: { type: "host", workspace: { type: "personal" } } });
});

it("keeps an explicit effort association when personal placement uses the unassigned parent", async () => {
  const env = await setup({ remoteOnly: true, noProject: true });
  const effort = env.store.establish({ sourceKey: "ticket:INK-42", name: "Manuscript review",
    goal: "Finish the review", projectId: PROJECT, coordinatorState: "none",
    members: { tickets: ["INK-42"], prUrls: [] } });
  const created = await env.message({ prUrl: URL }, null) as { ok: true; threadId: string; warning?: string };
  expect(created.warning).toContain("Effort project unavailable");
  expect(env.spawn.mock.calls.at(-1)?.[0].parentThreadId).toBe("thr-context-2");
  expect(env.metadata.get(created.threadId)).toMatchObject({ role: "context", workEffortId: effort.id });
  expect(env.store.owner("prUrl", URL)).toBeNull();
});

it("places a ticketless checkout context under the shared root when no repository is known", async () => {
  const env = await setup();
  env.setRaw({ ...base, repo: "local", githubRepo: null, branch: "draft", dirName: "draft" });
  await env.refresh();
  const created = await env.message({ path: PATH }, null) as { ok: true; threadId: string };
  expect(env.spawn.mock.calls[0]?.[0]).toMatchObject({ title: "Unassigned work", pluginMetadata: { role: "unassigned-root" } });
  expect(env.spawn.mock.calls[1]?.[0]).toMatchObject({ parentThreadId: "thr-context-1", pluginMetadata: { role: "context" } });
  expect(env.metadata.get(created.threadId)).not.toHaveProperty("workEffortId");
});

it("keeps a stale controller binding intact while starting a linked diagnostic root", async () => {
  const env = await setup();
  const effort = env.store.establish({ sourceKey: "ticket:INK-42", name: "Manuscript review",
    goal: "Finish the review", projectId: PROJECT, coordinatorState: "none",
    members: { tickets: ["INK-42"], prUrls: [] } });
  const claimed = env.store.claimRepoController({ effortId: effort.id, repo: REPO, projectId: PROJECT, hostId: HOST });
  env.store.saveRepoController({ ...claimed.record, threadId: "thr-stale-controller", state: "ready" });
  const created = await env.message({ prUrl: URL }, null, "Is anything wrong with the Workstreams data?") as
    { ok: true; threadId: string };
  expect(created.ok).toBe(true);
  expect(env.store.repoController(effort.id, REPO)?.threadId).toBe("thr-stale-controller");
  const args = env.spawn.mock.calls.at(-1)?.[0];
  expect(args?.parentThreadId).toBeUndefined();
  expect(args?.prompt).toContain("Repository parent unavailable");
  expect(args?.pluginMetadata).toMatchObject({ role: "context", linkedPrUrl: URL, workEffortId: effort.id });
  expect((await env.board()).prThreadLinks[URL]).toContain(created.threadId);
});

it("sends held-card context diagnostics but never starts execution", async () => {
  const env = await setup();
  await env.harness.callRpc("pr_hold_set", { prUrl: URL, held: true, reason: "Waiting for copy review" });
  const created = await env.message({ prUrl: URL }, null, "Is the Workstreams data corrupt?") as { ok: true; threadId: string };
  expect(env.spawn.mock.calls.at(-1)?.[0].prompt).toContain("Diagnose and report only");
  expect(await env.message({ prUrl: URL }, created.threadId, "Where are we?"))
    .toMatchObject({ ok: true, created: false });
  expect(await env.harness.callRpc("runs_open", null)).toEqual([]);
});

it("refuses an existing checkout thread when another live thread owns its path", async () => {
  const env = await setup({ initialThreads: [
    { id: "thr-linked", patch: { providerId: "codex", environmentPath: PATH }, metadata: { ticket: "INK-42" } },
    { id: "thr-writer", patch: { status: "active", environmentPath: PATH, environmentHostId: HOST }, metadata: {} },
  ] });
  env.setRaw({ ...base }); await env.refresh();
  // Ticket association is a thread link, not permission to share its writer path.
  expect(await env.message({ path: PATH }, "thr-linked", "Please edit the checkout"))
    .toMatchObject({ ok: false, error: expect.stringContaining("Another agent owns this checkout") });
  expect(env.send).not.toHaveBeenCalled();
});
