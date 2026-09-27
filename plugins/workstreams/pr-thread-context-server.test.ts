// PR thread reads and sends through the real server on BB's fake host.
// Every project, PR, checkout, and thread in this file is synthetic.
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RawUnit } from "./contract.js";
import { createEffortStore } from "./effort-store.js";
import { parsePrList } from "./gh.js";
import { createRunStore } from "./runstore.js";
import plugin from "./server.js";

const HOST = "host-inkwell";
const PROJECT = "proj-inkwell";
const PATH = "/p/folio-abc-42";
const REPO = "inkwell/folio";
const URL = "https://github.com/inkwell/folio/pull/42";
const NEXT_URL = "https://github.com/inkwell/folio/pull/43";
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function pr(number: number, state: "OPEN" | "MERGED" = "OPEN") {
  return parsePrList(JSON.stringify([{ number, url: `https://github.com/${REPO}/pull/${number}`, state,
    title: `ABC-${number} Improve manuscript review`, headRefName: `abc-${number}-review`,
    baseRefName: "main", reviewDecision: "APPROVED" }]))!.pr;
}

type Context = { threads: { id: string; title: string; role: "coordinator" | "repo" | "pr" | "linked" }[]; recommendedThreadId: string | null };

async function setup(options: { remoteOnly?: boolean; state?: "OPEN" | "MERGED"; metadata?: Record<string, Record<string, unknown>>;
  initialThreads?: { id: string; title: string }[] } = {}) {
  const currentPr = pr(42, options.state);
  const raw: RawUnit = { path: PATH, dirName: "folio-abc-42", repo: REPO, githubRepo: REPO,
    branch: "abc-42-review", dirty: false, ahead: 0, behind: 0, lastCommitAt: null,
    defaultBranch: "main", pr: options.remoteOnly ? null : currentPr, shipped: null,
    changedPaths: ["src/review.ts"], observed: { status: true, pr: true } };
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const add = (id: string, patch: Record<string, unknown> = {}) => {
    const row = makeThreadResponse({ id, projectId: PROJECT, title: id, status: "idle", ...patch } as never);
    threads.set(id, row);
    return row;
  };
  for (const row of options.initialThreads ?? []) add(row.id, { title: row.title });
  const send = vi.fn(async () => ({ ok: true as const, delivery: "sent" as const }));
  const output = vi.fn(async () => ({ output: null as string | null }));
  const spawn = vi.fn(async () => add("thr-unexpected"));
  const { bb, harness } = createFakePluginHost({ pluginId: "workstreams", settings: { scanRoots: "/p" }, sdk: {
    system: { config: async () => ({ primaryHostId: HOST }) as never },
    projects: { list: async () => [{ id: PROJECT, name: "Folio", sources: [{ hostId: HOST, path: "/p" }] }] as never },
    threads: {
      list: async () => [...threads.values()] as never,
      get: async ({ threadId }: { threadId: string }) => {
        const row = threads.get(threadId);
        if (!row) throw new Error("Unknown synthetic thread");
        return { ...row, canSpawnChild: true } as never;
      },
      getPluginMetadata: async ({ threadId }: { threadId: string }) => (options.metadata?.[threadId] ?? {}) as never,
      spawn, send, output, context: async () => ({ usage: null }) as never,
      events: { list: async () => [] }, interactions: { list: async () => [] as never },
    },
  }, experimental_callHostRpc: ({ method }) => {
    if (method === "scan" || method === "inspectPaths") return { units: [raw], warnings: [] };
    if (method === "authoredPrs") return { owners: ["inkwell"], entries: [{ repo: REPO, pr: currentPr }, { repo: REPO, pr: pr(43) }],
      discoveryComplete: true, repositories: [{ repo: REPO, complete: true }], complete: true, warnings: [] };
    throw new Error(`Unexpected host call ${method}`);
  } });
  await plugin(bb);
  cleanups.push(() => harness.lifecycle.dispose());
  expect((await harness.runCli(["refresh"])).exitCode).toBe(0);
  const effortStore = createEffortStore(bb.storage.database() as never);
  const effort = effortStore.establish({ sourceKey: "ticket:ABC-42", name: "Improve manuscript review", goal: "Make manuscript review reliable",
    projectId: PROJECT, members: { tickets: ["ABC-42"], prUrls: [URL, NEXT_URL] } });
  const context = async (url = URL) => await harness.callRpc("pr_thread_context", { prUrl: url }) as Context;
  const message = async (threadId: string, url = URL) => await harness.callRpc("thread_message", { prUrl: url, threadId, message: "Check this PR" });
  const update = async (threadId: string, url = URL) => await harness.callRpc("pr_thread_update", { prUrl: url, threadId });
  return { bb, harness, threads, add, send, output, spawn, effortStore, effort, context, message, update };
}

describe("PR thread context and messaging", () => {
  it("shows the final content line, skipping only Advance completion markers and bounding the preview", async () => {
    const env = await setup();
    env.add("thr-pr");
    env.effortStore.recordWorker(env.effort.id, "thr-pr", URL, "pr");
    env.output.mockResolvedValue({ output: `Checked the change.\nThe review is ready.\n\nWorkstreams job attempt-1 complete: prepared\n` });
    expect(await env.update("thr-pr")).toEqual({ lastLine: "The review is ready." });
    env.output.mockResolvedValue({ output: `The tests remain blocked.\nWorkstreams job attempt-1 complete: blocked` });
    expect(await env.update("thr-pr")).toEqual({ lastLine: "The tests remain blocked." });
    env.output.mockResolvedValue({ output: "Workstreams job attempt-1 complete: prepared\n\n" });
    expect(await env.update("thr-pr")).toEqual({ lastLine: null });
    env.output.mockResolvedValue({ output: "A".repeat(400) });
    expect(await env.update("thr-pr")).toEqual({ lastLine: "A".repeat(280) });
  });

  it("reads only linked threads, including closed PR history, and distinguishes missing from failed output", async () => {
    const env = await setup({ state: "MERGED" });
    env.add("thr-pr");
    env.add("thr-other");
    env.effortStore.recordWorker(env.effort.id, "thr-pr", URL, "pr");
    expect(await env.update("thr-other")).toEqual({ lastLine: null });
    expect(await env.update("thr-pr", "https://github.com/inkwell/folio/pull/999")).toEqual({ lastLine: null });
    expect(env.output).not.toHaveBeenCalled();
    expect(await env.update("thr-pr")).toEqual({ lastLine: null });
    env.output.mockRejectedValueOnce(new Error("Output unavailable"));
    await expect(env.update("thr-pr")).rejects.toThrow("Output unavailable");
    expect(env.output).toHaveBeenCalledTimes(2);
  });

  it("keeps linked thread updates readable while the PR is on hold", async () => {
    const env = await setup();
    env.add("thr-pr");
    env.effortStore.recordWorker(env.effort.id, "thr-pr", URL, "pr");
    await env.harness.callRpc("pr_hold_set", { prUrl: URL, held: true, reason: "Waiting for copy review" });
    env.output.mockResolvedValue({ output: "Waiting for copy review." });
    expect(await env.update("thr-pr")).toEqual({ lastLine: "Waiting for copy review." });
  });

  it("reads coordinator, repository, and PR history without launching work, and recommends the current repository controller", async () => {
    const env = await setup();
    env.add("thr-coordinator", { title: "🧭 Manuscript review" });
    env.add("thr-repo", { title: "📦 inkwell/folio", parentThreadId: "thr-coordinator", environment: { hostId: HOST } });
    env.add("thr-pr", { title: "Review fixes" });
    env.effortStore.save({ ...env.effort, coordinatorThreadId: "thr-coordinator", coordinatorState: "ready" });
    const claimed = env.effortStore.claimRepoController({ effortId: env.effort.id, repo: REPO, projectId: PROJECT, hostId: HOST });
    env.effortStore.saveRepoController({ ...claimed.record, threadId: "thr-repo", state: "ready" });
    env.effortStore.recordWorker(env.effort.id, "thr-pr", URL, "pr");

    const context = await env.context();
    expect(context.threads).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "thr-coordinator", role: "coordinator" }),
      expect.objectContaining({ id: "thr-repo", role: "repo" }),
      expect.objectContaining({ id: "thr-pr", role: "pr" }),
    ]));
    expect(context.recommendedThreadId).toBe("thr-repo");
    expect(env.spawn).not.toHaveBeenCalled();
    expect(env.send).not.toHaveBeenCalled();
  });

  it("includes an explicitly linked remote PR thread and sends without a checkout path", async () => {
    const env = await setup({ remoteOnly: true, metadata: { "thr-remote": { linkedPrUrl: URL } },
      initialThreads: [{ id: "thr-remote", title: "Remote PR author" }] });
    await vi.waitFor(async () => expect((await env.context()).threads).toEqual([
      expect.objectContaining({ id: "thr-remote", role: "pr" }),
    ]));
    expect((await env.context()).recommendedThreadId).toBe("thr-remote");
    expect(await env.message("thr-remote")).toEqual({ ok: true, delivery: "sent" });
    expect(env.send).toHaveBeenCalledWith(expect.objectContaining({ threadId: "thr-remote" }));
    expect(await env.harness.callRpc("runs_open", null)).toEqual([
      expect.objectContaining({ path: "", prUrl: URL, threadId: "thr-remote" }),
    ]);
  });

  it("keeps merged PR history visible while refusing new instructions", async () => {
    const env = await setup({ state: "MERGED" });
    env.add("thr-pr", { environmentPath: PATH });
    env.effortStore.recordWorker(env.effort.id, "thr-pr", URL, "pr");
    expect((await env.context()).threads).toEqual([expect.objectContaining({ id: "thr-pr", role: "pr" })]);
    expect(await env.message("thr-pr")).toMatchObject({ ok: false });
    expect(env.send).not.toHaveBeenCalled();
  });

  it("rejects unrelated, archived, and hidden targets from both the context and send path", async () => {
    const env = await setup();
    env.add("thr-unrelated");
    env.add("thr-archived", { archivedAt: Date.now() });
    env.add("thr-hidden", { visibility: "hidden" });
    env.effortStore.recordWorker(env.effort.id, "thr-archived", URL, "pr");
    env.effortStore.recordWorker(env.effort.id, "thr-hidden", URL, "pr");
    expect((await env.context()).threads).toEqual([]);
    for (const id of ["thr-unrelated", "thr-archived", "thr-hidden"])
      expect(await env.message(id)).toMatchObject({ ok: false });
    expect(env.send).not.toHaveBeenCalled();
  });

  it("rejects sends while the PR is on hold", async () => {
    const env = await setup();
    env.add("thr-pr");
    env.effortStore.recordWorker(env.effort.id, "thr-pr", URL, "pr");
    await env.harness.callRpc("pr_hold_set", { prUrl: URL, held: true, reason: "Waiting for copy review" });
    expect(await env.message("thr-pr")).toMatchObject({ ok: false, error: expect.stringContaining("hold") });
    expect(env.send).not.toHaveBeenCalled();
  });

  it("rejects a competing PR owner but allows a message to that same owner's thread", async () => {
    const env = await setup();
    env.add("thr-pr", { status: "active", environmentPath: PATH });
    env.add("thr-repo");
    env.effortStore.recordWorker(env.effort.id, "thr-pr", URL, "pr");
    const claimed = env.effortStore.claimRepoController({ effortId: env.effort.id, repo: REPO, projectId: PROJECT, hostId: HOST });
    env.effortStore.saveRepoController({ ...claimed.record, threadId: "thr-repo", state: "ready" });
    createRunStore(env.bb.storage.database()).begin({ path: PATH, ticket: "ABC-42", prUrl: URL, prNumber: 42,
      action: "address-review", mode: "continue", threadId: "thr-pr" });
    expect(await env.message("thr-repo")).toMatchObject({ ok: false, error: expect.stringContaining("Another agent") });
    expect(await env.message("thr-pr")).toEqual({ ok: true, delivery: "sent" });
    expect(env.send).toHaveBeenCalledTimes(1);
  });

  it("holds the PR writer lease through an asynchronous send so concurrent requests cannot both deliver", async () => {
    const env = await setup();
    env.add("thr-pr", { environmentPath: PATH });
    env.effortStore.recordWorker(env.effort.id, "thr-pr", URL, "pr");
    let release!: (value: { ok: true; delivery: "sent" }) => void;
    env.send.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const first = env.message("thr-pr");
    await vi.waitFor(() => expect(env.send).toHaveBeenCalledTimes(1));
    const second = await env.message("thr-pr");
    expect(second).toMatchObject({ ok: false, error: expect.stringContaining("owns this PR") });
    release({ ok: true, delivery: "sent" });
    expect(await first).toEqual({ ok: true, delivery: "sent" });
    expect(env.send).toHaveBeenCalledTimes(1);
  });
});
