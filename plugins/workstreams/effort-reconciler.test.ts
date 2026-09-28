// The v2 reconciler, the `effort-v2` background service: the one v2 scheduler.
// Events only mark rows due; each tick reads GitHub within its budgets, plans
// the due rows, and launches or takes an attempt's next step. Mechanics move
// without a stoppage and without the UI. Every SDK and host call is a test
// double; fixtures are in the fictional Inkwell domain.
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdvanceFacts } from "./advance-contract.js";
import type { AdvanceBatch } from "./bulk-advance.js";
import type { RawUnit } from "./contract.js";
import type { EffortRoster } from "./effort-roster.js";
import type { createEffortRunner } from "./effort-runner.js";
import { createEffortStore } from "./effort-store.js";
import type { createEffortV2, EffortCommandResult } from "./effort-v2-server.js";
import { createEffortWorkStore, type AttemptBody } from "./effort-work-store.js";
import { parsePrList } from "./gh.js";
import { createPrHoldStore } from "./pr-hold-store.js";
import type { RunDb } from "./runstore.js";
import plugin from "./server.js";

const runners = vi.hoisted(() => [] as ReturnType<typeof createEffortRunner>[]);
vi.mock("./effort-runner.js", async (original) => {
  const actual = await original<typeof import("./effort-runner.js")>();
  return { ...actual, createEffortRunner: (deps: Parameters<typeof actual.createEffortRunner>[0]) => {
    const runner = actual.createEffortRunner(deps);
    runners.push(runner);
    return runner;
  } };
});
/** Each plugin start's reconciler, so a test runs pass 0 and each tick itself, at the times it sets. */
const reconcilers = vi.hoisted(() => [] as ReturnType<typeof createEffortV2>["reconciler"][]);
vi.mock("./effort-v2-server.js", async (original) => {
  const actual = await original<typeof import("./effort-v2-server.js")>();
  return { ...actual, createEffortV2: (deps: Parameters<typeof actual.createEffortV2>[0]) => {
    const v2 = actual.createEffortV2(deps);
    reconcilers.push(v2.reconciler);
    return v2;
  } };
});

const HOST = "host-inkwell";
const PROJECT = "proj-inkwell";
const START = Date.UTC(2026, 8, 28, 15);
const MINUTE = 60_000;
const BASE = "b".repeat(40);
const url = (n: number) => `https://github.com/inkwell/folio/pull/${n}`;
const head = (n: number, version = 0) => `${n}${version}`.padEnd(40, "a");
/** GitHub's side of one PR. */
type Live = { state: "OPEN" | "MERGED" | "CLOSED"; headOid: string; checks: "passed" | "pending" | "failed"; mergeStateStatus: string; mergeable: string;
  reviewDecision: string | null; unresolvedThreads: number; basePrNumber: number | null; isDraft: boolean; reviewRequests: string[];
  latestReviews: { login: string; state: string }[]; reviewFollowupPosted?: boolean };
const ready = (n: number): Live => ({ state: "OPEN", headOid: head(n), checks: "passed", mergeStateStatus: "CLEAN", mergeable: "MERGEABLE", reviewDecision: "APPROVED",
  unresolvedThreads: 0, basePrNumber: null, isDraft: false, reviewRequests: [], latestReviews: [] });
const conflicting = { mergeStateStatus: "DIRTY", mergeable: "CONFLICTING" } satisfies Partial<Live>;
const title = (n: number) => `ABC-${n} Keep returned books on their shelf`;
/** The cheap read: what the board's inventory and inspectPrs see. */
const cheap = (n: number, live: Live) => ({ ...parsePrList(JSON.stringify([{ number: n, url: url(n), state: live.state, title: title(n), reviewDecision: live.reviewDecision ?? "",
  isDraft: live.isDraft, headRefName: `abc-${n}`, baseRefName: "main", headRefOid: live.headOid, baseRefOid: BASE, mergeStateStatus: live.mergeStateStatus, mergeable: live.mergeable,
  statusCheckRollup: [live.checks === "passed" ? { conclusion: "SUCCESS" } : live.checks === "failed" ? { conclusion: "FAILURE" } : { status: "IN_PROGRESS", conclusion: "" }],
  latestReviews: live.latestReviews.map(({ login, state }) => ({ author: { login }, state })), reviewRequests: live.reviewRequests.map((login) => ({ login })) }]))!.pr,
  unresolvedReviewThreads: live.unresolvedThreads, resolvedReviewThreads: 0 });
/** The full read: what advanceInspect sees. */
const full = (n: number, live: Live): AdvanceFacts => ({ prUrl: url(n), number: n, title: title(n), repo: "inkwell/folio", headRefName: `abc-${n}`, baseRefName: "main",
  headOid: live.state === "OPEN" ? live.headOid : "", baseOid: live.state === "OPEN" ? BASE : "", state: live.state, isDraft: live.isDraft, isCrossRepository: false,
  reviewDecision: live.reviewDecision, mergeStateStatus: live.mergeStateStatus, mergeable: live.mergeable, needsPreparation: false, readiness: "ready", detail: "",
  unresolvedThreads: live.unresolvedThreads, threadsComplete: true, checks: live.checks, basePrNumber: live.basePrNumber,
  ...live.reviewFollowupPosted === undefined ? {} : { reviewFollowupPosted: live.reviewFollowupPosted }, approvalFeedback: { status: "none", fingerprint: null, sourceIds: [] } });
/** BB's turn.failed for a worker's turn, with no rate limit to wait out. */
const failed = (threadId: string, requestId: string) => ({ threadId, requestId, turnId: null, errorInfo: null, inputAccepted: true, rateLimits: null, attemptNumber: 1 }) as never;
/** Let the event hooks record their signals and mark rows due. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 10));
const result = (attemptId: string, n: number, headOid: string) =>
  `Workstreams result v1: ${JSON.stringify({ attemptId, target: url(n), actions: ["integrate_base"], outcome: "changed", headOid, baseOid: BASE })}`;

/** A legacy Advance job on this PR that launched with an outcome no one confirmed; its batch loads when the plugin restarts. */
function saveUncertainJob(db: RunDb, n: number): string {
  const id = `00000000-0000-4000-8000-000000000${n}`;
  const jobId = `00000000-0000-4000-8000-000000001${n}`;
  const routing = { ...full(n, ready(n)), eligible: true, workspace: "create", projectId: PROJECT, hostId: HOST, sourcePath: `/p/folio-${n}`, path: `/p/folio-${n}`,
    effortId: null, effortKey: null, effortMembers: null, needsFeedback: false, needsChecks: false, blockedBy: null };
  const job = { ...routing, id: jobId, hiddenFromProgress: false, status: "running", attemptId: null, dedicated: false, previousAttempts: [], threadId: null,
    checkedHeadOid: null, updatedAt: START - 10 * MINUTE, uncertain: true };
  db.prepare("INSERT INTO advance_batches (id, body) VALUES (?, ?)").run(id, JSON.stringify({ id, token: `00000000-0000-4000-8000-000000002${n}`,
    createdAt: START - 10 * MINUTE, cancelled: false, jobs: [job], facts: { [jobId]: routing }, pollUntil: START + MINUTE, prepared: {}, repairs: {} }));
  return jobId;
}

const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(START); });
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.useRealTimers(); });

type Options = { live?: (n: number) => Partial<Live>; parents?: number[]; execution?: "dry-run" | "on"; concurrency?: number };
/** An effort on its v2 roster, "Shelving entry", owning these PRs, each checked out on the primary host, instructed to move all forward. */
async function setup(numbers: number[], options: Options = {}) {
  const lives = new Map([...numbers, ...options.parents ?? []].map((n) => [n, { ...ready(n), ...options.live?.(n) }]));
  const github = { fullError: null as string | null, resetAt: null as number | null, readback: null as Promise<void> | null,
    /** PRs whose full read fails for a reason other than a rate limit. */
    failFor: new Set<number>(),
    /** Runs while a pass reads a launch's checkout, between planning the row and committing it. */
    duringCheckoutRead: null as (() => void) | null,
    /** Whether one write lands on GitHub, and what the host answers (an Error is a call that never answered); by default it lands and succeeds. */
    write: null as ((request: { kind: string; prUrl: string }) => { lands: boolean; answer: { ok: true; detail: string } | { ok: false; error: string } | Error }) | null,
    /** PRs whose review requests the host can't read, with the error it answers. */
    reviewersFail: new Map<number, string>() };
  const checkout = (n: number): RawUnit => ({ path: `/p/folio-${n}`, dirName: `folio-${n}`, repo: "folio", githubRepo: "inkwell/folio", branch: `abc-${n}`, dirty: false, ahead: 0,
    behind: 0, lastCommitAt: "2026-09-27T12:00:00Z", defaultBranch: "main", pr: cheap(n, lives.get(n)!), shipped: null, changedPaths: [], observed: { status: true, pr: true } });
  const threads = new Map<string, ReturnType<typeof makeThreadResponse> & { environment: { hostId: string; path: string; branchName: string | null } }>();
  const metadata = new Map<string, Record<string, unknown>>();
  const outputs = new Map<string, string>();
  const requests = new Map<string, unknown[]>();
  const hostCalls: { method: string; input: any }[] = [];
  /** The interactions waiting on you in each thread. */
  const pending = new Map<string, unknown[]>();
  /** BB queues a retry, which runs as the thread's next turn request. */
  const retry = vi.fn(async (args: { threadId: string; turnRequestId?: string }) => {
    const list = requests.get(args.threadId) ?? [];
    requests.set(args.threadId, [{ type: "client/turn/requested", seq: 100 + list.length,
      data: { requestId: `req-${list.length + 1}`, retryOfRequestId: args.turnRequestId, input: [], senderThreadId: null } }, ...list]);
    return { ok: true } as never;
  });
  let spawned = 0;
  const spawn = vi.fn(async (args: Record<string, any>) => {
    const id = `thr-worker-${++spawned}`;
    const path = args.environment.workspace.path as string;
    threads.set(id, { ...makeThreadResponse({ id, projectId: args.projectId, title: args.title, providerId: args.providerId, status: "active", environmentId: `env-${id}`,
      originPluginId: "workstreams" }), environment: { hostId: args.environment.hostId, path, branchName: null } });
    metadata.set(id, args.pluginMetadata);
    requests.set(id, [{ type: "client/turn/requested", seq: 1, data: { requestId: "req-1", input: [{ type: "text", text: args.prompt }], senderThreadId: null } }]);
    return threads.get(id) as never;
  });
  const send = vi.fn(async (args: Record<string, any>) => {
    const list = requests.get(args.threadId) ?? [];
    requests.set(args.threadId, [{ type: "client/turn/requested", seq: 50 + list.length, data: { requestId: `req-${list.length + 1}`, input: args.input, senderThreadId: null } }, ...list]);
    threads.set(args.threadId, { ...threads.get(args.threadId)!, status: "active" });
    return { ok: true, delivery: "sent" } as never;
  });
  const { bb, harness } = createFakePluginHost({ pluginId: "workstreams", settings: { scanRoots: "/p", v2Execution: options.execution ?? "dry-run", workerConcurrency: options.concurrency ?? 2 }, sdk: {
    system: { config: async () => ({ primaryHostId: HOST }) as never },
    projects: { list: async () => [{ id: PROJECT, name: "Inkwell", sources: [{ hostId: HOST, path: "/p" }] }] as never },
    threads: {
      list: async (args?: { originPluginId?: string }) => {
        if (args?.originPluginId && github.readback) await github.readback;
        return [...threads.values()].map((thread) => ({ ...thread, environmentPath: thread.environment.path, environmentHostId: thread.environment.hostId,
          queuedWork: "none", hasPendingInteraction: false })) as never;
      },
      spawn, send,
      get: async ({ threadId }: { threadId: string }) => {
        const thread = threads.get(threadId);
        if (!thread) throw Object.assign(new Error("missing thread"), { status: 404 });
        return thread as never;
      },
      getPluginMetadata: async ({ threadId }: { threadId: string }) => (metadata.get(threadId) ?? {}) as never,
      output: async ({ threadId }: { threadId: string }) => ({ output: outputs.get(threadId) ?? null }),
      context: async () => ({ usage: null }) as never,
      events: { list: async ({ threadId, types }: { threadId: string; types?: readonly string[] }) => (types?.includes("client/turn/requested") ? requests.get(threadId) ?? [] : []) as never },
      queuedMessages: { list: async () => [] as never },
      interactions: { list: async ({ threadId }: { threadId: string }) => (pending.get(threadId) ?? []) as never },
      retry: retry as never,
    },
  }, experimental_callHostRpc: async ({ method, input }) => {
    hostCalls.push({ method, input });
    const number = (prUrl: string) => Number(prUrl.split("/").at(-1));
    const open = () => numbers.filter((n) => lives.get(n)!.state === "OPEN");
    if (method === "scan") return { units: open().map(checkout), warnings: [] };
    if (method === "inspectPaths") return { units: open().map(checkout).filter((unit) => (input as { paths: string[] }).paths.includes(unit.path)), warnings: [] };
    if (method === "authoredPrs") return { owners: ["inkwell"], entries: open().map((n) => ({ repo: "inkwell/folio", pr: cheap(n, lives.get(n)!) })),
      discoveryComplete: true, complete: true, repositories: [{ repo: "inkwell/folio", complete: true }], warnings: [] };
    if (method === "linkbacks") return { found: [], warnings: [] };
    if (method === "inspectPrs") {
      const read = (input as { prUrls: string[] }).prUrls.map(number);
      return { entries: read.filter((n) => lives.get(n)?.state === "OPEN").map((n) => ({ repo: "inkwell/folio", pr: cheap(n, lives.get(n)!) })),
        closed: read.filter((n) => lives.get(n) && lives.get(n)!.state !== "OPEN").map(url), failed: [], warnings: [] };
    }
    if (method === "advanceInspect") {
      const n = number((input as { prUrl: string }).prUrl);
      if (github.fullError || github.failFor.has(n)) return { ok: false, error: github.fullError ?? "GraphQL: Could not resolve to a PullRequest." };
      return { ok: true, facts: full(n, lives.get(n)!) };
    }
    if (method === "inspectCheckout") {
      github.duringCheckoutRead?.();
      const n = Number((input as { path: string }).path.split("-").at(-1));
      return { ok: true, head: lives.get(n)!.headOid, branch: `abc-${n}`, clean: true, commonDir: "/p/folio/.git", relation: "at-head" };
    }
    if (method === "githubRateLimit") return { resetAt: github.resetAt };
    if (method === "prReviewers") {
      const n = number((input as { prUrl: string }).prUrl);
      const error = github.reviewersFail.get(n);
      return error ? { ok: false, error } : { ok: true, reviewers: lives.get(n)!.reviewRequests };
    }
    if (method === "prWrite") {
      // GitHub as the host's prWrite leaves it, for the kinds v2 writes.
      const request = input as { kind: string; prUrl: string; reviewers?: string[] };
      const live = lives.get(number(request.prUrl))!;
      const { lands, answer } = github.write?.(request) ?? { lands: true, answer: { ok: true, detail: "written" } };
      if (lands && request.kind === "nudge") live.reviewRequests = [...new Set([...live.reviewRequests, ...request.reviewers!])];
      if (lands && request.kind === "ready") live.isDraft = false;
      if (lands && request.kind === "rerun-failed") live.checks = "pending";
      if (answer instanceof Error) throw answer;
      return answer;
    }
    if (method === "contextWorkspace") return { path: "/synthetic/workstreams/context" };
    throw new Error(`Unexpected host call ${method}`);
  } });
  await plugin(bb);
  cleanups.push(() => harness.lifecycle.dispose());
  expect((await harness.runCli(["refresh"])).exitCode).toBe(0);
  const db = bb.storage.database();
  const work = createEffortWorkStore(db);
  const effort = createEffortStore(db).establish({ sourceKey: "shelving-entry", name: "Shelving entry", goal: "Shelve every return", projectId: PROJECT,
    coordinatorState: "none", members: { tickets: [], prUrls: numbers.map(url) } });
  work.setMode(effort.id, "v2", 0, () => []);
  expect((await harness.runCli(["refresh"])).exitCode).toBe(0);
  const roster = await harness.callRpc("effort_roster_get", { effortId: effort.id }) as EffortRoster;
  const admitted = await harness.callRpc("effort_command", { effortId: effort.id, snapshotId: roster.snapshotId, text: "move all forward", requestId: "req-1",
    source: "panel" }) as EffortCommandResult;
  expect(admitted).toMatchObject({ kind: "admit" });
  const reconciler = reconcilers.at(-1)!;
  return {
    bb, harness, db, work, effort, admitted, reconciler, runner: runners.at(-1)!, spawn, send, threads, metadata, hostCalls, github, lives, retry, pending, outputs, requests,
    row: (n: number) => work.row(url(n)),
    /** GitHub changes for one PR. */
    set: (n: number, patch: Partial<Live>) => { lives.set(n, { ...lives.get(n)!, ...patch }); },
    at: (ms: number) => { vi.setSystemTime(START + ms); },
    calls: (method: string) => hostCalls.filter((call) => call.method === method),
    /** A worker's turn ends: its thread goes idle with this output, and BB says so. */
    finish: async (threadId: string, output: string) => {
      outputs.set(threadId, output);
      threads.set(threadId, { ...threads.get(threadId)!, status: "idle" });
      await harness.emitThreadEvent("thread.idle", { thread: threads.get(threadId)!, lastAssistantText: output });
      // The hooks record the signal and mark rows due asynchronously; let them settle.
      await new Promise((resolve) => setTimeout(resolve, 10));
    },
    criteriaNotes: () => (db.prepare(`SELECT detail FROM effort_transitions WHERE cause = 'criteria' ORDER BY seq`).all() as { detail: string }[])
      .map((row) => JSON.parse(row.detail) as { outcomeValidated: boolean; completed: boolean }),
  };
}

/** One command against the roster as it stands. */
async function say(env: Awaited<ReturnType<typeof setup>>, text: string, requestId: string) {
  const roster = await env.harness.callRpc("effort_roster_get", { effortId: env.effort.id }) as EffortRoster;
  const active = env.work.instruction(env.effort.id);
  return await env.harness.callRpc("effort_command", { effortId: env.effort.id, snapshotId: roster.snapshotId, text, requestId, source: "panel",
    ...active ? { expectedRevision: active.revision } : {} }) as EffortCommandResult;
}

describe("the v2 reconciler", () => {
  it("moves a row to Ready when its checks finish, with no worker and no model turn", async () => {
    const env = await setup([301], { live: () => ({ checks: "pending", mergeStateStatus: "BLOCKED" }) });
    await env.reconciler.recoverAll();
    await env.reconciler.tick();
    expect(env.row(301)).toMatchObject({ phase: "waiting", body: { cause: "ci" } });
    env.set(301, { checks: "passed", mergeStateStatus: "CLEAN" });
    // CI's two-minute poll: the cheap read shows the change, and a full read verifies the candidate.
    env.at(2 * MINUTE + 1_000);
    await env.reconciler.tick();
    expect(env.row(301)).toMatchObject({ phase: "prepared", body: { cause: "merge-candidate", userState: "ready" } });
    expect([env.spawn.mock.calls, env.send.mock.calls]).toEqual([[], []]);
  });

  it("queues new review feedback in the thread that did the last work, with no new thread", async () => {
    const env = await setup([302], { live: () => conflicting, execution: "on" });
    await env.reconciler.recoverAll();
    await env.reconciler.tick();
    expect(env.spawn).toHaveBeenCalledTimes(1);
    const [first] = env.work.attempts(url(302));
    // The worker rebased and reported; GitHub shows the new head clean and approved.
    env.set(302, { ...ready(302), headOid: head(302, 1) });
    await env.finish(first!.threadId!, result(first!.id, 302, head(302, 1)));
    await env.reconciler.tick();
    expect(env.row(302)).toMatchObject({ phase: "prepared" });
    // A reviewer asks for changes on that head.
    env.set(302, { reviewDecision: "CHANGES_REQUESTED", unresolvedThreads: 2, mergeStateStatus: "BLOCKED" });
    env.at(5 * MINUTE + 1_000);
    await env.reconciler.tick();
    expect(env.send).toHaveBeenCalledTimes(1);
    expect(env.send.mock.calls[0]![0]).toMatchObject({ threadId: first!.threadId });
    expect(env.spawn).toHaveBeenCalledTimes(1);
    expect(env.work.attempts(url(302))[0]).toMatchObject({ status: "running", threadId: first!.threadId, body: { recipes: ["address_review_feedback"], mode: "send" } });
  });

  it("only verifies a head another writer pushed, starting no worker", async () => {
    const env = await setup([303], { execution: "on" });
    await env.reconciler.recoverAll();
    await env.reconciler.tick();
    expect(env.row(303)?.phase).toBe("prepared");
    env.set(303, { headOid: head(303, 1), checks: "pending", mergeStateStatus: "BLOCKED" });
    env.at(5 * MINUTE + 1_000);
    await env.reconciler.tick();
    expect(env.row(303)).toMatchObject({ phase: "waiting", body: { cause: "ci", observedHead: head(303, 1) } });
    expect([env.spawn.mock.calls, env.send.mock.calls, env.work.attempts(url(303))]).toEqual([[], [], []]);
  });

  it("wakes a child in the same tick its stack parent merges, though the parent is on no roster", async () => {
    const env = await setup([305], { live: (n) => n === 305 ? { basePrNumber: 290 } : {}, parents: [290] });
    await env.reconciler.recoverAll();
    await env.reconciler.tick();
    expect(env.row(305)).toMatchObject({ phase: "waiting", body: { cause: "parent", owner: { kind: "pr", ref: "inkwell/folio#290" } } });
    env.set(290, { state: "MERGED" });
    env.set(305, { basePrNumber: null });
    // The child's own poll is five minutes away; the parent is watched every tick.
    env.at(MINUTE + 1_000);
    await env.reconciler.tick();
    expect(env.row(305)).toMatchObject({ phase: "prepared" });
    expect(env.calls("inspectPrs").at(-1)!.input.prUrls).toEqual([url(290)]);
  });

  it("holds no worker slot for a waiting row", async () => {
    const env = await setup([306, 307], { live: (n) => n === 306 ? { checks: "pending", mergeStateStatus: "BLOCKED" } : conflicting, execution: "on", concurrency: 1 });
    // With execution on, the next tick performs what a command planned.
    expect(env.admitted.kind === "admit" && env.admitted.acknowledgment.at(-1)).toBe("Next: 1, 2 read GitHub");
    await env.reconciler.recoverAll();
    await env.reconciler.tick();
    expect(env.row(306)).toMatchObject({ phase: "waiting", body: { cause: "ci" } });
    expect(env.row(307)).toMatchObject({ phase: "executing" });
    expect(env.spawn.mock.calls.map(([args]) => args.pluginMetadata.prUrl)).toEqual([url(307)]);
  });

  it("frees the worker slots of two turns that went idle without a report, and repairs their reports instead of calling them uncertain", async () => {
    const env = await setup([308, 309, 310], { live: () => conflicting, execution: "on", concurrency: 2 });
    await env.reconciler.recoverAll();
    await env.reconciler.tick();
    expect(env.spawn).toHaveBeenCalledTimes(2);
    expect(env.row(310)).toMatchObject({ phase: "waiting", body: { cause: "capacity" } });
    env.at(MINUTE + 1_000);
    for (const [attempt] of [env.work.attempts(url(308)), env.work.attempts(url(309))]) await env.finish(attempt!.threadId!, "Rebased and pushed. Ready to merge.");
    await env.reconciler.tick();
    expect(env.spawn.mock.calls.map(([args]) => args.pluginMetadata.prUrl)).toEqual([url(308), url(309), url(310)]);
    for (const n of [308, 309]) {
      expect(env.work.attempts(url(n))[0]).toMatchObject({ status: "completed", body: { report: { key: "report-invalid" } } });
      expect(env.row(n)).toMatchObject({ phase: "queued", body: { cause: "report-repair", nextAction: ["repair_report"] } });
    }
  });

  it("waits out a GitHub rate limit until the reset GitHub reports, reading nothing meanwhile, and never calls it a repair", async () => {
    const env = await setup([312]);
    env.github.fullError = "GraphQL: API rate limit exceeded for user ID 1001.";
    env.github.resetAt = START + 20 * MINUTE;
    await env.reconciler.recoverAll();
    await env.reconciler.tick();
    expect(env.row(312)).toMatchObject({ phase: "waiting", dueAt: START + 20 * MINUTE + 30_000, body: { cause: "rate-limit", userState: "waiting" } });
    const reads = env.hostCalls.length;
    env.at(10 * MINUTE);
    env.reconciler.due([url(312)]);
    await env.reconciler.tick();
    expect(env.hostCalls.length).toBe(reads);
    expect(env.row(312)?.body.cause).toBe("rate-limit");
    env.github.fullError = null;
    env.at(20 * MINUTE + 31_000);
    await env.reconciler.tick();
    expect(env.row(312)?.phase).toBe("prepared");
    expect(env.db.prepare(`SELECT count(*) AS count FROM effort_transitions WHERE target = ? AND to_phase = 'repair-needed'`).get(url(312))).toEqual({ count: 0 });
  });

  it("reads no PR again that the board or the reconciler read in the last minute", async () => {
    const env = await setup([313]);
    await env.reconciler.recoverAll();
    // The board's own refresh just read it.
    await env.reconciler.tick();
    expect(env.calls("inspectPrs")).toEqual([]);
    env.at(MINUTE + 1_000);
    env.reconciler.due([url(313)]);
    await env.reconciler.tick();
    expect(env.calls("inspectPrs").map((call) => call.input.prUrls)).toEqual([[url(313)]]);
    env.at(MINUTE + 30_000);
    env.reconciler.due([url(313)]);
    await env.reconciler.tick();
    expect(env.calls("inspectPrs")).toHaveLength(1);
  });

  it("journals outcome validated once and keeps the instruction active, then completes it when every row finished", async () => {
    const env = await setup([314, 315]);
    await env.reconciler.recoverAll();
    await env.reconciler.tick();
    expect([env.row(314)?.phase, env.row(315)?.phase]).toEqual(["prepared", "prepared"]);
    expect(env.criteriaNotes().map(({ outcomeValidated, completed }) => [outcomeValidated, completed])).toEqual([[true, false]]);
    env.at(5 * MINUTE + 1_000);
    await env.reconciler.tick();
    // Still validated: nothing is journaled again, and a Ready PR that regresses would re-enter work under the same instruction.
    expect(env.criteriaNotes()).toHaveLength(1);
    expect(env.work.instruction(env.effort.id)?.status).toBe("active");
    env.set(314, { state: "MERGED" });
    env.set(315, { state: "MERGED" });
    env.at(10 * MINUTE + 2_000);
    await env.reconciler.tick();
    expect([env.row(314)?.phase, env.row(315)?.phase]).toEqual(["finished", "finished"]);
    expect(env.criteriaNotes().map(({ outcomeValidated, completed }) => [outcomeValidated, completed])).toEqual([[true, false], [true, true]]);
    expect(env.work.instruction(env.effort.id)).toBeNull();
    expect(env.db.prepare(`SELECT status FROM effort_instructions WHERE effort_id = ?`).get(env.effort.id)).toEqual({ status: "completed" });
  });

  it("makes progress as a background service with no view open and no board poll", async () => {
    const env = await setup([316]);
    const { controller, done } = env.harness.runService("effort-v2");
    await vi.waitFor(() => expect(env.row(316)?.phase).toBe("prepared"));
    controller.abort();
    await done;
  });

  it("admits no launch until pass 0 has read every unfinished launch back", async () => {
    const env = await setup([317, 318], { live: () => conflicting, execution: "on" });
    // A launch a stopped process left uncertain on 317.
    const body: AttemptBody = { instructionRevision: 1, recipes: ["integrate_base"], role: "code", retryEpoch: 0, retryIndex: 0,
      start: { headOid: head(317), baseOid: BASE, fingerprint: null, sourceIds: [] }, resource: { kind: "spawn", threadId: null, path: "/p/folio-317", hostId: HOST, projectId: PROJECT,
        reason: null, workspace: null }, mode: "spawn", marker: "[Workstreams attempt A-317 · inkwell/folio#317 · instruction r1]", settledAt: START - MINUTE,
      uncertainAt: START - MINUTE, emptyReadbackAt: null, failure: null, error: null, releasedReason: null };
    env.work.claim({ id: "A-317", target: url(317), effortId: env.effort.id, instructionId: `I-${env.effort.id}-r1`, launchKey: "key-317", threadId: null, hostId: HOST,
      path: "/p/folio-317", body });
    env.work.recordAttempt("A-317", ["launching"], { status: "uncertain", body });
    let release!: () => void;
    env.github.readback = new Promise((resolve) => { release = resolve; });
    const { controller, done } = env.harness.runService("effort-v2");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect([env.spawn.mock.calls, env.work.claimOn(url(318), null), env.calls("advanceInspect")]).toEqual([[], null, []]);
    release();
    await vi.waitFor(() => expect(env.spawn.mock.calls.map(([args]) => args.pluginMetadata.prUrl)).toEqual([url(318)]));
    // The first empty readback: the claim holds until a second one a minute later.
    expect(env.work.attempt("A-317")).toMatchObject({ status: "uncertain", body: { emptyReadbackAt: expect.any(Number) } });
    controller.abort();
    await done;
  });

  it("writes nothing from a pass that another instance's write overtook, and plans again from that write", async () => {
    const env = await setup([319]);
    await env.reconciler.recoverAll();
    const transitions = () => (env.db.prepare(`SELECT source FROM effort_transitions WHERE target = ? ORDER BY seq`).all(url(319)) as { source: string }[]).map((row) => row.source);
    const before = transitions();
    // Between this pass reading 319's row and committing it, another instance commits 319's row.
    const other = createEffortWorkStore(env.db);
    const admission = env.runner.admission.bind(env.runner);
    vi.spyOn(env.runner, "admission").mockImplementationOnce(async () => {
      const row = other.row(url(319))!;
      other.commit({ effortId: env.effort.id, baseRevision: other.lastRevision(env.effort.id), source: "other-instance", instruction: null, journal: null,
        rows: [{ target: url(319), expectedRevision: row.revision, phase: row.phase, body: { ...row.body, detail: `${row.body.detail}.` }, dueAt: row.dueAt }] });
      return admission();
    });
    await env.reconciler.tick();
    expect(transitions()).toEqual([...before, "other-instance"]);
    expect(env.row(319)).toMatchObject({ phase: "verifying", body: { cause: "observe" } });
    // The next pass plans from what the other instance wrote.
    await env.reconciler.tick();
    expect(transitions()).toEqual([...before, "other-instance", "reconciler"]);
    expect(env.row(319)?.phase).toBe("prepared");
  });

  it("reads at most four PRs in full a minute", async () => {
    const numbers = [320, 321, 322, 323, 324, 325];
    const env = await setup(numbers);
    await env.reconciler.recoverAll();
    await env.reconciler.tick();
    expect(env.calls("advanceInspect")).toHaveLength(4);
    expect(numbers.map((n) => env.row(n)?.phase).sort()).toEqual(["prepared", "prepared", "prepared", "prepared", "verifying", "verifying"]);
    env.at(30_000);
    await env.reconciler.tick();
    expect(env.calls("advanceInspect")).toHaveLength(4);
    env.at(MINUTE + 1_000);
    await env.reconciler.tick();
    expect(env.calls("advanceInspect")).toHaveLength(6);
    expect(numbers.every((n) => env.row(n)?.phase === "prepared")).toBe(true);
  });

  it("rechecks an uncertain legacy Advance job holding a PR every ten minutes, at most six times, then names it a system issue", async () => {
    // 311 needs its base integrated, which the legacy job may still be doing.
    const env = await setup([311], { live: () => conflicting });
    const jobId = saveUncertainJob(env.db, 311);
    // Two threads answer to that job's launch, so no recheck can settle it.
    for (const id of ["thr-legacy-a", "thr-legacy-b"]) {
      env.threads.set(id, { ...makeThreadResponse({ id, projectId: PROJECT, providerId: "codex", status: "idle", originPluginId: "workstreams" }),
        environment: { hostId: HOST, path: "/p/folio-311", branchName: null } });
      env.metadata.set(id, { advanceJobId: jobId });
    }
    const restarted = await env.harness.lifecycle.reload(plugin);
    cleanups.push(() => restarted.harness.lifecycle.dispose());
    const db = restarted.bb.storage.database();
    const work = createEffortWorkStore(db);
    const reconciler = reconcilers.at(-1)!;
    const rechecks = () => (db.prepare(`SELECT count(*) AS count FROM effort_transitions WHERE cause = 'legacy-recheck'`).get() as { count: number }).count;
    await reconciler.recoverAll();
    await reconciler.tick();
    expect(work.row(url(311))).toMatchObject({ phase: "waiting", body: { cause: "legacy-drain", owner: { kind: "legacy-job" } } });
    expect(rechecks()).toBe(1);
    // It isn't rechecked again inside ten minutes, and looks again at its poll...
    env.at(MINUTE);
    await reconciler.tick();
    expect(rechecks()).toBe(1);
    expect(work.row(url(311))?.dueAt).toBe(START + 11 * MINUTE);
    // ...or at once when Advance says the job changed.
    env.at(2 * MINUTE);
    await restarted.harness.callRpc("advance_progress_visibility", { batchId: "00000000-0000-4000-8000-000000000311", jobId, hidden: false });
    expect(work.row(url(311))?.dueAt).toBe(START + 2 * MINUTE);
    for (let tick = 1; tick <= 6; tick++) {
      env.at(MINUTE + tick * 11 * MINUTE);
      await reconciler.tick();
      expect(rechecks()).toBe(Math.min(tick + 1, 6));
    }
    expect(work.row(url(311))).toMatchObject({ phase: "repair-needed", body: { cause: "legacy-uncertain", userState: "issue", recovery: ["retry N"] } });
    expect((await restarted.harness.callRpc("advance_get", null) as AdvanceBatch[]).flatMap((batch) => batch.jobs)).toMatchObject([{ uncertain: true }]);
  });

  it("in a dry run plans each launch where it would run, and claims, starts, sends, and writes nothing", async () => {
    const env = await setup([326], { live: () => conflicting });
    expect(env.admitted.kind === "admit" && env.admitted.acknowledgment.at(-1)).toBe("Next (planned; nothing runs until v2 execution is on): 1 read GitHub");
    // Reading GitHub is performed in a dry run too.
    expect(env.row(326)).toMatchObject({ phase: "verifying", body: { userState: "doing", modifiers: [] } });
    await env.reconciler.recoverAll();
    await env.reconciler.tick();
    expect(env.row(326)).toMatchObject({ phase: "queued", dueAt: START + 5 * MINUTE, body: { userState: "waiting", modifiers: ["plan only"],
      plan: { recipes: ["integrate_base"], resource: { kind: "spawn", path: "/p/folio-326", hostId: HOST } } } });
    const reads = env.calls("inspectCheckout").length;
    // Planned once, it looks again at its poll or an event, not every tick.
    await env.reconciler.tick();
    expect(env.calls("inspectCheckout")).toHaveLength(reads);
    expect([env.work.attempts(url(326)), env.work.claims(), env.spawn.mock.calls, env.send.mock.calls,
      env.hostCalls.filter((call) => ["advanceWorkspace", "prWrite"].includes(call.method))]).toEqual([[], [], [], [], []]);
  });
});

describe("the v2 reconciler's reads beside the board's", () => {
  it("reads a worker's report within the budget of full reads, never around it", async () => {
    const env = await setup([340, 341, 342, 343, 344], { live: (n) => n === 340 ? conflicting : {}, execution: "on" });
    await env.reconciler.recoverAll();
    await env.reconciler.tick();
    expect(env.calls("advanceInspect")).toHaveLength(4);
    const [attempt] = env.work.attempts(url(340));
    env.set(340, { ...ready(340), headOid: head(340, 1) });
    env.at(15_000);
    await env.finish(attempt!.threadId!, result(attempt!.id, 340, head(340, 1)));
    await env.reconciler.tick();
    // The minute's four full reads are spent, so the report waits unread rather than reading GitHub around the budget.
    expect(env.calls("advanceInspect")).toHaveLength(4);
    expect(env.work.attempt(attempt!.id)?.body.report?.key).toBeNull();
    env.at(MINUTE + 1_000);
    await env.reconciler.tick();
    expect(env.work.attempt(attempt!.id)?.body.report?.key).toBe("changed");
  });

  it("backs a secondary rate limit off 1, then 2 minutes, as a wait that is never a repair", async () => {
    const env = await setup([345]);
    env.github.fullError = "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.";
    await env.reconciler.recoverAll();
    await env.reconciler.tick();
    expect(env.row(345)).toMatchObject({ phase: "waiting", dueAt: START + MINUTE, body: { cause: "rate-limit" } });
    env.at(MINUTE);
    await env.reconciler.tick();
    expect(env.row(345)).toMatchObject({ phase: "waiting", dueAt: START + 3 * MINUTE, body: { cause: "rate-limit" } });
    env.github.fullError = null;
    env.at(3 * MINUTE);
    await env.reconciler.tick();
    expect(env.row(345)?.phase).toBe("prepared");
  });

  it("writes its cheap read of a PR the board tracks through the board's own stores, so the board shows what the roster does", async () => {
    const env = await setup([347], { live: () => ({ checks: "pending", mergeStateStatus: "BLOCKED" }) });
    await env.reconciler.recoverAll();
    await env.reconciler.tick();
    env.set(347, { checks: "passed", mergeStateStatus: "CLEAN" });
    env.at(2 * MINUTE + 1_000);
    await env.reconciler.tick();
    expect(env.row(347)?.phase).toBe("prepared");
    const board = await env.harness.callRpc("board_get", null) as { prInventory: { entries: { pr: { url: string; mergeStateStatus: string | null } }[] } };
    expect(board.prInventory.entries.find((entry) => entry.pr.url === url(347))?.pr.mergeStateStatus).toBe("CLEAN");
  });

  it("schedules the board's own refresh of a PR it tracks when a full read moved it", async () => {
    const env = await setup([346]);
    await env.reconciler.recoverAll();
    await env.reconciler.tick();
    expect(env.row(346)?.phase).toBe("prepared");
    env.set(346, { checks: "pending", mergeStateStatus: "BLOCKED" });
    env.at(5 * MINUTE + 1_000);
    await env.reconciler.tick();
    expect(env.row(346)?.body.cause).toBe("ci");
    const reads = env.calls("inspectPrs").length;
    // The board reads it itself after its rescan delay, with no tick.
    await vi.waitFor(() => expect(env.calls("inspectPrs")).toHaveLength(reads + 1), { timeout: 5_000, interval: 100 });
    expect(env.calls("inspectPrs").at(-1)!.input.prUrls).toEqual([url(346)]);
  });

  it("makes a row due at once when the board's own read of its PR comes in, ahead of the row's poll", async () => {
    const env = await setup([348]);
    await env.reconciler.recoverAll();
    await env.reconciler.tick();
    expect(env.row(348)).toMatchObject({ phase: "prepared", dueAt: START + 5 * MINUTE });
    env.at(MINUTE);
    expect(await env.harness.callRpc("pr_refresh", { prUrl: url(348) })).toMatchObject({ status: "checked" });
    expect(env.row(348)?.dueAt).toBe(START + MINUTE);
  });
});

describe("the v2 reconciler when a read fails or an event is missed", () => {
  /** An uncertain launch a stopped process left on this PR, as pass 0 finds it. */
  function seedUncertain(env: Awaited<ReturnType<typeof setup>>, n: number) {
    const body: AttemptBody = { instructionRevision: 1, recipes: ["integrate_base"], role: "code", retryEpoch: 0, retryIndex: 0,
      start: { headOid: head(n), baseOid: BASE, fingerprint: null, sourceIds: [] }, resource: { kind: "spawn", threadId: null, path: `/p/folio-${n}`, hostId: HOST, projectId: PROJECT,
        reason: null, workspace: null }, mode: "spawn", marker: `[Workstreams attempt A-${n} · inkwell/folio#${n} · instruction r1]`, settledAt: START - MINUTE,
      uncertainAt: START - MINUTE, emptyReadbackAt: null, failure: null, error: null, releasedReason: null };
    env.work.claim({ id: `A-${n}`, target: url(n), effortId: env.effort.id, instructionId: `I-${env.effort.id}-r1`, launchKey: `key-${n}`, threadId: null, hostId: HOST,
      path: `/p/folio-${n}`, body });
    env.work.recordAttempt(`A-${n}`, ["launching"], { status: "uncertain", body });
  }
  it("backs a PR GitHub can't read off 1, 2, 4, 8, then 15 minutes, names a system issue after six tries, and reads it again at its poll", async () => {
    const env = await setup([501]);
    env.github.failFor.add(501);
    await env.reconciler.recoverAll();
    const read: number[] = [];
    for (let minute = 0; minute <= 31; minute++) {
      env.at(minute * MINUTE + 1_000);
      const before = env.calls("advanceInspect").length;
      await env.reconciler.tick();
      if (env.calls("advanceInspect").length > before) read.push(minute);
      if (minute !== 0) continue;
      expect(env.row(501)).toMatchObject({ phase: "waiting", dueAt: START + MINUTE + 1_000, body: { cause: "source-unavailable", userState: "waiting" } });
      // An event that makes the row due inside its backoff reads nothing.
      env.at(30_000);
      env.reconciler.due([url(501)]);
      await env.reconciler.tick();
      expect(env.calls("advanceInspect")).toHaveLength(1);
    }
    expect(read).toEqual([0, 1, 3, 7, 15, 30]);
    expect(env.row(501)).toMatchObject({ phase: "repair-needed", body: { cause: "source-unavailable", userState: "issue", recovery: ["refresh N"],
      detail: expect.stringContaining("6 times in a row: GraphQL: Could not resolve to a PullRequest.") } });
    // Once GitHub reads it again, at the issue's poll, the row recovers with no command.
    env.github.failFor.delete(501);
    env.at(45 * MINUTE + 1_000);
    await env.reconciler.tick();
    expect(env.row(501)?.phase).toBe("prepared");
  });

  it("leaves other PRs their full reads while PRs GitHub can't read back off", async () => {
    const unreadable = [501, 502, 503, 504, 505, 506];
    const env = await setup([...unreadable, 599]);
    for (const n of unreadable) env.github.failFor.add(n);
    await env.reconciler.recoverAll();
    for (let tick = 0; tick < 6; tick++) {
      env.at(tick * 15_000 + 1_000);
      await env.reconciler.tick();
    }
    expect(env.row(599)?.phase).toBe("prepared");
    const reads = env.calls("advanceInspect").map((call) => Number(call.input.prUrl.split("/").at(-1)));
    for (const n of unreadable) expect(reads.filter((read) => read === n).length).toBeLessThanOrEqual(2);
  });

  it("reads back an uncertain launch that BB couldn't read after a backoff, and the launch breaker clears once BB reads again", async () => {
    const env = await setup([701, 702, 703], { live: () => conflicting, execution: "on", concurrency: 3 });
    seedUncertain(env, 701);
    seedUncertain(env, 702);
    const unreadable = Promise.reject(new Error("BB is restarting"));
    unreadable.catch(() => undefined);
    env.github.readback = unreadable;
    await env.reconciler.recoverAll();
    for (let minute = 0; minute <= 31; minute++) {
      env.at(minute * MINUTE + 1_000);
      await env.reconciler.tick();
    }
    // Pass 0 and the reads at 0, 2, 6, 14, and 29 minutes failed: a system issue, with the claim held and still read back at its poll.
    expect(env.work.attempt("A-701")).toMatchObject({ status: "uncertain", body: { failure: "source-unavailable", readbackFailures: 6 } });
    expect(env.row(701)).toMatchObject({ phase: "repair-needed", body: { cause: "source-unavailable", userState: "issue", nextAction: "recover-launch",
      recovery: ["recheck launches", "reset N release"] } });
    expect(env.row(703)).toMatchObject({ phase: "waiting", body: { cause: "launch-breaker" } });
    expect(env.spawn).not.toHaveBeenCalled();
    // BB reads again: two empty readbacks a minute apart release both claims, and the breaker lets 703 launch.
    env.github.readback = null;
    for (let minute = 44; minute <= 50; minute++) {
      env.at(minute * MINUTE + 1_000);
      await env.reconciler.tick();
    }
    expect([env.work.attempt("A-701")?.status, env.work.attempt("A-702")?.status]).toEqual(["released", "released"]);
    expect(env.spawn.mock.calls.map(([args]) => args.pluginMetadata.prUrl)).toContain(url(703));
  });

  it("reads a worker's interactions again at its five-minute poll, so an answer no event reported lets the finished turn be read", async () => {
    const env = await setup([801], { live: () => conflicting, execution: "on" });
    await env.reconciler.recoverAll();
    await env.reconciler.tick();
    const [attempt] = env.work.attempts(url(801));
    const threadId = attempt!.threadId!;
    env.pending.set(threadId, [{ id: "int-1" }]);
    await env.harness.emitThreadEvent("interaction.pending", { thread: env.threads.get(threadId)!, interaction: {} as never });
    await settled();
    await env.reconciler.tick();
    expect(env.row(801)).toMatchObject({ phase: "decision-needed", dueAt: START + 5 * MINUTE, body: { cause: "worker-interaction" } });
    // While the plugin was down you answered, and the worker went on working: no event reached us, and the poll finds nothing pending.
    env.pending.delete(threadId);
    env.at(5 * MINUTE + 1_000);
    await env.reconciler.tick();
    expect(env.row(801)).toMatchObject({ phase: "executing", body: { cause: "worker" } });
    // The worker finished with its report, and again no event reached us: the executing poll reads the turn.
    env.set(801, { ...ready(801), headOid: head(801, 1) });
    env.outputs.set(threadId, result(attempt!.id, 801, head(801, 1)));
    env.threads.set(threadId, { ...env.threads.get(threadId)!, status: "idle" });
    env.at(10 * MINUTE + 2_000);
    await env.reconciler.tick();
    expect(env.work.attempt(attempt!.id)).toMatchObject({ status: "completed", body: { interactionPending: false, report: { key: "changed" } } });
    expect(env.work.claimOn(url(801), null)).toBeNull();
    expect(env.row(801)?.phase).toBe("prepared");
  });

  it("settles a wait on a PR the worker reported blocking once that PR merges, though it is on no roster", async () => {
    const env = await setup([330], { live: () => conflicting, execution: "on", parents: [291] });
    await env.reconciler.recoverAll();
    await env.reconciler.tick();
    const [attempt] = env.work.attempts(url(330));
    await env.finish(attempt!.threadId!, `Workstreams result v1: ${JSON.stringify({ attemptId: attempt!.id, target: url(330), actions: ["integrate_base"], outcome: "blocked",
      headOid: head(330), baseOid: BASE, blockers: [{ kind: "dependency", summary: "Needs the shelf index from #291", prUrl: url(291) }] })}`);
    await env.reconciler.tick();
    expect(env.row(330)).toMatchObject({ phase: "waiting", body: { cause: "dependency", owner: { kind: "pr", ref: url(291) } } });
    env.set(291, { state: "MERGED" });
    // The blocked row's own poll is five minutes away; the PR it waits on is watched every tick.
    env.at(MINUTE + 1_000);
    await env.reconciler.tick();
    expect(env.calls("advanceInspect").map((call) => call.input.prUrl)).toContain(url(291));
    expect(env.row(330)?.body.cause).not.toBe("dependency");
    expect(env.work.attempts(url(330))).toHaveLength(2);
  });

  it("asks BB to retry no failed turn once v2 execution is back to a dry run, and shows the retry as a plan", async () => {
    const env = await setup([401], { live: () => conflicting, execution: "on" });
    await env.reconciler.recoverAll();
    await env.reconciler.tick();
    const [attempt] = env.work.attempts(url(401));
    await env.harness.setSettings({ v2Execution: "dry-run" });
    await env.harness.emitThreadEvent("turn.failed", failed(attempt!.threadId!, "req-1"));
    await settled();
    await env.reconciler.tick();
    expect(env.retry).not.toHaveBeenCalled();
    expect(env.row(401)).toMatchObject({ phase: "repair-needed", body: { cause: "turn-retry", userState: "waiting", modifiers: ["recovering", "plan only"] } });
  });

  it("ends an attempt whose turn failed past its retries, so retry N launches a new one", async () => {
    const env = await setup([601], { live: () => conflicting, execution: "on" });
    await env.reconciler.recoverAll();
    await env.reconciler.tick();
    const [attempt] = env.work.attempts(url(601));
    for (let failure = 1; failure <= 3; failure++) {
      await env.harness.emitThreadEvent("turn.failed", failed(attempt!.threadId!, `req-${failure}`));
      await settled();
      env.at(failure * 3 * MINUTE);
      await env.reconciler.tick();
    }
    expect(env.retry).toHaveBeenCalledTimes(2);
    expect(env.work.attempt(attempt!.id)).toMatchObject({ status: "failed", body: { failure: "turn-failed" } });
    expect(env.row(601)).toMatchObject({ phase: "repair-needed", body: { cause: "turn-failed", userState: "issue", recovery: ["retry N"] } });
    expect(await say(env, "retry 1", "req-retry")).toMatchObject({ kind: "admit" });
    env.at(10 * MINUTE);
    await env.reconciler.tick();
    expect(env.work.attempts(url(601))).toHaveLength(2);
    expect(env.work.attempts(url(601))[0]).toMatchObject({ status: "running", body: { retryEpoch: 1 } });
  });

  it("never takes a report on a cancelled instruction's c1 as proof of a new instruction's c1", async () => {
    const env = await setup([901], { live: () => conflicting, execution: "on" });
    expect(await say(env, "done when 1: returned books keep their shelf order", "req-2")).toMatchObject({ kind: "admit" });
    await env.reconciler.recoverAll();
    await env.reconciler.tick();
    const [attempt] = env.work.attempts(url(901));
    env.set(901, { ...ready(901), headOid: head(901, 1) });
    await env.finish(attempt!.threadId!, `Workstreams result v1: ${JSON.stringify({ attemptId: attempt!.id, target: url(901), actions: ["integrate_base"], outcome: "changed",
      headOid: head(901, 1), baseOid: BASE, criteria: [{ id: "c1", outcome: "passed", evidence: "npm test -- shelf passed" }] })}`);
    await env.reconciler.tick();
    expect(env.row(901)?.phase).toBe("prepared");
    for (const [text, requestId] of [["cancel", "req-3"], ["move 1 forward", "req-4"], ["done when 1: the audit log records every checkout", "req-5"]])
      expect(await say(env, text!, requestId!)).toMatchObject({ kind: "admit" });
    env.at(3 * MINUTE);
    env.reconciler.due([url(901)]);
    await env.reconciler.tick();
    // The new c1 is unproven, so the worker is asked to validate it.
    expect(env.row(901)?.phase).not.toBe("prepared");
    expect(env.work.attempts(url(901))[0]).toMatchObject({ body: { recipes: ["validate_criteria"] } });
  });
});

describe("the v2 reconciler's code actions", () => {
  /** Changes were requested and followed up; ada asked for changes, bea's approval was dismissed, cy approved, and dee is already requested again. */
  const followedUp = (): Partial<Live> => ({ reviewDecision: "CHANGES_REQUESTED", reviewFollowupPosted: true, mergeStateStatus: "BLOCKED", reviewRequests: ["dee"],
    latestReviews: [{ login: "ada", state: "CHANGES_REQUESTED" }, { login: "bea", state: "DISMISSED" }, { login: "cy", state: "APPROVED" }, { login: "dee", state: "CHANGES_REQUESTED" }] });
  const writes = (env: Awaited<ReturnType<typeof setup>>) => env.calls("prWrite").map((call) => call.input);

  it("re-requests review only from reviewers who asked for changes or whose approval was dismissed, skips those already requested, posts no comment, and runs once per head", async () => {
    const env = await setup([711], { live: followedUp, execution: "on" });
    await env.reconciler.recoverAll();
    await env.reconciler.tick();
    expect(writes(env)).toEqual([{ kind: "nudge", prUrl: url(711), reviewers: ["ada", "bea"], comment: null }]);
    expect(env.row(711)).toMatchObject({ phase: "waiting", body: { cause: "review", codeActions: [{ recipe: "request_rereview", headOid: head(711), status: "done", tries: 1 }] } });
    // Someone takes ada's request off again: this head already had its re-request, so v2 doesn't repeat it.
    env.set(711, { reviewRequests: ["dee", "bea"] });
    env.at(16 * MINUTE);
    env.reconciler.due([url(711)]);
    await env.reconciler.tick();
    expect(writes(env)).toHaveLength(1);
    // A new head is new work to review: its re-request runs once.
    env.set(711, { headOid: head(711, 1) });
    env.at(32 * MINUTE);
    env.reconciler.due([url(711)]);
    await env.reconciler.tick();
    expect(writes(env)).toEqual([expect.anything(), { kind: "nudge", prUrl: url(711), reviewers: ["ada"], comment: null }]);
  });

  it("requests review and marks a draft ready only once a command grants each, never on its own", async () => {
    const env = await setup([721, 722], { live: (n) => n === 721 ? { isDraft: true, reviewDecision: null, mergeStateStatus: "DRAFT" }
      : { reviewDecision: null, mergeStateStatus: "BLOCKED" }, execution: "on" });
    await env.reconciler.recoverAll();
    await env.reconciler.tick();
    expect([env.row(721)?.body.decision?.subkind, env.row(722)?.body.decision?.subkind]).toEqual(["mark-ready", "request-review"]);
    expect(writes(env)).toEqual([]);
    const [draft, open] = [env.row(721)!.body.n, env.row(722)!.body.n];
    expect(await say(env, `mark ${draft} ready`, "req-ready")).toMatchObject({ kind: "admit" });
    expect(await say(env, `request review ${open} from @ada`, "req-review")).toMatchObject({ kind: "admit" });
    await env.reconciler.tick();
    expect(writes(env)).toEqual([{ kind: "ready", prUrl: url(721), headOid: head(721) }, { kind: "nudge", prUrl: url(722), reviewers: ["ada"], comment: null }]);
  });

  it("reruns failed checks once on a head after a worker reports an environment blocker, and a second failure on that head is a CI issue", async () => {
    const env = await setup([731], { live: () => ({ checks: "failed", mergeStateStatus: "BLOCKED" }), execution: "on" });
    await env.reconciler.recoverAll();
    await env.reconciler.tick();
    const [attempt] = env.work.attempts(url(731));
    expect(attempt?.body.recipes).toEqual(["fix_failing_checks"]);
    await env.finish(attempt!.threadId!, `Workstreams result v1: ${JSON.stringify({ attemptId: attempt!.id, target: url(731), actions: ["fix_failing_checks"], outcome: "blocked",
      headOid: head(731), baseOid: BASE, blockers: [{ kind: "environment", summary: "The shelf index runner lost its cache", checks: ["ci/shelf-index"] }] })}`);
    await env.reconciler.tick();
    await env.reconciler.tick();
    expect(writes(env)).toEqual([{ kind: "rerun-failed", prUrl: url(731), headOid: head(731) }]);
    expect(env.row(731)).toMatchObject({ phase: "waiting", body: { cause: "ci" } });
    env.set(731, { checks: "failed" });
    env.at(2 * MINUTE + 1_000);
    await env.reconciler.tick();
    expect(env.row(731)).toMatchObject({ phase: "repair-needed", body: { cause: "ci-infrastructure", userState: "issue", recovery: ["retry N"] } });
    expect(writes(env)).toHaveLength(1);
    expect(env.spawn).toHaveBeenCalledTimes(1);
  });

  it("writes the action key into the row before the GitHub write, and reads GitHub back after an unclear answer instead of writing blind", async () => {
    const env = await setup([741, 742], { live: followedUp, execution: "on" });
    const atWrite: unknown[] = [];
    // 741's request lands but its answer is lost; 742's never reaches GitHub.
    env.github.write = (request) => {
      atWrite.push(env.work.row(request.prUrl)?.body.codeActions?.[0]);
      return { lands: request.prUrl === url(741), answer: new Error("socket hang up") };
    };
    await env.reconciler.recoverAll();
    await env.reconciler.tick();
    expect(atWrite).toEqual([741, 742].map((n) => expect.objectContaining({ recipe: "request_rereview", headOid: head(n), retryEpoch: 0, status: "pending" })));
    const methods = env.hostCalls.map((call) => call.method);
    expect(methods.lastIndexOf("prReviewers")).toBeGreaterThan(methods.lastIndexOf("prWrite"));
    expect(env.row(741)?.body.codeActions?.[0]).toMatchObject({ status: "done", tries: 1 });
    // 742 stays pending, and its row says GitHub's answer is being read back.
    expect(env.row(742)).toMatchObject({ phase: "executing", body: { cause: "code-action", userState: "doing", codeActions: [{ status: "pending", tries: 1 }] } });
    env.github.write = null;
    env.at(5 * MINUTE + 1_000);
    await env.reconciler.tick();
    expect(writes(env).map((request) => request.prUrl)).toEqual([url(741), url(742), url(742)]);
    expect(env.row(742)?.body.codeActions?.[0]).toMatchObject({ status: "done", tries: 2 });
  });

  it("reads a ready mark or a rerun back before writing it again after an unclear answer, and writes it once when GitHub shows it landed", async () => {
    // GitHub shows each write only after the read that follows it: the write's answer is lost, and the first read back still shows the PR as it was.
    const lost = () => ({ lands: false, answer: new Error("socket hang up") });
    const draft = await setup([791], { live: () => ({ isDraft: true, reviewDecision: null, mergeStateStatus: "DRAFT" }), execution: "on" });
    draft.github.write = lost;
    await draft.reconciler.recoverAll();
    await draft.reconciler.tick();
    expect(await say(draft, `mark ${draft.row(791)!.body.n} ready`, "req-ready")).toMatchObject({ kind: "admit" });
    await draft.reconciler.tick();
    expect(draft.row(791)?.body.codeActions?.[0]).toMatchObject({ recipe: "mark_ready_for_review", status: "pending", tries: 1 });
    draft.set(791, { isDraft: false });
    draft.reconciler.due([url(791)]);
    await draft.reconciler.tick();
    expect(writes(draft)).toEqual([{ kind: "ready", prUrl: url(791), headOid: head(791) }]);
    expect(draft.row(791)?.body.codeActions?.[0]).toMatchObject({ status: "done", tries: 1, detail: "GitHub shows the PR ready for review" });

    const failing = await setup([792], { live: () => ({ checks: "failed", mergeStateStatus: "BLOCKED" }), execution: "on" });
    failing.github.write = lost;
    await failing.reconciler.recoverAll();
    await failing.reconciler.tick();
    const [attempt] = failing.work.attempts(url(792));
    await failing.finish(attempt!.threadId!, `Workstreams result v1: ${JSON.stringify({ attemptId: attempt!.id, target: url(792), actions: ["fix_failing_checks"],
      outcome: "blocked", headOid: head(792), baseOid: BASE, blockers: [{ kind: "environment", summary: "The shelf index runner lost its cache", checks: ["ci/shelf-index"] }] })}`);
    await failing.reconciler.tick();
    await failing.reconciler.tick();
    expect(failing.row(792)?.body.codeActions?.[0]).toMatchObject({ recipe: "rerun_failed_checks", status: "pending", tries: 1 });
    failing.set(792, { checks: "pending" });
    failing.reconciler.due([url(792)]);
    await failing.reconciler.tick();
    expect(writes(failing)).toEqual([{ kind: "rerun-failed", prUrl: url(792), headOid: head(792) }]);
    expect(failing.row(792)?.body.codeActions?.[0]).toMatchObject({ status: "done", tries: 1, detail: "GitHub shows the failed checks running again" });
  });

  it("writes nothing to GitHub for a code action whose row was held on the board after the pass planned it", async () => {
    const env = await setup([793], { live: followedUp, execution: "on" });
    // The board's hold changes no v2 row, so only planning the row again before its key is written can see it.
    const code = env.runner.code;
    env.runner.code = async (run) => {
      createPrHoldStore(env.db).set(url(793), true, "Waiting on the shelf audit");
      return code(run);
    };
    await env.reconciler.recoverAll();
    await env.reconciler.tick();
    expect([writes(env), env.row(793)?.body.codeActions]).toEqual([[], undefined]);
    env.runner.code = code;
    await env.reconciler.tick();
    expect(env.row(793)).toMatchObject({ phase: "paused", body: { cause: "hold" } });
    expect(writes(env)).toEqual([]);
  });

  it("checks a pending code action again before it writes a second time, so a hold after the pass stops the retry too", async () => {
    const env = await setup([794], { live: followedUp, execution: "on" });
    env.github.write = () => ({ lands: false, answer: new Error("socket hang up") });
    await env.reconciler.recoverAll();
    await env.reconciler.tick();
    expect(env.row(794)?.body.codeActions?.[0]).toMatchObject({ status: "pending", tries: 1 });
    env.github.write = null;
    // You hold the PR after the pass planned the retry, and before it runs.
    const code = env.runner.code;
    env.runner.code = async (run) => {
      env.runner.code = code;
      expect(await say(env, `hold ${env.row(794)!.body.n}`, "req-hold")).toMatchObject({ kind: "admit" });
      return code(run);
    };
    env.at(5 * MINUTE + 1_000);
    await env.reconciler.tick();
    expect(writes(env)).toHaveLength(1);
    expect(env.row(794)).toMatchObject({ phase: "paused", body: { cause: "hold", codeActions: [{ status: "pending", tries: 1 }] } });
  });

  it("counts a review-request read GitHub can't answer as a try and names it an issue after six, and waits out a rate limit on that read", async () => {
    const env = await setup([795, 796], { live: followedUp, execution: "on" });
    env.github.resetAt = START + 20 * MINUTE;
    env.github.reviewersFail.set(795, "HTTP 502: Bad Gateway");
    env.github.reviewersFail.set(796, "API rate limit exceeded for user ID 1001.");
    await env.reconciler.recoverAll();
    await env.reconciler.tick();
    expect(env.row(795)?.body.codeActions?.[0]).toMatchObject({ status: "pending", tries: 1, detail: expect.stringContaining("HTTP 502") });
    expect(env.row(796)).toMatchObject({ phase: "waiting", dueAt: START + 20 * MINUTE + 30_000, body: { cause: "rate-limit", userState: "waiting" } });
    for (let poll = 1; poll <= 5; poll++) {
      env.at(poll * 5 * MINUTE + 1_000);
      await env.reconciler.tick();
    }
    expect(env.row(795)).toMatchObject({ phase: "repair-needed", body: { cause: "github-write", userState: "issue", recovery: ["retry N"],
      detail: expect.stringContaining("stayed unclear through 6 tries: GitHub couldn't read whom review is requested from: HTTP 502: Bad Gateway") } });
    expect(writes(env)).toEqual([]);
    expect(env.db.prepare(`SELECT count(*) AS count FROM effort_transitions WHERE target = ? AND to_phase = 'repair-needed'`).get(url(796))).toEqual({ count: 0 });
  });

  it("makes no GitHub write and reads no reviewer in a dry run, and shows the code action as a plan", async () => {
    const env = await setup([751], { live: followedUp });
    await env.reconciler.recoverAll();
    await env.reconciler.tick();
    expect(env.row(751)).toMatchObject({ phase: "queued", body: { cause: "code-action", nextAction: ["request_rereview"], userState: "waiting", modifiers: ["plan only"] } });
    expect([env.calls("prWrite"), env.calls("prReviewers"), env.row(751)?.body.codeActions]).toEqual([[], [], undefined]);
  });

  it("waits out a rate-limited write until GitHub's reset, and names a refused write as a system issue that retry N runs again", async () => {
    const env = await setup([761, 762], { live: followedUp, execution: "on" });
    env.github.resetAt = START + 20 * MINUTE;
    env.github.write = (request) => ({ lands: false, answer: { ok: false, error: request.prUrl === url(761) ? "Re-requesting review failed: API rate limit exceeded for user ID 1001."
      : "Re-requesting review failed: HTTP 422: Reviews may only be requested from collaborators." } });
    await env.reconciler.recoverAll();
    await env.reconciler.tick();
    expect(env.row(761)).toMatchObject({ phase: "waiting", dueAt: START + 20 * MINUTE + 30_000, body: { cause: "rate-limit", userState: "waiting" } });
    expect(env.row(762)).toMatchObject({ phase: "repair-needed", body: { cause: "github-write", userState: "issue", recovery: ["retry N"],
      detail: expect.stringContaining("only be requested from collaborators") } });
    env.github.write = null;
    env.at(20 * MINUTE + 31_000);
    await env.reconciler.tick();
    await env.reconciler.tick();
    expect(env.row(761)?.body.codeActions?.[0]).toMatchObject({ status: "done" });
    expect(env.db.prepare(`SELECT count(*) AS count FROM effort_transitions WHERE target = ? AND to_phase = 'repair-needed'`).get(url(761))).toEqual({ count: 0 });
    expect(await say(env, `retry ${env.row(762)!.body.n}`, "req-retry")).toMatchObject({ kind: "admit" });
    await env.reconciler.tick();
    await env.reconciler.tick();
    expect(env.row(762)?.body.codeActions?.[0]).toMatchObject({ retryEpoch: 1, status: "done" });
    expect(writes(env).filter((request) => request.prUrl === url(762))).toHaveLength(2);
  });
});
