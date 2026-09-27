import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import type { RawUnit } from "./contract.js";
import plugin, { type Board } from "./server.js";

const PATH = "/p/app-abc-101";
const URL = "https://github.com/acme/app/pull/42";
const HOST = "host-a";

function unit(mergeStateStatus: "DIRTY" | "CLEAN"): RawUnit {
  return {
    path: PATH, dirName: "app-abc-101", repo: "acme/app", branch: "abc-101-fix", dirty: false,
    observed: { status: true, pr: true }, ahead: 0, behind: 0, lastCommitAt: "2026-09-23T12:00:00Z",
    defaultBranch: "main", shipped: null, changedPaths: ["src/app.ts"],
    pr: {
      number: 42, state: "OPEN", isDraft: false, reviewDecision: "APPROVED", checkConclusions: ["SUCCESS"],
      url: URL, title: "Fix app", mergeable: mergeStateStatus === "DIRTY" ? "CONFLICTING" : "MERGEABLE",
      baseRefName: "main", headRefName: "abc-101-fix", latestReviewStates: ["APPROVED"], mergedAt: null,
      mergeStateStatus, reviewRequests: [], latestReviews: [], unresolvedReviewThreads: 0, resolvedReviewThreads: 0,
    },
  };
}

async function setup(second = false) {
  const beforeProjects = vi.fn(async () => {});
  let contextWorkspaces = 0;
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const spawn = vi.fn(async (args: Record<string, any>) => {
    const role = args.pluginMetadata?.role;
    const id = role === "coordinator" ? "thr-coordinator" : role === "repo" ? `thr-repo-${args.pluginMetadata?.repo?.replaceAll("/", "-")}` : "thr-dispatch";
    const row = makeThreadResponse({ id, projectId: args.projectId, parentThreadId: args.parentThreadId ?? null,
      title: args.title ?? "PR worker", status: role === "pr" ? "active" : "idle",
      environment: { hostId: args.environment.hostId } } as never);
    threads.set(id, row);
    return row;
  });
  const another = { ...unit("DIRTY"), path: "/p/web-abc-101", dirName: "web-abc-101", repo: "acme/web",
    pr: { ...unit("DIRTY").pr!, number: 43, url: "https://github.com/acme/web/pull/43" } };
  const inspected = new Map([[PATH, unit("DIRTY")], ...(second ? [[another.path, another] as const] : [])]);
  let fullScan = second ? [unit("DIRTY"), another] : [unit("DIRTY")];
  let inspectCount = 0;
  const { bb, harness } = createFakePluginHost({
    pluginId: "workstreams",
    settings: { scanRoots: "/p" },
    sdk: {
      system: { config: async () => ({ primaryHostId: HOST }) as never },
      projects: { list: async () => { await beforeProjects(); return [{ id: "proj-a", sources: [{ hostId: HOST, path: "/p" }] }] as never; } },
      threads: {
        list: async () => [] as never, spawn,
        get: async ({ threadId }: { threadId: string }) => {
          const thread = threads.get(threadId);
          if (!thread) throw new Error("missing thread");
          return { ...thread, canSpawnChild: true } as never;
        },
        context: async () => ({ usage: null }) as never,
        output: async () => ({ output: "Result: Local repair proposed" }),
        getPluginMetadata: async () => ({}) as never,
        events: { list: async () => [] }, interactions: { list: async () => [] as never },
      },
    },
    experimental_callHostRpc: (call) => {
      if (call.method === "contextWorkspace") return { path: `/synthetic/workstreams/context/${++contextWorkspaces}` };
      if (call.method === "scan") return { units: fullScan, warnings: [] };
      if (call.method === "inspectPaths") {
        inspectCount++;
        const inspectedUnit = inspected.get((call.input as { paths: string[] }).paths[0]!);
        return { units: inspectedUnit === undefined ? [] : [inspectedUnit], warnings: [] };
      }
      throw new Error(`Unexpected host call: ${call.method}`);
    },
  });
  await plugin(bb);
  expect((await harness.runCli(["refresh"])).exitCode).toBe(0);
  const board = async () => await harness.callRpc("board_get", null) as Board;
  const current = await board();
  const leaf = current.groups.find((group) => !current.groups.some((child) => child.parentKey === group.key));
  expect(leaf).toBeDefined();
  const prSpawns = () => spawn.mock.calls.filter(([args]) => args.pluginMetadata?.role === "pr");
  const expectGraph = () => {
    const coordinator = spawn.mock.calls.find(([args]) => args.pluginMetadata?.role === "coordinator")?.[0];
    const repo = spawn.mock.calls.find(([args]) => args.pluginMetadata?.role === "repo")?.[0];
    const worker = prSpawns()[0]?.[0];
    expect(coordinator).toMatchObject({ projectId: "proj-a", pluginMetadata: { role: "coordinator" } });
    expect(coordinator?.environment).toMatchObject({ type: "host", hostId: HOST,
      workspace: { type: "unmanaged", path: "/synthetic/workstreams/context/1" } });
    expect(coordinator).not.toHaveProperty("parentThreadId");
    expect(repo).toMatchObject({ projectId: "proj-a", parentThreadId: "thr-coordinator", pluginMetadata: { repo: expect.stringMatching(/^acme\//u) } });
    expect(repo?.environment).toMatchObject({ type: "host", hostId: HOST,
      workspace: { type: "unmanaged", path: "/synthetic/workstreams/context/2" } });
    expect(worker).toMatchObject({ projectId: "proj-a", parentThreadId: expect.stringMatching(/^thr-repo-acme-/u),
      environment: { workspace: { path: expect.any(String) } } });
    expect([PATH, another.path]).toContain(worker.environment.workspace.path);
  };
  return { harness, board, leafKey: leaf!.key, spawn, prSpawns, expectGraph, beforeProjects, inspectCount: () => inspectCount,
    setInspection: (next: RawUnit) => { inspected.set(next.path, next); },
    setFullScan: (next: RawUnit) => { fullScan = [next]; } };
}

describe("dispatcher server wiring", () => {
  it("excludes held work from Auto while still allowing a manual agent", async () => {
    const env = await setup();
    await env.harness.callRpc("pr_hold_set", { prUrl: URL, held: true });
    await env.harness.callRpc("dispatch_set", { mode: "auto", effortKey: env.leafKey });
    expect((await env.board()).dispatch.candidate).toBeNull();
    expect(env.spawn).not.toHaveBeenCalled();
    expect(await env.harness.callRpc("agent_run", { path: PATH, action: "resolve-conflicts", mode: "new", threadId: null, prompt: "Fix the conflict without merging" })).toMatchObject({ ok: true });
    expect(env.prSpawns()).toHaveLength(1);
    env.expectGraph();
  });
  it("refuses Auto when a hold arrives during the final project lookup", async () => {
    const env = await setup();
    env.beforeProjects.mockImplementationOnce(async () => { await env.harness.callRpc("pr_hold_set", { prUrl: URL, held: true }); });
    await env.harness.callRpc("dispatch_set", { mode: "auto", effortKey: env.leafKey });
    await vi.waitFor(async () => expect((await env.board()).dispatch.attempts[0]).toMatchObject({ status: "failed", detail: expect.stringContaining("On hold") }));
    expect(env.spawn).not.toHaveBeenCalled();
    expect((await env.board()).runs).toEqual([]);
  });
  it("keeps Off and Shadow read-only, then preflights and launches once after Auto is selected", async () => {
    const env = await setup();
    expect((await env.board()).dispatch).toMatchObject({ mode: "off", candidate: null, attempts: [] });
    await env.harness.callRpc("dispatch_set", { mode: "shadow", effortKey: env.leafKey });
    expect((await env.board()).dispatch.candidate).toMatchObject({ action: "resolve-conflicts", path: PATH });
    expect(env.spawn).not.toHaveBeenCalled();
    await env.harness.callRpc("dispatch_set", { mode: "auto", effortKey: env.leafKey });
    await vi.waitFor(() => expect(env.prSpawns()).toHaveLength(1));
    env.expectGraph();
    expect(env.inspectCount()).toBe(1);
    expect((await env.board()).dispatch).toMatchObject({ candidate: null, attempts: [expect.objectContaining({ status: "running", threadId: "thr-dispatch" })] });
    expect(await env.harness.callRpc("agent_run", { path: PATH, action: "resolve-conflicts", mode: "new", threadId: null, prompt: "Fix it" })).toMatchObject({ ok: false });
    await env.harness.callRpc("board_get", null);
    expect(env.prSpawns()).toHaveLength(1);
  });

  it("makes one more selection pass when preflight clears the first candidate", async () => {
    const env = await setup(true);
    env.setInspection(unit("CLEAN"));
    await env.harness.callRpc("dispatch_set", { mode: "auto", effortKey: env.leafKey });
    await vi.waitFor(() => expect(env.prSpawns()).toHaveLength(1));
    env.expectGraph();
    expect(env.inspectCount()).toBe(2);
    expect((await env.board()).dispatch.attempts[0]).toMatchObject({ path: "/p/web-abc-101", status: "running" });
  });

  it("marks a completed agent verified only after a fresh inspection clears its gate", async () => {
    const env = await setup();
    await env.harness.callRpc("dispatch_set", { mode: "auto", effortKey: env.leafKey });
    await vi.waitFor(() => expect(env.prSpawns()).toHaveLength(1));
    env.expectGraph();
    env.setInspection(unit("CLEAN"));
    await env.harness.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr-dispatch", status: "idle" }),
      lastAssistantText: "Result: Local repair proposed",
    });
    await vi.waitFor(async () => expect((await env.board()).dispatch.attempts[0]?.status).toBe("verified"));
    expect(env.inspectCount()).toBe(2);
  });

  it("recognizes a merged PR as the endpoint when the fresh inspection reports it", async () => {
    const env = await setup();
    await env.harness.callRpc("dispatch_set", { mode: "auto", effortKey: env.leafKey });
    await vi.waitFor(() => expect(env.prSpawns()).toHaveLength(1));
    env.expectGraph();
    const merged = unit("CLEAN");
    merged.pr = { ...merged.pr!, state: "MERGED" };
    env.setInspection(merged);
    await env.harness.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr-dispatch", status: "idle" }),
      lastAssistantText: "Result: Local repair proposed",
    });
    await vi.waitFor(async () => expect((await env.board()).dispatch.attempts[0]).toMatchObject({ status: "verified", detail: expect.stringContaining("merged") }));
  });

  it("pauses when a fresh inspection still shows the gate", async () => {
    const env = await setup();
    await env.harness.callRpc("dispatch_set", { mode: "auto", effortKey: env.leafKey });
    await vi.waitFor(() => expect(env.prSpawns()).toHaveLength(1));
    env.expectGraph();
    await env.harness.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr-dispatch", status: "idle" }),
      lastAssistantText: "Result: Local repair proposed",
    });
    await vi.waitFor(async () => expect((await env.board()).dispatch.attempts[0]?.status).toBe("needs-you"));
    expect((await env.board()).dispatch.candidate).toBeNull();
    expect(env.prSpawns()).toHaveLength(1);
    expect(await env.harness.callRpc("agent_run", { path: PATH, action: "resolve-conflicts", mode: "new", threadId: null, prompt: "Fix it" })).toMatchObject({ ok: false });
    env.setFullScan(unit("CLEAN"));
    expect((await env.harness.runCli(["refresh"])).exitCode).toBe(0);
    expect((await env.board()).dispatch.attempts[0]?.status).toBe("verified");
  });

  it("keeps the effort paused when a full scan clears the gate while the agent awaits a decision", async () => {
    const env = await setup();
    await env.harness.callRpc("dispatch_set", { mode: "auto", effortKey: env.leafKey });
    await vi.waitFor(() => expect(env.prSpawns()).toHaveLength(1));
    env.expectGraph();
    await env.harness.emitThreadEvent("interaction.pending", {
      thread: makeThreadResponse({ id: "thr-dispatch", status: "active" }), interaction: {} as never,
    });
    await vi.waitFor(async () => expect((await env.board()).dispatch.attempts[0]?.status).toBe("needs-you"));
    env.setFullScan(unit("CLEAN"));
    expect((await env.harness.runCli(["refresh"])).exitCode).toBe(0);
    expect((await env.board()).dispatch).toMatchObject({ candidate: null, attempts: [expect.objectContaining({ status: "needs-you" })] });
    expect(env.prSpawns()).toHaveLength(1);
  });
});
