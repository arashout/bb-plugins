// Address selected on Your turn PRs, through the real server on BB's fake host: the listing, its Undo window, one batch thread on the
// code-work model under the effort's parent, the checks its claims pass as it starts, the claims it holds until it finishes or goes, and
// each PR's own thread as the other choice. Every name here is synthetic.
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pr, RawUnit } from "./contract.js";
import type { BatchItem, DeckBatch } from "./deck-batch.js";
import { startAddress } from "./deck-flow.js";
import type { DeckView } from "./deck.js";
import { createEffortStore } from "./effort-store.js";
import { createEffortWorkStore, type AttemptBody } from "./effort-work-store.js";
import { PR_THREADS_RULE, RESULT_PREFIX } from "./effort-recipes.js";
import { parsePrList } from "./gh.js";
import type { InventoryView } from "./inventory-view.js";
import { commentsOnly, inventoryScreen, onYourTurn, yourTurnRows } from "./inventory-view-model.js";
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
  /** More checkouts the scan finds, with no PR it linked. */
  const units: RawUnit[] = [];
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const metadata = new Map<string, Record<string, unknown>>();
  const add = (id: string, patch: Record<string, unknown> = {}) => {
    const row = makeThreadResponse({ id, projectId: PROJECT, title: id, status: "idle", providerId: "codex", environmentPath: null, ...patch } as never);
    threads.set(id, row);
    return row;
  };
  add("thr-42", { title: "Order fixes" });
  /** A start BB never answers; `made`: it made the thread all the same. `until`: BB makes the thread and answers once this settles. */
  const hang = { spawn: false, made: false, until: null as Promise<void> | null };
  const hostCalls: string[] = [];
  /** Each PR read from GitHub, and what lands while one PR's read is out. */
  const reads = { urls: [] as string[], during: null as ((prUrl: string) => Promise<unknown>) | null };
  /** What lands once, after the board's next full thread list is read and before it answers. */
  const lists = { during: null as (() => Promise<unknown>) | null };
  const output = { text: "" };
  const send = vi.fn(async () => ({ ok: true as const, delivery: "sent" as const }));
  const spawn = vi.fn(async (args: { title?: string; parentThreadId?: string; pluginMetadata?: Record<string, unknown> }) => {
    const id = `thr-batch-${spawn.mock.calls.length}`;
    const made = () => { metadata.set(id, args.pluginMetadata ?? {}); return add(id, { title: args.title ?? id, status: "active", parentThreadId: args.parentThreadId ?? null }); };
    if (hang.spawn) { if (hang.made) made(); return await new Promise<never>(() => undefined); }
    if (hang.until) await hang.until;
    return made();
  });
  const { bb, harness } = createFakePluginHost({ pluginId: "workstreams", settings: { scanRoots: "/p" }, sdk: {
    system: { config: async () => ({ primaryHostId: HOST }) as never },
    projects: { list: async () => [{ id: PROJECT, name: "Folio", sources: [{ hostId: HOST, path: "/p" }] }] as never },
    threads: {
      // As BB lists them: archived threads only when asked for.
      list: async (args?: { archived?: boolean; limit?: number }) => {
        const rows = [...threads.values()].filter((row) => (row.archivedAt !== null) === !!args?.archived)
          .map((row) => ({ ...row, originPluginId: metadata.has(row.id) ? "workstreams" : null }));
        const during = args?.limit === 500 ? lists.during : null;
        if (during) { lists.during = null; await during(); }
        return rows as never;
      },
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
    if (method === "scan" || method === "inspectPaths") return { units: [{ ...raw, pr: current.get(43)! }, ...units], warnings: [] };
    if (method === "authoredPrs") return { owners: ["inkwell"], entries: [...current.values()].map((entry) => ({ repo: REPO, pr: entry })),
      discoveryComplete: true, repositories: [{ repo: REPO, complete: true }], complete: true, warnings: [] };
    if (method === "inspectPrs") return (async () => {
      const { prUrls } = input as { prUrls: string[] };
      reads.urls.push(...prUrls);
      for (const prUrl of prUrls) await reads.during?.(prUrl);
      return { entries: prUrls.map((prUrl) => ({ repo: REPO, pr: current.get(Number(prUrl.split("/").pop()))! })), closed: [], failed: [], warnings: [] };
    })();
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
  const env = { harness, bb, current, units, send, spawn, hang, output, effort, spine, efforts, threads, add, metadata, hostCalls, reads, lists,
    rpc: (method: string, value: unknown) => env.harness.callRpc(method as never, value as never),
    refresh: async () => expect((await env.harness.runCli(["refresh"])).exitCode).toBe(0),
    batch: async (batchId: string) => await env.rpc("deck_batch_get", { batchId }) as DeckBatch,
    settled: (batchId: string) => vi.waitFor(async () => expect((await env.batch(batchId)).state).toBe("done")),
    plan: async (prUrls: string[], mode?: "batch" | "each") => await env.rpc("deck_batch_plan", { kind: "address", prUrls, ...mode ? { mode } : {} }) as
      { ok: true; batchId: string | null; items: BatchItem[]; skipped: { ref: string; reason: string }[]; thread?: DeckBatch["thread"] },
    card: async () => (await env.rpc("deck_get", {}) as DeckView).active.find((item) => item.id === effort.id)!,
    rows: async () => new Map((await env.card()).sections.flatMap((section) => section.rows).map((row) => [row.number, row])),
    /** All PRs' Your turn, by PR number. */
    /** The PRs Address takes: Your turn's real follow-ups and Comments only's alike. */
    turn: async () => inventoryScreen(await env.rpc("inventory_get", {}) as InventoryView, { now: Date.now(), filter: null }).groups.flatMap((group) => group.lines)
      .filter((line) => onYourTurn(line) || commentsOnly(line)).map((line) => line.number).sort(),
    /** Your turn's alone, which the badge counts. */
    followUps: async () => yourTurnRows(await env.rpc("inventory_get", {}) as InventoryView, Date.now()).map((line) => line.number).sort(),
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
/** The batch thread's work order, each PR's line by its number. */
const orders = (env: Env) => new Map(spawned(env)[0]!.prompt.split("\n").filter((line) => line.startsWith('{"attemptId"'))
  .map((line) => JSON.parse(line) as { url: string; checkout: string | null; threads: unknown }).map((order) => [Number(order.url.split("/").pop()), order]));
/** A checkout the scan found with no PR linked. */
const worktree = (path: string, githubRepo: string, branch: string): RawUnit => ({ path, dirName: path.split("/").pop()!, repo: githubRepo, githubRepo, branch,
  dirty: false, ahead: 0, behind: 0, lastCommitAt: null, defaultBranch: "main", pr: null, shipped: null, changedPaths: [], observed: { status: true, pr: true } });
const result = (attemptId: string, number: number, outcome = "changed") => `${RESULT_PREFIX}${JSON.stringify({ attemptId, target: url(number),
  actions: ["address_review_feedback"], outcome, headOid: "b".repeat(40), baseOid: "c".repeat(40), commits: [], validation: [], blockers: [] })}`;
/** Manuscript review's v2 roster claims #43 and its checkout. */
function claimV2(env: Env) {
  const body: AttemptBody = { instructionRevision: 1, recipes: ["address_review_feedback"], role: "code", retryEpoch: 0, retryIndex: 0,
    start: { headOid: HEAD, baseOid: "c".repeat(40), fingerprint: null, sourceIds: [] },
    resource: { kind: "spawn", threadId: null, path: PATH, hostId: HOST, projectId: PROJECT, reason: null, workspace: null },
    mode: "spawn", marker: "[Workstreams attempt A-1 · inkwell/folio#43 · instruction r1]", settledAt: Date.now(), uncertainAt: null,
    emptyReadbackAt: null, failure: null, error: null, releasedReason: null };
  const work = createEffortWorkStore(env.bb.storage.database() as never);
  work.claim({ id: "A-1", target: url(43), effortId: env.effort.id, instructionId: `I-${env.effort.id}-r1`, launchKey: "key-A-1", threadId: null, hostId: HOST, path: PATH, body });
  return { work, body };
}
/** An agent on this PR in its own thread, in the board's run record. */
const runOn = (env: Env, number: number) => createRunStore(env.bb.storage.database() as never).begin({ path: "", ticket: null, prUrl: url(number), prNumber: number,
  action: "address-review", mode: "new", threadId: `thr-${number}` });
/** Every step already under way finishes: a thread event's handling, or the thread list a refresh starts and doesn't wait for. */
const drain = () => new Promise((resolve) => setImmediate(resolve));
/** BB says this thread went to work. */
async function activate(env: Env, id: string) {
  env.threads.set(id, { ...env.threads.get(id)!, status: "active" });
  await env.harness.emitThreadEvent("thread.active", { thread: env.threads.get(id)! });
  await drain();
}
/** Confirm a listing and let its Undo window pass; `during`, what lands inside the window first. */
async function confirm(env: Env, batchId: string | null, during?: () => Promise<unknown>) {
  expect(await env.rpc("deck_batch_start", { batchId })).toMatchObject({ ok: true });
  await vi.advanceTimersByTimeAsync(2_000);
  await during?.();
  env.reads.urls.length = 0;
  await vi.advanceTimersByTimeAsync(6_100);
  await env.settled(batchId!);
  return (await env.batch(batchId!)).items.map((item) => `${item.ref}: ${item.state}: ${item.detail}`);
}
/** Each batch claim in the board's run record: its PR and status. */
const claims = (env: Env) => createRunStore(env.bb.storage.database() as never).recent(0).filter((run) => run.action === "address-feedback")
  .map((run) => [run.prNumber, run.status]);

describe("addressing Your turn PRs in one batch thread", () => {
  it("lists each PR's feedback and where it runs, then after the window starts one worker under the effort's parent that claims them all until it finishes", async () => {
    const env = await setup();
    expect(await env.turn()).toEqual([42, 43, 44, 45, 46]);
    // 44 and 46 wait only on comments, so the badge leaves them out; Address takes them all the same.
    expect(await env.followUps()).toEqual([42, 43, 45]);
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
      [`folio #${number}`, "sent", "Started “Address feedback: folio #42, #43, #44”."]));

    // One worker, on the code-work model, under the effort's parent, in a context workspace; each PR's feedback, bound to its claim.
    const [args] = spawned(env);
    expect(env.spawn).toHaveBeenCalledTimes(1);
    expect(args).toMatchObject({ title: "Address feedback: folio #42, #43, #44", parentThreadId: "thr-coordinator", projectId: PROJECT, providerId: "codex", model: "gpt-6-sol",
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

    // Each PR in it reads Working, In flight on the deck, and stays on Your turn where you sent it from; the thread shows on the card.
    await env.refresh();
    const rows = await env.rows();
    for (const number of [42, 43, 44]) expect(rows.get(number)).toMatchObject({ section: "flight", addressing: { threadId: "thr-batch-1", title: "Address feedback: folio #42, #43, #44" },
      sent: { state: "working", threadId: "thr-batch-1", title: "Address feedback: folio #42, #43, #44" } });
    expect(await env.turn()).toEqual([42, 43, 44, 45, 46]);
    expect((await env.card()).threads.map((thread) => thread.id)).toContain("thr-batch-1");
  });

  // A PR the scan linked no checkout to still works where its branch already is, so the thread neither clones again nor works on a stale
  // copy; a worktree on another branch, in another repository, or on the default branch a fork's head can share a name with is not it.
  it("lists and sends a PR without a scanned checkout in its repository's worktree on its head branch, and no other", async () => {
    const env = await setup();
    env.current.set(46, { ...env.current.get(46)!, headRefName: "main" });
    env.units.push(worktree("/p/folio-wt-44", REPO, "abc-44-order"), worktree("/p/folio-abc-42-draft", REPO, "abc-42-draft"),
      worktree("/p/quill-abc-45", "inkwell/quill", "abc-45-order"), worktree("/p/folio", REPO, "main"));
    await env.refresh();
    const plan = await env.plan([42, 44, 45, 46].map(url));
    expect(plan.items.map((item) => [item.ref, item.where])).toEqual([["folio #42", "No checkout: a clean clone"], ["folio #44", "In folio-wt-44"],
      ["folio #45", "No checkout: a clean clone"], ["folio #46", "No checkout: a clean clone"]]);
    await confirm(env, plan.batchId);
    expect([...orders(env)].map(([number, order]) => [number, order.checkout])).toEqual([[42, null], [44, "/p/folio-wt-44"], [45, null], [46, null]]);
  });

  // The PR's earlier threads hold what was decided and why; the batch thread may read them, but they never steer it and it never writes there.
  it("gives each PR's line the thread its work started in and the one that worked on it, to read for context and never message", async () => {
    const env = await setup();
    env.add("thr-42-origin", { title: "Start manuscript order" });
    env.metadata.set("thr-42-origin", { prUrl: url(42) });
    await env.refresh();
    const plan = await env.plan([42, 44].map(url));
    await confirm(env, plan.batchId);
    expect([...orders(env)].map(([number, order]) => [number, order.threads])).toEqual([
      [42, { origin: { id: "thr-42-origin", title: "Start manuscript order" }, executor: { id: "thr-42", title: "Order fixes" } }],
      [44, { origin: null, executor: null }]]);
    expect(spawned(env)[0]!.prompt).toContain(PR_THREADS_RULE);
    expect(env.send).not.toHaveBeenCalled();
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
      .toEqual({ ok: false, error: "A batch thread is addressing this PR's feedback. Wait for it to finish." });
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
    const { work, body } = claimV2(env);
    runOn(env, 44);
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
    expect(spawned(env).map((args) => args.title)).toEqual(["Address feedback: folio #42, #43"]);
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
      // Either way the PRs stay on Your turn: working in the thread BB made, or back to you when it made none.
      expect(await env.turn()).toEqual([42, 43, 44, 45, 46]);
      expect((await env.rows()).get(43)?.sent?.state).toBe(made ? "working" : "refused");
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

describe("the checks a batch thread's claims pass as it starts", () => {
  // What the listing checked, the start checks again before it reads GitHub. #42 has no checkout, so only its own thread going to work
  // shows an agent on it.
  it("leaves out, unread, a PR that got a hold, a v2 claim, or an agent in the Undo window, even one only in the PR's own thread", async () => {
    const env = await setup();
    const plan = await env.plan([42, 43, 44, 45].map(url));
    expect(plan.items).toHaveLength(4);
    expect(await confirm(env, plan.batchId, async () => {
      await activate(env, "thr-42");
      claimV2(env);
      runOn(env, 44);
      await env.rpc("pr_hold_set", { prUrl: url(45), held: true, reason: "Counter redesign" });
    })).toEqual(["folio #42: refused: An agent is already working on it.",
      "folio #43: refused: A worker from the Manuscript review roster is writing this PR or checkout. Wait for it to finish, or instruct it from the roster.",
      "folio #44: refused: An agent is already working on it.", "folio #45: refused: On hold: Counter redesign. Release the hold before advancing or merging this PR."]);
    expect(env.reads.urls).toEqual([]);
    expect([claims(env), env.spawn.mock.calls.length]).toEqual([[], 0]);
  });

  // An effort held while GitHub answers holds each of its PRs: the one being read at the claim, and the next before it's read.
  it("claims nothing for a PR whose effort is held while GitHub reads it", async () => {
    const env = await setup();
    const plan = await env.plan([42, 43].map(url));
    expect(await confirm(env, plan.batchId, async () => {
      env.reads.during = async (prUrl) => { if (prUrl === url(42)) await env.rpc("effort_hold", { effortKey: env.effort.id, reason: "Counter redesign" }); };
    })).toEqual([42, 43].map((number) => `folio #${number}: refused: Its effort is on hold. Resume it first; nothing was written.`));
    expect(env.reads.urls).toEqual([url(42)]);
    expect([claims(env), env.spawn.mock.calls.length]).toEqual([[], 0]);
  });

  // Whatever lands while GitHub answers, the step that claims sees, on every PR in the listing: #42 gets a new worker thread, at work.
  it("checks each PR again in the step that claims it, after the last GitHub read", async () => {
    const env = await setup();
    const plan = await env.plan([42, 43, 44, 45, 46].map(url));
    expect(plan.items).toHaveLength(5);
    expect(await confirm(env, plan.batchId, async () => {
      env.reads.during = async (prUrl) => {
        if (prUrl !== url(46)) return;
        env.efforts.recordWorker(env.effort.id, "thr-42-again", url(42), "pr");
        env.add("thr-42-again", { title: "Order fixes, again" });
        await activate(env, "thr-42-again");
        claimV2(env);
        runOn(env, 44);
        await env.rpc("pr_hold_set", { prUrl: url(45), held: true, reason: "Counter redesign" });
        await env.rpc("effort_hold", { effortKey: env.spine.id, reason: "Labels later" });
      };
    })).toEqual(["folio #42: refused: An agent is already working on it.",
      "folio #43: refused: A worker from the Manuscript review roster is writing this PR or checkout. Wait for it to finish, or instruct it from the roster.",
      "folio #44: refused: An agent is already working on it.", "folio #45: refused: On hold: Counter redesign. Release the hold before advancing or merging this PR.",
      "folio #46: refused: Its effort is on hold. Resume it first; nothing was written."]);
    expect(env.reads.urls).toEqual([42, 43, 44, 45, 46].map(url));
    expect([claims(env), env.spawn.mock.calls.length]).toEqual([[], 0]);
  });

  // The thread gets only what GitHub still shows waiting on you, on the head the listing showed.
  it("leaves out a PR with new commits since the listing, or with no feedback waiting now, and starts the rest", async () => {
    const env = await setup();
    const plan = await env.plan([42, 43, 44].map(url));
    expect(await confirm(env, plan.batchId, async () => {
      env.current.set(43, { ...env.current.get(43)!, headRefOid: "d".repeat(40) });
      env.current.set(44, { ...env.current.get(44)!, reviewFeedback: { openThreads: 0, comment: { login: "ines", at: ago(HOUR) }, repliedAt: ago(HOUR / 2) } });
    })).toEqual(["folio #42: sent: Started “Address feedback: folio #42”.",
      "folio #43: refused: New commits landed since the listing. Review it and try again; nothing was started.",
      "folio #44: refused: No feedback waits on you now; nothing was started."]);
    expect(claims(env)).toEqual([[42, "running"]]);
    expect(spawned(env).map((args) => [args.title, args.prompt.includes(url(42)), args.prompt.includes(url(43)), args.prompt.includes(url(44))]))
      .toEqual([["Address feedback: folio #42", true, false, false]]);
  });

  it("starts nothing when the parent thread it listed is gone", async () => {
    const env = await setup();
    const plan = await env.plan([42, 43].map(url));
    expect(plan.thread?.parentThreadId).toBe("thr-coordinator");
    expect(await confirm(env, plan.batchId, async () => { env.threads.delete("thr-coordinator"); })).toEqual([42, 43].map((number) =>
      `folio #${number}: refused: Its parent thread is gone since the listing. Review it and try again; nothing was started.`));
    expect([claims(env), env.spawn.mock.calls.length]).toEqual([[], 0]);
  });

  // Two listings confirmed together that share a PR: one claim takes it, and the other batch starts without it. Each batch's read of #43
  // waits for the other's, so both pass the check before the read and only the one at the claim can tell them apart.
  it("claims a PR two listings share once when both are confirmed in the same window", async () => {
    const env = await setup();
    const first = await env.plan([42, 43].map(url));
    const second = await env.plan([43, 44].map(url));
    for (const plan of [first, second]) expect(await env.rpc("deck_batch_start", { batchId: plan.batchId })).toMatchObject({ ok: true });
    let meet = () => undefined as void;
    const met = new Promise<void>((resolve) => { meet = resolve; });
    let seen = 0;
    env.reads.during = async (prUrl) => { if (prUrl === url(43) && ++seen <= 2) { if (seen === 2) meet(); await met; } };
    await vi.advanceTimersByTimeAsync(8_100);
    for (const plan of [first, second]) await env.settled(plan.batchId!);
    const items = [...(await env.batch(first.batchId!)).items, ...(await env.batch(second.batchId!)).items];
    expect(items.filter((item) => item.ref === "folio #43").map((item) => item.state).sort()).toEqual(["refused", "sent"]);
    expect(items.find((item) => item.state === "refused")?.detail).toBe("An agent is already working on it.");
    expect(seen).toBe(2);
    expect(claims(env).map(([number]) => number).sort()).toEqual([42, 43, 44]);
    expect(env.spawn).toHaveBeenCalledTimes(2);
  });

  // Until its start returns, a claim has no thread for a message's owner check to name; it holds the PR all the same.
  it("refuses a message to a batched PR's thread while the batch thread is still starting", async () => {
    const env = await setup();
    env.hang.spawn = true;
    const plan = await env.plan([42, 43].map(url));
    await env.rpc("deck_batch_start", { batchId: plan.batchId });
    await vi.advanceTimersByTimeAsync(8_100);
    await vi.waitFor(() => expect(env.spawn).toHaveBeenCalledTimes(1));
    expect(claims(env).map(([number]) => number).sort()).toEqual([42, 43]);
    expect(await env.rpc("thread_message", { prUrl: url(42), threadId: "thr-42", message: "Address mira's note." }))
      .toEqual({ ok: false, error: "A batch thread is addressing this PR's feedback. Wait for it to finish." });
    expect(env.send).not.toHaveBeenCalled();
  });

  // Each sent PR keeps its link to the batch thread however the thread ends, back on Your turn and needing you, until a newer batch takes it.
  it("keeps each PR's link to a batch thread stopped without a report, lets Address take it again, and a newer batch replaces the link", async () => {
    const env = await setup();
    const sent = async () => new Map(((await env.rpc("inventory_get", {})) as InventoryView).groups.flatMap((group) => group.rows)
      .map((row) => [row.number, row.sent && `${row.sent.state} ${row.sent.threadId}`]));
    const first = await env.plan([43, 44].map(url));
    await confirm(env, first.batchId);
    await env.refresh();
    expect([(await sent()).get(43), (await sent()).get(44)]).toEqual(["working thr-batch-1", "working thr-batch-1"]);
    // Stopped by hand: its turn ends with no result line for either PR.
    env.output.text = "Stopped.";
    env.threads.set("thr-batch-1", { ...env.threads.get("thr-batch-1")!, status: "idle" });
    await env.harness.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr-batch-1", status: "idle" }), lastAssistantText: env.output.text });
    await vi.waitFor(async () => expect([(await sent()).get(43), (await sent()).get(44)]).toEqual(["no-report thr-batch-1", "no-report thr-batch-1"]));
    await env.refresh();
    expect(await env.turn()).toEqual([42, 43, 44, 45, 46]);
    // The claim is gone and so is the start's mark: the deck files it where its feedback does, needing you, and Address takes it again.
    expect((await env.rows()).get(43)).toMatchObject({ addressing: null, acted: null, sent: { state: "no-report", threadId: "thr-batch-1" } });
    expect((await env.rows()).get(43)?.section).not.toBe("flight");
    const again = await env.plan([url(43)]);
    expect([again.items.map((item) => item.ref), again.skipped]).toEqual([["folio #43"], []]);
    await confirm(env, again.batchId);
    await env.refresh();
    expect([(await sent()).get(43), (await sent()).get(44)]).toEqual(["working thr-batch-2", "no-report thr-batch-1"]);
    // Once GitHub shows #44's feedback answered, it leaves Your turn, link and all.
    env.current.set(44, { ...env.current.get(44)!, reviewFeedback: { openThreads: 0, comment: { login: "ines", at: ago(HOUR) }, repliedAt: ago(HOUR / 2) } });
    await env.refresh();
    expect(await env.turn()).toEqual([42, 43, 45, 46]);
  });

  // Address selected's own path, with no listing: its one click schedules the batch, the row reads Sending with Undo, and Undo starts nothing.
  it("starts Address selected's batch at once through the server, and its Undo starts nothing", async () => {
    const env = await setup();
    const rpc = { plan: (input: unknown) => env.rpc("deck_batch_plan", input) as never, start: (batchId: string) => env.rpc("deck_batch_start", { batchId }) as never };
    const outcome = await startAddress(rpc, null, [42, 43].map(url), {});
    expect(outcome).toMatchObject({ ok: true, count: 2, skipped: [] });
    const batchId = (outcome as { batchId: string }).batchId;
    expect((await env.batch(batchId)).state).toBe("scheduled");
    expect((await env.rows()).get(42)?.sent).toEqual({ state: "sending", threadId: null, title: null, detail: null, batchId });
    expect(await env.rpc("deck_batch_undo", { batchId })).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(env.spawn).not.toHaveBeenCalled();
    expect([(await env.batch(batchId)).state, (await env.rows()).get(42)?.sent ?? null]).toEqual(["cancelled", null]);
  });

  // Nothing fails quietly: a PR dispatch refuses keeps why on its row, where All PRs and the deck both read it.
  it("keeps why dispatch refused a PR on its row", async () => {
    const env = await setup();
    const plan = await env.plan([url(43)]);
    const said = await confirm(env, plan.batchId, () => env.rpc("pr_hold_set", { prUrl: url(43), held: true, reason: "Counter redesign" }));
    const why = said[0]!.replace(/^folio #43: refused: /u, "");
    expect(why).not.toBe(said[0]);
    await env.rpc("pr_hold_set", { prUrl: url(43), held: false });
    await env.refresh();
    expect((await env.rows()).get(43)?.sent).toEqual({ state: "refused", threadId: null, title: null, detail: why, batchId: null });
    expect(await env.turn()).toContain(43);
    expect(env.spawn).not.toHaveBeenCalled();
  });

  // A batch thread removed while no load listened sends no event. The next list of BB's threads finds it gone and ends its claims, so its
  // PRs don't wait on a thread that no longer exists; a run of another kind in a thread the list leaves out keeps its own rules.
  it("releases the claims of a batch thread deleted or archived unheard, back to Your turn", async () => {
    for (const gone of ["deleted", "archived"] as const) {
      const env = await setup();
      const plan = await env.plan([43, 44].map(url));
      await confirm(env, plan.batchId);
      const other = runOn(env, 45);
      await env.restart();
      if (gone === "deleted") env.threads.delete("thr-batch-1");
      else env.threads.set("thr-batch-1", { ...env.threads.get("thr-batch-1")!, archivedAt: Date.now() });
      await env.refresh();
      await drain();
      const runs = createRunStore(env.bb.storage.database() as never).recent(0);
      expect(runs.filter((run) => run.action === "address-feedback").map((run) => [run.prNumber, run.status, run.error])).toEqual([44, 43].map((number) =>
        [number, "failed", "Its batch thread is gone: deleted or archived while the board wasn't listening. Its report was never read."]));
      expect(runs.find((run) => run.id === other)?.status).toBe("running");
      // The thread is gone, but each PR keeps its link to it, saying it ended without a report.
      expect((await env.rows()).get(43)).toMatchObject({ addressing: null, sent: { state: "no-report", threadId: "thr-batch-1" } });
      expect(await env.turn()).toEqual([42, 43, 44, 45, 46]);
      await env.harness.lifecycle.dispose();
      cleanups.pop();
      vi.useRealTimers();
    }
  });

  // A list read before BB made a batch thread can't show it: the claim bound while that list was out is not taken for gone.
  it("keeps the claims of a batch thread its start bound after the thread list began", async () => {
    const env = await setup();
    let answer = () => undefined as void;
    env.hang.until = new Promise<void>((resolve) => { answer = resolve; });
    const plan = await env.plan([url(43)]);
    await env.rpc("deck_batch_start", { batchId: plan.batchId });
    await vi.advanceTimersByTimeAsync(8_100);
    await vi.waitFor(() => expect(env.spawn).toHaveBeenCalledTimes(1));
    let listed = false;
    env.lists.during = async () => { answer(); await env.settled(plan.batchId!); listed = true; };
    await env.refresh();
    // The list answers after BB made the thread and its claim was bound; then the board reconciles.
    await vi.waitFor(() => expect(listed).toBe(true));
    await drain();
    expect(claims(env)).toEqual([[43, "running"]]);
    expect((await env.rows()).get(43)?.addressing?.threadId).toBe("thr-batch-1");
  });
});
