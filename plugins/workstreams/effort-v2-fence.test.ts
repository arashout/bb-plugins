// Once an effort runs on its v2 roster, no legacy launcher may start work on a
// PR that roster owns, including a PR it owns only through a ticket. Each test
// pairs the v2 PR with a legacy effort's PR, which must behave exactly as before.
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdvanceFacts } from "./advance-contract.js";
import type { AdvanceBatch, AdvancePreview } from "./bulk-advance.js";
import { cardEffortMoveScope, type CardEffortReady } from "./card-effort.js";
import type { RawUnit } from "./contract.js";
import { createDispatchStore } from "./dispatch.js";
import { createEffortStore, type EstablishedEffort } from "./effort-store.js";
import { createEffortWorkStore } from "./effort-work-store.js";
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
  detail: "Resolve branch conflicts", unresolvedThreads: 0, threadsComplete: true, checks: "passed", basePrNumber: null,
  approvalFeedback: { status: "none", fingerprint: null, sourceIds: [] } });

/** A legacy Advance batch saved by an earlier run, which the service loads when the plugin starts. */
function saveBatch(db: RunDb, number: number, status: "queued" | "needs-attention") {
  const id = `00000000-0000-4000-8000-0000000000${number}`;
  const jobId = `00000000-0000-4000-8000-0000000001${number}`;
  const routing = { ...facts(number), eligible: true, workspace: "create", projectId: PROJECT, hostId: HOST, sourcePath: `/p/folio-${number}`,
    path: `/p/folio-${number}`, effortId: null, effortKey: null, effortMembers: null, needsFeedback: false, needsChecks: false, blockedBy: null };
  const job = { ...routing, id: jobId, hiddenFromProgress: false, status, attemptId: null, dedicated: false, previousAttempts: [],
    threadId: null, checkedHeadOid: null, updatedAt: Date.now(), uncertain: false };
  db.prepare("INSERT INTO advance_batches (id, body) VALUES (?, ?)").run(id, JSON.stringify({ id, token: `00000000-0000-4000-8000-0000000002${number}`,
    createdAt: Date.now(), cancelled: false, jobs: [job], facts: { [jobId]: routing }, pollUntil: Date.now() + 60_000, prepared: {}, repairs: {} }));
}

async function setup() {
  const units = [12, 14, 16].map(checkout);
  const threads = new Map<string, ReturnType<typeof makeThreadResponse> & { environment?: { hostId: string; path?: string } }>();
  const metadata = new Map<string, Record<string, unknown>>();
  const hostCalls: { method: string; input: any }[] = [];
  let failWorkspace = false;
  const beforeWorkspace = vi.fn(async () => {});
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
      output: async () => ({ output: "" }), context: async () => ({ usage: null }) as never,
      events: { list: async () => [] }, interactions: { list: async () => [] as never },
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
    if (method === "advanceInspect") return { ok: true, facts: facts(number((input as { prUrl: string }).prUrl)) };
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
  return { bb, harness, db, store, work, returns, used, rpc, optIn, preview, job, workedOn, spawn, send, threads, metadata, hostCalls, beforeWorkspace,
    failWorkspace: (value: boolean) => { failWorkspace = value; } };
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
