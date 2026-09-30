// Address selected on Your turn PRs, through the real server on BB's fake host: the listing, its Undo window, one batch thread on the
// code-work model under the effort's parent, the claims it holds until it finishes, and each PR's own thread as the other choice. Every
// name here is synthetic.
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pr, RawUnit } from "./contract.js";
import type { BatchItem, DeckBatch } from "./deck-batch.js";
import type { DeckView } from "./deck.js";
import { createEffortStore } from "./effort-store.js";
import { createEffortWorkStore, type AttemptBody } from "./effort-work-store.js";
import { RESULT_PREFIX } from "./effort-recipes.js";
import { parsePrList } from "./gh.js";
import type { InventoryView } from "./inventory-view.js";
import { yourTurnRows } from "./inventory-view-model.js";
import { createRunStore } from "./runstore.js";
import plugin from "./server.js";

const HOST = "host-inkwell";
const PROJECT = "proj-inkwell";
const REPO = "inkwell/folio";
const PATH = "/p/folio-abc-43";
const HEAD = "a".repeat(40);
const HOUR = 3_600_000;
const url = (number: number) => `https://github.com/${REPO}/pull/${number}`;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.useRealTimers(); });

const pr = (number: number, extra: Record<string, unknown> = {}, facts: Partial<Pr> = {}): Pr => ({ ...parsePrList(JSON.stringify([{ number, url: url(number),
  state: "OPEN", title: `ABC-${number} Keep manuscripts in order`, isDraft: false, reviewDecision: "REVIEW_REQUIRED", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
  headRefName: `abc-${number}-order`, baseRefName: "main", headRefOid: HEAD, latestReviews: [], reviewRequests: [], statusCheckRollup: [{ conclusion: "SUCCESS" }],
  createdAt: ago(5 * 24 * HOUR), ...extra }]))!.pr, unresolvedReviewThreads: 0, resolvedReviewThreads: 0, headCommittedAt: ago(3 * HOUR),
  reviewFeedback: { openThreads: 0, comment: null, repliedAt: null }, ...facts });

/**
 * Manuscript review owns four of your PRs. #42: mira approved with a comment, and its thread "Order fixes" worked on it. #43: otto asked
 * for changes, in its checkout. #44: ines commented and opened two threads, with no thread or checkout. #45: otto asked for changes too.
 * Spine labels owns #46, where ines commented.
 */
async function setup() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const current = new Map<number, Pr>([
    [42, pr(42, { reviewDecision: "APPROVED", latestReviews: [{ author: { login: "mira" }, state: "APPROVED", submittedAt: ago(2 * HOUR) }] }, {
      approvalFeedback: { status: "present", fingerprint: "f".repeat(64), sourceIds: ["review-42"] }, approvalFeedbackVerified: false,
      reviewFeedback: { openThreads: 0, comment: null, repliedAt: null, noteAt: ago(2 * HOUR), followUpAt: null } })],
    [43, pr(43, { reviewDecision: "CHANGES_REQUESTED", latestReviews: [{ author: { login: "otto" }, state: "CHANGES_REQUESTED", submittedAt: ago(HOUR) }] })],
    [44, pr(44, { latestReviews: [{ author: { login: "ines" }, state: "COMMENTED", submittedAt: ago(HOUR) }] },
      { reviewFeedback: { openThreads: 2, comment: { login: "ines", at: ago(HOUR) }, repliedAt: null } })],
    [45, pr(45, { reviewDecision: "CHANGES_REQUESTED", latestReviews: [{ author: { login: "otto" }, state: "CHANGES_REQUESTED", submittedAt: ago(HOUR) }] })],
    [46, pr(46, { latestReviews: [{ author: { login: "ines" }, state: "COMMENTED", submittedAt: ago(HOUR) }] },
      { reviewFeedback: { openThreads: 0, comment: { login: "ines", at: ago(HOUR) }, repliedAt: null } })],
  ]);
  const raw: RawUnit = { path: PATH, dirName: "folio-abc-43", repo: REPO, githubRepo: REPO, branch: "abc-43-order", dirty: false, ahead: 0, behind: 0,
    lastCommitAt: null, defaultBranch: "main", pr: current.get(43)!, shipped: null, changedPaths: [], observed: { status: true, pr: true } };
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const metadata = new Map<string, Record<string, unknown>>();
  const add = (id: string, patch: Record<string, unknown> = {}) => {
    const row = makeThreadResponse({ id, projectId: PROJECT, title: id, status: "idle", providerId: "codex", environmentPath: null, ...patch } as never);
    threads.set(id, row);
    return row;
  };
  add("thr-42", { title: "Order fixes" });
  /** A start BB never answers; `made`: it made the thread all the same. */
  const hang = { spawn: false, made: false };
  const hostCalls: string[] = [];
  const output = { text: "" };
  const send = vi.fn(async () => ({ ok: true as const, delivery: "sent" as const }));
  const spawn = vi.fn(async (args: { title?: string; parentThreadId?: string; pluginMetadata?: Record<string, unknown> }) => {
    const id = `thr-batch-${spawn.mock.calls.length}`;
    const made = () => { metadata.set(id, args.pluginMetadata ?? {}); return add(id, { title: args.title ?? id, status: "active", parentThreadId: args.parentThreadId ?? null }); };
    if (hang.spawn) { if (hang.made) made(); return await new Promise<never>(() => undefined); }
    return made();
  });
  const { bb, harness } = createFakePluginHost({ pluginId: "workstreams", settings: { scanRoots: "/p" }, sdk: {
    system: { config: async () => ({ primaryHostId: HOST }) as never },
    projects: { list: async () => [{ id: PROJECT, name: "Folio", sources: [{ hostId: HOST, path: "/p" }] }] as never },
    threads: {
      list: async () => [...threads.values()].map((row) => ({ ...row, originPluginId: metadata.has(row.id) ? "workstreams" : null })) as never,
      get: async ({ threadId }: { threadId: string }) => {
        const row = threads.get(threadId);
        if (!row) throw new Error("Unknown synthetic thread");
        return { ...row, canSpawnChild: true } as never;
      },
      getPluginMetadata: async ({ threadId }: { threadId: string }) => (metadata.get(threadId) ?? {}) as never,
      spawn: spawn as never, send, output: async () => ({ output: output.text }), context: async () => ({ usage: null }) as never,
      events: { list: async () => [] }, interactions: { list: async () => [] as never },
    },
  }, experimental_callHostRpc: ({ method, input }) => {
    hostCalls.push(method);
    if (method === "scan" || method === "inspectPaths") return { units: [{ ...raw, pr: current.get(43)! }], warnings: [] };
    if (method === "authoredPrs") return { owners: ["inkwell"], entries: [...current.values()].map((entry) => ({ repo: REPO, pr: entry })),
      discoveryComplete: true, repositories: [{ repo: REPO, complete: true }], complete: true, warnings: [] };
    if (method === "inspectPrs") return { entries: (input as { prUrls: string[] }).prUrls.map((prUrl) => ({ repo: REPO,
      pr: current.get(Number(prUrl.split("/").pop()))! })), closed: [], failed: [], warnings: [] };
    if (method === "contextWorkspace") return { path: "/synthetic/workstreams/context/batch" };
    if (method === "advanceInspect") return { ok: false, error: "Not read in this test." };
    throw new Error(`Unexpected host call ${method}`);
  } });
  await plugin(bb);
  const efforts = createEffortStore(bb.storage.database() as never);
  const effort = efforts.establish({ sourceKey: "ticket:ABC-42", name: "Manuscript review", goal: "Make manuscript review reliable", projectId: PROJECT,
    coordinatorState: "none", members: { tickets: [], prUrls: [42, 43, 44, 45].map(url) } });
  const spine = efforts.establish({ sourceKey: "ticket:ABC-46", name: "Spine labels", goal: "Print spine labels", projectId: PROJECT, coordinatorState: "none",
    members: { tickets: [], prUrls: [url(46)] } });
  efforts.recordWorker(effort.id, "thr-42", url(42), "pr");
  add("thr-coordinator", { title: "🧭 Manuscript review" });
  efforts.save({ ...efforts.get(effort.id)!, coordinatorThreadId: "thr-coordinator", coordinatorState: "ready" });
  const env = { harness, bb, current, send, spawn, hang, output, effort, spine, efforts, threads, add, metadata, hostCalls,
    rpc: (method: string, value: unknown) => env.harness.callRpc(method as never, value as never),
    refresh: async () => expect((await env.harness.runCli(["refresh"])).exitCode).toBe(0),
    batch: async (batchId: string) => await env.rpc("deck_batch_get", { batchId }) as DeckBatch,
    settled: (batchId: string) => vi.waitFor(async () => expect((await env.batch(batchId)).state).toBe("done")),
    plan: async (prUrls: string[], mode?: "batch" | "each") => await env.rpc("deck_batch_plan", { kind: "address", prUrls, ...mode ? { mode } : {} }) as
      { ok: true; batchId: string | null; items: BatchItem[]; skipped: { ref: string; reason: string }[]; thread?: DeckBatch["thread"] },
    card: async () => (await env.rpc("deck_get", {}) as DeckView).active.find((item) => item.id === effort.id)!,
    rows: async () => new Map((await env.card()).sections.flatMap((section) => section.rows).map((row) => [row.number, row])),
    /** All PRs' Your turn, by PR number. */
    turn: async () => yourTurnRows(await env.rpc("inventory_get", {}) as InventoryView, Date.now()).map((line) => line.number).sort(),
    /** Restart the plugin on the same database, as a host reload does. */
    restart: async () => { const next = await env.harness.lifecycle.reload(plugin); env.harness = next.harness; env.bb = next.bb; },
  };
  cleanups.push(() => env.harness.lifecycle.dispose());
  await env.refresh();
  return env;
}
type Env = Awaited<ReturnType<typeof setup>>;
const spawned = (env: Env) => env.spawn.mock.calls.map(([args]) => args as unknown as { title: string; prompt: string; parentThreadId?: string; projectId: string;
  providerId: string; model: string; reasoningLevel: string; environment: unknown; pluginMetadata: { role: string; runIds: number[] } });
const result = (attemptId: string, number: number, outcome = "changed") => `${RESULT_PREFIX}${JSON.stringify({ attemptId, target: url(number),
  actions: ["address_review_feedback"], outcome, headOid: "b".repeat(40), baseOid: "c".repeat(40), commits: [], validation: [], blockers: [] })}`;

describe("addressing Your turn PRs in one batch thread", () => {
  it("lists each PR's feedback and where it runs, then after the window starts one worker under the effort's parent that claims them all until it finishes", async () => {
    const env = await setup();
    expect(await env.turn()).toEqual([42, 43, 44, 45, 46]);
    const plan = await env.plan([42, 43, 44].map(url));
    // The listing is exactly what the thread gets.
    expect(plan.items.map((item) => [item.ref, item.kind, item.feedback, item.where, item.headOid])).toEqual([
      ["folio #42", "address", "Approval comment from @mira", "No checkout: a clean clone", HEAD],
      ["folio #43", "address", "Changes requested by @otto", "In folio-abc-43", HEAD],
      ["folio #44", "address", "2 open threads · New comments from @ines", "No checkout: a clean clone", HEAD]]);
    expect([plan.skipped, plan.thread]).toEqual([[], { projectId: PROJECT, parentThreadId: "thr-coordinator", under: "🧭 Manuscript review" }]);
    expect(await env.rpc("deck_batch_start", { batchId: plan.batchId })).toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(7_900);
    expect(env.spawn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    await env.settled(plan.batchId!);
    expect((await env.batch(plan.batchId!)).items.map((item) => [item.ref, item.state, item.detail])).toEqual([42, 43, 44].map((number) =>
      [`folio #${number}`, "sent", "Started “Address feedback on 3 PRs”."]));

    // One worker, on the code-work model, under the effort's parent, in a context workspace; each PR's feedback, bound to its claim.
    const [args] = spawned(env);
    expect(env.spawn).toHaveBeenCalledTimes(1);
    expect(args).toMatchObject({ title: "Address feedback on 3 PRs", parentThreadId: "thr-coordinator", projectId: PROJECT, providerId: "codex", model: "gpt-6-sol",
      reasoningLevel: "high", environment: { type: "host", hostId: HOST, workspace: { type: "unmanaged", path: "/synthetic/workstreams/context/batch" } },
      pluginMetadata: { role: "address-feedback" } });
    const runIds = args!.pluginMetadata.runIds;
    expect(runIds).toHaveLength(3);
    for (const [index, number] of [42, 43, 44].entries()) expect(args!.prompt).toContain(`"attemptId":"address-${runIds[index]}","pr":"${REPO}#${number}"`);
    expect(args!.prompt).toContain('"waiting":"Approval comment from @mira"');
    expect(args!.prompt).toContain(`"checkout":"${PATH}"`);
    expect(args!.prompt).toContain("Reply to each reviewer's note on the PR");
    expect(args!.prompt).toContain("Do not merge, deploy, mark ready, request review, or start another thread.");
    // Nothing here writes to GitHub, and nothing merges.
    expect(env.hostCalls.filter((method) => !["scan", "inspectPaths", "authoredPrs", "inspectPrs", "contextWorkspace", "advanceInspect"].includes(method))).toEqual([]);

    // Each PR in it reads Addressing, In flight, off Your turn, and the thread shows on the card.
    await env.refresh();
    const rows = await env.rows();
    for (const number of [42, 43, 44]) expect(rows.get(number)).toMatchObject({ section: "flight", addressing: { threadId: "thr-batch-1", title: "Address feedback on 3 PRs" } });
    expect(await env.turn()).toEqual([45, 46]);
    expect((await env.card()).threads.map((thread) => thread.id)).toContain("thr-batch-1");
  });

  // One writer per PR: while the batch thread's claims hold, no second agent starts on a batched PR, from any path that starts one.
  it("keeps a second agent off every PR it claims, and the next Address listing says why", async () => {
    const env = await setup();
    const plan = await env.plan([42, 43].map(url));
    await env.rpc("deck_batch_start", { batchId: plan.batchId });
    await vi.advanceTimersByTimeAsync(8_100);
    await env.settled(plan.batchId!);
    await env.refresh();
    expect(await env.rpc("agent_run", { path: PATH, action: "address-review", mode: "new", threadId: null, prompt: "Fix it" }))
      .toEqual({ ok: false, error: "A batch thread is addressing this PR's feedback. Wait for it to finish." });
    expect(await env.rpc("thread_start", { path: PATH, prompt: "Fix it" })).toEqual({ ok: false, error: "A batch thread is addressing this PR's feedback. Wait for it to finish." });
    expect(await env.rpc("thread_message", { prUrl: url(42), threadId: "thr-42", message: "Address mira's note." }))
      .toEqual({ ok: false, error: "Another agent thread is working on this PR. Open its thread before sending." });
    const again = await env.plan([42, 43, 44].map(url));
    expect(again.items.map((item) => item.ref)).toEqual(["folio #44"]);
    expect(again.skipped).toEqual([{ prUrl: url(42), ref: "folio #42", reason: "An agent is already working on it." },
      { prUrl: url(43), ref: "folio #43", reason: "An agent is already working on it." }]);
    expect(env.spawn).toHaveBeenCalledTimes(1);
    expect(env.send).not.toHaveBeenCalled();
  });

  // The worker's report is read, never trusted: its claims end with its turn, and only its replies on the PR clear the feedback.
  it("releases its claims when it finishes, keeps each PR's report, and clears feedback only once a reply shows on the PR", async () => {
    const env = await setup();
    const plan = await env.plan([43, 44].map(url));
    await env.rpc("deck_batch_start", { batchId: plan.batchId });
    await vi.advanceTimersByTimeAsync(8_100);
    await env.settled(plan.batchId!);
    const [first, second] = spawned(env)[0]!.pluginMetadata.runIds;
    const blocked = `${RESULT_PREFIX}${JSON.stringify({ attemptId: `address-${second}`, target: url(44), actions: ["address_review_feedback"], outcome: "blocked",
      headOid: HEAD, baseOid: "c".repeat(40), blockers: [{ kind: "product-decision", summary: "ines asks for a new sort order" }] })}`;
    env.output.text = `Worked #43 then #44.\n${result(`address-${first}`, 43)}\n${blocked}`;
    env.threads.set("thr-batch-1", { ...env.threads.get("thr-batch-1")!, status: "idle" });
    await env.harness.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr-batch-1", status: "idle" }), lastAssistantText: env.output.text });
    const runs = createRunStore(env.bb.storage.database() as never);
    await vi.waitFor(() => expect(runs.recent(0).filter((run) => run.action === "address-feedback").map((run) => [run.prNumber, run.status, run.result ?? run.error]))
      .toEqual([[44, "failed", "Blocked: ines asks for a new sort order"], [43, "done", "Reported changed at bbbbbbb"]]));
    await env.refresh();
    // Claims released, and the feedback still waits: a report and a push answer no reviewer.
    expect((await env.rows()).get(43)).toMatchObject({ addressing: null });
    expect(await env.turn()).toEqual([42, 43, 44, 45, 46]);
    // The worker replied to ines on #44 and resolved her threads: its next read clears it. #43 waits until you ask otto again.
    env.current.set(44, { ...env.current.get(44)!, reviewFeedback: { openThreads: 0, comment: { login: "ines", at: ago(HOUR) }, repliedAt: ago(HOUR / 2) } });
    await env.refresh();
    expect(await env.turn()).toEqual([42, 43, 45, 46]);
  });

  // What the listing leaves out, it names with why: a hold, a held effort, a v2 claim, or an agent already on the PR or its checkout.
  it("leaves out a held PR, a held effort's PR, a v2 claim, and a PR an agent is on, each with why", async () => {
    const env = await setup();
    await env.rpc("pr_hold_set", { prUrl: url(45), held: true, reason: "Counter redesign" });
    expect(await env.rpc("effort_hold", { effortKey: env.spine.id, reason: "Labels later" })).toMatchObject({ ok: true });
    const body: AttemptBody = { instructionRevision: 1, recipes: ["address_review_feedback"], role: "code", retryEpoch: 0, retryIndex: 0,
      start: { headOid: HEAD, baseOid: "c".repeat(40), fingerprint: null, sourceIds: [] },
      resource: { kind: "spawn", threadId: null, path: PATH, hostId: HOST, projectId: PROJECT, reason: null, workspace: null },
      mode: "spawn", marker: "[Workstreams attempt A-1 · inkwell/folio#43 · instruction r1]", settledAt: Date.now(), uncertainAt: null,
      emptyReadbackAt: null, failure: null, error: null, releasedReason: null };
    const work = createEffortWorkStore(env.bb.storage.database() as never);
    work.claim({ id: "A-1", target: url(43), effortId: env.effort.id, instructionId: `I-${env.effort.id}-r1`, launchKey: "key-A-1", threadId: null, hostId: HOST, path: PATH, body });
    createRunStore(env.bb.storage.database() as never).begin({ path: "", ticket: null, prUrl: url(44), prNumber: 44, action: "address-review", mode: "new", threadId: "thr-44" });
    env.threads.set("thr-42", { ...env.threads.get("thr-42")!, status: "active" });
    await env.refresh();
    const plan = await env.plan([42, 43, 44, 45, 46].map(url));
    expect([plan.batchId, plan.items]).toEqual([null, []]);
    expect(plan.skipped.map((skip) => `${skip.ref}: ${skip.reason}`)).toEqual(["folio #42: An agent is already working on it.",
      "folio #43: A v2 roster worker holds it.", "folio #44: An agent is already working on it.", "folio #45: On hold. Release it first.",
      "folio #46: Its effort is on hold."]);
    // With the claim ended, an active thread in #43's checkout still keeps it out.
    work.recordAttempt("A-1", ["launching"], { status: "completed", body });
    env.add("thr-desk", { title: "Desk tidy", status: "active", environmentPath: PATH });
    await env.refresh();
    expect((await env.plan([url(43)])).skipped).toEqual([{ prUrl: url(43), ref: "folio #43", reason: "An agent is working in its checkout." }]);
    expect(env.spawn).not.toHaveBeenCalled();
  });

  // Undo takes the batch back before anything starts, and a restart inside the window keeps both the cancel and the one start.
  it("starts nothing after an Undo, and a restart inside the window neither starts twice nor loses the Undo", async () => {
    const env = await setup();
    const kept = await env.plan([42, 43].map(url));
    const undone = await env.plan([url(44)]);
    for (const plan of [kept, undone]) expect(await env.rpc("deck_batch_start", { batchId: plan.batchId })).toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await env.rpc("deck_batch_undo", { batchId: undone.batchId })).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(1_000);
    await env.restart();
    await vi.advanceTimersByTimeAsync(4_900);
    expect(env.spawn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    await env.settled(kept.batchId!);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(spawned(env).map((args) => args.title)).toEqual(["Address feedback on 2 PRs"]);
    expect((await env.batch(undone.batchId!)).state).toBe("cancelled");
    await env.refresh();
    expect((await env.rows()).get(44)).toMatchObject({ addressing: null, acted: null });
  });

  // A start cut off by a reload can't know whether BB made the thread: the PRs read maybe sent and stay claimed until a read of BB's
  // threads finds the one it made, whose claims it keeps, or finds none, and drops them so nothing holds a PR no one works on.
  it("binds a start a reload cut off to the thread BB made, and drops its claims when BB made none", async () => {
    for (const made of [true, false]) {
      const env = await setup();
      env.hang.spawn = true;
      env.hang.made = made;
      const plan = await env.plan([43, 44].map(url));
      await env.rpc("deck_batch_start", { batchId: plan.batchId });
      await vi.advanceTimersByTimeAsync(8_100);
      await vi.waitFor(() => expect(env.spawn).toHaveBeenCalledTimes(1));
      await env.restart();
      await env.settled(plan.batchId!);
      expect((await env.batch(plan.batchId!)).items.map((item) => item.state)).toEqual(["unknown", "unknown"]);
      await env.refresh();
      expect((await env.rows()).get(43)?.addressing).toEqual({ threadId: null, title: null });
      await vi.advanceTimersByTimeAsync(90_000);
      await vi.waitFor(async () => { await env.refresh(); expect((await env.rows()).get(43)?.addressing?.threadId ?? "none").toBe(made ? "thr-batch-1" : "none"); });
      expect(await env.turn()).toEqual(made ? [42, 45, 46] : [42, 43, 44, 45, 46]);
      expect(env.spawn).toHaveBeenCalledTimes(1);
      await env.harness.lifecycle.dispose();
      cleanups.pop();
      vi.useRealTimers();
    }
  });

  // Each PR in its own thread is the Ask its thread path, and only for a PR that has a thread; the rest are listed with why.
  it("offers each PR's own thread only to PRs that have one, and sends there, starting nothing", async () => {
    const env = await setup();
    const plan = await env.plan([42, 43, 44].map(url), "each");
    expect(plan.items.map((item) => [item.ref, item.kind, item.what, item.feedback])).toEqual([
      ["folio #42", "ask", "Ask “Order fixes” to address 1 note", "Approval comment from @mira"]]);
    expect(plan.skipped.map((skip) => `${skip.ref}: ${skip.reason}`)).toEqual(["folio #43: It has no thread. Use One batch thread.",
      "folio #44: It has no thread. Use One batch thread."]);
    expect(plan.thread).toBeUndefined();
    await env.rpc("deck_batch_start", { batchId: plan.batchId });
    await vi.advanceTimersByTimeAsync(8_100);
    await env.settled(plan.batchId!);
    expect((await env.batch(plan.batchId!)).items.map((item) => [item.state, item.detail])).toEqual([["sent", "Asked “Order fixes” to address the notes."]]);
    expect((env.send.mock.calls as unknown as [{ threadId: string }][]).map(([args]) => args.threadId)).toEqual(["thr-42"]);
    expect(env.spawn).not.toHaveBeenCalled();
  });
});
