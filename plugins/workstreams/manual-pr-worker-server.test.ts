import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RawUnit } from "./contract.js";
import { parsePrList } from "./gh.js";
import plugin from "./server.js";

const PATH = "/p/widget-checkout";
const HOST = "host-example";
const HEAD = "a".repeat(40), BASE = "b".repeat(40);
const LEGACY_BATCH = "00000000-0000-4000-8000-000000000052";
const LEGACY_JOB = "00000000-0000-4000-8000-000000000053";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function setup(options: { ready?: boolean; omitLaunchedThreadsFromList?: boolean; legacyJob?: "running" } = {}) {
  const repo = "example/widget";
  const url = `https://github.com/${repo}/pull/42`;
  const pr = { ...parsePrList(JSON.stringify([{ number: 42, url, state: "OPEN", title: "ABC-42 Fix account lookup", reviewDecision: "APPROVED",
    isDraft: false, headRefName: "abc-42-lookup", baseRefName: "main", headRefOid: HEAD, baseRefOid: BASE, mergeStateStatus: options.ready ? "CLEAN" : "DIRTY",
    mergeable: options.ready ? "MERGEABLE" : "CONFLICTING", statusCheckRollup: [{ conclusion: "SUCCESS" }], latestReviews: [], reviewRequests: [] }]))!.pr,
    unresolvedReviewThreads: 0, resolvedReviewThreads: 0 };
  const unit: RawUnit = { path: PATH, dirName: "widget-checkout", repo: "Widget", githubRepo: repo, branch: "abc-42-lookup",
    dirty: false, ahead: 0, behind: 0, lastCommitAt: null, defaultBranch: "main", pr, shipped: null, changedPaths: [], observed: { status: true, pr: true } };
  const calls: { method: string; input: unknown }[] = [];
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const threadMetadata = new Map<string, Record<string, unknown>>();
  let spawned = 0, contextWorkspaces = 0;
  const spawn = vi.fn(async (args: Record<string, any>) => {
    const role = args.pluginMetadata?.role;
    const id = role === "coordinator" ? "thr-coordinator" : role === "repo" ? "thr-repo" :
      role === "unassigned-root" ? "thr-unassigned" : role === "unassigned-repo" ? "thr-unassigned-repo" :
      ++spawned === 1 ? "thr-rebasing" : `thr-worker-${spawned}`;
    const thread = { ...makeThreadResponse({ id, projectId: args.projectId, title: args.title, originPluginId: "workstreams",
      providerId: args.providerId, status: role === "coordinator" ? "idle" : "active" }), parentThreadId: args.parentThreadId ?? null,
      environment: { hostId: args.environment.hostId }, environmentPath: args.environment.workspace?.path ?? null,
      environmentHostId: args.environment.hostId ?? null };
    threadMetadata.set(thread.id, args.pluginMetadata ?? {});
    threads.set(thread.id, thread); return thread;
  });
  const send = vi.fn(async () => ({} as never));
  const { bb, harness } = createFakePluginHost({ pluginId: "workstreams", settings: { scanRoots: "/p" }, sdk: {
    system: { config: async () => ({ primaryHostId: HOST }) as never },
    projects: { list: async () => [{ id: "project-example", name: "Example", sources: [{ hostId: HOST, path: "/p" }] }] as never },
    threads: {
      list: async () => (options.omitLaunchedThreadsFromList ? [] : [...threads.values()].map((thread) => ({ ...thread,
        queuedWork: "none", hasPendingInteraction: false, activity: { activeBackgroundAgentCount: 0,
          activeBackgroundCommandCount: 0, activeGoalCount: 0, activePlanModeCount: 0, activeWorkflowCount: 0 } }))) as never, spawn, send,
      get: async ({ threadId }: { threadId: string }) => ({ ...threads.get(threadId)!, canSpawnChild: true }) as never,
      update: async ({ threadId, parentThreadId, title }: { threadId: string; parentThreadId?: string | null; title?: string | null }) => {
        const thread = { ...threads.get(threadId)!, ...(parentThreadId !== undefined ? { parentThreadId } : {}),
          ...(title !== undefined ? { title } : {}) };
        threads.set(threadId, thread);
        return thread as never;
      },
      getPluginMetadata: async ({ threadId }: { threadId: string }) => (threadMetadata.get(threadId) ?? {}) as never, output: async () => ({ output: "" }),
      context: async () => ({ usage: null }) as never, events: { list: async () => [] }, interactions: { list: async () => [] as never },
    },
  }, experimental_callHostRpc: async ({ method, input }) => {
    calls.push({ method, input });
    if (method === "contextWorkspace") return { path: `/synthetic/workstreams/context/${++contextWorkspaces}` };
    if (method === "scan" || method === "inspectPaths") return { units: [unit], warnings: [] };
    if (method === "authoredPrs") return { owners: [repo.split("/")[0]], entries: [{ repo, pr }], discoveryComplete: true,
      repositories: [{ repo, complete: true }], complete: true, warnings: [] };
    if (method === "equalHeadTrees") return { ok: true, priorTreeOid: "c".repeat(40), currentTreeOid: "c".repeat(40) };
    if (method === "prLive") return { ok: true, live: { state: pr.state, isDraft: false, reviewDecision: pr.reviewDecision,
      mergeStateStatus: pr.mergeStateStatus, headRefOid: pr.headRefOid, stackedAbove: [], unresolvedThreads: 0,
      unresolvedAtLeast: false, approvalNotes: [], approvalNotesMore: 0, approvalNotesComplete: true,
      approvalFeedback: { status: "none", fingerprint: null, sourceIds: [] }, reviewFeedback: { openThreads: 0, comment: null, repliedAt: null, noteAt: null, followUpAt: null } } };
    if (method === "inspectPrs") return { entries: [{ repo, pr }], closed: [], failed: [], warnings: [] };
    throw new Error(`Unexpected host method ${method}`);
  } });
  if (options.legacyJob) {
    // A job the removed Advance engine saved mid-run: its worker's outcome was never confirmed.
    const db = bb.storage.database();
    db.prepare("CREATE TABLE IF NOT EXISTS advance_batches (id TEXT PRIMARY KEY, body TEXT NOT NULL)").run();
    const job = { prUrl: url, repo, number: 42, title: pr.title, headOid: HEAD, baseOid: BASE, baseRefName: "main", headRefName: "abc-42-lookup",
      needsPreparation: true, needsFeedback: false, needsChecks: false, eligible: true, detail: "Working on branch preparation in the repository thread",
      workspace: "create", id: LEGACY_JOB, status: options.legacyJob, threadId: "thr-legacy", path: "/synthetic/workstreams/batch/repo/job", checkedHeadOid: null,
      updatedAt: Date.now() };
    db.prepare("INSERT INTO advance_batches (id, body) VALUES (?, ?)").run(LEGACY_BATCH, JSON.stringify({ id: LEGACY_BATCH, createdAt: Date.now(), cancelled: false,
      jobs: [job], facts: { [LEGACY_JOB]: { path: PATH } } }));
  }
  await plugin(bb); cleanups.push(() => harness.lifecycle.dispose());
  expect((await harness.runCli(["refresh"])).exitCode).toBe(0);
  return { bb, harness, calls, spawn, send, pr, unit, url, threads };
}

describe("manual PR workers and refresh", () => {
  it("carries complete saved feedback across a code-identical head during a targeted read-only refresh", async () => {
    const env = await setup({ ready: true });
    const snapshot = { status: "present" as const, fingerprint: "f".repeat(64), sourceIds: ["approval-42"] };
    Object.assign(env.pr, { approvalFeedback: snapshot });
    const record = { prUrl: env.url, threadId: "thr-old", attemptId: "attempt-old", headOid: HEAD,
      fingerprint: snapshot.fingerprint, findings: [{ sourceId: "approval-42", resolution: "already-satisfied",
        evidence: "The current fallback handles the reviewed case in src/fallback.ts.",
        validation: { outcome: "passed", detail: "Focused fallback test passed." } }], blockers: [], verifiedAt: 1_000,
      provenance: { kind: "worker" } };
    env.bb.storage.database().prepare("INSERT INTO approval_feedback_verifications (pr_url, body) VALUES (?, ?)")
      .run(env.url, JSON.stringify(record));
    const freshHead = "d".repeat(40);
    env.pr.headRefOid = freshHead;
    const refreshed = await env.harness.callRpc("pr_refresh", { prUrl: env.url });
    expect(refreshed).toMatchObject({ status: "checked" });
    expect(env.calls.some((call) => call.method === "equalHeadTrees")).toBe(true);
    const saved = env.bb.storage.database().prepare("SELECT body FROM approval_feedback_verifications WHERE pr_url = ?")
      .get(env.url) as { body: string };
    expect(JSON.parse(saved.body)).toMatchObject({ headOid: freshHead, verifiedAt: 1_000,
      equivalence: { sourceHeadOid: HEAD, sourceVerifiedAt: 1_000, treeOid: "c".repeat(40) } });
    const board = await env.harness.callRpc("board_get", null) as { prInventory: { entries: { pr: { approvalFeedbackVerified: boolean } }[] } };
    expect(board.prInventory.entries[0]?.pr.approvalFeedbackVerified).toBe(true);
  });

  it("previews and starts an inferred-effort manual PR worker beneath its repository controller", async () => {
    const env = await setup();
    const plan = await env.harness.callRpc("agent_plan", { path: PATH, action: "resolve-conflicts" }) as
      { recommendation: { mode: string; threadId: string | null } };
    expect(plan.recommendation).toMatchObject({ mode: "new", threadId: null });
    expect(env.spawn).not.toHaveBeenCalled();
    expect(await env.harness.callRpc("agent_run", { path: PATH, action: "resolve-conflicts", mode: "new", threadId: null,
      prompt: "Repair the checkout." })).toMatchObject({ ok: true, threadId: "thr-rebasing" });
    expect(env.spawn.mock.calls.map((call) => call[0].pluginMetadata.role)).toEqual(["coordinator", "repo", "pr"]);
    expect(env.spawn.mock.calls[2]?.[0].parentThreadId).toBe("thr-repo");
    const again = await env.harness.callRpc("agent_plan", { path: PATH, action: "resolve-conflicts" }) as
      { recommendation: { mode: string; threadId: string | null } };
    expect(again.recommendation).toMatchObject({ mode: "subthread", threadId: "thr-repo" });
  });

  it("starts a ticketless manual PR worker beneath the shared unassigned repository parent", async () => {
    const env = await setup();
    env.pr.title = "Fix account lookup";
    env.pr.headRefName = "fix-account-lookup";
    env.unit.branch = "fix-account-lookup";
    await env.harness.runCli(["refresh"]);
    const plan = await env.harness.callRpc("agent_plan", { path: PATH, action: "resolve-conflicts" }) as
      { recommendation: { mode: string; threadId: string | null } };
    expect(plan.recommendation).toMatchObject({ mode: "new", threadId: null });
    expect(await env.harness.callRpc("agent_run", { path: PATH, action: "resolve-conflicts", mode: "new", threadId: null,
      prompt: "Repair the checkout." })).toMatchObject({ ok: true });
    expect(env.spawn.mock.calls.map((call) => call[0].pluginMetadata.role)).toEqual(["unassigned-root", "unassigned-repo", "pr"]);
    expect(env.spawn.mock.calls[2]?.[0].parentThreadId).toBe("thr-unassigned-repo");
    expect(await env.harness.callRpc("agent_plan", { path: PATH, action: "resolve-conflicts" })).toMatchObject({
      recommendation: { mode: "subthread", threadId: "thr-unassigned-repo" } });
  });

  it("keeps a ticketless checkout preview and manual launch under the same unassigned root", async () => {
    const env = await setup();
    env.unit.pr = null;
    env.unit.branch = "draft";
    env.unit.githubRepo = null;
    await env.harness.runCli(["refresh"]);
    expect(await env.harness.callRpc("agent_plan", { path: PATH, action: "investigate-ci" })).toMatchObject({
      ok: true, recommendation: { mode: "new", threadId: null } });
    expect(await env.harness.callRpc("agent_run", { path: PATH, action: "investigate-ci", mode: "new", threadId: null,
      prompt: "Inspect this checkout." })).toMatchObject({ ok: true });
    expect(env.spawn.mock.calls[0]?.[0]).toMatchObject({ title: "Unassigned work", pluginMetadata: { role: "unassigned-root" } });
    expect(env.spawn.mock.calls[1]?.[0].parentThreadId).toBe("thr-unassigned");
    expect(await env.harness.callRpc("agent_plan", { path: PATH, action: "investigate-ci" })).toMatchObject({
      ok: true, recommendation: { mode: "subthread", threadId: "thr-unassigned" } });
  });

  it("places a pre-PR checkout with a known repository beneath its repository parent", async () => {
    const env = await setup();
    env.unit.pr = null;
    env.unit.branch = "draft";
    await env.harness.runCli(["refresh"]);
    expect(await env.harness.callRpc("agent_plan", { path: PATH, action: "investigate-ci" })).toMatchObject({
      ok: true, recommendation: { mode: "new", threadId: null } });
    expect(await env.harness.callRpc("agent_run", { path: PATH, action: "investigate-ci", mode: "new", threadId: null,
      prompt: "Inspect this checkout." })).toMatchObject({ ok: true });
    expect(env.spawn.mock.calls.map((call) => call[0].pluginMetadata.role)).toEqual(["unassigned-root", "unassigned-repo", "checkout"]);
    expect(env.spawn.mock.calls[2]?.[0].parentThreadId).toBe("thr-unassigned-repo");
    expect(await env.harness.callRpc("agent_plan", { path: PATH, action: "investigate-ci" })).toMatchObject({
      ok: true, recommendation: { mode: "subthread", threadId: "thr-unassigned-repo" } });
  });

  it("keeps a newly launched author thread busy before its lifecycle events reach the board", async () => {
    const env = await setup({ omitLaunchedThreadsFromList: true });
    expect(await env.harness.callRpc("thread_start", { path: PATH, prompt: "Rebase this PR" }))
      .toMatchObject({ ok: true, threadId: "thr-rebasing" });
    // The effort parent and repository controller are created before the PR worker.
    expect(env.spawn).toHaveBeenCalledTimes(3);
    expect(env.spawn.mock.calls.map(([args]) => args.pluginMetadata?.role)).toEqual(["coordinator", "repo", "pr"]);
    expect(env.spawn.mock.calls[0]?.[0].environment).toMatchObject({ type: "host", hostId: HOST,
      workspace: { type: "unmanaged", path: "/synthetic/workstreams/context/1" } });
    expect(env.spawn.mock.calls[1]?.[0].parentThreadId).toBe("thr-coordinator");
    expect(env.spawn.mock.calls[1]?.[0].environment).toMatchObject({ type: "host", hostId: HOST,
      workspace: { type: "unmanaged", path: "/synthetic/workstreams/context/2" } });
    expect(env.spawn.mock.calls[2]?.[0].parentThreadId).toBe("thr-repo");
    expect(env.spawn.mock.calls[2]?.[0].environment).toMatchObject({ workspace: { path: PATH } });
  });

  it("starts a manual PR worker on the Code-work model, because it hands the thread code work", async () => {
    const env = await setup();
    await env.harness.behavior.setSettings({ codeModel: "claude-code/claude-opus/high" });
    expect(await env.harness.callRpc("agent_run", { path: PATH, action: "resolve-conflicts", mode: "new", threadId: null,
      prompt: "Repair the checkout." })).toMatchObject({ ok: true });
    expect(env.spawn.mock.calls.at(-1)![0]).toMatchObject({ providerId: "claude-code", model: "claude-opus", reasoningLevel: "high",
      pluginMetadata: { role: "pr" } });
  });

  it("keeps a legacy Advance job that never settled fencing its PR from manual agent and GitHub actions", async () => {
    const env = await setup({ legacyJob: "running" });
    const owned = "A batch or another action owns this PR or checkout.";
    expect(await env.harness.callRpc("agent_run", { path: PATH, action: "resolve-conflicts", mode: "new", threadId: null, prompt: "Rebase this PR" }))
      .toEqual({ ok: false, error: owned });
    expect(await env.harness.callRpc("action_update_branch", { prUrl: env.url })).toEqual({ ok: false, error: "A batch or another action owns this PR." });
    expect(await env.harness.callRpc("thread_start", { path: PATH, prompt: "Rebase this PR" })).toEqual({ ok: false, error: owned });
    expect(env.calls.some((call) => call.method === "prWrite")).toBe(false);
    expect([env.spawn.mock.calls, env.send.mock.calls]).toEqual([[], []]);
  });
});
