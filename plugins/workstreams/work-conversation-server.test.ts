import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RawUnit } from "./contract.js";
import type { AdvanceFacts } from "./advance-contract.js";
import type { AdvanceBatch, AdvancePreview } from "./bulk-advance.js";
import { parsePrList } from "./gh.js";
import type { WorkConversation } from "./work-conversation.js";
import plugin from "./server.js";

const REPO = "example/widget";
const URLS = [42, 43].map((number) => `https://github.com/${REPO}/pull/${number}`);
const PATH = "/p/widget-checkout";
const HOST = "host-example";
const PROJECT = "project-example";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

function pr(number: number) {
  return parsePrList(JSON.stringify([{ number, url: URLS[number - 42], state: "OPEN", title: `ABC-${number} Fix account lookup`,
    reviewDecision: "APPROVED", isDraft: false, headRefName: `abc-${number}-lookup`, baseRefName: "main",
    headRefOid: `${number === 42 ? "a" : "c"}`.repeat(40), baseRefOid: "b".repeat(40), mergeStateStatus: "DIRTY",
    mergeable: "CONFLICTING", statusCheckRollup: [{ conclusion: "SUCCESS" }], latestReviews: [], reviewRequests: [] }]))!.pr;
}

type SavedRows = { conversations: { id: string; scope_key: string; revision: number; body: string }[];
  batches: { id: string; body: string }[] };

async function setup(saved?: SavedRows) {
  const local = pr(42), remote = pr(43);
  const unit: RawUnit = { path: PATH, dirName: "widget-checkout", repo: "Widget", githubRepo: REPO,
    branch: "abc-42-lookup", dirty: false, ahead: 0, behind: 0, lastCommitAt: null, defaultBranch: "main",
    pr: local, shipped: null, changedPaths: [], observed: { status: true, pr: true } };
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const metadata = new Map<string, Record<string, unknown>>();
  const spawn = vi.fn(async (args: Record<string, any>) => {
    const id = `thr-${threads.size + 1}`;
    const thread = { ...makeThreadResponse({ id, projectId: args.projectId, title: args.title, providerId: args.providerId,
      originPluginId: "workstreams", status: args.pluginMetadata?.role === "work-conversation" ? "idle" : "active" }),
      environment: { hostId: HOST }, environmentPath: args.environment.workspace?.path ?? null,
      environmentHostId: HOST, parentThreadId: args.parentThreadId ?? null };
    threads.set(id, thread); metadata.set(id, args.pluginMetadata ?? {});
    return thread as never;
  });
  const send = vi.fn(async () => ({} as never));
  const beforeAdvanceInspect = vi.fn(async () => {});
  const calls: string[] = [];
  const facts = (number: number): AdvanceFacts => ({ prUrl: URLS[number - 42]!, number, title: `ABC-${number} Fix account lookup`, repo: REPO,
    headRefName: `abc-${number}-lookup`, baseRefName: "main", headOid: `${number === 42 ? "a" : "c"}`.repeat(40),
    baseOid: "b".repeat(40), state: "OPEN", isDraft: false, isCrossRepository: false, reviewDecision: "APPROVED",
    mergeStateStatus: "DIRTY", mergeable: "CONFLICTING", needsPreparation: true, readiness: "needs-attention",
    detail: "Resolve branch conflicts", unresolvedThreads: 0, threadsComplete: true, checks: "passed", basePrNumber: null,
    approvalFeedback: { status: "none", fingerprint: null, sourceIds: [] } });
  const { bb, harness } = createFakePluginHost({ pluginId: "workstreams", settings: { scanRoots: "/p" }, sdk: {
    system: { config: async () => ({ primaryHostId: HOST }) as never },
    projects: { list: async () => [{ id: PROJECT, name: "Example", sources: [{ hostId: HOST, path: "/p" }] }] as never },
    threads: {
      list: async () => [...threads.values()].map((thread) => ({ ...thread, queuedWork: "none", hasPendingInteraction: false,
        activity: { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activeGoalCount: 0,
          activePlanModeCount: 0, activeWorkflowCount: 0 } })) as never,
      spawn, send,
      get: async ({ threadId }: { threadId: string }) => ({ ...threads.get(threadId)!, canSpawnChild: true }) as never,
      getPluginMetadata: async ({ threadId }: { threadId: string }) => metadata.get(threadId) ?? {},
      output: async () => ({ output: "" }), context: async () => ({ usage: null }) as never,
      events: { list: async () => [] }, interactions: { list: async () => [] as never },
    },
  }, experimental_callHostRpc: async ({ method, input }) => {
    calls.push(method);
    if (method === "scan" || method === "inspectPaths") return { units: [unit], warnings: [] };
    if (method === "authoredPrs") return { owners: ["example"], entries: [{ repo: REPO, pr: remote }], discoveryComplete: true,
      repositories: [{ repo: REPO, complete: true }], complete: true, warnings: [] };
    if (method === "contextWorkspace") return { path: "/synthetic/workstreams/context" };
    if (method === "advanceInspect") {
      await beforeAdvanceInspect();
      return { ok: true, facts: facts(Number((input as { prUrl: string }).prUrl.split("/").at(-1))) };
    }
    if (method === "advanceWorkspace") return { ok: true, path: "/synthetic/workstreams/advance/job", workerPath: "/synthetic/workstreams/advance",
      sourcePath: PATH, created: true };
    if (method === "prLive") return { ok: true, live: { state: "OPEN", isDraft: false, reviewDecision: "APPROVED",
      mergeStateStatus: "DIRTY", headRefOid: "a".repeat(40), stackedAbove: [], unresolvedThreads: 0,
      unresolvedAtLeast: false, approvalNotes: [], approvalNotesMore: 0, approvalNotesComplete: true,
      approvalFeedback: { status: "none", fingerprint: null, sourceIds: [] } } };
    throw new Error(`Unexpected host method ${method}`);
  } });
  if (saved) {
    const db = bb.storage.database();
    db.prepare("CREATE TABLE IF NOT EXISTS work_conversations (id TEXT PRIMARY KEY, scope_key TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL, body TEXT NOT NULL)").run();
    db.prepare("CREATE TABLE IF NOT EXISTS advance_batches (id TEXT PRIMARY KEY, body TEXT NOT NULL)").run();
    for (const row of saved.conversations) db.prepare("INSERT INTO work_conversations (id, scope_key, revision, body) VALUES (?, ?, ?, ?)")
      .run(row.id, row.scope_key, row.revision, row.body);
    for (const row of saved.batches) db.prepare("INSERT INTO advance_batches (id, body) VALUES (?, ?)").run(row.id, row.body);
  }
  await plugin(bb); cleanups.push(() => harness.lifecycle.dispose());
  expect((await harness.runCli(["refresh"])).exitCode).toBe(0);
  const rpc = (method: string, input: unknown) => harness.callRpc(method, input);
  const open = async (prUrls = URLS, instruction = "Review both PRs.") => rpc("conversation_open", { prUrls, instruction }) as Promise<{ conversation: WorkConversation; created: boolean; warning: string | null }>;
  const get = async (conversationId: string) => rpc("conversation_get", { conversationId }) as Promise<{ conversation: WorkConversation;
    scopeItems: { prUrl: string; hold: string | null; selected: boolean; exclusionReason: string | null; state: string }[];
    batches: AdvanceBatch[]; warning: string | null }>;
  const propose = async (conversation: WorkConversation, selectedPrUrls: string[], exclusions: { prUrl: string; reason: string }[], instruction = "Fix the lookup fallback.") =>
    rpc("conversation_propose", { conversationId: conversation.id, expectedRevision: conversation.revision,
      selectedPrUrls, exclusions, instruction }) as Promise<WorkConversation>;
  const rows = (): SavedRows => ({
    conversations: bb.storage.database().prepare("SELECT id, scope_key, revision, body FROM work_conversations").all() as SavedRows["conversations"],
    batches: bb.storage.database().prepare("SELECT id, body FROM advance_batches").all() as SavedRows["batches"],
  });
  return { bb, harness, rpc, open, get, propose, rows, spawn, send, calls, threads, metadata, beforeAdvanceInspect };
}

describe("work conversation server integration", () => {
  it("reads local and remote-only PRs, holds, and opens one read-only planning thread under concurrent calls", async () => {
    const env = await setup();
    await env.rpc("pr_hold_set", { prUrl: URLS[1], held: true, reason: "Awaiting product decision" });
    const before = await env.rpc("conversation_get", { prUrls: [...URLS].reverse() }) as Awaited<ReturnType<typeof env.get>>;
    expect(before.conversation).toBeNull();
    expect(before.scopeItems).toMatchObject([
      { prUrl: URLS[0], state: "OPEN", hold: null },
      { prUrl: URLS[1], state: "OPEN", hold: "Awaiting product decision" },
    ]);
    const [first, second] = await Promise.all([env.open(), env.open([...URLS].reverse())]);
    expect(first.conversation.id).toBe(second.conversation.id);
    expect(first.conversation.scopePrUrls).toEqual(URLS);
    expect(first.conversation.instruction).toBe("Review both PRs.");
    expect(env.spawn.mock.calls.filter(([args]) => args.pluginMetadata?.role === "work-conversation")).toHaveLength(1);
    expect(env.spawn.mock.calls.filter(([args]) => args.pluginMetadata?.role === "rebase-worker")).toHaveLength(0);
    expect(env.calls).not.toContain("advanceWorkspace");
    const prompt = env.spawn.mock.calls.find(([args]) => args.pluginMetadata?.role === "work-conversation")?.[0].prompt as string;
    expect(prompt).toContain("read-only triage and planning thread");
    expect(prompt).toContain("Awaiting product decision");
    const read = await env.get(first.conversation.id);
    expect(read.scopeItems[1]).toMatchObject({ selected: false, exclusionReason: "Awaiting product decision" });
    const threadId = first.conversation.threadId!;
    env.threads.set(threadId, { ...env.threads.get(threadId)!, archivedAt: Date.now() });
    expect((await env.get(first.conversation.id)).warning).toContain("archived");
    expect((await env.open()).created).toBe(false);
    expect(env.spawn.mock.calls.filter(([args]) => args.pluginMetadata?.role === "work-conversation")).toHaveLength(1);
    expect((await env.open(URLS, "A different follow-up.")).conversation.instruction).toBe("Review both PRs.");
  });

  it("lists saved conversations without reading threads or starting work", async () => {
    const env = await setup();
    const { conversation } = await env.open();
    const spawnCount = env.spawn.mock.calls.length;
    const hostCalls = env.calls.length;
    const sdkCalls = env.harness.inspection.sdk.calls.length;
    const page = await env.rpc("conversation_list", { offset: 0, limit: 1 }) as { items: WorkConversation[]; total: number };
    expect(page).toEqual({ items: [conversation], total: 1 });
    expect(await env.rpc("conversation_list", { offset: 1, limit: 1 })).toEqual({ items: [], total: 1 });
    expect(env.spawn).toHaveBeenCalledTimes(spawnCount);
    expect(env.calls).toHaveLength(hostCalls);
    expect(env.harness.inspection.sdk.calls).toHaveLength(sdkCalls);
    await expect(env.rpc("conversation_list", { offset: -1, limit: 1 })).rejects.toThrow();
    await expect(env.rpc("conversation_list", { offset: 0, limit: 101 })).rejects.toThrow();
  });

  it("recovers a later materialized planning thread only when explicitly requested", async () => {
    const env = await setup();
    env.spawn.mockRejectedValueOnce(new Error("Synthetic spawn result was lost"));
    const opened = await env.open();
    expect(opened.conversation.threadId).toBeNull();
    expect(opened.warning).toContain("could not be confirmed");
    expect((await env.get(opened.conversation.id)).conversation.threadId).toBeNull();
    const threadId = "thr-late-planner";
    const later = { ...makeThreadResponse({ id: threadId, projectId: PROJECT, title: "Work on 2 PRs",
      originPluginId: "workstreams", status: "idle" }), environment: { hostId: HOST } };
    env.threads.set(threadId, later);
    env.metadata.set(threadId, { role: "work-conversation", conversationId: opened.conversation.id, scopePrUrls: URLS });
    expect((await env.get(opened.conversation.id)).conversation.threadId).toBeNull();
    const recovered = await env.rpc("conversation_get", { conversationId: opened.conversation.id, recoverThread: true }) as Awaited<ReturnType<typeof env.get>>;
    expect(recovered.conversation.threadId).toBe(threadId);
    expect(env.spawn).toHaveBeenCalledTimes(1);
  });

  it("requires a selected subset with reasons, and keeps held or foreign PRs outside the proposal", async () => {
    const env = await setup();
    await env.rpc("pr_hold_set", { prUrl: URLS[1], held: true, reason: "Awaiting product decision" });
    const { conversation } = await env.open();
    await expect(env.propose(conversation, [URLS[0]!], [])).rejects.toThrow("Explain why every PR excluded");
    await expect(env.propose(conversation, [URLS[0]!, "https://github.com/example/widget/pull/99"], []))
      .rejects.toThrow("outside this conversation");
    await expect(env.propose(conversation, [URLS[1]!], [{ prUrl: URLS[0]!, reason: "Later" }])).rejects.toThrow("On hold");
    const updated = await env.propose(conversation, [URLS[0]!], [{ prUrl: URLS[1]!, reason: "Awaiting product decision" }]);
    expect(updated.proposal).toMatchObject({ selectedPrUrls: [URLS[0]], instruction: "Fix the lookup fallback." });
    await expect(env.propose(conversation, [URLS[0]!], [{ prUrl: URLS[1]!, reason: "Later" }])).rejects.toThrow("Conversation changed");
  });

  it("binds preview and start to the current proposal, rechecks holds, and shows accepted results", async () => {
    const env = await setup();
    const { conversation } = await env.open();
    const proposed = await env.propose(conversation, [URLS[0]!], [{ prUrl: URLS[1]!, reason: "Review later" }]);
    const first = await env.rpc("conversation_preview", { conversationId: proposed.id }) as { conversation: WorkConversation; preview: AdvancePreview };
    expect(first.preview).toMatchObject({ instruction: "Fix the lookup fallback.", jobs: [{ prUrl: URLS[0] }] });
    await env.rpc("pr_hold_set", { prUrl: URLS[0], held: true, reason: "Pause changes" });
    await expect(env.rpc("conversation_start", { conversationId: proposed.id, previewToken: first.preview.token })).rejects.toThrow("Pause changes");
    await expect(env.rpc("conversation_preview", { conversationId: proposed.id })).rejects.toThrow("Pause changes");
    await env.rpc("pr_hold_set", { prUrl: URLS[0], held: false });
    const fresh = await env.rpc("conversation_preview", { conversationId: proposed.id }) as { conversation: WorkConversation; preview: AdvancePreview };
    await expect(env.rpc("conversation_start", { conversationId: proposed.id, previewToken: first.preview.token })).rejects.toThrow("changed or expired");
    const started = await env.rpc("conversation_start", { conversationId: proposed.id, previewToken: fresh.preview.token }) as { conversation: WorkConversation; batch: AdvanceBatch };
    await vi.waitFor(async () => expect((await env.rpc("advance_get", null) as AdvanceBatch[])[0]?.jobs[0]?.status).toBe("running"));
    expect(started.batch).toMatchObject({ instruction: "Fix the lookup fallback.", jobs: [{ prUrl: URLS[0] }] });
    expect((await env.get(proposed.id)).batches.map((batch) => batch.id)).toEqual([started.batch.id]);
    const repeated = await env.rpc("conversation_start", { conversationId: proposed.id, previewToken: fresh.preview.token }) as { batch: AdvanceBatch };
    expect(repeated.batch.id).toBe(started.batch.id);
  });

  it("rejects a preview token after the proposal direction changes", async () => {
    const env = await setup();
    const { conversation } = await env.open();
    const proposed = await env.propose(conversation, [URLS[0]!], [{ prUrl: URLS[1]!, reason: "Review later" }]);
    const old = await env.rpc("conversation_preview", { conversationId: proposed.id }) as { conversation: WorkConversation; preview: AdvancePreview };
    const revised = await env.propose(old.conversation, [URLS[0]!], [{ prUrl: URLS[1]!, reason: "Review later" }], "Check the retry path.");
    expect(revised.proposal?.previewToken).toBeNull();
    await expect(env.rpc("conversation_start", { conversationId: proposed.id, previewToken: old.preview.token })).rejects.toThrow("changed or expired");
    const current = await env.rpc("conversation_preview", { conversationId: proposed.id }) as { preview: AdvancePreview };
    expect(current.preview.instruction).toBe("Check the retry path.");
    expect(env.spawn.mock.calls.filter(([args]) => args.pluginMetadata?.role === "rebase-worker")).toHaveLength(0);
  });

  it("rejects a concurrent proposal while an approved start waits for admission", async () => {
    const env = await setup();
    const { conversation } = await env.open();
    const proposed = await env.propose(conversation, [URLS[0]!], [{ prUrl: URLS[1]!, reason: "Review later" }]);
    const ready = await env.rpc("conversation_preview", { conversationId: proposed.id }) as { conversation: WorkConversation; preview: AdvancePreview };
    let entered!: () => void, release!: () => void;
    const inspecting = new Promise<void>((resolve) => { entered = resolve; });
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    env.beforeAdvanceInspect.mockImplementation(async () => { entered(); await waiting; });
    const starting = env.rpc("conversation_start", { conversationId: proposed.id, previewToken: ready.preview.token });
    await inspecting;
    await expect(env.propose(ready.conversation, [URLS[0]!], [{ prUrl: URLS[1]!, reason: "Review later" }], "Change direction."))
      .rejects.toThrow("Preparation is starting");
    release();
    const result = await starting as { batch: AdvanceBatch };
    await vi.waitFor(async () => expect((await env.rpc("advance_get", null) as AdvanceBatch[])[0]?.jobs[0]?.status).toBe("running"));
    expect((await env.get(proposed.id)).batches.map((batch) => batch.id)).toEqual([result.batch.id]);
  });

  it("recovers an accepted batch from its saved preview token after a reload", async () => {
    const env = await setup();
    const { conversation } = await env.open();
    const proposed = await env.propose(conversation, [URLS[0]!], [{ prUrl: URLS[1]!, reason: "Review later" }]);
    const preview = await env.rpc("conversation_preview", { conversationId: proposed.id }) as { preview: AdvancePreview };
    const started = await env.rpc("conversation_start", { conversationId: proposed.id, previewToken: preview.preview.token }) as { batch: AdvanceBatch };
    await vi.waitFor(async () => expect((await env.rpc("advance_get", null) as AdvanceBatch[])[0]?.jobs[0]?.status).toBe("running"));
    const rows = env.rows();
    const row = rows.conversations[0]!;
    const body = JSON.parse(row.body) as WorkConversation;
    body.batchIds = [];
    body.proposal = { ...body.proposal!, previewToken: preview.preview.token, previewExpiresAt: 1 };
    row.body = JSON.stringify(body);
    await env.harness.lifecycle.dispose();
    const restored = await setup(rows);
    const recovered = await restored.get(proposed.id);
    expect(recovered.conversation.batchIds).toEqual([started.batch.id]);
    expect(recovered.batches.map((batch) => batch.id)).toEqual([started.batch.id]);
    expect((recovered.conversation.proposal?.previewToken)).toBeNull();
    const repeated = await restored.rpc("conversation_start", { conversationId: proposed.id, previewToken: preview.preview.token }) as { batch: AdvanceBatch };
    expect(repeated.batch.id).toBe(started.batch.id);
    expect(restored.spawn.mock.calls.filter(([args]) => args.pluginMetadata?.role === "rebase-worker")).toHaveLength(0);
  });
});
