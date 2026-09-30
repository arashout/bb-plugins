// Once an effort runs on its v2 roster, no legacy launcher may start work on a
// PR that roster owns, including a PR it owns only through a ticket. Each test
// pairs the v2 PR with a legacy effort's PR, which must behave exactly as before.
// Opting in links or starts one parent thread and cancels queued legacy jobs; it
// never changes membership or reparents a thread.
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdvanceFacts } from "./advance-contract.js";
import type { AdvanceBatch, AdvancePreview } from "./bulk-advance.js";
import { cardEffortMoveScope, type CardEffortReady } from "./card-effort.js";
import type { RawUnit } from "./contract.js";
import { createDispatchStore } from "./dispatch.js";
import { createEffortStore, type EstablishedEffort } from "./effort-store.js";
import { effortTitle } from "./effort-title.js";
import type { createEffortV2, EffortV2Preview } from "./effort-v2-server.js";
import { DEFAULT_EFFECTS, formatTargets } from "./effort-command.js";
import type { Next } from "./effort-phase.js";
import type { createEffortRunner } from "./effort-runner.js";
import { createEffortWorkStore, type AttemptBody, type StoredAttempt } from "./effort-work-store.js";
import { parsePrList } from "./gh.js";
import { createRunStore, type RunDb } from "./runstore.js";
import plugin, { type Board } from "./server.js";
import type { ThreadEffortReady } from "./thread-effort.js";
import type { WorkConversation } from "./work-conversation.js";

const HOST = "host-inkwell";
const PROJECT = "proj-inkwell";
const HEAD = "a".repeat(40), BASE = "b".repeat(40);
const url = (number: number) => `https://github.com/inkwell/folio/pull/${number}`;
/** 12 is owned by the v2 effort only through its ticket; 14 belongs to a legacy effort; 16 is unowned. */
const RETURNS = url(12), USED = url(14), WRAP = url(16);
const TITLES: Record<number, string> = { 12: "ABC-12 Shelve returned books", 14: "ABC-14 Price used paperbacks", 16: "ABC-16 Label gift wrap",
  18: "ABC-18 Restock returned maps" };
const POINTER = "Managed by the Returns desk roster; instruct there.";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
/** Each plugin start's own launch runner, so a test can hand it a queued step as the reconciler does. */
const runners = vi.hoisted(() => [] as ReturnType<typeof createEffortRunner>[]);
/** Each plugin start's reconciler, so a test can run one tick after an event. */
const reconcilers = vi.hoisted(() => [] as ReturnType<typeof createEffortV2>["reconciler"][]);
vi.mock("./effort-v2-server.js", async (original) => {
  const actual = await original<typeof import("./effort-v2-server.js")>();
  return { ...actual, createEffortV2: (deps: Parameters<typeof actual.createEffortV2>[0]) => {
    const v2 = actual.createEffortV2(deps);
    reconcilers.push(v2.reconciler);
    return v2;
  } };
});
vi.mock("./effort-runner.js", async (original) => {
  const actual = await original<typeof import("./effort-runner.js")>();
  return { ...actual, createEffortRunner: (deps: Parameters<typeof actual.createEffortRunner>[0]) => {
    const runner = actual.createEffortRunner(deps);
    runners.push(runner);
    return runner;
  } };
});

const pull = (number: number) => ({ ...parsePrList(JSON.stringify([{ number, url: url(number), state: "OPEN", title: TITLES[number],
  reviewDecision: "APPROVED", isDraft: false, headRefName: `abc-${number}-shelf`, baseRefName: "main", headRefOid: HEAD, baseRefOid: BASE,
  mergeStateStatus: "DIRTY", mergeable: "CONFLICTING", statusCheckRollup: [{ conclusion: "SUCCESS" }], latestReviews: [], reviewRequests: [] }]))!.pr,
  unresolvedReviewThreads: 0, resolvedReviewThreads: 0 });
const checkout = (number: number): RawUnit => ({ path: `/p/folio-${number}`, dirName: `folio-${number}`, repo: "folio", githubRepo: "inkwell/folio",
  branch: `abc-${number}-shelf`, dirty: false, ahead: 0, behind: 0, lastCommitAt: "2026-09-27T12:00:00Z", defaultBranch: "main",
  pr: pull(number), shipped: null, changedPaths: [], observed: { status: true, pr: true } });
const facts = (number: number): AdvanceFacts => ({ prUrl: url(number), number, title: TITLES[number]!, repo: "inkwell/folio",
  headRefName: `abc-${number}-shelf`, baseRefName: "main", headOid: HEAD, baseOid: BASE, state: "OPEN", isDraft: false, isCrossRepository: false,
  reviewDecision: "APPROVED", mergeStateStatus: "DIRTY", mergeable: "CONFLICTING", needsPreparation: true, readiness: "needs-attention",
  detail: "Resolve branch conflicts", unresolvedThreads: 0, threadsComplete: true, reviewFeedback: { openThreads: 0, comment: null, repliedAt: null, noteAt: null, followUpAt: null }, checks: "passed", basePrNumber: null,
  approvalFeedback: { status: "none", fingerprint: null, sourceIds: [] } });

/** A legacy Advance batch saved by an earlier run, which the service loads when the plugin starts. */
function saveBatch(db: RunDb, number: number, status: "queued" | "running" | "needs-attention", saved: { uncertain?: boolean; threadId?: string } = {}) {
  const id = `00000000-0000-4000-8000-0000000000${number}`;
  const jobId = `00000000-0000-4000-8000-0000000001${number}`;
  const routing = { ...facts(number), eligible: true, workspace: "create", projectId: PROJECT, hostId: HOST, sourcePath: `/p/folio-${number}`,
    path: `/p/folio-${number}`, effortId: null, effortKey: null, effortMembers: null, needsFeedback: false, needsChecks: false, blockedBy: null };
  const job = { ...routing, id: jobId, hiddenFromProgress: false, status, attemptId: null, dedicated: false, previousAttempts: [],
    threadId: saved.threadId ?? null, checkedHeadOid: null, updatedAt: Date.now(), uncertain: saved.uncertain ?? false };
  db.prepare("INSERT INTO advance_batches (id, body) VALUES (?, ?)").run(id, JSON.stringify({ id, token: `00000000-0000-4000-8000-0000000002${number}`,
    createdAt: Date.now(), cancelled: false, jobs: [job], facts: { [jobId]: routing }, pollUntil: Date.now() + 60_000, prepared: {}, repairs: {} }));
}

async function setup() {
  const units = [12, 14, 16].map(checkout);
  const threads = new Map<string, ReturnType<typeof makeThreadResponse> & { environment?: { hostId: string; path?: string } }>();
  const metadata = new Map<string, Record<string, unknown>>();
  /** Each thread's turn requests, newest first, as BB's event log returns them. */
  const turnRequests = new Map<string, unknown[]>();
  /** Each thread's queued messages, waiting behind its active turn. */
  const queued = new Map<string, unknown[]>();
  const hostCalls: { method: string; input: any }[] = [];
  let failWorkspace = false;
  /** GitHub's live facts for a PR, over the default conflicting ones, and full reads that fail next. */
  const live = new Map<number, Partial<AdvanceFacts>>();
  let failedReads = 0;
  /** Each thread's latest output. */
  const outputs = new Map<string, string>();
  /** The interactions waiting on you in each thread. */
  const pending = new Map<string, unknown[]>();
  const retry = vi.fn(async () => ({ ok: true, delivery: "queued", attempt: 2, queuedMessageId: "qm-retry", sendAt: null, turnRequestId: "req-retry" }) as never);
  const beforeWorkspace = vi.fn(async () => {});
  const beforeGet = vi.fn(async (_threadId: string) => {});
  let spawned = 0;
  const spawn = vi.fn(async (args: Record<string, any>) => {
    const role = args.pluginMetadata?.role;
    const id = `thr-${role ?? "worker"}-${++spawned}`;
    const thread = { ...makeThreadResponse({ id, projectId: args.projectId, title: args.title, providerId: args.providerId, originPluginId: "workstreams",
      parentThreadId: args.parentThreadId ?? null, status: ["coordinator", "repo", "context"].includes(role) ? "idle" : "active" }),
      environment: { hostId: args.environment.hostId ?? HOST, path: args.environment.workspace?.path } };
    threads.set(id, thread); metadata.set(id, args.pluginMetadata ?? {});
    return thread as never;
  });
  const send = vi.fn(async () => ({ ok: true, delivery: "sent" }) as never);
  const { bb, harness } = createFakePluginHost({ pluginId: "workstreams", settings: { scanRoots: "/p" }, sdk: {
    system: { config: async () => ({ primaryHostId: HOST }) as never },
    projects: { list: async () => [{ id: PROJECT, name: "Inkwell", sources: [{ hostId: HOST, path: "/p" }] }] as never },
    threads: {
      list: async () => [...threads.values()].map((thread) => ({ ...thread, environmentPath: thread.environment?.path ?? null,
        environmentHostId: thread.environment?.hostId ?? null, queuedWork: "none", hasPendingInteraction: false,
        activity: { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activeGoalCount: 0, activePlanModeCount: 0, activeWorkflowCount: 0 } })) as never,
      spawn, send,
      get: async ({ threadId }: { threadId: string }) => {
        await beforeGet(threadId);
        const thread = threads.get(threadId);
        if (!thread) throw Object.assign(new Error("missing thread"), { status: 404 });
        return thread as never;
      },
      update: async ({ threadId, ...patch }: { threadId: string; title?: string | null; parentThreadId?: string | null }) => {
        const thread = { ...threads.get(threadId)!, ...patch };
        threads.set(threadId, thread); return thread as never;
      },
      getPluginMetadata: async ({ threadId }: { threadId: string }) => (metadata.get(threadId) ?? {}) as never,
      updatePluginMetadata: async ({ threadId, set }: { threadId: string; set?: Record<string, unknown> }) => {
        metadata.set(threadId, { ...metadata.get(threadId), ...set }); return metadata.get(threadId) as never;
      },
      output: async ({ threadId }: { threadId: string }) => ({ output: outputs.get(threadId) ?? "" }), context: async () => ({ usage: null }) as never, retry,
      events: { list: async ({ threadId, types }: { threadId: string; types?: readonly string[] }) =>
        (types?.includes("client/turn/requested") ? turnRequests.get(threadId) ?? [] : []) as never },
      queuedMessages: { list: async ({ threadId }: { threadId: string }) => (queued.get(threadId) ?? []) as never },
      interactions: { list: async ({ threadId }: { threadId: string }) => (pending.get(threadId) ?? []) as never },
    },
  }, experimental_callHostRpc: async ({ method, input }) => {
    hostCalls.push({ method, input });
    const number = (prUrl: string) => Number(prUrl.split("/").at(-1));
    if (method === "scan") return { units, warnings: [] };
    if (method === "inspectPaths") return { units: units.filter((unit) => (input as { paths: string[] }).paths.includes(unit.path)), warnings: [] };
    if (method === "authoredPrs") return { owners: ["inkwell"], entries: units.map((unit) => ({ repo: "inkwell/folio", pr: unit.pr! })),
      discoveryComplete: true, complete: true, repositories: [{ repo: "inkwell/folio", complete: true }], warnings: [] };
    if (method === "linkbacks") return { found: [], warnings: [] };
    if (method === "inspectPrs") return { entries: [], closed: [], failed: (input as { prUrls: string[] }).prUrls, warnings: [] };
    if (method === "contextWorkspace") return { path: "/synthetic/workstreams/context" };
    if (method === "advanceInspect") {
      if (failedReads > 0 && failedReads--) return { ok: false, error: "GitHub is unavailable" };
      const n = number((input as { prUrl: string }).prUrl);
      return { ok: true, facts: { ...facts(n), ...live.get(n) } };
    }
    if (method === "advanceWorkspace") {
      await beforeWorkspace();
      if (failWorkspace) return { ok: false, error: "The fetched PR base changed. No checkout was created." };
      const { prUrl, jobId } = input as { prUrl: string; jobId: string };
      return { ok: true, path: `/synthetic/workstreams/folio-${number(prUrl)}/${jobId}`, workerPath: "/synthetic/workstreams/folio",
        sourcePath: `/p/folio-${number(prUrl)}`, created: true };
    }
    throw new Error(`Unexpected host call ${method}`);
  } });
  await plugin(bb); cleanups.push(() => harness.lifecycle.dispose());
  const runner = runners.at(-1)!;
  const reconciler = reconcilers.at(-1)!;
  expect((await harness.runCli(["refresh"])).exitCode).toBe(0);
  const db = bb.storage.database();
  const store = createEffortStore(db);
  const work = createEffortWorkStore(db);
  const returns = store.establish({ sourceKey: "returns-desk", name: "Returns desk", goal: "Shelve every return", projectId: PROJECT,
    coordinatorState: "none", members: { tickets: ["ABC-12"], prUrls: [] } });
  const used = store.establish({ sourceKey: "used-books", name: "Used books", goal: "Price used stock", projectId: PROJECT,
    coordinatorState: "none", members: { tickets: ["ABC-14"], prUrls: [USED] } });
  expect((await harness.runCli(["refresh"])).exitCode).toBe(0);
  const rpc = (method: string, input: unknown) => harness.callRpc(method as never, input as never) as Promise<any>;
  /** Opt Returns desk in through the store, then let the board sync resolve its roster's PRs, as the server does after every scan. */
  const optIn = async () => {
    work.setMode(returns.id, "v2", work.execution(returns.id).revision, () => []);
    expect((await harness.runCli(["refresh"])).exitCode).toBe(0);
    await vi.waitFor(() => expect(work.managedBy(RETURNS)).toBe(returns.id));
  };
  const preview = async (prUrls: string[]) => (await rpc("advance_preview", { prUrls }) as AdvancePreview).jobs;
  const job = async (prUrl: string) => (await rpc("advance_get", null) as AdvanceBatch[]).flatMap((batch) => batch.jobs)
    .find((entry) => entry.prUrl === prUrl);
  const workedOn = (prUrl: string) => [
    ...spawn.mock.calls.filter(([args]) => args.pluginMetadata?.prUrl === prUrl || args.environment?.workspace?.path?.includes(`folio-${prUrl.split("/").at(-1)}`)),
    ...hostCalls.filter((call) => call.method === "advanceWorkspace" && call.input.prUrl === prUrl)];
  return { bb, harness, db, store, work, returns, used, rpc, optIn, preview, job, workedOn, spawn, send, threads, metadata, turnRequests, queued, hostCalls, beforeWorkspace, beforeGet,
    runner, reconciler, live, outputs, pending, retry, failWorkspace: (value: boolean) => { failWorkspace = value; }, failReads: (count: number) => { failedReads = count; } };
}

describe("v2 execution fence", () => {
  it("fences the PRs a v2 roster owns, including one owned only through a ticket, and nothing of a legacy effort", async () => {
    const env = await setup();
    await env.optIn();
    expect(env.db.prepare("SELECT target, effort_id AS effortId, source FROM effort_v2_targets").all())
      .toEqual([{ target: RETURNS, effortId: env.returns.id, source: "ticket" }]);
    expect([USED, WRAP].map((prUrl) => env.work.managedBy(prUrl))).toEqual([null, null]);
  });

  it("shows a v2 PR ineligible in Advance with a pointer, starts no work on it, and advances a legacy effort's PR", async () => {
    const env = await setup();
    await env.optIn();
    const jobs = await env.preview([RETURNS, USED]);
    expect(jobs.map(({ prUrl, eligible, detail }) => ({ prUrl, eligible, detail }))).toEqual([
      { prUrl: RETURNS, eligible: false, detail: POINTER }, { prUrl: USED, eligible: true, detail: "Resolve branch conflicts" }]);
    const plan = await env.rpc("advance_preview", { prUrls: [RETURNS, USED] }) as AdvancePreview;
    const batch = await env.rpc("advance_start", { token: plan.token }) as AdvanceBatch;
    expect(batch.jobs.find((entry) => entry.prUrl === RETURNS)).toMatchObject({ status: "needs-attention", detail: POINTER });
    await vi.waitFor(async () => expect(await env.job(USED)).toMatchObject({ status: "running" }));
    expect(env.workedOn(RETURNS)).toEqual([]);
    expect(env.workedOn(USED).length).toBeGreaterThan(0);
  });

  it("stops a legacy job at its last check when opt-in lands while its checkout is being prepared", async () => {
    const env = await setup();
    env.beforeWorkspace.mockImplementationOnce(async () => {
      env.work.setMode(env.returns.id, "v2", 0, (effortId) => effortId === env.returns.id ? [{ target: RETURNS, source: "ticket" }] : []);
    });
    const plan = await env.rpc("advance_preview", { prUrls: [RETURNS] }) as AdvancePreview;
    expect(plan.jobs[0]).toMatchObject({ eligible: true });
    await env.rpc("advance_start", { token: plan.token });
    await vi.waitFor(async () => expect(await env.job(RETURNS)).toMatchObject({ status: "needs-attention", uncertain: false,
      detail: expect.stringContaining(POINTER) }));
    expect(env.spawn).not.toHaveBeenCalled();
    expect(env.send).not.toHaveBeenCalled();
  });

  it("never launches a v2 PR's queued Advance job when the plugin restarts and ticks", async () => {
    const env = await setup();
    await env.optIn();
    saveBatch(env.db, 12, "queued");
    const restarted = await env.harness.lifecycle.reload(plugin);
    cleanups.push(() => restarted.harness.lifecycle.dispose());
    await vi.waitFor(async () => expect((await restarted.harness.callRpc("advance_get", null) as AdvanceBatch[])[0]!.jobs[0])
      .toMatchObject({ status: "needs-attention", uncertain: false, detail: expect.stringContaining(POINTER) }));
    expect(env.workedOn(RETURNS)).toEqual([]);
  });

  it("refuses to plan or run an Advance repair for a v2 PR, even from a repair previewed before opt-in", async () => {
    const env = await setup();
    env.failWorkspace(true);
    const plan = await env.rpc("advance_preview", { prUrls: [RETURNS] }) as AdvancePreview;
    const batch = await env.rpc("advance_start", { token: plan.token }) as AdvanceBatch;
    await vi.waitFor(async () => expect(await env.job(RETURNS)).toMatchObject({ status: "needs-attention" }));
    env.failWorkspace(false);
    const ids = { batchId: batch.id, jobId: batch.jobs[0]!.id };
    const repair = await env.rpc("advance_repair_plan", ids) as { token: string };
    await env.optIn();
    const before = await env.job(RETURNS);
    await expect(env.rpc("advance_repair_plan", ids)).rejects.toThrow(POINTER);
    await expect(env.rpc("advance_repair_run", { token: repair.token, mode: "new", threadId: null, instruction: "Resolve the conflict." }))
      .rejects.toThrow(POINTER);
    expect(await env.job(RETURNS)).toEqual(before);
    expect(env.spawn).not.toHaveBeenCalled();
  });

  it("refuses to start a conversation's Advance batch for a v2 PR previewed before opt-in", async () => {
    const env = await setup();
    const { conversation } = await env.rpc("conversation_open", { prUrls: [RETURNS], instruction: "Prepare the returns shelf PR." });
    const proposed = await env.rpc("conversation_propose", { conversationId: conversation.id, expectedRevision: conversation.revision,
      selectedPrUrls: [RETURNS], exclusions: [], instruction: "Resolve the conflict." }) as WorkConversation;
    const { preview } = await env.rpc("conversation_preview", { conversationId: proposed.id }) as { preview: AdvancePreview };
    await env.optIn();
    await expect(env.rpc("conversation_start", { conversationId: proposed.id, previewToken: preview.token })).rejects.toThrow(`${RETURNS}: ${POINTER}`);
    expect(await env.rpc("advance_get", null)).toEqual([]);
  });

  it("refuses Auto for a v2 effort and never dispatches its PR under any key, while Auto still repairs a legacy effort's PR", async () => {
    const env = await setup();
    await env.optIn();
    await expect(env.rpc("dispatch_set", { mode: "auto", effortKey: env.returns.key })).rejects.toThrow(POINTER);
    // A policy saved before opt-in still points at the effort's board group: the fence, not the key, decides.
    const dispatch = createDispatchStore(env.db);
    const group = (ticket: string) => (env.rpc("board_get", null) as Promise<Board>).then((board) => board.groups
      .find((entry) => entry.clusters.some((cluster) => cluster.ticket === ticket))!.key);
    dispatch.setPolicy("auto", await group("ABC-12"));
    expect((await env.rpc("board_get", null) as Board).dispatch.candidate).toBeNull();
    expect((await env.harness.runCli(["refresh"])).exitCode).toBe(0);
    // A scan ends with one automatic dispatch pass, which signals nothing when it finds no candidate.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(dispatch.attempts()).toEqual([]);
    expect(env.workedOn(RETURNS)).toEqual([]);
    await env.rpc("dispatch_set", { mode: "auto", effortKey: await group("ABC-14") });
    await vi.waitFor(() => expect(dispatch.attempts()).toMatchObject([{ prUrl: USED, action: "resolve-conflicts" }]));
  });

  it("refuses an agent action on a v2 PR and runs it on a legacy effort's PR", async () => {
    const env = await setup();
    await env.optIn();
    const run = (path: string) => env.rpc("agent_run", { path, action: "resolve-conflicts", mode: "new", threadId: null, prompt: "Resolve the conflict." });
    expect(await run("/p/folio-12")).toEqual({ ok: false, error: POINTER });
    expect(await run("/p/folio-14")).toMatchObject({ ok: true });
    expect(env.workedOn(RETURNS)).toEqual([]);
  });

  it("places nothing under a v2 effort: no coordinator or controller, a checkout thread refuses, and a card agent starts unplaced with the pointer", async () => {
    const env = await setup();
    await env.optIn();
    await expect(env.rpc("thread_start", { path: "/p/folio-12", prompt: "Look at the shelf conflict." })).rejects.toThrow(POINTER);
    const card = await env.rpc("card_thread_message", { target: { prUrl: RETURNS }, threadId: null, message: "What blocks this PR?" });
    expect(card).toMatchObject({ ok: true, created: true, warning: expect.stringContaining(POINTER) });
    expect(env.threads.get(card.threadId)?.parentThreadId).toBeNull();
    expect(env.spawn.mock.calls.map(([args]) => args.pluginMetadata.role)).toEqual(["context"]);
    expect(env.store.get(env.returns.id)).toMatchObject({ coordinatorThreadId: null });
    expect(env.store.repoControllers(env.returns.id)).toEqual([]);
  });

  it("suggests, never claims, work an idle intent thread links to a v2 effort, and still claims it for a legacy effort", async () => {
    const env = await setup();
    await env.optIn();
    env.threads.set("thr-intent", { ...makeThreadResponse({ id: "thr-intent", projectId: PROJECT, status: "idle", title: "Gift wrap labels" }),
      environment: { hostId: HOST, path: "/p/folio-16" } });
    env.metadata.set("thr-intent", { workEffortId: env.returns.id });
    env.db.prepare("INSERT INTO thread_work_intent_ids (thread_id) VALUES (?)").run("thr-intent");
    const context = async () => await env.rpc("thread_effort_context", { threadId: "thr-intent" }) as ThreadEffortReady;
    await env.harness.emitThreadEvent("thread.idle", { thread: env.threads.get("thr-intent")!, lastAssistantText: "Labels drafted" });
    await vi.waitFor(async () => expect((await context()).inheritanceNotice).toBe(
      `This effort runs on its roster, so linked work is not added automatically. Add it to the effort to put it on the roster: ABC-16, ${WRAP}.`));
    expect([env.store.owner("ticket", "ABC-16"), env.store.owner("prUrl", WRAP)]).toEqual([null, null]);

    env.metadata.set("thr-intent", { workEffortId: env.used.id });
    await env.harness.emitThreadEvent("thread.idle", { thread: env.threads.get("thr-intent")!, lastAssistantText: "Labels drafted" });
    await vi.waitFor(() => expect(env.store.owner("prUrl", WRAP)?.id).toBe(env.used.id));
  });

  it("keeps a v2 effort's threads under their parents when another effort merges into it", async () => {
    const env = await setup();
    const merge = async (source: EstablishedEffort, destination: EstablishedEffort) => {
      const keys = { sourceKey: source.key, destinationKey: destination.key };
      const preview = await env.rpc("effort_admin_merge_preview", keys);
      expect(preview).toMatchObject({ ok: true, preview: { blockers: [] } });
      expect(await env.rpc("effort_admin_merge", { ...keys, expectedScope: preview.preview.scope })).toMatchObject({ ok: true, pendingThreadSync: 0 });
    };
    const withController = (name: string, ticket: string) => {
      const effort = env.store.establish({ sourceKey: name, name, goal: "", projectId: PROJECT, coordinatorState: "none", members: { tickets: [ticket], prUrls: [] } });
      const controller = `thr-${ticket.toLowerCase()}-repo`;
      env.threads.set(controller, makeThreadResponse({ id: controller, projectId: PROJECT, status: "idle", parentThreadId: `thr-${ticket.toLowerCase()}-old` }));
      const { record } = env.store.claimRepoController({ effortId: effort.id, repo: "inkwell/folio", projectId: PROJECT, hostId: HOST });
      env.store.saveRepoController({ ...record, threadId: controller, state: "ready" });
      return { effort, controller };
    };
    const withParent = (effort: EstablishedEffort, threadId: string) => {
      env.threads.set(threadId, makeThreadResponse({ id: threadId, projectId: PROJECT, status: "idle", title: effort.name }));
      return env.store.save({ ...env.store.get(effort.id)!, coordinatorThreadId: threadId, coordinatorState: "ready" });
    };
    // Control: merging into a legacy effort moves the source controller under the destination's coordinator.
    const legacy = withController("Gift wrap", "ABC-30");
    await merge(legacy.effort, withParent(env.used, "thr-used-parent"));
    expect(env.threads.get(legacy.controller)?.parentThreadId).toBe("thr-used-parent");

    await env.optIn();
    const other = withController("Bookmarks", "ABC-31");
    await merge(other.effort, withParent(env.returns, "thr-returns-parent"));
    expect(env.threads.get(other.controller)?.parentThreadId).toBe("thr-abc-31-old");
  });

  it("refuses to merge a v2 effort into a legacy one, which would hand its PRs back to legacy launchers", async () => {
    const env = await setup();
    await env.optIn();
    const keys = { sourceKey: env.returns.key, destinationKey: env.used.key };
    const blocker = "Returns desk runs on its roster and Used books does not. Move Returns desk back to legacy launchers, or Used books to its roster, before merging.";
    const preview = await env.rpc("effort_admin_merge_preview", keys);
    expect(preview).toMatchObject({ ok: true, preview: { blockers: [blocker] } });
    expect(await env.rpc("effort_admin_merge", { ...keys, expectedScope: preview.preview.scope })).toEqual({ ok: false, error: blocker });
    expect(env.store.get(env.returns.id)?.id).toBe(env.returns.id);
    expect(await env.preview([RETURNS])).toMatchObject([{ eligible: false, detail: POINTER }]);
  });

  it("archives a v2 effort without refusal and keeps its PRs fenced", async () => {
    const env = await setup();
    await env.optIn();
    const scope = (await env.rpc("effort_admin_list", null)).scopes[env.returns.key];
    expect(await env.rpc("effort_admin_archive", { effortKey: env.returns.key, archived: true, expectedScope: scope }))
      .toMatchObject({ ok: true, effort: { archivedAt: expect.any(Number) } });
    expect(await env.preview([RETURNS])).toMatchObject([{ eligible: false, detail: POINTER }]);
    expect(env.work.managedBy(RETURNS)).toBe(env.returns.id);
  });

  it("moves a PR's fence with its membership, in and out of a v2 effort", async () => {
    const env = await setup();
    await env.optIn();
    const move = async (destination: EstablishedEffort) => {
      const context = await env.rpc("card_effort_context", { prUrl: USED }) as CardEffortReady;
      expect(await env.rpc("card_effort_move", { target: { prUrl: USED }, destinationKey: destination.key,
        expectedScope: cardEffortMoveScope(context, destination.key) })).toMatchObject({ ok: true });
    };
    await move(env.returns);
    expect(env.work.managedBy(USED)).toBe(env.returns.id);
    expect(await env.preview([USED])).toMatchObject([{ eligible: false, detail: POINTER }]);
    await move(env.used);
    expect(env.work.managedBy(USED)).toBeNull();
    expect(await env.preview([USED])).toMatchObject([{ eligible: true }]);
  });

  it("fences Advance by fresh ownership before the targets catch up", async () => {
    const env = await setup();
    // The mode is v2 but no rewrite has run yet: Advance reads the PR's current owner itself.
    env.work.setMode(env.returns.id, "v2", 0, () => []);
    expect(env.work.managedBy(RETURNS)).toBeNull();
    expect(await env.preview([RETURNS, USED])).toMatchObject([{ eligible: false, detail: POINTER }, { eligible: true }]);
  });

  it("fences a v2 PR the board stopped listing, through the targets its kept full read resolved", async () => {
    const env = await setup();
    const LISTED_ONCE = url(18);
    env.store.transfer(env.returns.key, { tickets: ["ABC-18"], prUrls: [] });
    // Only a kept full read and a legacy job still name this PR; the board's ownership read no longer sees it.
    env.db.prepare("INSERT INTO pr_facts (pr_url, body, full_at) VALUES (?, ?, ?)").run(LISTED_ONCE, JSON.stringify(facts(18)), Date.now());
    saveBatch(env.db, 18, "needs-attention");
    env.work.setMode(env.returns.id, "v2", 0, () => []);
    const restarted = await env.harness.lifecycle.reload(plugin);
    cleanups.push(() => restarted.harness.lifecycle.dispose());
    expect((await restarted.harness.runCli(["refresh"])).exitCode).toBe(0);
    const work = createEffortWorkStore(restarted.bb.storage.database());
    await vi.waitFor(() => expect(work.managedBy(LISTED_ONCE)).toBe(env.returns.id));
    expect((await restarted.harness.callRpc("advance_preview", { prUrls: [LISTED_ONCE] }) as AdvancePreview).jobs)
      .toMatchObject([{ eligible: false, detail: POINTER }]);
  });

  it("lets you steer an idle thread already linked to a v2 PR, because v2 holds no claim on it yet", async () => {
    const env = await setup();
    await env.optIn();
    env.threads.set("thr-author", makeThreadResponse({ id: "thr-author", projectId: PROJECT, status: "idle", providerId: "codex", title: TITLES[12] }));
    const runs = createRunStore(env.db);
    runs.settle(runs.begin({ path: "/p/folio-12", ticket: "ABC-12", prUrl: RETURNS, prNumber: 12, action: "resolve-conflicts", mode: "new",
      threadId: "thr-author" }), true, "Conflict resolved");
    expect(await env.rpc("thread_message", { prUrl: RETURNS, threadId: "thr-author", message: "Also rerun the shelf tests." }))
      .toMatchObject({ ok: true });
    expect(env.send).toHaveBeenCalledWith(expect.objectContaining({ threadId: "thr-author" }));
  });
});

describe("v2 opt-in", () => {
  type Preview = EffortV2Preview;
  /** A thread on the planning provider unless patched, linked to a PR through a finished action when one is named. */
  function thread(env: Awaited<ReturnType<typeof setup>>, id: string, patch: Partial<ReturnType<typeof makeThreadResponse>> = {}, linkedPr?: number) {
    env.threads.set(id, makeThreadResponse({ id, projectId: PROJECT, status: "idle", providerId: "codex", title: `Thread ${id}`, ...patch }));
    if (linkedPr === undefined) return;
    const runs = createRunStore(env.db);
    runs.settle(runs.begin({ path: `/p/folio-${linkedPr}`, ticket: `ABC-${linkedPr}`, prUrl: url(linkedPr), prNumber: linkedPr,
      action: "resolve-conflicts", mode: "new", threadId: id }), true, "Done");
  }
  const giftWrap = (env: Awaited<ReturnType<typeof setup>>) => env.store.establish({ sourceKey: "thread-created:thr-origin:11111111-1111-4111-8111-111111111111",
    name: "Gift wrap", goal: "", projectId: PROJECT, coordinatorState: "none", members: { tickets: ["ABC-16"], prUrls: [] } });
  const noThreadWrites = (env: Awaited<ReturnType<typeof setup>>) =>
    expect([...env.threads.values()].every((entry) => entry.parentThreadId === null)).toBe(true);

  it("offers the coordinator, the thread that created the effort, and idle linked threads on the planning provider as parents", async () => {
    const env = await setup();
    const gifts = giftWrap(env);
    thread(env, "thr-origin");
    thread(env, "thr-linked", {}, 16);
    thread(env, "thr-other-provider", { providerId: "claude-code" }, 16);
    thread(env, "thr-busy", { status: "active" }, 16);
    thread(env, "thr-used-parent", {}, 16);
    env.store.save({ ...env.used, coordinatorThreadId: "thr-used-parent", coordinatorState: "ready" });
    const candidates = async () => (await env.rpc("effort_v2_preview", { effortId: gifts.id }) as Preview).parent;
    expect(await candidates()).toEqual({ recommended: "thr-origin", reason: "The thread that created this effort becomes its parent.", candidates: [
      { threadId: "thr-origin", title: "Thread thr-origin", reason: "origin", canSpawnChild: true },
      { threadId: "thr-linked", title: "Thread thr-linked", reason: "linked", canSpawnChild: true }] });
    // A thread the preview left out is refused at opt-in too, before anything is written.
    await expect(env.rpc("effort_v2_set", { effortId: gifts.id, mode: "v2", expectedRevision: 0, parentThreadId: "thr-other-provider" }))
      .rejects.toThrow("can't be this effort's parent");
    expect([env.work.execution(gifts.id).mode, env.metadata.has("thr-other-provider")]).toEqual(["legacy", false]);
    thread(env, "thr-coordinator");
    env.store.save({ ...env.store.get(gifts.id)!, coordinatorThreadId: "thr-coordinator", coordinatorState: "ready" });
    expect(await candidates()).toMatchObject({ recommended: "thr-coordinator",
      candidates: [{ threadId: "thr-coordinator", reason: "coordinator" }, { threadId: "thr-origin" }, { threadId: "thr-linked" }] });
    // Returns desk has no coordinator, no originating thread, and no linked thread: it would start one new parent.
    expect((await env.rpc("effort_v2_preview", { effortId: env.returns.id }) as Preview).parent).toMatchObject({ candidates: [], recommended: null });
  });

  it("links a chosen thread as the parent by retitling and associating it, sends nothing, and fences the roster at once", async () => {
    const env = await setup();
    const gifts = giftWrap(env);
    thread(env, "thr-origin");
    const result = await env.rpc("effort_v2_set", { effortId: gifts.id, mode: "v2", expectedRevision: 0, parentThreadId: "thr-origin" });
    expect(result).toEqual({ execution: { mode: "v2", revision: 1 }, parentThreadId: "thr-origin", cancelled: [], draining: [] });
    expect(env.threads.get("thr-origin")?.title).toBe(effortTitle("Gift wrap"));
    expect(env.metadata.get("thr-origin")).toEqual({ effortId: gifts.id, role: "coordinator" });
    expect(env.spawn).not.toHaveBeenCalled();
    expect(env.send).not.toHaveBeenCalled();
    noThreadWrites(env);
    // The parent lives only in the coordinator pointer; membership is unchanged.
    expect(env.store.get(gifts.id)).toMatchObject({ coordinatorThreadId: "thr-origin", members: gifts.members });
    expect((env.db.prepare("PRAGMA table_info(effort_execution)").all() as { name: string }[]).map((column) => column.name))
      .toEqual(["effort_id", "mode", "revision", "updated_at"]);
    expect(env.work.managedBy(WRAP)).toBe(gifts.id);
  });

  it("refuses a second opt-in while the first is changing the effort, so the parent it reports is the one saved", async () => {
    const env = await setup();
    const gifts = giftWrap(env);
    thread(env, "thr-origin");
    thread(env, "thr-linked", {}, 16);
    const settled = await Promise.allSettled(["thr-origin", "thr-linked"].map((parentThreadId) =>
      env.rpc("effort_v2_set", { effortId: gifts.id, mode: "v2", expectedRevision: 0, parentThreadId })));
    const joined = settled.flatMap((outcome) => outcome.status === "fulfilled" ? [outcome.value] : []);
    expect(joined).toHaveLength(1);
    expect(settled.find((outcome) => outcome.status === "rejected")).toMatchObject({ reason: expect.objectContaining({ message: expect.stringContaining("already changing") }) });
    expect(env.store.get(gifts.id)?.coordinatorThreadId).toBe(joined[0].parentThreadId);
    expect(env.metadata.has(joined[0].parentThreadId === "thr-origin" ? "thr-linked" : "thr-origin")).toBe(false);
  });

  it("refuses an opt-in whose preview was still reading when another landed, before it starts or links a parent", async () => {
    const env = await setup();
    const gifts = giftWrap(env);
    thread(env, "thr-origin");
    // The late request's preview read revision 0, then waits on a thread read while the other opt-in lands.
    let resume!: () => void;
    const reading = new Promise<void>((started) => env.beforeGet.mockImplementationOnce(async () => {
      started();
      await new Promise<void>((resolve) => { resume = resolve; });
    }));
    const late = env.rpc("effort_v2_set", { effortId: gifts.id, mode: "v2", expectedRevision: 0, parentThreadId: null });
    await reading;
    expect(await env.rpc("effort_v2_set", { effortId: gifts.id, mode: "v2", expectedRevision: 0, parentThreadId: "thr-origin" }))
      .toMatchObject({ execution: { mode: "v2", revision: 1 }, parentThreadId: "thr-origin" });
    resume();
    await expect(late).rejects.toThrow("execution mode changed");
    expect(env.spawn).not.toHaveBeenCalled();
    expect(env.store.get(gifts.id)?.coordinatorThreadId).toBe("thr-origin");
  });

  it("offers the thread an unresolved parent launch started, and blocks opt-in while it finds none", async () => {
    const env = await setup();
    const launch = env.spawn.getMockImplementation()!;
    // Returns desk's launch started a thread before its answer was lost; Used books' launch left no thread.
    env.spawn.mockImplementationOnce(async (args) => { await launch(args); throw new Error("socket hang up"); })
      .mockRejectedValueOnce(new Error("socket hang up"));
    const optIn = (effort: EstablishedEffort, parentThreadId: string | null) =>
      env.rpc("effort_v2_set", { effortId: effort.id, mode: "v2", expectedRevision: 0, parentThreadId });
    const preview = async (effort: EstablishedEffort) => await env.rpc("effort_v2_preview", { effortId: effort.id }) as Preview;
    await expect(optIn(env.returns, null)).rejects.toThrow("socket hang up");
    await expect(optIn(env.used, null)).rejects.toThrow("socket hang up");
    expect(await preview(env.returns)).toMatchObject({ blockers: [],
      parent: { recommended: "thr-coordinator-1", candidates: [{ threadId: "thr-coordinator-1", reason: "coordinator" }] } });
    await expect(optIn(env.returns, null)).rejects.toThrow("unresolved");
    expect(await optIn(env.returns, "thr-coordinator-1")).toMatchObject({ execution: { mode: "v2" }, parentThreadId: "thr-coordinator-1" });
    const blocker = "A coordinator launch is unresolved. Inspect it before moving this effort to its roster.";
    expect(await preview(env.used)).toMatchObject({ blockers: [blocker], parent: { candidates: [] } });
    await expect(optIn(env.used, null)).rejects.toThrow(blocker);
    expect(env.spawn).toHaveBeenCalledTimes(2);
    expect(env.work.execution(env.used.id).mode).toBe("legacy");
  });

  it("starts one new parent on the planning model with the minimal prompt when none is chosen", async () => {
    const env = await setup();
    const result = await env.rpc("effort_v2_set", { effortId: env.returns.id, mode: "v2", expectedRevision: 0, parentThreadId: null });
    expect(env.spawn).toHaveBeenCalledTimes(1);
    expect(env.spawn.mock.calls[0]![0]).toMatchObject({ providerId: "codex", model: "gpt-6-sol", reasoningLevel: "medium", projectId: PROJECT,
      title: effortTitle("Returns desk"), pluginMetadata: { effortId: env.returns.id, role: "coordinator" },
      prompt: "This is the effort parent thread for Returns desk. Workstreams posts rosters and decisions here. Reply only: Ready." });
    expect(env.spawn.mock.calls[0]![0]).not.toHaveProperty("parentThreadId");
    expect(env.send).not.toHaveBeenCalled();
    expect(result.parentThreadId).toBe(env.store.get(env.returns.id)!.coordinatorThreadId);
    expect(env.work.managedBy(RETURNS)).toBe(env.returns.id);
  });

  it("cancels each queued legacy job at opt-in and lists running or uncertain ones as draining", async () => {
    const env = await setup();
    // Used books' PR and the gift-wrap ticket join Returns desk, so its roster is 12, 14, and 16.
    env.store.transfer(env.returns.key, { tickets: ["ABC-14", "ABC-16"], prUrls: [USED] });
    thread(env, "thr-folio-16", { status: "active" });
    saveBatch(env.db, 12, "queued");
    // A running and an uncertain worker fill Advance's two slots, so the queued job is still waiting at opt-in.
    saveBatch(env.db, 14, "needs-attention", { uncertain: true });
    saveBatch(env.db, 16, "running", { threadId: "thr-folio-16" });
    const restarted = await env.harness.lifecycle.reload(plugin);
    cleanups.push(() => restarted.harness.lifecycle.dispose());
    const rpc = (method: string, input: unknown) => restarted.harness.callRpc(method as never, input as never) as Promise<any>;
    const preview = await rpc("effort_v2_preview", { effortId: env.returns.id }) as Preview;
    expect(preview).toMatchObject({ v2Execution: "dry-run", blockers: [],
      consequence: "Legacy Advance and dispatch stop for this effort. v2 plans work but runs nothing until v2 execution is on.",
      members: { tickets: 3, prUrls: 1, prs: 3, open: 3 } });
    expect(preview.legacy.queued.map((job) => [job.number, job.status])).toEqual([[12, "queued"]]);
    expect(preview.legacy.draining.map((job) => [job.number, job.status, job.uncertain]).sort()).toEqual([[14, "needs-attention", true], [16, "running", false]]);
    const result = await rpc("effort_v2_set", { effortId: env.returns.id, mode: "v2", expectedRevision: 0, parentThreadId: null });
    expect(result).toMatchObject({ cancelled: preview.legacy.queued, draining: preview.legacy.draining });
    const jobs = (await rpc("advance_get", null) as AdvanceBatch[]).flatMap((batch) => batch.jobs);
    expect(jobs.map((job) => [job.number, job.status, job.uncertain]).sort())
      .toEqual([[12, "cancelled", false], [14, "needs-attention", true], [16, "running", false]]);
    expect(env.workedOn(RETURNS)).toEqual([]);
  });

  it("reports a queued job that launched while the parent was being linked as draining, not cancelled", async () => {
    const env = await setup();
    thread(env, "thr-coordinator");
    env.store.save({ ...env.returns, coordinatorThreadId: "thr-coordinator", coordinatorState: "ready" });
    thread(env, "thr-linked", {}, 12);
    let prepared!: () => void;
    env.beforeWorkspace.mockImplementationOnce(() => new Promise<void>((resolve) => { prepared = resolve; }));
    await env.rpc("advance_start", { token: (await env.rpc("advance_preview", { prUrls: [RETURNS] }) as AdvancePreview).token });
    await vi.waitFor(() => expect(prepared).toBeDefined());
    expect((await env.rpc("effort_v2_preview", { effortId: env.returns.id }) as Preview).legacy.queued).toMatchObject([{ prUrl: RETURNS }]);
    // Its checkout is ready as opt-in reads the chosen parent a second time, to link it, so the job launches before the fence lands.
    let reads = 0;
    env.beforeGet.mockImplementation(async (threadId) => {
      if (threadId !== "thr-linked" || ++reads !== 2) return;
      prepared();
      await vi.waitFor(async () => expect(await env.job(RETURNS)).toMatchObject({ status: "running" }));
    });
    expect(await env.rpc("effort_v2_set", { effortId: env.returns.id, mode: "v2", expectedRevision: 0, parentThreadId: "thr-linked" }))
      .toMatchObject({ cancelled: [], draining: [{ prUrl: RETURNS, status: "running" }] });
  });

  it("refuses opt-in for an archived or merged effort, or while Auto dispatch targets it, and changes nothing", async () => {
    const env = await setup();
    const refused = async (effort: EstablishedEffort, blocker: string) => {
      expect((await env.rpc("effort_v2_preview", { effortId: effort.id }) as Preview).blockers).toEqual([blocker]);
      await expect(env.rpc("effort_v2_set", { effortId: effort.id, mode: "v2", expectedRevision: 0, parentThreadId: null })).rejects.toThrow(blocker);
    };
    const dispatch = createDispatchStore(env.db);
    dispatch.setPolicy("auto", env.used.key);
    await refused(env.used, "Turn off automatic dispatch for this effort before moving it to its roster.");
    dispatch.setPolicy("off", null);
    env.store.setArchived(env.returns.id, true);
    await refused(env.returns, "Restore this effort before moving it to its roster.");
    const gifts = giftWrap(env);
    env.store.merge(gifts.id, env.used.id);
    await refused(gifts, "This effort was merged into Used books. Opt in Used books instead.");
    expect([env.returns, env.used, gifts].map((effort) => env.work.execution(effort.id).mode)).toEqual(["legacy", "legacy", "legacy"]);
    expect(env.spawn).not.toHaveBeenCalled();
  });

  it("opts out at the current revision only, keeping the parent and every record and lifting the fence", async () => {
    const env = await setup();
    const joined = await env.rpc("effort_v2_set", { effortId: env.returns.id, mode: "v2", expectedRevision: 0, parentThreadId: null });
    expect(await env.rpc("effort_command", { effortId: env.returns.id, snapshotId: null, text: `move ${RETURNS} forward`, requestId: "returns-1", source: "panel" }))
      .toMatchObject({ kind: "admit" });
    await expect(env.rpc("effort_v2_set", { effortId: env.returns.id, mode: "v2", expectedRevision: 1, parentThreadId: null })).rejects.toThrow("already runs on its roster");
    await expect(env.rpc("effort_v2_set", { effortId: env.returns.id, mode: "legacy", expectedRevision: 0 })).rejects.toThrow("execution mode changed");
    await expect(env.rpc("effort_v2_set", { effortId: env.returns.id, mode: "legacy", expectedRevision: 1, parentThreadId: null })).rejects.toThrow("keeps the parent");
    expect(await env.rpc("effort_v2_set", { effortId: env.returns.id, mode: "legacy", expectedRevision: 1 }))
      .toEqual({ execution: { mode: "legacy", revision: 2 }, parentThreadId: joined.parentThreadId, cancelled: [], draining: [] });
    expect(env.store.get(env.returns.id)).toMatchObject({ coordinatorThreadId: joined.parentThreadId, members: env.returns.members });
    // The instruction stays; its row pauses and no longer fences the PR.
    expect(env.work.instruction(env.returns.id)).toMatchObject({ revision: 1 });
    expect(env.work.row(RETURNS)).toMatchObject({ phase: "paused", body: { cause: "v2-off" } });
    expect(env.work.managedBy(RETURNS)).toBeNull();
    expect(await env.preview([RETURNS])).toMatchObject([{ eligible: true }]);
    // Opting in again with the same parent resumes the row where the instruction left it.
    await env.rpc("effort_v2_set", { effortId: env.returns.id, mode: "v2", expectedRevision: 2, parentThreadId: joined.parentThreadId });
    expect(env.work.row(RETURNS)).toMatchObject({ phase: "verifying", body: { cause: "observe" } });
    expect(env.spawn).toHaveBeenCalledTimes(1);
  });

  it("states the v2 execution setting and what it means, a dry run unless you turn it on", async () => {
    const env = await setup();
    expect(env.harness.registrations.settingsDescriptors).toMatchObject({ v2Execution: { type: "select", options: ["dry-run", "on"], default: "dry-run" },
      workerConcurrency: { type: "number", default: 2 } });
    const preview = async () => await env.rpc("effort_v2_preview", { effortId: env.returns.id }) as Preview;
    expect(await preview()).toMatchObject({ v2Execution: "dry-run",
      consequence: "Legacy Advance and dispatch stop for this effort. v2 plans work but runs nothing until v2 execution is on." });
    await env.harness.setSettings({ v2Execution: "on" });
    expect(await preview()).toMatchObject({ v2Execution: "on",
      consequence: "Legacy Advance and dispatch stop for this effort. v2 claims each PR it works on and launches the work its instruction authorizes." });
  });

  it("previews and opts in from the CLI with the revision the preview showed", async () => {
    const env = await setup();
    const preview = await env.harness.runCli(["v2", "preview", "Returns", "desk"]);
    expect(preview).toMatchObject({ exitCode: 0 });
    expect(preview.stdout!.split("\n").slice(0, 4)).toEqual(["Returns desk · legacy · revision 0",
      "Legacy Advance and dispatch stop for this effort. v2 plans work but runs nothing until v2 execution is on.",
      "PRs: 1 (1 open) from 1 tickets and 0 PRs",
      "Parent: a new thread. No coordinator or originating thread is available on the planning model, so one new parent starts unless you choose a linked thread."]);
    const stale = await env.harness.runCli(["v2", "set", "Returns", "desk", "--mode", "v2", "--revision", "3", "--new-parent"]);
    expect(stale).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("execution mode changed") });
    // A stale request is refused before it starts a parent, not after.
    expect(env.spawn).not.toHaveBeenCalled();
    const joined = await env.harness.runCli(["v2", "set", "Returns", "desk", "--mode", "v2", "--revision", "0", "--new-parent"]);
    expect(joined).toMatchObject({ exitCode: 0,
      stdout: `Runs on its roster (revision 1). Parent: ${env.store.get(env.returns.id)!.coordinatorThreadId}.\nCancelled: none. Draining: none.` });
    expect(env.work.managedBy(RETURNS)).toBe(env.returns.id);
  });
});

describe("v2 claims", () => {
  const CLAIM = "A worker from the Returns desk roster is writing this PR or checkout. Wait for it to finish, or instruct it from the roster.";
  /** A v2 attempt as a launch leaves it: claiming its PR, its checkout, and its thread while launching, running, or uncertain. */
  function seed(env: Awaited<ReturnType<typeof setup>>, id: string, target: string, status: StoredAttempt["status"], where: { path?: string | null; threadId?: string | null } = {}) {
    const { path = null, threadId = null } = where;
    const body: AttemptBody = { instructionRevision: 1, recipes: ["integrate_base"], role: "code", retryEpoch: 0, retryIndex: 0,
      start: { headOid: HEAD, baseOid: BASE, fingerprint: null, sourceIds: [] }, resource: { kind: "spawn", threadId: null, path, hostId: HOST, projectId: PROJECT, reason: null, workspace: null },
      mode: "spawn", marker: `[Workstreams attempt ${id} · inkwell/folio#12 · instruction r1]`, settledAt: Date.now(), uncertainAt: status === "uncertain" ? Date.now() : null,
      emptyReadbackAt: null, failure: null, error: null, releasedReason: null };
    env.work.claim({ id, target, effortId: env.returns.id, instructionId: `I-${env.returns.id}-r1`, launchKey: `key-${id}`, threadId, hostId: HOST, path, body });
    if (status !== "launching") env.work.recordAttempt(id, ["launching"], { status, body });
    return body;
  }
  const end = (env: Awaited<ReturnType<typeof setup>>, id: string) =>
    env.work.recordAttempt(id, ["launching", "running", "uncertain"], { status: "completed", body: env.work.attempt(id)!.body });
  const command = (env: Awaited<ReturnType<typeof setup>>, text: string, requestId: string) =>
    env.rpc("effort_command", { effortId: env.returns.id, snapshotId: null, text, requestId, source: "panel" });
  /** 12's stored step, queued for the server's own runner as the reconciler (C20) will hand it over: a new thread in 12's checkout. */
  const launch = (env: Awaited<ReturnType<typeof setup>>) => {
    const row = env.work.row(RETURNS)!;
    const step: Next = { phase: "queued", cause: row.body.cause, detail: row.body.detail, modifiers: [], nextAction: ["integrate_base"], owner: null, wake: row.body.wake,
      decision: null, recovery: [], offers: [], resource: { kind: "spawn", reason: "no idle thread", references: [],
        checkout: { path: "/p/folio-12", kind: "author", hostId: HOST, projectId: PROJECT, workspace: null, moveCleanToHead: false } } };
    return env.runner.launch({ effortId: env.returns.id, target: RETURNS, baseRevision: env.work.lastRevision(env.returns.id), expectedRevision: row.revision, step,
      body: row.body, order: { revision: env.work.instruction(env.returns.id)!.revision, facts: facts(12), granted: DEFAULT_EFFECTS, parentMerged: false, tickets: [],
        criteria: [], threads: [], answers: [], direction: null } });
  };
  const transitions = (env: Awaited<ReturnType<typeof setup>>) =>
    (env.db.prepare("SELECT count(*) AS count FROM effort_transitions WHERE target = ?").get(RETURNS) as { count: number }).count;

  it("keeps every writer outside v2 off a claimed PR and its checkout, even after the effort opts out, until the claim ends", async () => {
    const env = await setup();
    await env.optIn();
    env.threads.set("thr-author", makeThreadResponse({ id: "thr-author", projectId: PROJECT, status: "idle", providerId: "codex", title: TITLES[12] }));
    const runs = createRunStore(env.db);
    runs.settle(runs.begin({ path: "/p/folio-12", ticket: "ABC-12", prUrl: RETURNS, prNumber: 12, action: "resolve-conflicts", mode: "new", threadId: "thr-author" }), true, "Done");
    seed(env, "A-12", RETURNS, "running", { path: "/p/folio-12", threadId: "thr-v2-worker" });
    // Opting out lifts the roster's fence at once, but its worker still writes: the claim holds until it ends.
    env.work.setMode(env.returns.id, "legacy", 1, () => []);
    expect(env.work.managedBy(RETURNS)).toBeNull();
    const writes = {
      preview: async () => (await env.preview([RETURNS]))[0],
      agent: () => env.rpc("agent_run", { path: "/p/folio-12", action: "resolve-conflicts", mode: "new", threadId: null, prompt: "Resolve the conflict." }),
      message: () => env.rpc("thread_message", { prUrl: RETURNS, threadId: "thr-author", message: "Also rerun the shelf tests." }),
      card: () => env.rpc("card_thread_message", { target: { prUrl: RETURNS }, threadId: null, message: "What blocks this PR?" }),
      merge: () => env.rpc("action_merge", { prUrl: RETURNS, sha: HEAD, acknowledgeUnresolved: false }),
    };
    expect(await writes.preview()).toMatchObject({ eligible: false, detail: "Another action or batch already owns this PR" });
    for (const write of [writes.agent, writes.message, writes.card, writes.merge]) expect(await write()).toEqual({ ok: false, error: CLAIM });
    expect([env.spawn.mock.calls, env.send.mock.calls, env.hostCalls.filter((call) => ["prWrite", "advanceWorkspace"].includes(call.method))]).toEqual([[], [], []]);
    end(env, "A-12");
    expect(await writes.preview()).toMatchObject({ eligible: true });
    expect(await writes.message()).toMatchObject({ ok: true });
    expect(await writes.agent()).toMatchObject({ ok: true });
  });

  it("fences a checkout a v2 attempt claims from another PR's writer, and leaves every other checkout alone", async () => {
    const env = await setup();
    await env.optIn();
    // Returns desk's worker runs in the checkout Used books' PR is checked out in.
    seed(env, "A-12", RETURNS, "uncertain", { path: "/p/folio-14" });
    const agent = (path: string) => env.rpc("agent_run", { path, action: "resolve-conflicts", mode: "new", threadId: null, prompt: "Resolve the conflict." });
    expect(await agent("/p/folio-14")).toEqual({ ok: false, error: CLAIM });
    expect(await env.preview([USED])).toMatchObject([{ eligible: false, detail: "Another action or batch already owns this PR" }]);
    // Auto dispatch for Used books reaches the same checkout, and holds off until the claim ends.
    const group = (await env.rpc("board_get", null) as Board).groups.find((entry) => entry.clusters.some((cluster) => cluster.ticket === "ABC-14"))!.key;
    await env.rpc("dispatch_set", { mode: "auto", effortKey: group });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const dispatch = createDispatchStore(env.db);
    expect(dispatch.attempts()).toEqual([]);
    expect(await agent("/p/folio-16")).toMatchObject({ ok: true });
    end(env, "A-12");
    expect((await env.harness.runCli(["refresh"])).exitCode).toBe(0);
    await vi.waitFor(() => expect(dispatch.attempts()).toMatchObject([{ prUrl: USED, action: "resolve-conflicts" }]));
  });

  it("stops a legacy Advance start at its last synchronous check when a v2 claim lands after its async one", async () => {
    const env = await setup();
    await env.optIn();
    env.threads.set("thr-used", { ...makeThreadResponse({ id: "thr-used", projectId: PROJECT, status: "idle", providerId: "codex" }), environment: { hostId: HOST, path: "/p/folio-14" } });
    expect((await env.harness.runCli(["refresh"])).exitCode).toBe(0);
    const plan = await env.rpc("advance_preview", { prUrls: [USED] }) as AdvancePreview;
    expect(plan.jobs[0]).toMatchObject({ eligible: true });
    // The start's async writer check reads the checkout's threads; the claim lands while it waits on BB.
    env.beforeGet.mockImplementationOnce(async (threadId) => { if (threadId === "thr-used") seed(env, "A-12", RETURNS, "launching", { path: "/p/folio-14" }); });
    await expect(env.rpc("advance_start", { token: plan.token })).rejects.toThrow("Another action started on this selection. Preview again.");
    expect(env.work.attempt("A-12")?.status).toBe("launching");
    expect(await env.rpc("advance_get", null)).toEqual([]);
  });

  it("blocks merging efforts while either has a v2 worker claim, including one that lands just before the merge commits", async () => {
    const env = await setup();
    await env.optIn();
    const keys = { sourceKey: env.used.key, destinationKey: env.returns.key };
    const blockers = async () => (await env.rpc("effort_admin_merge_preview", keys)).preview.blockers;
    expect(await blockers()).toEqual([]);
    seed(env, "A-12", RETURNS, "uncertain");
    expect(await blockers()).toEqual(["Returns desk has a v2 worker launching, running, or uncertain. Let it finish, or release it from the roster, before merging."]);
    end(env, "A-12");
    const { scope } = (await env.rpc("effort_admin_merge_preview", keys)).preview;
    const transaction = env.db.transaction.bind(env.db);
    vi.spyOn(env.db, "transaction").mockImplementationOnce((fn) => transaction((...args: unknown[]) => {
      seed(env, "A-13", RETURNS, "launching");
      return fn(...args);
    }));
    expect(await env.rpc("effort_admin_merge", { ...keys, expectedScope: scope }))
      .toEqual({ ok: false, error: expect.stringContaining("A v2 worker claimed work for these efforts. Reopen the merge preview.") });
    expect(env.store.get(env.used.id)!.mergedInto ?? null).toBeNull();
  });

  it("drops an uncertain launch's claim on reset only with reset N release, in the command's own journaled commit", async () => {
    const env = await setup();
    await env.optIn();
    expect(await command(env, `move ${RETURNS} forward`, "returns-1")).toMatchObject({ kind: "admit" });
    seed(env, "A-12", RETURNS, "uncertain");
    const name = formatTargets([{ target: RETURNS, n: env.work.row(RETURNS)?.body.n ?? null }]);
    expect(await command(env, `reset ${RETURNS}`, "returns-2")).toEqual({ kind: "clarify", normalized: `reset ${name}`,
      message: `${name}'s launch is uncertain. Reset drops that claim only if you confirm no worker is writing: reset ${name} release` });
    expect(env.work.attempt("A-12")?.status).toBe("uncertain");
    const released = await command(env, `reset ${RETURNS} release`, "returns-3");
    expect(released).toMatchObject({ kind: "admit", acknowledgment: expect.arrayContaining([`Reset, releasing the uncertain launch claim: ${name}`]) });
    expect(env.work.attempt("A-12")).toMatchObject({ status: "released", body: { releasedReason: "no-worker" } });
    expect(env.work.claims()).toEqual([]);
    // The release is journaled with the words that asked for it, and the row starts over in a new epoch.
    expect(env.work.command(env.returns.id, "returns-3")).toEqual(released);
    expect(env.db.prepare(`SELECT json_extract(detail, '$.text') AS text FROM effort_transitions WHERE cause = 'command' ORDER BY seq DESC LIMIT 1`).get())
      .toEqual({ text: `reset ${RETURNS} release` });
    // The row plans from the release in that commit: no launch is uncertain any more, so it reads GitHub before anything else.
    expect(env.work.row(RETURNS)).toMatchObject({ phase: "verifying", body: { cause: "observe", retryEpoch: 1 } });
  });

  it("refuses reset N release while this process is still launching that PR, and lets the launch settle on its own", async () => {
    const env = await setup();
    await env.optIn();
    await command(env, `move ${RETURNS} forward`, "returns-1");
    await command(env, `refresh ${RETURNS}`, "returns-2");
    await env.harness.setSettings({ v2Execution: "on" });
    const spawn = env.spawn.getMockImplementation()!;
    let finish!: () => void;
    env.spawn.mockImplementationOnce(async (args) => { await new Promise<void>((resolve) => { finish = resolve; }); return spawn(args); });
    const launching = launch(env);
    await vi.waitFor(() => expect(env.spawn).toHaveBeenCalled());
    const { id } = env.work.attempts(RETURNS)[0]!;
    const name = formatTargets([{ target: RETURNS, n: env.work.row(RETURNS)?.body.n ?? null }]);
    // Released now, the spawn in flight would start a worker nothing records, and the row would launch another.
    expect(await command(env, `reset ${RETURNS} release`, "returns-3")).toEqual({ kind: "clarify", normalized: null, message: `${name}'s launch is still waiting on BB, `
      + `and settles as running or uncertain on its own. If it stays uncertain, send reset ${name} release again. Nothing was admitted.` });
    expect(env.work.attempt(id)?.status).toBe("launching");
    finish();
    expect(await launching).toBe("launched");
    expect(env.work.attempt(id)).toMatchObject({ status: "running", threadId: expect.stringMatching(/^thr-v2-worker-/u) });
    expect(env.spawn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["before a legacy Advance start on it runs", "v2"], ["while that start prepares its checkout", "v2"], ["while that start spawns its worker", "legacy"],
    ["after that start's worker runs", "legacy"],
  ] as const)("keeps one writer on an unowned PR a v2 command names %s", async (when, winner) => {
    const env = await setup();
    await env.optIn();
    await env.harness.setSettings({ v2Execution: "on" });
    // Returns desk's command names 16 from outside membership, and its reconciler acts at once.
    let answer: unknown = null;
    const v2 = async () => {
      answer = await command(env, `move ${WRAP} forward`, "wrap-1");
      await env.reconciler.recoverAll();
      await env.reconciler.tick();
    };
    const plan = await env.rpc("advance_preview", { prUrls: [WRAP] }) as AdvancePreview;
    expect(plan.jobs[0]).toMatchObject({ eligible: true });
    if (when === "before a legacy Advance start on it runs") await v2();
    if (when === "while that start prepares its checkout") env.beforeWorkspace.mockImplementationOnce(v2);
    if (when === "while that start spawns its worker") {
      const spawn = env.spawn.getMockImplementation()!;
      env.spawn.mockImplementationOnce(async (args) => { await v2(); return spawn(args); });
    }
    const started = await env.rpc("advance_start", { token: plan.token }).then(() => true, () => false);
    if (started) await vi.waitFor(async () => expect(["running", "needs-attention"]).toContain((await env.job(WRAP))?.status));
    if (when === "after that start's worker runs") await v2();
    // Whichever started first holds the PR; the other stays off it through every later pass. Exactly one writer: a v2 worker, or legacy Advance's.
    for (let pass = 0; pass < 3; pass++) await env.reconciler.tick();
    const legacy = await env.job(WRAP);
    const v2Spawns = env.spawn.mock.calls.filter(([args]) => args.pluginMetadata?.role === "v2-worker" && args.pluginMetadata.prUrl === WRAP).length;
    expect([v2Spawns, env.work.attempts(WRAP).length, legacy?.threadId ? 1 : 0]).toEqual(winner === "v2" ? [1, 1, 0] : [0, 0, 1]);
    if (winner === "v2") {
      expect(answer).toMatchObject({ kind: "admit" });
      expect(env.work.attempts(WRAP)).toMatchObject([{ status: "running", threadId: expect.stringMatching(/^thr-v2-worker-/u) }]);
      // The start is refused outright, or its job stops at a fence before any worker.
      expect(legacy === undefined || (legacy.status === "needs-attention" && legacy.threadId === null)).toBe(true);
    } else {
      // Legacy Advance placed 16 under an effort of its own before its worker started, so the command admits nothing and names that effort.
      expect(answer).toMatchObject({ kind: "clarify", message: expect.stringContaining(`${WRAP} belongs to other efforts`) });
      expect(legacy).toMatchObject({ status: "running" });
      expect([env.work.claims(), env.work.row(WRAP)]).toEqual([[], null]);
    }
  });

  it("waits for a legacy Advance job the server finds inside the claim's transaction, and claims and starts nothing", async () => {
    const env = await setup();
    // A legacy job took 12 before its roster opted in, and drains.
    const batch = await env.rpc("advance_start", { token: (await env.rpc("advance_preview", { prUrls: [RETURNS] }) as AdvancePreview).token }) as AdvanceBatch;
    await vi.waitFor(async () => expect(await env.job(RETURNS)).toMatchObject({ status: "running" }));
    await env.optIn();
    await command(env, `move ${RETURNS} forward`, "returns-1");
    await command(env, `refresh ${RETURNS}`, "returns-2");
    await env.harness.setSettings({ v2Execution: "on" });
    const legacy = env.spawn.mock.calls.length;
    expect(await launch(env)).toBe("waiting");
    expect([env.work.attempts(RETURNS), env.spawn.mock.calls.length]).toEqual([[], legacy]);
    expect(env.work.row(RETURNS)).toMatchObject({ phase: "waiting", body: { cause: "legacy-drain", owner: { kind: "legacy-job", ref: `${batch.id}/${batch.jobs[0]!.id}` } } });
  });

  it("keeps a dry run's plan through a re-plan that changes nothing else, so no pass churns the journal", async () => {
    const env = await setup();
    await env.optIn();
    await command(env, `move ${RETURNS} forward`, "returns-1");
    await command(env, `refresh ${RETURNS}`, "returns-2");
    expect(await launch(env)).toBe("planned");
    const planned = env.work.row(RETURNS)!;
    expect(planned).toMatchObject({ phase: "queued", body: { plan: { recipes: ["integrate_base"], resource: { kind: "spawn", path: "/p/folio-12" } } } });
    const before = transitions(env);
    // Every command re-plans each row from stored facts, as every reconciler tick will; this one changes nothing about 12.
    await command(env, "recheck launches", "returns-3");
    expect(env.work.row(RETURNS)).toEqual(planned);
    expect(await launch(env)).toBe("planned");
    expect(transitions(env)).toBe(before);
    expect([env.work.claims(), env.spawn.mock.calls, env.send.mock.calls]).toEqual([[], [], []]);
  });

  it("reads each row's claim into the plan, and refuses stop N in a dry run, which writes nothing to BB", async () => {
    const env = await setup();
    await env.optIn();
    await command(env, `move ${RETURNS} forward`, "returns-1");
    seed(env, "A-12", RETURNS, "running", { path: "/p/folio-12", threadId: "thr-v2-worker" });
    expect(await command(env, `hold ${RETURNS}`, "returns-2")).toMatchObject({ kind: "admit" });
    // The hold arrives mid-turn: the turn finishes, and nothing new starts.
    expect(env.work.row(RETURNS)).toMatchObject({ phase: "executing", body: { cause: "worker", modifiers: ["draining"], owner: { kind: "v2-attempt", ref: "A-12" } } });
    const n = formatTargets([{ target: RETURNS, n: env.work.row(RETURNS)?.body.n ?? null }]);
    expect(await command(env, `stop ${RETURNS}`, "returns-3")).toEqual({ kind: "clarify", normalized: null,
      message: `v2 execution is a dry run, so v2 stops no worker. Stop ${n} in thr-v2-worker yourself. Nothing was admitted.` });
    expect([env.work.attempt("A-12")?.status, env.work.attempt("A-12")?.body.stopRequestedAt]).toEqual(["running", undefined]);
  });

  it("reads every unfinished launch back from BB on recheck launches, attaching the one thread its spawn metadata names", async () => {
    const env = await setup();
    await env.optIn();
    await command(env, `move ${RETURNS} forward`, "returns-1");
    seed(env, "A-12", RETURNS, "uncertain");
    env.threads.set("thr-found", makeThreadResponse({ id: "thr-found", projectId: PROJECT, status: "active", providerId: "codex", originPluginId: "workstreams" }));
    env.metadata.set("thr-found", { workAttemptId: "A-12", role: "v2-worker", prUrl: RETURNS, effortId: env.returns.id });
    const name = formatTargets([{ target: RETURNS, n: env.work.row(RETURNS)?.body.n ?? null }]);
    expect(await command(env, "recheck launches", "returns-2")).toMatchObject({ kind: "admit",
      acknowledgment: ["Recheck launches: read back every uncertain launch", `Readback: ${name} attached to thr-found`] });
    expect(env.work.attempt("A-12")).toMatchObject({ status: "running", threadId: "thr-found" });
    expect(env.work.row(RETURNS)).toMatchObject({ phase: "executing", body: { cause: "worker", owner: { kind: "v2-attempt", ref: "A-12" } } });
    expect([env.spawn.mock.calls, env.send.mock.calls]).toEqual([[], []]);
  });

  it("finds a timed-out send by its marker in the thread's turn requests, and never sends it again", async () => {
    const env = await setup();
    await env.optIn();
    await command(env, `move ${RETURNS} forward`, "returns-1");
    const body = seed(env, "A-12", RETURNS, "uncertain", { path: "/p/folio-12", threadId: "thr-author" });
    env.work.recordAttempt("A-12", ["uncertain"], { status: "uncertain", body: { ...body, mode: "send", resource: { ...body.resource, kind: "reuse", threadId: "thr-author" } } });
    const name = formatTargets([{ target: RETURNS, n: env.work.row(RETURNS)?.body.n ?? null }]);
    // Another prompt in that thread doesn't prove the work order arrived.
    env.turnRequests.set("thr-author", [{ type: "client/turn/requested", seq: 7, data: { input: [{ type: "text", text: "What changed on the shelf?" }], senderThreadId: null } }]);
    expect((await command(env, "recheck launches", "returns-2")).acknowledgment).toContain(`Readback: ${name} still uncertain`);
    expect(env.work.attempt("A-12")?.status).toBe("uncertain");
    env.turnRequests.set("thr-author", [{ type: "client/turn/requested", seq: 8, data: { input: [{ type: "text", text: `${body.marker}\nPrepare exactly one PR toward merge.` }],
      senderThreadId: null } }]);
    expect((await command(env, "recheck launches", "returns-3")).acknowledgment).toContain(`Readback: ${name} attached to thr-author`);
    expect(env.work.attempt("A-12")).toMatchObject({ status: "running", threadId: "thr-author" });
    expect(env.send).not.toHaveBeenCalled();
  });

  it("finds a timed-out send still queued behind the thread's active turn by its marker, and never sends it again", async () => {
    const env = await setup();
    await env.optIn();
    await command(env, `move ${RETURNS} forward`, "returns-1");
    const body = seed(env, "A-12", RETURNS, "uncertain", { path: "/p/folio-12", threadId: "thr-author" });
    env.work.recordAttempt("A-12", ["uncertain"], { status: "uncertain", body: { ...body, mode: "send", resource: { ...body.resource, kind: "reuse", threadId: "thr-author" } } });
    const name = formatTargets([{ target: RETURNS, n: env.work.row(RETURNS)?.body.n ?? null }]);
    // Sends queue while the thread is busy, so no turn request carries the work order yet.
    env.queued.set("thr-author", [{ id: "qm-1", threadId: "thr-author", content: [{ type: "text", text: `${body.marker}\nPrepare exactly one PR toward merge.`, mentions: [] }] }]);
    expect((await command(env, "recheck launches", "returns-2")).acknowledgment).toContain(`Readback: ${name} attached to thr-author`);
    expect(env.work.attempt("A-12")).toMatchObject({ status: "running", threadId: "thr-author" });
    expect(env.send).not.toHaveBeenCalled();
  });

  describe("worker results and SDK signals", () => {
    const NEXT = "c".repeat(40);
    const result = (attemptId: string, patch: Record<string, unknown> = {}) =>
      `Workstreams result v1: ${JSON.stringify({ attemptId, target: RETURNS, actions: ["integrate_base"], outcome: "changed", headOid: NEXT, baseOid: BASE, ...patch })}`;
    /** GitHub once the worker's rebase landed: a clean, approved merge candidate. */
    const ready: Partial<AdvanceFacts> = { headOid: NEXT, mergeStateStatus: "CLEAN", mergeable: "MERGEABLE", checks: "passed", readiness: "ready", detail: "" };
    /** 12 opted in, instructed, and read; then its work order launched in a new thread with v2 execution on. */
    async function running(env: Awaited<ReturnType<typeof setup>>) {
      await env.optIn();
      await command(env, `move ${RETURNS} forward`, "returns-1");
      await command(env, `refresh ${RETURNS}`, "returns-2");
      await env.harness.setSettings({ v2Execution: "on" });
      expect(await launch(env)).toBe("launched");
      return env.work.attempts(RETURNS)[0]!;
    }
    /** The worker's turn ends: its thread goes idle with this output, after the turn its work order started. */
    async function idle(env: Awaited<ReturnType<typeof setup>>, attempt: StoredAttempt, output: string) {
      const threadId = attempt.threadId!;
      env.turnRequests.set(threadId, [{ type: "client/turn/requested", seq: 3, data: { input: [{ type: "text", text: attempt.body.marker }], senderThreadId: null } }]);
      env.outputs.set(threadId, output);
      env.threads.set(threadId, { ...env.threads.get(threadId)!, status: "idle" });
      await env.harness.emitThreadEvent("thread.idle", { thread: env.threads.get(threadId)!, lastAssistantText: output });
    }
    const name = (env: Awaited<ReturnType<typeof setup>>) => formatTargets([{ target: RETURNS, n: env.work.row(RETURNS)?.body.n ?? null }]);
    /** Events only make rows due: the reconciler's ticks act on them. */
    const ticked = (env: Awaited<ReturnType<typeof setup>>, check: () => void) => vi.waitFor(async () => { await env.reconciler.tick(); check(); });

    it("reads a worker's report when its thread goes idle, judges the PR on a fresh GitHub read, and never merges", async () => {
      const env = await setup();
      const attempt = await running(env);
      env.live.set(12, { ...ready, checks: "pending", mergeStateStatus: "BLOCKED" });
      const reads = env.hostCalls.filter((call) => call.method === "advanceInspect").length;
      await idle(env, attempt, `Rebased onto main.\n${result(attempt.id)}`);
      await ticked(env, () => expect(env.work.row(RETURNS)).toMatchObject({ phase: "waiting", body: { cause: "ci" } }));
      expect(env.work.attempt(attempt.id)).toMatchObject({ status: "completed", body: { startSeq: 3, report: { key: "changed", rejection: null } } });
      expect(env.hostCalls.filter((call) => call.method === "advanceInspect").length).toBe(reads + 1);
      // Code declares readiness, and no path from a report reaches a merge or any other GitHub write.
      expect(env.hostCalls.filter((call) => call.method === "prWrite")).toEqual([]);
      expect([env.spawn.mock.calls.length, env.send.mock.calls.length]).toEqual([1, 0]);
    });

    it("asks BB to retry a worker's failed turn, and releases a work order you deleted from its thread's queue", async () => {
      const env = await setup();
      const attempt = await running(env);
      await env.harness.emitThreadEvent("turn.failed", { threadId: attempt.threadId!, requestId: "req-1", turnId: null, errorInfo: null, inputAccepted: true,
        rateLimits: null, attemptNumber: 1 });
      await ticked(env, () => expect(env.retry).toHaveBeenCalledWith({ threadId: attempt.threadId, turnRequestId: "req-1", sendAt: expect.any(Number) }));
      await vi.waitFor(() => expect(env.work.attempt(attempt.id)?.body).toMatchObject({ turnRetries: 1, turnFailure: null }));
      // The worker asks for input: you answer in its thread, and the row goes back to executing once nothing is pending.
      const thread = env.threads.get(attempt.threadId!)!;
      env.pending.set(thread.id, [{ id: "int-1" }]);
      await env.harness.emitThreadEvent("interaction.pending", { thread, interaction: {} as never });
      await ticked(env, () => expect(env.work.row(RETURNS)).toMatchObject({ phase: "decision-needed", body: { cause: "worker-interaction" } }));
      env.pending.delete(thread.id);
      await env.harness.emitThreadEvent("experimental_thread.events", { thread, sequence: 9 });
      await ticked(env, () => expect(env.work.row(RETURNS)).toMatchObject({ phase: "executing", body: { cause: "worker" } }));
      expect(env.retry).toHaveBeenCalledTimes(1);
      // A work order sent to a busy thread waits in its queue; you delete it there.
      const body = seed(env, "A-16", WRAP, "running", { path: "/p/folio-16", threadId: "thr-author" });
      env.work.recordAttempt("A-16", ["running"], { status: "running", body: { ...body, mode: "send", resource: { ...body.resource, kind: "reuse", threadId: "thr-author" } } });
      await env.harness.emitThreadEvent("message.cancelled", { entry: { id: "qm-1", threadId: "thr-author",
        content: [{ type: "text", text: `${body.marker}\nPrepare exactly one PR toward merge.`, mentions: [] }] } as never });
      await vi.waitFor(() => expect(env.work.attempt("A-16")).toMatchObject({ status: "released", body: { releasedReason: "user-cancelled" } }));
      expect(env.work.claimOn(WRAP, null)).toBeNull();
    });

    it("asks BB for no second retry when it took one whose answer was lost, and reads the turn that retry ran", async () => {
      const env = await setup();
      const attempt = await running(env);
      const threadId = attempt.threadId!;
      const requested = (seq: number, requestId: string, more: Record<string, unknown> = {}) =>
        ({ type: "client/turn/requested", seq, data: { requestId, input: [{ type: "text", text: attempt.body.marker }], senderThreadId: null, ...more } });
      env.turnRequests.set(threadId, [requested(3, "req-1")]);
      env.retry.mockRejectedValueOnce(new Error("socket hang up"));
      await env.harness.emitThreadEvent("turn.failed", { threadId, requestId: "req-1", turnId: null, errorInfo: null, inputAccepted: true, rateLimits: null, attemptNumber: 1 });
      await ticked(env, () => expect(env.work.attempt(attempt.id)?.body).toMatchObject({ turnRetries: 1, turnFailure: { requestId: "req-1" }, error: "socket hang up" }));
      // BB took the retry anyway: a turn was requested after the failed one, and it finished with the work order's report.
      env.turnRequests.set(threadId, [requested(7, "req-7", { retryOfRequestId: "req-1" }), requested(3, "req-1")]);
      env.live.set(12, ready);
      env.outputs.set(threadId, result(attempt.id));
      env.threads.set(threadId, { ...env.threads.get(threadId)!, status: "idle" });
      await env.harness.emitThreadEvent("thread.idle", { thread: env.threads.get(threadId)!, lastAssistantText: result(attempt.id) });
      await ticked(env, () => expect(env.work.attempt(attempt.id)).toMatchObject({ status: "completed", body: { turnFailure: null, report: { key: "changed" } } }));
      expect(env.retry).toHaveBeenCalledTimes(1);
    });

    it("reads the latest attempt's report again on recheck N, against a fresh read, and clears the row to Ready without a worker", async () => {
      const env = await setup();
      const attempt = await running(env);
      env.live.set(12, ready);
      // GitHub can't be read when the turn ends: the report waits unread, backing off, rather than being judged on stale facts.
      env.failReads(1);
      await idle(env, attempt, result(attempt.id));
      await ticked(env, () => expect(env.work.row(RETURNS)).toMatchObject({ phase: "waiting", body: { cause: "source-unavailable", nextAction: "parse-report" } }));
      expect(env.work.attempt(attempt.id)?.body.report?.key).toBeNull();
      const recheck = await command(env, `recheck ${RETURNS}`, "returns-3");
      expect(recheck.acknowledgment).toContain(`Recheck ${name(env)}: Ready`);
      expect(env.work.attempt(attempt.id)?.body.report).toMatchObject({ key: "changed", rejection: null });
      expect(env.work.row(RETURNS)).toMatchObject({ phase: "prepared", body: { cause: "merge-candidate" } });
      expect([env.spawn.mock.calls.length, env.send.mock.calls.length, env.retry.mock.calls.length]).toEqual([1, 0, 0]);
    });

    it("rebuilds a row from source facts on reset N after its attempt finished, keeping the attempt and every transition", async () => {
      const env = await setup();
      const attempt = await running(env);
      await idle(env, attempt, result(attempt.id, { outcome: "blocked", blockers: [{ kind: "other", summary: "The shelf fixture is missing" }] }));
      await ticked(env, () => expect(env.work.row(RETURNS)).toMatchObject({ phase: "repair-needed", body: { cause: "worker-blocked", detail: "The shelf fixture is missing" } }));
      const before = transitions(env);
      expect(await command(env, `reset ${RETURNS}`, "returns-3")).toMatchObject({ kind: "admit" });
      // The finished attempt's route belonged to the old epoch: the PR is still conflicting, so its work is planned again.
      expect(env.work.row(RETURNS)).toMatchObject({ phase: "queued", body: { cause: "launching", nextAction: ["integrate_base"], retryEpoch: 1 } });
      expect(env.work.attempts(RETURNS).map((item) => [item.id, item.status])).toEqual([[attempt.id, "completed"]]);
      expect(transitions(env)).toBe(before + 1);
    });

    it("counts a criterion an accepted report proved on the PR's current head, so the row can be Ready", async () => {
      const env = await setup();
      await env.optIn();
      const roster = await env.rpc("effort_roster_get", { effortId: env.returns.id });
      const n = roster.rows.find((row: { target: string }) => row.target === RETURNS).n;
      for (const [text, requestId] of [[`move ${n} forward`, "returns-1"], [`done when ${n}: returned books keep their shelf order`, "returns-2"], [`refresh ${n}`, "returns-3"]])
        expect(await env.rpc("effort_command", { effortId: env.returns.id, snapshotId: roster.snapshotId, text, requestId, source: "panel" })).toMatchObject({ kind: "admit" });
      await env.harness.setSettings({ v2Execution: "on" });
      expect(await launch(env)).toBe("launched");
      const attempt = env.work.attempts(RETURNS)[0]!;
      env.live.set(12, ready);
      await idle(env, attempt, result(attempt.id, { criteria: [{ id: "c1", outcome: "passed", evidence: "npm test -- shelf passed" }] }));
      await ticked(env, () => expect(env.work.row(RETURNS)).toMatchObject({ phase: "prepared" }));
      expect((await env.rpc("effort_roster_get", { effortId: env.returns.id })).rollup[1]).toContain("returned books keep their shelf order (c1)");
    });

    it("in a dry run hears no thread signal and writes nothing to BB", async () => {
      const env = await setup();
      await env.optIn();
      await command(env, `move ${RETURNS} forward`, "returns-1");
      await command(env, `refresh ${RETURNS}`, "returns-2");
      expect(await launch(env)).toBe("planned");
      const row = env.work.row(RETURNS)!;
      const thread = makeThreadResponse({ id: "thr-author", projectId: PROJECT, status: "idle", providerId: "codex" });
      await env.harness.emitThreadEvent("thread.idle", { thread, lastAssistantText: "Done. Ready to merge." });
      await env.harness.emitThreadEvent("interaction.pending", { thread, interaction: {} as never });
      await env.harness.emitThreadEvent("turn.failed", { threadId: "thr-author", requestId: "req-1", turnId: null, errorInfo: null, inputAccepted: true, rateLimits: null, attemptNumber: 1 });
      await env.harness.emitThreadEvent("message.cancelled", { entry: { id: "qm-1", threadId: "thr-author", content: [{ type: "text", text: "anything", mentions: [] }] } as never });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(env.work.row(RETURNS)).toEqual(row);
      expect([env.work.attempts(RETURNS), env.spawn.mock.calls, env.send.mock.calls, env.retry.mock.calls,
        env.hostCalls.filter((call) => ["prWrite", "advanceWorkspace"].includes(call.method))]).toEqual([[], [], [], [], []]);
    });
  });
});
