import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RawUnit } from "./contract.js";
import type { AdvanceFacts } from "./advance-contract.js";
import { advancePreviewJobSchema, type AdvanceBatch, type AdvancePreview, type AdvanceRepairPlan } from "./bulk-advance.js";
import { parsePrList } from "./gh.js";
import { createEffortStore } from "./effort-store.js";
import plugin from "./server.js";

const PATH = "/p/widget-checkout";
const HOST = "host-example";
const HEAD = "a".repeat(40), BASE = "b".repeat(40);
const PLACEMENT_BATCH = "00000000-0000-4000-8000-000000000042";
const PLACEMENT_JOB = "00000000-0000-4000-8000-000000000043";
const PLACEMENT_ATTEMPT = "00000000-0000-4000-8000-000000000046";
const OBSERVATION_BATCH = "00000000-0000-4000-8000-000000000052";
const OBSERVATION_JOB = "00000000-0000-4000-8000-000000000053";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.useRealTimers(); });

async function setup(options: { remoteOnly?: boolean; mixedCase?: boolean; ready?: boolean; fork?: boolean; projectAvailable?: boolean; omitLaunchedThreadsFromList?: boolean; feedback?: "threads" | "approval-note"; failFirstWorkspace?: boolean; author?: boolean; terminal?: "MERGED" | "CLOSED"; savedBatch?: { id: string; body: string }; misparentWorker?: boolean; seedPlacementRepair?: boolean; seedPlacementRepairAttempt?: boolean; seedUncertainConflict?: boolean; seedObservationJob?: "never-launched" | "failed-worker"; duplicateScanUnit?: boolean } = {}) {
  const repo = options.mixedCase ? "Example/Widget" : "example/widget";
  const url = `https://github.com/${repo}/pull/42`;
  const pr = { ...parsePrList(JSON.stringify([{ number: 42, url, state: options.terminal ?? "OPEN", title: "ABC-42 Fix account lookup", reviewDecision: "APPROVED",
    isDraft: false, headRefName: "abc-42-lookup", baseRefName: "main", headRefOid: HEAD, baseRefOid: BASE, mergeStateStatus: options.ready ? "CLEAN" : "DIRTY",
    mergeable: options.ready ? "MERGEABLE" : "CONFLICTING", statusCheckRollup: [{ conclusion: "SUCCESS" }], latestReviews: [], reviewRequests: [] }]))!.pr,
    unresolvedReviewThreads: options.feedback === "threads" ? 1 : 0, resolvedReviewThreads: 0 };
  const unit: RawUnit = { path: PATH, dirName: "widget-checkout", repo: "Widget", githubRepo: repo, branch: options.remoteOnly ? "main" : "abc-42-lookup",
    dirty: false, ahead: 0, behind: 0, lastCommitAt: null, defaultBranch: "main", pr: options.remoteOnly ? null : pr,
    shipped: null, changedPaths: [], observed: { status: true, pr: true } };
  const facts: AdvanceFacts = { prUrl: url, number: 42, title: pr.title, repo, headRefName: "abc-42-lookup", baseRefName: "main", headOid: HEAD, baseOid: BASE,
    state: options.terminal ?? "OPEN", isDraft: false, isCrossRepository: options.fork ?? false, reviewDecision: "APPROVED", mergeStateStatus: options.ready ? "CLEAN" : "DIRTY",
    mergeable: options.ready ? "MERGEABLE" : "CONFLICTING", needsPreparation: !options.ready, readiness: options.terminal === "MERGED" ? "merged" : options.terminal === "CLOSED" ? "closed" : options.ready && !options.feedback ? "ready" : "needs-attention",
    detail: options.feedback ? "Review feedback needs attention" : options.ready ? "Approved and ready to merge" : "Resolve branch conflicts",
    unresolvedThreads: options.feedback === "threads" ? 1 : 0, threadsComplete: true, checks: "passed", basePrNumber: null,
    approvalFeedback: options.feedback === "approval-note"
      ? { status: "present", fingerprint: "f".repeat(64), sourceIds: ["approval-42"] }
      : { status: "none", fingerprint: null, sourceIds: [] } };
  const calls: { method: string; input: unknown }[] = [];
  const beforeWorkspace = vi.fn(async () => {});
  const beforeAnchor = vi.fn(async () => {});
  const beforePlacementUpdate = vi.fn(async () => {});
  const afterPlacementUpdate = vi.fn(async () => {});
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const threadMetadata = new Map<string, Record<string, unknown>>();
  if (options.author) threads.set("thr-author", makeThreadResponse({ id: "thr-author", title: "ABC-42 Fix account lookup", projectId: "project-example", status: "idle" }));
  if (options.seedPlacementRepair) {
    threads.set("thr-legacy", { ...makeThreadResponse({ id: "thr-legacy", projectId: "project-example", status: "idle", originPluginId: "workstreams" }),
      environment: { hostId: HOST } } as ReturnType<typeof makeThreadResponse>);
    threadMetadata.set("thr-legacy", options.seedPlacementRepairAttempt
      ? { role: "advance-repair", advanceJobId: PLACEMENT_ATTEMPT, prUrl: url }
      : { role: "rebase-worker", advanceJobId: PLACEMENT_JOB });
  }
  const blockedParents = new Set<string>();
  let spawned = 0, workspaces = 0, contextWorkspaces = 0;
  const spawn = vi.fn(async (args: Record<string, any>) => {
    const role = args.pluginMetadata?.role;
    if (role === "unassigned-repo") await beforeAnchor();
    const id = role === "coordinator" ? "thr-coordinator" : role === "repo" ? "thr-repo" :
      role === "unassigned-root" ? "thr-unassigned" : role === "unassigned-repo" ? "thr-unassigned-repo" :
      ++spawned === 1 ? "thr-rebasing" : `thr-repair-${spawned}`;
    const thread = { ...makeThreadResponse({ id, projectId: args.projectId, title: args.title, originPluginId: "workstreams",
      providerId: args.providerId,
      status: role === "coordinator" ? "idle" : "active" }), parentThreadId: options.misparentWorker && role === "rebase-worker" ? null : args.parentThreadId ?? null,
      environment: { hostId: args.environment.hostId }, environmentPath: args.environment.workspace?.path ?? null,
      environmentHostId: args.environment.hostId ?? null };
    threadMetadata.set(thread.id, args.pluginMetadata ?? {});
    threads.set(thread.id, thread); return thread;
  });
  const send = vi.fn(async () => ({} as never));
  const { bb, harness } = createFakePluginHost({ pluginId: "workstreams", settings: { scanRoots: "/p" }, sdk: {
    system: { config: async () => ({ primaryHostId: HOST }) as never },
    projects: { list: async () => (options.projectAvailable === false ? [] : [{ id: "project-example", name: "Example", sources: [{ hostId: HOST, path: "/p" }] }]) as never },
    threads: {
      list: async () => (options.omitLaunchedThreadsFromList ? [] : [...threads.values()].map((thread) => ({ ...thread,
        queuedWork: "none", hasPendingInteraction: false, activity: { activeBackgroundAgentCount: 0,
          activeBackgroundCommandCount: 0, activeGoalCount: 0, activePlanModeCount: 0, activeWorkflowCount: 0 } }))) as never, spawn, send,
      get: async ({ threadId }: { threadId: string }) => ({ ...threads.get(threadId)!, canSpawnChild: !blockedParents.has(threadId) }) as never,
      update: async ({ threadId, parentThreadId, title }: { threadId: string; parentThreadId?: string | null; title?: string | null }) => {
        await beforePlacementUpdate();
        const thread = { ...threads.get(threadId)!, ...(parentThreadId !== undefined ? { parentThreadId } : {}),
          ...(title !== undefined ? { title } : {}) };
        threads.set(threadId, thread);
        await afterPlacementUpdate();
        return thread as never;
      },
      getPluginMetadata: async ({ threadId }: { threadId: string }) => (threadMetadata.get(threadId) ?? {}) as never, output: async () => ({ output: "" }),
      context: async () => ({ usage: null }) as never, events: { list: async () => [] }, interactions: { list: async () => [] as never },
    },
  }, experimental_callHostRpc: async ({ method, input }) => {
    calls.push({ method, input });
    if (method === "contextWorkspace") return { path: `/synthetic/workstreams/context/${++contextWorkspaces}` };
    if (method === "scan" || method === "inspectPaths") return { units: options.duplicateScanUnit
      ? [unit, { ...unit, path: `${PATH}-duplicate`, dirName: "widget-checkout-duplicate" }] : [unit], warnings: [] };
    if (method === "authoredPrs") return { owners: [repo.split("/")[0]], entries: pr.state === "OPEN" ? [{ repo, pr }] : [], discoveryComplete: true,
      repositories: [{ repo, complete: true }], complete: true, warnings: [] };
    if (method === "advanceInspect") return { ok: true, facts };
    if (method === "equalHeadTrees") return { ok: true, priorTreeOid: "c".repeat(40), currentTreeOid: "c".repeat(40) };
    if (method === "prLive") return { ok: true, live: { state: pr.state, isDraft: false, reviewDecision: pr.reviewDecision,
      mergeStateStatus: pr.mergeStateStatus, headRefOid: pr.headRefOid, stackedAbove: [], unresolvedThreads: 0,
      unresolvedAtLeast: false, approvalNotes: [], approvalNotesMore: 0, approvalNotesComplete: true,
      approvalFeedback: { status: "none", fingerprint: null, sourceIds: [] }, reviewFeedback: { openThreads: 0, comment: null, repliedAt: null, noteAt: null, followUpAt: null } } };
    if (method === "inspectPrs") return facts.state === "OPEN"
      ? { entries: [{ repo, pr }], closed: [], failed: [], warnings: [] }
      : { entries: [], closed: [url], failed: [], warnings: [] };
    if (method === "advanceWorkspace") {
      await beforeWorkspace();
      workspaces++;
      if (options.failFirstWorkspace && workspaces === 1) return { ok: false, error: "The fetched PR base changed. No checkout was created." };
      return { ok: true, path: `/synthetic/workstreams/batch/repo/${workspaces === 1 ? "job" : (input as { jobId: string }).jobId}`, workerPath: "/synthetic/workstreams/batch/repo", sourcePath: PATH, created: true };
    }
    throw new Error(`Unexpected host method ${method}`);
  } });
  if (options.savedBatch) {
    const db = bb.storage.database();
    db.prepare("CREATE TABLE IF NOT EXISTS advance_batches (id TEXT PRIMARY KEY, body TEXT NOT NULL)").run();
    db.prepare("INSERT INTO advance_batches (id, body) VALUES (?, ?)").run(options.savedBatch.id, options.savedBatch.body);
  }
  if (options.seedPlacementRepair) {
    const db = bb.storage.database();
    db.prepare("CREATE TABLE IF NOT EXISTS advance_batches (id TEXT PRIMARY KEY, body TEXT NOT NULL)").run();
    const job = { ...advancePreviewJobSchema.parse({ ...facts, eligible: true, workspace: "create" }), id: PLACEMENT_JOB, hiddenFromProgress: false,
      status: "needs-attention", attemptId: options.seedPlacementRepairAttempt ? PLACEMENT_ATTEMPT : null,
      dedicated: options.seedPlacementRepairAttempt ?? false, previousAttempts: [], threadId: "thr-legacy",
      path: PATH, checkedHeadOid: null, updatedAt: Date.now(), uncertain: false };
    const routing = { ...facts, eligible: true, workspace: "create", projectId: "project-example", hostId: HOST, sourcePath: PATH, path: PATH,
      effortId: null, effortKey: null, effortMembers: null, needsFeedback: false, needsChecks: false, blockedBy: null };
    const competingId = "00000000-0000-4000-8000-000000000045";
    const competing = { ...job, id: competingId, threadId: "thr-other", uncertain: true };
    db.prepare("INSERT INTO advance_batches (id, body) VALUES (?, ?)").run(PLACEMENT_BATCH, JSON.stringify({ id: PLACEMENT_BATCH,
      token: "00000000-0000-4000-8000-000000000044", createdAt: Date.now(), cancelled: false,
      jobs: options.seedUncertainConflict ? [job, competing] : [job],
      facts: { [PLACEMENT_JOB]: routing, ...(options.seedUncertainConflict ? { [competingId]: routing } : {}) },
      pollUntil: Date.now() + 60_000, prepared: {}, repairs: {} }));
  }
  if (options.seedObservationJob) {
    const db = bb.storage.database();
    db.prepare("CREATE TABLE IF NOT EXISTS advance_batches (id TEXT PRIMARY KEY, body TEXT NOT NULL)").run();
    const job = { ...advancePreviewJobSchema.parse({ ...facts, eligible: true, workspace: "create" }), id: OBSERVATION_JOB,
      status: "needs-attention", attemptId: null, dedicated: false, previousAttempts: [],
      threadId: options.seedObservationJob === "failed-worker" ? "thr-failed" : null, path: PATH,
      detail: options.seedObservationJob === "failed-worker" ? "Worker reported incomplete work or failed validation" : "PR changed before launch",
      checkedHeadOid: null, updatedAt: Date.now(), uncertain: false };
    const routing = { ...facts, eligible: true, workspace: "create", projectId: "project-example", hostId: HOST, sourcePath: PATH, path: PATH,
      effortId: null, effortKey: null, effortMembers: null, needsFeedback: false, needsChecks: false, blockedBy: null };
    db.prepare("INSERT INTO advance_batches (id, body) VALUES (?, ?)").run(OBSERVATION_BATCH, JSON.stringify({ id: OBSERVATION_BATCH,
      token: "00000000-0000-4000-8000-000000000054", createdAt: Date.now(), cancelled: false,
      jobs: [job], facts: { [OBSERVATION_JOB]: routing }, pollUntil: Date.now() + 60_000, prepared: {}, repairs: {} }));
  }
  await plugin(bb); cleanups.push(() => harness.lifecycle.dispose());
  expect((await harness.runCli(["refresh"])).exitCode).toBe(0);
  return { bb, harness, calls, spawn, send, facts, pr, unit, url, threads, threadMetadata, blockedParents, beforeWorkspace,
    beforeAnchor, beforePlacementUpdate, afterPlacementUpdate,
    savedBatch: (id: string) => bb.storage.database().prepare("SELECT id, body FROM advance_batches WHERE id = ?").get(id) as { id: string; body: string }, preview: async (prUrl = url) => await harness.callRpc("advance_preview", { prUrls: [prUrl] }) as AdvancePreview };
}

/** An established effort whose coordinator and repository controller already exist on the default provider. */
async function seedRepoController(env: Awaited<ReturnType<typeof setup>>) {
  const board = await env.harness.callRpc("board_get", null) as { groups: { key: string; name: string; level: string; clusters: { ticket: string }[] }[] };
  const group = board.groups.find((entry) => entry.level === "effort" && entry.clusters.some((cluster) => cluster.ticket === "ABC-42"))!;
  const store = createEffortStore(env.bb.storage.database());
  const effort = store.establish({ sourceKey: group.key, name: group.name, goal: "", projectId: "project-example",
    members: { tickets: ["ABC-42"], prUrls: [env.url] }, coordinatorState: "none" });
  store.save({ ...effort, coordinatorThreadId: "thr-coordinator", coordinatorState: "ready" });
  env.threads.set("thr-coordinator", makeThreadResponse({ id: "thr-coordinator", projectId: "project-example", status: "idle", providerId: "codex" }));
  env.threads.set("thr-repo", { ...makeThreadResponse({ id: "thr-repo", projectId: "project-example", status: "idle", providerId: "codex" }),
    parentThreadId: "thr-coordinator", environment: { hostId: HOST } } as never);
  const record = store.claimRepoController({ effortId: effort.id, repo: "example/widget", projectId: "project-example", hostId: HOST });
  store.saveRepoController({ ...record.record, threadId: "thr-repo", state: "ready" });
}

async function failedBatch(env: Awaited<ReturnType<typeof setup>>) {
  const batch = await env.harness.callRpc("advance_start", { token: (await env.preview()).token }) as AdvanceBatch;
  await vi.waitFor(async () => expect(await env.harness.callRpc("advance_get", null)).toMatchObject([{ jobs: [{ status: "needs-attention" }] }]));
  return { batchId: batch.id, jobId: batch.jobs[0]!.id };
}

describe("bulk advance server integration", () => {
  it("reconciles a never-launched saved job on fresh PR observations without spawning a worker", async () => {
    const env = await setup({ seedObservationJob: "never-launched", duplicateScanUnit: true });
    const nextHead = "c".repeat(40);
    Object.assign(env.pr, { headRefOid: nextHead, reviewDecision: "", mergeStateStatus: "CLEAN", mergeable: "MERGEABLE" });
    Object.assign(env.facts, { headOid: nextHead, reviewDecision: "", mergeStateStatus: "CLEAN", mergeable: "MERGEABLE",
      needsPreparation: false, readiness: "waiting-review", detail: "Waiting for approval on the current PR" });

    expect(await env.harness.callRpc("pr_refresh", { prUrl: env.url })).toMatchObject({ status: "checked" });
    expect(await env.harness.callRpc("advance_get", null)).toMatchObject([{ id: OBSERVATION_BATCH,
      jobs: [{ id: OBSERVATION_JOB, status: "waiting-review", checkedHeadOid: nextHead, threadId: null }] }]);
    expect(env.spawn).not.toHaveBeenCalled();
    const inspected = env.calls.filter((call) => call.method === "advanceInspect").length;
    expect((await env.harness.runCli(["refresh"])).exitCode).toBe(0);
    expect(env.calls.filter((call) => call.method === "advanceInspect")).toHaveLength(inspected);

    Object.assign(env.pr, { reviewDecision: "APPROVED", approvalFeedback: { status: "none", fingerprint: null, sourceIds: [] } });
    Object.assign(env.facts, { reviewDecision: "APPROVED", readiness: "ready", detail: "Approved and ready to merge" });
    const beforeApproval = env.calls.filter((call) => call.method === "advanceInspect").length;
    expect((await env.harness.runCli(["refresh"])).exitCode).toBe(0);
    expect(env.calls.filter((call) => call.method === "advanceInspect")).toHaveLength(beforeApproval + 1);
    expect(await env.harness.callRpc("advance_get", null)).toMatchObject([{ id: OBSERVATION_BATCH,
      jobs: [{ id: OBSERVATION_JOB, status: "ready", detail: "Approved and ready to merge", threadId: null }] }]);
    expect(env.spawn).not.toHaveBeenCalled();
  });

  it("does not clear a failed worker when a fresh PR observation looks ready", async () => {
    const env = await setup({ seedObservationJob: "failed-worker" });
    const inspected = env.calls.filter((call) => call.method === "advanceInspect").length;
    Object.assign(env.pr, { mergeStateStatus: "CLEAN", mergeable: "MERGEABLE" });
    Object.assign(env.facts, { mergeStateStatus: "CLEAN", mergeable: "MERGEABLE", needsPreparation: false,
      readiness: "ready", detail: "Approved and ready to merge" });

    expect(await env.harness.callRpc("pr_refresh", { prUrl: env.url })).toMatchObject({ status: "checked" });
    expect(await env.harness.callRpc("advance_get", null)).toMatchObject([{ id: OBSERVATION_BATCH,
      jobs: [{ id: OBSERVATION_JOB, status: "needs-attention", threadId: "thr-failed",
        detail: "Worker reported incomplete work or failed validation" }] }]);
    expect(env.calls.filter((call) => call.method === "advanceInspect")).toHaveLength(inspected);
    expect(env.spawn).not.toHaveBeenCalled();
  });

  it("carries complete saved feedback across a code-identical head during a targeted read-only refresh", async () => {
    const env = await setup({ ready: true, feedback: "approval-note" });
    const snapshot = env.facts.approvalFeedback;
    if (!snapshot || snapshot.status !== "present") throw new Error("Expected synthetic approval feedback");
    Object.assign(env.pr, { approvalFeedback: snapshot });
    const record = { prUrl: env.url, threadId: "thr-old", attemptId: "attempt-old", headOid: HEAD,
      fingerprint: snapshot.fingerprint, findings: [{ sourceId: "approval-42", resolution: "already-satisfied",
        evidence: "The current fallback handles the reviewed case in src/fallback.ts.",
        validation: { outcome: "passed", detail: "Focused fallback test passed." } }], blockers: [], verifiedAt: 1_000,
      provenance: { kind: "worker" } };
    env.bb.storage.database().prepare("INSERT INTO approval_feedback_verifications (pr_url, body) VALUES (?, ?)")
      .run(env.url, JSON.stringify(record));
    const freshHead = "d".repeat(40);
    env.pr.headRefOid = freshHead; env.facts.headOid = freshHead;
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
  it("automatically retires a saved failed item when complete discovery loses its merged PR", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const env = await setup({ remoteOnly: true, failFirstWorkspace: true });
    await failedBatch(env);
    env.pr.state = "MERGED";
    Object.assign(env.facts, { state: "MERGED", readiness: "merged", detail: "GitHub confirms this PR merged" });
    await env.harness.runCli(["refresh"]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await env.harness.callRpc("advance_get", null)).toMatchObject([{ jobs: [{ status: "merged", hiddenFromProgress: true }] }]);
    const inspections = env.calls.filter((call) => call.method === "inspectPrs").length;
    await vi.advanceTimersByTimeAsync(6_000);
    expect(env.calls.filter((call) => call.method === "inspectPrs")).toHaveLength(inspections);
    expect(env.spawn).not.toHaveBeenCalled();
  });
  it("reconciles a saved item missing from inventory once on startup", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const previous = await setup({ remoteOnly: true, failFirstWorkspace: true });
    const ids = await failedBatch(previous);
    const savedBatch = previous.savedBatch(ids.batchId);
    await previous.harness.lifecycle.dispose();
    const env = await setup({ remoteOnly: true, terminal: "CLOSED", savedBatch });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await env.harness.callRpc("advance_get", null)).toMatchObject([{ jobs: [{ status: "closed", hiddenFromProgress: true }] }]);
    expect(env.calls.filter((call) => call.method === "inspectPrs")).toHaveLength(1);
    expect(env.spawn).not.toHaveBeenCalled();
  });
  it("blocks Advance if Hold arrives while the separate checkout is being prepared", async () => {
    const env = await setup();
    env.beforeWorkspace.mockImplementationOnce(async () => { await env.harness.callRpc("pr_hold_set", { prUrl: env.url, held: true }); });
    const batch = await env.harness.callRpc("advance_start", { token: (await env.preview()).token }) as AdvanceBatch;
    await vi.waitFor(async () => expect(await env.harness.callRpc("advance_get", null)).toMatchObject([{ id: batch.id, jobs: [{ status: "needs-attention", uncertain: false, detail: expect.stringContaining("On hold") }] }]));
    expect(env.spawn).not.toHaveBeenCalled();
    expect(env.send).not.toHaveBeenCalled();
  });
  it("does not stop a worker that was already running when a PR is held", async () => {
    const env = await setup();
    await env.harness.callRpc("advance_start", { token: (await env.preview()).token });
    await vi.waitFor(() => expect(env.send).toHaveBeenCalledOnce());
    await env.harness.callRpc("pr_hold_set", { prUrl: env.url, held: true });
    expect(await env.harness.callRpc("advance_get", null)).toMatchObject([{ jobs: [{ status: "running", threadId: "thr-repo" }] }]);
    expect(env.send).toHaveBeenCalledOnce();
  });
  it("starts the repository controller on the Code-work provider, because Advance hands it code work", async () => {
    const env = await setup();
    await env.harness.behavior.setSettings({ codeModel: "claude-code/claude-opus/high" });
    await env.harness.callRpc("advance_start", { token: (await env.preview()).token });
    await vi.waitFor(() => expect(env.send).toHaveBeenCalledOnce());
    expect(env.spawn.mock.calls.map(([args]) => [args.pluginMetadata.role, args.providerId, args.model, args.reasoningLevel])).toEqual([
      ["coordinator", "codex", "gpt-6-sol", "medium"], ["repo", "claude-code", "claude-opus", "high"]]);
    expect(env.spawn.mock.calls[0]![0].prompt).toContain("claude-code/claude-opus/high for work agents and codex/gpt-6-sol/medium for planning agents");
    expect(env.spawn.mock.calls[1]![0].prompt).toContain("claude-code/claude-opus/high for work agents and codex/gpt-6-sol/medium for planning agents");
    expect(env.send).toHaveBeenCalledWith(expect.objectContaining({ threadId: "thr-repo", model: "claude-opus", reasoningLevel: "high" }));
    expect(await env.harness.callRpc("advance_get", null)).toMatchObject([{ jobs: [{ status: "running", threadId: "thr-repo", uncertain: false }] }]);
  });
  it("refuses a controller on another provider before recording a launch, so no uncertain owner blocks the PR", async () => {
    const env = await setup();
    await seedRepoController(env);
    await env.harness.behavior.setSettings({ codeModel: "claude-code/claude-opus/high" });
    await env.harness.callRpc("advance_start", { token: (await env.preview()).token });
    await vi.waitFor(async () => expect(await env.harness.callRpc("advance_get", null)).toMatchObject([{ jobs: [{ status: "needs-attention",
      uncertain: false, detail: expect.stringContaining("repository controller runs on another provider") }] }]));
    expect(env.spawn).not.toHaveBeenCalled();
    expect(env.send).not.toHaveBeenCalled();
  });
  it("rechecks a saved failed PR after it leaves tracked inventory and confirms it merged", async () => {
    const env = await setup({ remoteOnly: true, failFirstWorkspace: true });
    const ids = await failedBatch(env);
    env.pr.state = "MERGED";
    Object.assign(env.facts, { state: "MERGED", needsPreparation: false, readiness: "merged", detail: "GitHub confirms this PR merged" });
    await env.harness.runCli(["refresh"]);
    expect(await env.harness.callRpc("board_get", null)).toMatchObject({ prInventory: { entries: [] } });
    expect(await env.harness.callRpc("advance_recheck", ids)).toMatchObject({ jobs: [{ status: "merged", hiddenFromProgress: true }] });
    expect(env.spawn).not.toHaveBeenCalled();
    await expect(env.preview("https://github.com/example/widget/pull/999")).rejects.toThrow("no longer tracked");
  });
  it("excludes held PRs from Advance and invalidates previews when a hold is added", async () => {
    const env = await setup(); const plan = await env.preview();
    await env.harness.callRpc("pr_hold_set", { prUrl: env.url.toUpperCase().replace("HTTPS:", "https:"), held: true, reason: "Await launch decision" });
    expect((await env.preview()).jobs[0]).toMatchObject({ eligible: false, detail: expect.stringContaining("On hold") });
    await expect(env.harness.callRpc("advance_start", { token: plan.token })).rejects.toThrow("changed");
    expect(env.spawn).not.toHaveBeenCalled();
    expect(env.calls.some((call) => call.method === "advanceWorkspace")).toBe(false);
  });
  it("requires releasing a hold before repairing a failed Advance item", async () => {
    const env = await setup({ failFirstWorkspace: true, author: true });
    const ids = await failedBatch(env);
    await env.harness.callRpc("pr_hold_set", { prUrl: env.url, held: true });
    await expect(env.harness.callRpc("advance_repair_plan", ids)).rejects.toThrow("On hold");
    expect(env.spawn).not.toHaveBeenCalled();
    expect(await env.harness.callRpc("board_get", null)).toMatchObject({ prHolds: { [env.url]: { reason: "" } } });
  });
  it("removes and restores progress through the RPC without deleting results or launching workers", async () => {
    const env = await setup({ ready: true });
    const batch = await env.harness.callRpc("advance_start", { token: (await env.preview()).token }) as AdvanceBatch;
    const ids = { batchId: batch.id, jobId: batch.jobs[0]!.id };
    await vi.waitFor(async () => expect(await env.harness.callRpc("advance_get", null)).toMatchObject([{ jobs: [{ status: "ready", hiddenFromProgress: false }] }]));
    expect(await env.harness.callRpc("advance_progress_visibility", { ...ids, hidden: true })).toMatchObject({ jobs: [{ status: "ready", hiddenFromProgress: true }] });
    expect(await env.harness.callRpc("advance_get", null)).toMatchObject([{ jobs: [{ hiddenFromProgress: true }] }]);
    expect(await env.harness.callRpc("advance_recheck", ids)).toMatchObject({ jobs: [{ status: "ready", hiddenFromProgress: false }] });
    expect(await env.harness.callRpc("advance_progress_visibility", { ...ids, hidden: false })).toMatchObject({ jobs: [{ status: "ready", hiddenFromProgress: false }] });
    expect(env.spawn).not.toHaveBeenCalled();
    await expect(env.harness.callRpc("advance_recheck", { ...ids, jobId: "00000000-0000-4000-8000-000000000000" })).rejects.toThrow("item is no longer available");
  });
  it("rejects removing an active worker through the progress RPC", async () => {
    const env = await setup();
    const batch = await env.harness.callRpc("advance_start", { token: (await env.preview()).token }) as AdvanceBatch;
    await vi.waitFor(() => expect(env.send).toHaveBeenCalledOnce());
    await expect(env.harness.callRpc("advance_progress_visibility", { batchId: batch.id, jobId: batch.jobs[0]!.id, hidden: true })).rejects.toThrow("reconcile");
  });
  it("previews without writes and routes a remote PR to a separate checkout in the exact matched project", async () => {
    const env = await setup({ remoteOnly: true });
    const plan = await env.preview();
    expect(plan.jobs[0]).toMatchObject({ eligible: true, workspace: "create", needsPreparation: true });
    expect(env.spawn).not.toHaveBeenCalled();
    expect(env.calls.some((call) => call.method === "advanceWorkspace")).toBe(false);
    await env.harness.callRpc("advance_start", { token: plan.token });
    await vi.waitFor(() => expect(env.spawn).toHaveBeenCalledTimes(3));
    expect(env.calls.find((call) => call.method === "advanceWorkspace")?.input).toMatchObject({ sourcePath: PATH, prUrl: env.url, expectedHeadOid: HEAD, expectedBaseOid: BASE });
    expect(env.spawn.mock.calls[0]?.[0]).toMatchObject({ title: "Unassigned work", pluginMetadata: { role: "unassigned-root" } });
    expect(env.spawn.mock.calls[1]?.[0]).toMatchObject({ title: "example/widget", parentThreadId: "thr-unassigned", pluginMetadata: { role: "unassigned-repo" } });
    expect(env.spawn.mock.calls[2]?.[0]).toMatchObject({ title: "example/widget PR #42", projectId: "project-example", parentThreadId: "thr-unassigned-repo",
      environment: { type: "host", hostId: HOST, workspace: { type: "unmanaged", path: "/synthetic/workstreams/batch/repo" } },
      pluginMetadata: { role: "rebase-worker", prUrl: env.url } });
    expect(env.spawn.mock.calls[2]?.[0]).toMatchObject({ providerId: "codex", model: "gpt-6-sol", reasoningLevel: "high" });
    expect(env.spawn.mock.calls[2]?.[0].prompt).toContain("/synthetic/workstreams/batch/repo/job");
  });

  it("starts Advance repository parents on the Planning model and its worker on the Code-work model", async () => {
    const env = await setup({ remoteOnly: true });
    await env.harness.behavior.setSettings({ codeModel: "claude-code/claude-opus/high", planningModel: "claude-code/claude-sonnet/low" });
    await env.harness.callRpc("advance_start", { token: (await env.preview()).token });
    await vi.waitFor(() => expect(env.spawn).toHaveBeenCalledTimes(3));
    expect(env.spawn.mock.calls.map(([args]) => [args.pluginMetadata.role, args.providerId, args.model, args.reasoningLevel])).toEqual([
      ["unassigned-root", "claude-code", "claude-sonnet", "low"], ["unassigned-repo", "claude-code", "claude-sonnet", "low"],
      ["rebase-worker", "claude-code", "claude-opus", "high"]]);
  });

  it("starts an Advance repair and a manual PR worker on the Code-work model", async () => {
    const env = await setup({ remoteOnly: true, failFirstWorkspace: true });
    const ids = await failedBatch(env);
    await env.harness.behavior.setSettings({ codeModel: "claude-code/claude-opus/high" });
    const plan = await env.harness.callRpc("advance_repair_plan", ids) as AdvanceRepairPlan;
    await env.harness.callRpc("advance_repair_run", { token: plan.token, mode: "new", threadId: null, instruction: "Fix the failure." });
    expect(env.spawn.mock.calls.at(-1)![0]).toMatchObject({ providerId: "claude-code", model: "claude-opus", reasoningLevel: "high",
      pluginMetadata: { role: "advance-repair" } });
    const manual = await setup();
    await manual.harness.behavior.setSettings({ codeModel: "claude-code/claude-opus/high" });
    expect(await manual.harness.callRpc("agent_run", { path: PATH, action: "resolve-conflicts", mode: "new", threadId: null,
      prompt: "Repair the checkout." })).toMatchObject({ ok: true });
    expect(manual.spawn.mock.calls.at(-1)![0]).toMatchObject({ providerId: "claude-code", model: "claude-opus", reasoningLevel: "high",
      pluginMetadata: { role: "pr" } });
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

  it("accepts the unassigned repository parent recommended after a context thread created it", async () => {
    const env = await setup();
    env.pr.title = "Fix account lookup";
    env.pr.headRefName = "fix-account-lookup";
    env.unit.branch = "fix-account-lookup";
    await env.harness.runCli(["refresh"]);
    expect(await env.harness.callRpc("card_thread_message", { target: { prUrl: env.url }, threadId: null,
      message: "Inspect this PR." })).toMatchObject({ ok: true, created: true });
    const plan = await env.harness.callRpc("agent_plan", { path: PATH, action: "resolve-conflicts" }) as
      { recommendation: { mode: string; threadId: string | null } };
    expect(plan.recommendation).toMatchObject({ mode: "subthread", threadId: "thr-unassigned-repo" });
    const result = await env.harness.callRpc("agent_run", { path: PATH, action: "resolve-conflicts", mode: "subthread",
      threadId: plan.recommendation.threadId, prompt: "Repair the checkout." });
    expect(result).toMatchObject({ ok: true });
    expect(env.spawn.mock.calls.at(-1)?.[0]).toMatchObject({ parentThreadId: "thr-unassigned-repo", pluginMetadata: { role: "pr" } });
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

  it("stops an unassigned Advance launch when the PR gains an effort during workspace creation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const env = await setup({ remoteOnly: true });
    env.beforeWorkspace.mockImplementationOnce(async () => {
      createEffortStore(env.bb.storage.database()).establish({ sourceKey: "manual:widget", name: "Account lookup",
        goal: "", projectId: "project-example", members: { tickets: [], prUrls: [env.url] }, coordinatorState: "none" });
    });
    const batch = await env.harness.callRpc("advance_start", { token: (await env.preview()).token }) as AdvanceBatch;
    await vi.waitFor(async () => expect(await env.harness.callRpc("advance_get", null)).toMatchObject([{ id: batch.id,
      jobs: [{ status: "needs-attention", uncertain: true, detail: expect.stringContaining("assigned to an effort") }] }]));
    expect(env.spawn).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => setImmediate(resolve));
    vi.setSystemTime(Date.now() + 31_000);
    expect(await env.harness.callRpc("advance_recheck", { batchId: batch.id })).toMatchObject({ jobs: [{
      status: "needs-attention", uncertain: false, detail: expect.stringContaining("No worker exists") }] });
    expect(env.spawn).not.toHaveBeenCalled();
  });

  it("keeps a created worker recoverable when SDK readback reports the wrong parent", async () => {
    const env = await setup({ remoteOnly: true, misparentWorker: true });
    const batch = await env.harness.callRpc("advance_start", { token: (await env.preview()).token }) as AdvanceBatch;
    await vi.waitFor(async () => expect(await env.harness.callRpc("advance_get", null)).toMatchObject([{ id: batch.id,
      jobs: [{ status: "needs-attention", uncertain: true, detail: expect.stringContaining("parent differs") }] }]));
    expect(env.spawn).toHaveBeenCalledTimes(3);
    expect(env.threads.has("thr-rebasing")).toBe(true);
    expect(await env.harness.callRpc("advance_recheck", { batchId: batch.id, jobId: batch.jobs[0]!.id }))
      .toMatchObject({ jobs: [{ threadId: "thr-rebasing" }] });
    expect(env.spawn).toHaveBeenCalledTimes(3);
  });

  it("launches a CI repair for an unapproved remote PR with a mapped repository", async () => {
    const env = await setup({ remoteOnly: true, ready: true });
    Object.assign(env.facts, { reviewDecision: "REVIEW_REQUIRED", checks: "failed", readiness: "needs-attention", detail: "One or more checks failed." });
    const plan = await env.preview();
    expect(plan.jobs[0]).toMatchObject({ eligible: true, needsPreparation: false, needsFeedback: false, needsChecks: true });
    expect(env.calls.some((call) => call.method === "advanceWorkspace")).toBe(false);
    await env.harness.callRpc("advance_start", { token: plan.token });
    await vi.waitFor(() => expect(env.spawn).toHaveBeenCalledTimes(3));
    const prompt = env.spawn.mock.calls[2]![0].prompt as string;
    expect(prompt).toContain("Inspect the failing checks");
    expect(prompt).toContain("This preview did not authorize branch integration");
    expect(env.calls.some((call) => call.method === "prWrite")).toBe(false);
  });

  it("skips an unapproved remote CI repair without a matching BB repository source", async () => {
    const env = await setup({ remoteOnly: true, ready: true, projectAvailable: false });
    Object.assign(env.facts, { reviewDecision: "REVIEW_REQUIRED", checks: "failed", readiness: "needs-attention", detail: "One or more checks failed." });
    expect((await env.preview()).jobs[0]).toMatchObject({ eligible: false, needsChecks: true,
      detail: expect.stringContaining("No matching scanned repository") });
    expect(env.spawn).not.toHaveBeenCalled();
    expect(env.calls.some((call) => call.method === "advanceWorkspace")).toBe(false);
  });

  it("repairs an unaddressed changes request but does not repeat a verified author follow-up", async () => {
    const env = await setup({ remoteOnly: true, ready: true });
    Object.assign(env.facts, { reviewDecision: "CHANGES_REQUESTED", reviewFollowupPosted: false,
      readiness: "needs-attention", detail: "Review requests changes without a verified author follow-up." });
    expect((await env.preview()).jobs[0]).toMatchObject({ eligible: true, needsFeedback: true });
    env.facts.reviewFollowupPosted = true;
    env.facts.readiness = "waiting-review";
    env.facts.detail = "Review still requests changes; wait for a new approval after follow-up.";
    const plan = await env.preview();
    expect(plan.jobs[0]).toMatchObject({ eligible: true, needsFeedback: false, needsChecks: false });
    await env.harness.callRpc("advance_start", { token: plan.token });
    await vi.waitFor(async () => expect(await env.harness.callRpc("advance_get", null)).toMatchObject([{ jobs: [{ status: "waiting-review" }] }]));
    expect(env.spawn).not.toHaveBeenCalled();
    expect(env.calls.some((call) => call.method === "prWrite")).toBe(false);
  });

  it("verifies a clean draft without marking it ready, but repairs failed draft checks", async () => {
    const clean = await setup({ remoteOnly: true, ready: true });
    Object.assign(clean.facts, { isDraft: true, reviewDecision: null, readiness: "needs-attention",
      detail: "Draft PR: finish the work and mark it ready for review." });
    const plan = await clean.preview();
    expect(plan.jobs[0]).toMatchObject({ eligible: true, needsChecks: false, needsPreparation: false });
    await clean.harness.callRpc("advance_start", { token: plan.token });
    await vi.waitFor(async () => expect(await clean.harness.callRpc("advance_get", null)).toMatchObject([{ jobs: [{ status: "needs-attention", detail: expect.stringContaining("mark it ready") }] }]));
    expect(clean.spawn).not.toHaveBeenCalled();

    const failing = await setup({ remoteOnly: true, ready: true });
    Object.assign(failing.facts, { isDraft: true, reviewDecision: null, checks: "failed", readiness: "needs-attention", detail: "One or more checks failed." });
    const repair = await failing.preview();
    expect(repair.jobs[0]).toMatchObject({ eligible: true, needsChecks: true });
    await failing.harness.callRpc("advance_start", { token: repair.token });
    await vi.waitFor(() => expect(failing.spawn).toHaveBeenCalledTimes(3));
    expect(failing.spawn.mock.calls[2]![0].prompt).toContain("If this PR is a draft, keep it a draft");
  });

  it("requires a new preview when approval is lost before a ready PR starts", async () => {
    const env = await setup({ remoteOnly: true, ready: true });
    const plan = await env.preview();
    Object.assign(env.facts, { reviewDecision: "REVIEW_REQUIRED", readiness: "waiting-review", detail: "Waiting for approval on the current PR." });
    await expect(env.harness.callRpc("advance_start", { token: plan.token })).rejects.toThrow("changed");
    expect(env.spawn).not.toHaveBeenCalled();
    const current = await env.preview();
    await env.harness.callRpc("advance_start", { token: current.token });
    await vi.waitFor(async () => expect(await env.harness.callRpc("advance_get", null)).toMatchObject([{ jobs: [{ status: "waiting-review" }] }]));
  });

  it("reserves the PR against manual agent and GitHub actions while its worker runs", async () => {
    const env = await setup();
    await env.harness.callRpc("advance_start", { token: (await env.preview()).token });
    await vi.waitFor(() => expect(env.send).toHaveBeenCalledOnce());
    expect(await env.harness.callRpc("agent_run", { path: PATH, action: "resolve-conflicts", mode: "new", threadId: null, prompt: "Rebase this PR" })).toMatchObject({ ok: false });
    expect(await env.harness.callRpc("action_update_branch", { prUrl: env.url })).toMatchObject({ ok: false });
    expect(await env.harness.callRpc("thread_start", { path: PATH, prompt: "Rebase this PR" })).toMatchObject({ ok: false });
    expect(await env.harness.callRpc("thread_message", { path: PATH, prUrl: env.url, threadId: "thr-author", message: "Rebase this PR" })).toMatchObject({ ok: false });
    expect(env.calls.some((call) => call.method === "prWrite")).toBe(false);
    expect(env.send).toHaveBeenCalledOnce();
    expect(env.spawn).toHaveBeenCalledTimes(2);
  });

  it("matches normalized selection URLs to mixed-case GitHub repository identities", async () => {
    const env = await setup({ mixedCase: true, remoteOnly: true });
    expect((await env.preview(env.url.toLowerCase())).jobs[0]).toMatchObject({ eligible: true, prUrl: env.url });
  });

  it("keeps a newly launched author thread busy before its lifecycle events reach the board", async () => {
    const env = await setup({ omitLaunchedThreadsFromList: true });
    expect(await env.harness.callRpc("thread_start", { path: PATH, prompt: "Rebase this PR" }))
      .toMatchObject({ ok: true, threadId: "thr-rebasing" });
    // The effort parent and repository controller are created before the PR worker.
    // No lifecycle event or linked thread reaches the board, so the saved PR
    // launch reference still guards Advance without starting another worker.
    expect((await env.preview()).jobs[0]).toMatchObject({ eligible: false, detail: "Another action or batch already owns this PR" });
    expect(env.spawn).toHaveBeenCalledTimes(3);
    expect(env.spawn.mock.calls.map(([args]) => args.pluginMetadata?.role)).toEqual(["coordinator", "repo", "pr"]);
    expect(env.spawn.mock.calls[0]?.[0].environment).toMatchObject({ type: "host", hostId: HOST,
      workspace: { type: "unmanaged", path: "/synthetic/workstreams/context/1" } });
    expect(env.spawn.mock.calls[1]?.[0].parentThreadId).toBe("thr-coordinator");
    expect(env.spawn.mock.calls[1]?.[0].environment).toMatchObject({ type: "host", hostId: HOST,
      workspace: { type: "unmanaged", path: "/synthetic/workstreams/context/2" } });
    expect(env.spawn.mock.calls[2]?.[0].parentThreadId).toBe("thr-repo");
    expect(env.spawn.mock.calls[2]?.[0].environment).toMatchObject({ workspace: { path: PATH } });
    expect(env.calls.some((call) => call.method === "advanceWorkspace")).toBe(false);
  });

  it("verifies an already-ready fork without provisioning or starting a writer", async () => {
    const env = await setup({ ready: true, fork: true, remoteOnly: true });
    const plan = await env.preview();
    expect(plan.jobs[0]).toMatchObject({ eligible: true, needsPreparation: false, needsFeedback: false });
    await env.harness.callRpc("advance_start", { token: plan.token });
    await vi.waitFor(async () => expect(await env.harness.callRpc("advance_get", null)).toMatchObject([{ jobs: [{ status: "ready", checkedHeadOid: HEAD }] }]));
    expect(env.spawn).not.toHaveBeenCalled();
    expect(env.calls.some((call) => call.method === "advanceWorkspace")).toBe(false);
  });

  it.each(["threads", "approval-note"] as const)("launches feedback-only %s work even when the approved branch is clean", async (feedback) => {
    const env = await setup({ ready: true, remoteOnly: true, feedback });
    const plan = await env.preview();
    expect(plan.jobs[0]).toMatchObject({ eligible: true, needsPreparation: false, needsFeedback: true, workspace: "create",
      detail: feedback === "approval-note" ? expect.stringContaining("Approval feedback needs code") : env.facts.detail });
    await env.harness.callRpc("advance_start", { token: plan.token });
    await vi.waitFor(() => expect(env.spawn).toHaveBeenCalledTimes(3));
    expect(env.calls.find((call) => call.method === "advanceWorkspace")?.input).toMatchObject({ sourcePath: PATH, prUrl: env.url, expectedHeadOid: HEAD, expectedBaseOid: BASE });
    expect(env.spawn.mock.calls[2]?.[0]).toMatchObject({ title: "example/widget PR #42", projectId: "project-example", parentThreadId: "thr-unassigned-repo",
      environment: { type: "host", hostId: HOST, workspace: { type: "unmanaged", path: "/synthetic/workstreams/batch/repo" } } });
  });

  it.each(["threads", "approval-note"] as const)("skips fork %s feedback instead of silently treating it as verify-only", async (feedback) => {
    const env = await setup({ ready: true, remoteOnly: true, fork: true, feedback });
    expect((await env.preview()).jobs[0]).toMatchObject({ eligible: false, needsPreparation: false, needsFeedback: true, detail: expect.stringContaining("Fork PRs") });
    expect(env.spawn).not.toHaveBeenCalled();
    expect(env.calls.some((call) => call.method === "advanceWorkspace")).toBe(false);
  });

  it("preserves the current approval blocker when completed feedback work needs a new review", async () => {
    const env = await setup({ ready: true, remoteOnly: true, feedback: "threads" });
    const batch = await env.harness.callRpc("advance_start", { token: (await env.preview()).token }) as AdvanceBatch;
    await vi.waitFor(() => expect(env.spawn).toHaveBeenCalledTimes(3));
    const pushedHead = "c".repeat(40);
    Object.assign(env.facts, { headOid: pushedHead, unresolvedThreads: 0, reviewDecision: "REVIEW_REQUIRED", readiness: "waiting-review", detail: "Waiting for approval on the current PR." });
    Object.assign(env.pr, { headRefOid: pushedHead, unresolvedReviewThreads: 0, reviewDecision: "REVIEW_REQUIRED" });
    await env.harness.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr-rebasing", status: "idle" }),
      lastAssistantText: `Result: Feedback addressed and validated.\nWorkstreams job ${batch.jobs[0]!.id} complete: prepared`,
    });
    await vi.waitFor(async () => expect(await env.harness.callRpc("advance_get", null)).toMatchObject([{ jobs: [{
      status: "waiting-review", checkedHeadOid: pushedHead, detail: "Waiting for approval on the current PR.",
    }] }]));
  });

  it("previews a failed remote item without writes and repairs it after approval was dismissed", async () => {
    const env = await setup({ remoteOnly: true, feedback: "threads", failFirstWorkspace: true });
    const ids = await failedBatch(env);
    env.facts.reviewDecision = "REVIEW_REQUIRED";
    env.facts.readiness = "waiting-review";
    const plan = await env.harness.callRpc("advance_repair_plan", ids) as AdvanceRepairPlan;
    expect(plan.fresh).toMatchObject({ eligible: true, needsFeedback: true });
    expect(env.calls.filter((call) => call.method === "advanceWorkspace")).toHaveLength(1);
    expect(env.spawn).not.toHaveBeenCalled();
    const result = await env.harness.callRpc("advance_repair_run", { token: plan.token, mode: "new", threadId: null, instruction: "Address the remaining feedback and reply." }) as { batch: AdvanceBatch; threadId: string };
    expect(result.batch.jobs[0]).toMatchObject({ status: "running", dedicated: true, threadId: result.threadId });
    const request = env.spawn.mock.calls[2]![0];
    expect(request).toMatchObject({ projectId: "project-example", title: "widget #42: repair review feedback",
      environment: { type: "host", hostId: HOST, workspace: { type: "unmanaged", path: "/synthetic/workstreams/batch/repo" } },
      pluginMetadata: { role: "advance-repair", advanceJobId: result.batch.jobs[0]!.attemptId, prUrl: env.url } });
    expect(request).toMatchObject({ providerId: "codex", model: "gpt-6-sol", reasoningLevel: "high" });
    expect(request.parentThreadId).toBe("thr-unassigned-repo");
    expect(result.batch.jobs[0]!.attemptId).not.toBe(ids.jobId);
    expect(request.prompt).toContain("Address the remaining feedback and reply.");
    expect(request.prompt).toContain("do not reset");
  });

  it("keeps legacy author history while launching an effort repair under its repository controller", async () => {
    const env = await setup({ feedback: "threads", failFirstWorkspace: true, author: true });
    const plan = await env.harness.callRpc("advance_repair_plan", await failedBatch(env)) as AdvanceRepairPlan;
    expect(plan.candidates).toEqual([]);
    expect(plan.modes).toEqual(["new"]);
    await expect(env.harness.callRpc("advance_repair_run", { token: plan.token, mode: "subthread", threadId: "thr-unrelated", instruction: "Fix remaining comments" })).rejects.toThrow();
    expect(env.spawn).not.toHaveBeenCalled();
    await env.harness.callRpc("advance_repair_run", { token: plan.token, mode: "new", threadId: null, instruction: "Fix remaining comments" });
    expect(env.spawn.mock.calls.map(([request]) => request.pluginMetadata.role)).toEqual(["coordinator", "repo", "advance-repair"]);
    expect(env.spawn.mock.calls[0]![0].environment.workspace.path).toBe("/synthetic/workstreams/context/1");
    expect(env.spawn.mock.calls[1]![0]).toMatchObject({ parentThreadId: "thr-coordinator" });
    expect(env.spawn.mock.calls[1]![0].environment.workspace.path).toBe("/synthetic/workstreams/context/2");
    expect(env.spawn.mock.calls[2]![0]).toMatchObject({ parentThreadId: "thr-repo", projectId: "project-example", pluginMetadata: { role: "advance-repair" } });
    expect(env.spawn.mock.calls[2]![0].environment.workspace.path).toBe("/synthetic/workstreams/batch/repo");
  });

  it("revalidates the repository controller's child capability before launching a repair", async () => {
    const env = await setup({ failFirstWorkspace: true });
    const ids = await failedBatch(env);
    await seedRepoController(env);
    const plan = await env.harness.callRpc("advance_repair_plan", ids) as AdvanceRepairPlan;
    expect(plan.candidates).toContainEqual(expect.objectContaining({ id: "thr-repo", canSpawnChild: true }));
    env.blockedParents.add("thr-repo");
    await expect(env.harness.callRpc("advance_repair_run", { token: plan.token, mode: "subthread", threadId: "thr-repo", instruction: "Fix the failure" })).rejects.toThrow();
    expect(env.spawn).not.toHaveBeenCalled();
    expect(env.calls.filter((call) => call.method === "advanceWorkspace")).toHaveLength(2);
    expect(await env.harness.callRpc("advance_get", null)).toMatchObject([{ jobs: [{ status: "needs-attention", uncertain: false, threadId: null }] }]);
  });

  it("refuses a competing repair while the linked author is actively working", async () => {
    const env = await setup({ failFirstWorkspace: true, author: true });
    const ids = await failedBatch(env);
    env.threads.set("thr-author", { ...env.threads.get("thr-author")!, status: "active" });
    await expect(env.harness.callRpc("advance_repair_plan", ids)).rejects.toThrow(/Another writer/u);
    expect(env.spawn).not.toHaveBeenCalled();
  });

  it.each(["closed", "fork"] as const)("refuses %s repairs even when the remaining task has no branch or feedback flag", async (blocker) => {
    const env = await setup({ failFirstWorkspace: true });
    const ids = await failedBatch(env);
    Object.assign(env.facts, { needsPreparation: false, unresolvedThreads: 0, readiness: "ready", detail: "Current state needs attention" });
    if (blocker === "closed") env.facts.state = "CLOSED";
    if (blocker === "fork") env.facts.isCrossRepository = true;
    await expect(env.harness.callRpc("advance_repair_plan", ids)).rejects.toThrow();
    expect(env.spawn).not.toHaveBeenCalled();
  });
});

describe("bounded placement repair for saved unassigned workers", () => {
  const request = (prUrl: string, apply: boolean) => ({ batchId: PLACEMENT_BATCH, jobId: PLACEMENT_JOB,
    threadId: "thr-legacy", prUrl, expectedParentThreadId: null, apply });

  it("previews without writes, places the saved worker under its repo, and safely repeats the request", async () => {
    const env = await setup({ remoteOnly: true, seedPlacementRepair: true });
    expect(await env.harness.callRpc("repair_unassigned_thread", request(env.url, false))).toMatchObject({
      threadId: "thr-legacy", parentThreadId: null, updated: false });
    expect(env.spawn).not.toHaveBeenCalled();
    expect(await env.harness.callRpc("repair_unassigned_thread", request(env.url, true))).toMatchObject({
      threadId: "thr-legacy", parentThreadId: "thr-unassigned-repo", updated: true });
    expect(env.spawn.mock.calls.map((call) => call[0].pluginMetadata.role)).toEqual(["unassigned-root", "unassigned-repo"]);
    expect(env.threads.get("thr-legacy")?.parentThreadId).toBe("thr-unassigned-repo");
    expect(await env.harness.callRpc("repair_unassigned_thread", request(env.url, true))).toMatchObject({
      parentThreadId: "thr-unassigned-repo", updated: false });
    expect(env.spawn).toHaveBeenCalledTimes(2);
    expect(env.beforePlacementUpdate).toHaveBeenCalledOnce();
  });

  it("accepts the exact saved repair attempt without treating its older attempt as current", async () => {
    const env = await setup({ remoteOnly: true, seedPlacementRepair: true, seedPlacementRepairAttempt: true });
    expect(await env.harness.callRpc("repair_unassigned_thread", request(env.url, true))).toMatchObject({
      parentThreadId: "thr-unassigned-repo", updated: true });
    expect(env.threads.get("thr-legacy")?.parentThreadId).toBe("thr-unassigned-repo");
  });

  it("rejects missing direct evidence, busy workers, and a PR that GitHub closed", async () => {
    const env = await setup({ remoteOnly: true, seedPlacementRepair: true });
    env.threadMetadata.set("thr-legacy", { role: "rebase-worker", advanceJobId: "another-job" });
    await expect(env.harness.callRpc("repair_unassigned_thread", request(env.url, true))).rejects.toThrow("plugin evidence");
    env.threadMetadata.set("thr-legacy", { role: "rebase-worker", advanceJobId: PLACEMENT_JOB });
    env.threads.set("thr-legacy", { ...env.threads.get("thr-legacy")!, status: "active" });
    await expect(env.harness.callRpc("repair_unassigned_thread", request(env.url, true))).rejects.toThrow("active, queued");
    env.threads.set("thr-legacy", { ...env.threads.get("thr-legacy")!, status: "idle" });
    env.pr.state = "CLOSED";
    await expect(env.harness.callRpc("repair_unassigned_thread", request(env.url, true))).rejects.toThrow("GitHub no longer confirms");
    expect(env.spawn).not.toHaveBeenCalled();
  });

  it("rejects an uncertain competing job, explicit effort intent, or an unexpected parent", async () => {
    const conflict = await setup({ remoteOnly: true, seedPlacementRepair: true, seedUncertainConflict: true });
    await expect(conflict.harness.callRpc("repair_unassigned_thread", request(conflict.url, true))).rejects.toThrow("Another Advance item");
    expect(conflict.spawn).not.toHaveBeenCalled();
    const env = await setup({ remoteOnly: true, seedPlacementRepair: true });
    env.threadMetadata.set("thr-legacy", { role: "rebase-worker", advanceJobId: PLACEMENT_JOB, effortId: "effort-other" });
    await expect(env.harness.callRpc("repair_unassigned_thread", request(env.url, true))).rejects.toThrow("plugin evidence");
    env.threadMetadata.set("thr-legacy", { role: "rebase-worker", advanceJobId: PLACEMENT_JOB });
    env.threads.set("thr-legacy", { ...env.threads.get("thr-legacy")!, parentThreadId: "thr-other" });
    await expect(env.harness.callRpc("repair_unassigned_thread", request(env.url, true))).rejects.toThrow("parent changed");
    expect(env.spawn).not.toHaveBeenCalled();
  });

  it("rechecks the worker after anchor creation and leaves a changed thread untouched", async () => {
    const env = await setup({ remoteOnly: true, seedPlacementRepair: true });
    env.beforeAnchor.mockImplementationOnce(async () => {
      env.threads.set("thr-legacy", { ...env.threads.get("thr-legacy")!, status: "active" });
    });
    await expect(env.harness.callRpc("repair_unassigned_thread", request(env.url, true))).rejects.toThrow("active, queued");
    expect(env.spawn).toHaveBeenCalledTimes(2);
    expect(env.threads.get("thr-legacy")?.parentThreadId).toBeNull();
    expect(env.beforePlacementUpdate).not.toHaveBeenCalled();
  });

  it("reads back a timed-out update and never blindly moves the worker again", async () => {
    const env = await setup({ remoteOnly: true, seedPlacementRepair: true });
    env.afterPlacementUpdate.mockRejectedValueOnce(new Error("transport timed out"));
    expect(await env.harness.callRpc("repair_unassigned_thread", request(env.url, true))).toMatchObject({
      parentThreadId: "thr-unassigned-repo", updated: true });
    expect(env.threads.get("thr-legacy")?.parentThreadId).toBe("thr-unassigned-repo");
    expect(await env.harness.callRpc("repair_unassigned_thread", request(env.url, true))).toMatchObject({ updated: false });
    expect(env.beforePlacementUpdate).toHaveBeenCalledOnce();
  });
});
