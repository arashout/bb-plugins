// The v2 reconciler, the `effort-v2` background service: the one v2 scheduler.
// Events only mark rows due; each tick reads GitHub within its budgets, plans
// the due rows, and launches or takes an attempt's next step. Mechanics move
// without a stoppage and without the UI. Every SDK and host call is a test
// double; fixtures are in the fictional Inkwell domain.
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdvanceFacts } from "./advance-contract.js";
import type { RawUnit } from "./contract.js";
import type { EffortRoster } from "./effort-roster.js";
import type { createEffortRunner } from "./effort-runner.js";
import { createEffortStore } from "./effort-store.js";
import type { createEffortV2, EffortCommandResult } from "./effort-v2-server.js";
import { createEffortWorkStore, type AttemptBody } from "./effort-work-store.js";
import { parsePrList } from "./gh.js";
import { createPrHoldStore } from "./pr-hold-store.js";
import type { RunDb } from "./runstore.js";
import plugin, { type Board } from "./server.js";

const runners = vi.hoisted(() => [] as ReturnType<typeof createEffortRunner>[]);
/** Each runner's dependencies, so a test can hold two instances at the same point. */
const runnerDeps = vi.hoisted(() => [] as Parameters<typeof createEffortRunner>[0][]);
vi.mock("./effort-runner.js", async (original) => {
  const actual = await original<typeof import("./effort-runner.js")>();
  return { ...actual, createEffortRunner: (deps: Parameters<typeof actual.createEffortRunner>[0]) => {
    const runner = actual.createEffortRunner(deps);
    runners.push(runner);
    runnerDeps.push(deps);
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
  latestReviews: { login: string; state: string }[]; reviewFollowupPosted?: boolean; approvalFeedback?: AdvanceFacts["approvalFeedback"];
  reviewFeedback?: AdvanceFacts["reviewFeedback"] };
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
  unresolvedThreads: live.unresolvedThreads, threadsComplete: true, reviewFeedback: live.reviewFeedback ?? { openThreads: 0, comment: null, repliedAt: null, noteAt: null, followUpAt: null }, checks: live.checks, basePrNumber: live.basePrNumber,
  ...live.reviewFollowupPosted === undefined ? {} : { reviewFollowupPosted: live.reviewFollowupPosted },
  approvalFeedback: live.approvalFeedback ?? { status: "none", fingerprint: null, sourceIds: [] } });
/** BB's turn.failed for a worker's turn, with no rate limit to wait out. */
const failed = (threadId: string, requestId: string) => ({ threadId, requestId, turnId: null, errorInfo: null, inputAccepted: true, rateLimits: null, attemptNumber: 1 }) as never;
/** Let the event hooks record their signals and mark rows due. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 10));
/** A call whose answer never comes: the process stopped, or restarted, while it waited. */
const never = () => new Promise<never>(() => {});
const result = (attemptId: string, n: number, headOid: string) =>
  `Workstreams result v1: ${JSON.stringify({ attemptId, target: url(n), actions: ["integrate_base"], outcome: "changed", headOid, baseOid: BASE })}`;

/** A legacy Advance job on this PR, by default one that launched with an outcome no one confirmed; its batch loads when the plugin restarts. */
function saveLegacyJob(db: RunDb, n: number, patch: Record<string, unknown> = {}): string {
  const id = `00000000-0000-4000-8000-000000000${n}`;
  const jobId = `00000000-0000-4000-8000-000000001${n}`;
  const routing = { ...full(n, ready(n)), eligible: true, workspace: "create", projectId: PROJECT, hostId: HOST, sourcePath: `/p/folio-${n}`, path: `/p/folio-${n}`,
    effortId: null, effortKey: null, effortMembers: null, needsFeedback: false, needsChecks: false, blockedBy: null };
  const job = { ...routing, id: jobId, hiddenFromProgress: false, status: "running", attemptId: null, dedicated: false, previousAttempts: [], threadId: null,
    checkedHeadOid: null, updatedAt: START - 10 * MINUTE, uncertain: true, ...patch };
  db.prepare("INSERT INTO advance_batches (id, body) VALUES (?, ?)").run(id, JSON.stringify({ id, token: `00000000-0000-4000-8000-000000002${n}`,
    createdAt: START - 10 * MINUTE, cancelled: false, jobs: [job], facts: { [jobId]: routing }, pollUntil: START + MINUTE, prepared: {}, repairs: {} }));
  return jobId;
}

const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(START); });
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.useRealTimers(); });

/** `others` are open PRs on the board that no effort owns. */
type Options = { live?: (n: number) => Partial<Live>; parents?: number[]; others?: number[]; execution?: "dry-run" | "on"; concurrency?: number };
/** An effort on its v2 roster, "Shelving entry", owning these PRs, each checked out on the primary host, instructed to move all forward. */
async function setup(numbers: number[], options: Options = {}) {
  const lives = new Map([...numbers, ...options.parents ?? [], ...options.others ?? []].map((n) => [n, { ...ready(n), ...options.live?.(n) }]));
  const github = { fullError: null as string | null, resetAt: null as number | null, readback: null as Promise<void> | null,
    /** PRs whose full read fails for a reason other than a rate limit. */
    failFor: new Set<number>(),
    /** Runs while a pass reads a launch's checkout, between planning the row and committing it; the read waits for what it returns. */
    duringCheckoutRead: null as (() => void | Promise<void>) | null,
    /** A full read of a PR it names never answers, as when the process stops while GitHub is read. */
    fullHangs: null as ((n: number) => boolean) | null,
    /**
     * Whether one write lands on GitHub, and what the host answers (an Error is a call that never answered, and `never` one the process
     * stopped waiting for); by default it lands and succeeds.
     */
    write: null as ((request: { kind: string; prUrl: string }) => { lands: boolean; answer: { ok: true; detail: string } | { ok: false; error: string } | Error | "never" }) | null,
    /** PRs whose review requests the host can't read, with the error it answers. */
    reviewersFail: new Map<number, string>(),
    /** Heads whose failed checks GitHub reran. */
    reran: [] as string[] };
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
  /** BB can't confirm the interrupt of a running turn at once: the thread stays stopping until the test lets its turn end. A thread that reads idle stays idle. */
  const stop = vi.fn(async ({ threadId }: { threadId: string }) => {
    const thread = threads.get(threadId)!;
    if (thread.status === "active") threads.set(threadId, { ...thread, status: "stopping" });
    return { ok: true } as never;
  });
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
      stop: stop as never,
    },
  }, experimental_callHostRpc: async ({ method, input }) => {
    hostCalls.push({ method, input });
    const number = (prUrl: string) => Number(prUrl.split("/").at(-1));
    const open = () => [...numbers, ...options.others ?? []].filter((n) => lives.get(n)!.state === "OPEN");
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
      if (github.fullHangs?.(n)) return never();
      if (github.fullError || github.failFor.has(n)) return { ok: false, error: github.fullError ?? "GraphQL: Could not resolve to a PullRequest." };
      return { ok: true, facts: full(n, lives.get(n)!) };
    }
    if (method === "inspectCheckout") {
      await github.duringCheckoutRead?.();
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
      // The host reruns a head's failed checks once, whoever asks: it finds a run already rerun and reruns nothing.
      if (lands && request.kind === "rerun-failed" && !github.reran.includes(live.headOid)) {
        github.reran.push(live.headOid);
        live.checks = "pending";
      }
      if (answer === "never") return never();
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
    bb, harness, db, work, effort, admitted, reconciler, runner: runners.at(-1)!, spawn, send, threads, metadata, hostCalls, github, lives, retry, stop, pending, outputs, requests,
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

  it("looks at an uncertain legacy Advance job holding a PR every ten minutes, at most six times, then names it a system issue", async () => {
    // 311 needs its base integrated, which the legacy job may still be doing. Advance no longer runs, so nothing settles it.
    const env = await setup([311], { live: () => conflicting });
    saveLegacyJob(env.db, 311);
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
    // It isn't looked at again inside ten minutes: it waits for its poll.
    env.at(MINUTE);
    await reconciler.tick();
    expect(rechecks()).toBe(1);
    expect(work.row(url(311))?.dueAt).toBe(START + 10 * MINUTE);
    for (let tick = 1; tick <= 6; tick++) {
      env.at(MINUTE + tick * 11 * MINUTE);
      await reconciler.tick();
      expect(rechecks()).toBe(Math.min(tick + 1, 6));
    }
    expect(work.row(url(311))).toMatchObject({ phase: "repair-needed", body: { cause: "legacy-uncertain", userState: "issue", recovery: ["retry N"] } });
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

  it("confirms with a full read a roster row Done only because a legacy job saw it merge, names a read that fails, and reads it no more once GitHub agrees", async () => {
    // 352 merged without the board ever listing it; only its legacy Advance job saw that. Another effort, not on v2, names it.
    const env = await setup([351], { others: [352], live: (n) => n === 352 ? { state: "MERGED" } : {} });
    const returns = createEffortStore(env.db).establish({ sourceKey: "returns-desk", name: "Returns desk", goal: "Take returns at the desk", projectId: PROJECT,
      coordinatorState: "none", members: { tickets: [], prUrls: [url(352)] } });
    saveLegacyJob(env.db, 352, { status: "merged", uncertain: false });
    const next = await restart(env);
    const row = async () => (await next.harness.callRpc("effort_roster_get", { effortId: returns.id }) as EffortRoster).rows[0];
    const reads = () => env.calls("advanceInspect").filter((call) => call.input.prUrl === url(352)).length;
    expect(await row()).toMatchObject({ state: "done", cause: "merged", label: "Merged when legacy Advance last read it; confirming with GitHub" });
    // The roster read only asked; the next tick reads GitHub.
    expect(reads()).toBe(0);
    env.github.failFor.add(352);
    await next.reconciler.tick();
    expect(reads()).toBe(1);
    // The row says the read failed rather than that it is still confirming, and the read is tried again after its backoff.
    expect(await row()).toMatchObject({ state: "done", cause: "merged", label: "Merged when legacy Advance last read it; GitHub read failed", failedAt: START });
    env.github.failFor.delete(352);
    env.at(MINUTE);
    await next.reconciler.tick();
    expect(reads()).toBe(2);
    expect(await row()).toMatchObject({ state: "done", cause: "merged", label: "Merged" });
    env.at(10 * MINUTE);
    await next.reconciler.tick();
    expect(reads()).toBe(2);
  });

  it("confirms a legacy job's word only with the full reads the due rows leave", async () => {
    // Legacy Advance alone saw 361–364 merge. 360 is due with no full read yet, and it decides its next step on one.
    const settled = [361, 362, 363, 364];
    const env = await setup([360], { others: settled, live: (n) => n === 360 ? {} : { state: "MERGED" } });
    const returns = createEffortStore(env.db).establish({ sourceKey: "returns-desk", name: "Returns desk", goal: "Take returns at the desk", projectId: PROJECT,
      coordinatorState: "none", members: { tickets: [], prUrls: settled.map(url) } });
    for (const n of settled) saveLegacyJob(env.db, n, { status: "merged", uncertain: false });
    const next = await restart(env);
    await next.harness.callRpc("effort_roster_get", { effortId: returns.id });
    const reads = (n: number) => env.calls("advanceInspect").filter((call) => call.input.prUrl === url(n)).length;
    const before = reads(360);
    await next.reconciler.recoverAll();
    await next.reconciler.tick();
    // 360 takes the first of the minute's four full reads; the confirmations share the other three, and the last waits a tick.
    expect([reads(360) - before, ...settled.map(reads)]).toEqual([1, 1, 1, 1, 0]);
    expect(next.row(360)?.phase).toBe("prepared");
    env.at(MINUTE + 1_000);
    await next.reconciler.tick();
    expect(settled.map(reads)).toEqual([1, 1, 1, 1]);
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

  it("labels a member its instruction let go, and one whose row another effort holds, as not in the instruction, and no card once the effort leaves v2", async () => {
    const env = await setup([353, 354], { live: () => ({ checks: "pending", mergeStateStatus: "BLOCKED" }), others: [356] });
    await env.reconciler.recoverAll();
    await env.reconciler.tick();
    // Returns desk's instruction takes 356 from outside membership; then the PR's membership moves to Shelving entry.
    const efforts = createEffortStore(env.db);
    const desk = efforts.establish({ sourceKey: "returns-desk", name: "Returns desk", goal: "Clear the returns desk", projectId: PROJECT, coordinatorState: "none",
      members: { tickets: [], prUrls: [] } });
    env.work.setMode(desk.id, "v2", 0, () => []);
    const roster = await env.harness.callRpc("effort_roster_get", { effortId: desk.id }) as EffortRoster;
    expect(await env.harness.callRpc("effort_command", { effortId: desk.id, snapshotId: roster.snapshotId, text: `move ${url(356)} forward`, requestId: "req-desk",
      source: "panel" })).toMatchObject({ kind: "admit" });
    efforts.transfer(env.effort.key, { tickets: [], prUrls: [url(356)] });
    expect((await env.harness.runCli(["refresh"])).exitCode).toBe(0);
    expect(await say(env, `drop ${env.row(354)!.body.n}`, "req-drop")).toMatchObject({ kind: "admit" });
    expect([env.row(354)?.phase, env.row(356)?.effortId]).toEqual(["finished", desk.id]);
    const managed = async () => (await env.harness.callRpc("board_get", null) as Board).v2Managed;
    const shelving = { effortId: env.effort.id, effortName: "Shelving entry" };
    // The roster reads each the same way: 354 keeps its number, and 356 has none in Shelving entry, which never numbered it.
    expect(await managed()).toEqual({ [url(353)]: { ...shelving, n: 1, state: "waiting", owner: "ci", modifiers: [] },
      [url(354)]: { ...shelving, n: 2, state: "not-in-instruction", owner: null, modifiers: [] },
      [url(356)]: { ...shelving, n: null, state: "not-in-instruction", owner: null, modifiers: [] } });
    const rows = (await env.harness.callRpc("effort_roster_get", { effortId: env.effort.id }) as EffortRoster).rows;
    expect(rows.filter((row) => row.target !== url(353)).map((row) => [row.target, row.state])).toEqual([[url(354), "not-in-instruction"], [url(356), "not-in-instruction"]]);
    // Leaving v2 lifts Shelving entry's fences, though 353's row holds its PR until it pauses: that card is a legacy card again. 356's row is
    // Returns desk's, which fences it now.
    env.work.setMode(env.effort.id, "legacy", 1, () => []);
    expect(await managed()).toEqual({ [url(356)]: expect.objectContaining({ effortId: desk.id, effortName: "Returns desk" }) });
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

describe("the v2 reconciler's bounded repairs", () => {
  const fingerprint = "e".repeat(64);
  /** GitHub shows the PR's review feedback, which this fingerprint names. */
  const feedback = (n: number) => ({ status: "present" as const, fingerprint, sourceIds: [`review:${n}`] });
  /**
   * A settled legacy Advance job on each PR, whose worker's last output reports its feedback fixed on `reportHead` in the older field names
   * legacy Advance rejected. The plugin restarts, so the jobs' batches load.
   */
  async function legacyReports(env: Awaited<ReturnType<typeof setup>>, numbers: number[], reportHead: (n: number) => string) {
    for (const n of numbers) {
      const threadId = `thr-legacy-${n}`;
      saveLegacyJob(env.db, n, { status: "needs-attention", uncertain: false, threadId, attemptId: `L-${n}`,
        detail: "Requested work was not confirmed. GitHub: Approval feedback needs verified follow-up." });
      env.threads.set(threadId, { ...makeThreadResponse({ id: threadId, projectId: PROJECT, providerId: "codex", status: "idle", originPluginId: "workstreams" }),
        environment: { hostId: HOST, path: `/p/folio-${n}`, branchName: null } });
      const evidence = { attemptId: `L-${n}`, finalHeadOid: reportHead(n), approvalFeedbackFingerprint: fingerprint, blockers: [],
        findings: [{ sourceId: `review:${n}`, resolution: "fixed", evidence: "Returned books keep their shelf order after a reload", validation: { outcome: "passed", detail: "npm test -- shelf" } }] };
      env.outputs.set(threadId, `Kept shelf order on reload.\nWorkstreams approval feedback evidence: ${JSON.stringify(evidence)}\nWorkstreams job L-${n} complete: prepared`);
    }
    const restarted = await env.harness.lifecycle.reload(plugin);
    cleanups.push(() => restarted.harness.lifecycle.dispose());
    return { restarted, work: createEffortWorkStore(restarted.bb.storage.database()), reconciler: reconcilers.at(-1)! };
  }

  it("asks the worker's own thread to re-emit its report at most twice, then names an issue; retry N starts one new epoch per command and keeps the history", async () => {
    const env = await setup([801], { live: () => conflicting, execution: "on" });
    await env.reconciler.recoverAll();
    await env.reconciler.tick();
    const [work] = env.work.attempts(url(801));
    // Three turns in a row end in prose with no result line: the work, then two corrections in the same thread.
    for (let round = 1; round <= 3; round++) {
      env.at(round * MINUTE);
      await env.finish(work!.threadId!, "Rebased onto main and pushed. Ready to merge.");
      await env.reconciler.tick();
      await env.reconciler.tick();
    }
    expect(env.spawn).toHaveBeenCalledTimes(1);
    expect(env.send.mock.calls.map(([args]) => args.threadId)).toEqual([work!.threadId, work!.threadId]);
    expect(env.work.attempts(url(801)).map((attempt) => attempt.body.recipes)).toEqual([["repair_report"], ["repair_report"], ["integrate_base"]]);
    expect(env.row(801)).toMatchObject({ phase: "repair-needed", body: { cause: "report-unrepairable", userState: "issue", recovery: ["retry N"],
      detail: "The worker's report still can't be read after 2 corrections in its thread" } });
    const exhausted = env.db.prepare(`SELECT count(*) AS count FROM effort_transitions WHERE target = ?`).get(url(801)) as { count: number };
    // retry N starts a new epoch, so the same work on the same head launches again under a new key; a repeated request changes nothing more.
    const n = env.row(801)!.body.n;
    const first = await say(env, `retry ${n}`, "req-retry");
    expect(first).toMatchObject({ kind: "admit" });
    expect(await say(env, `retry ${n}`, "req-retry")).toEqual(first);
    expect(env.row(801)?.body.retryEpoch).toBe(1);
    env.at(4 * MINUTE);
    await env.reconciler.tick();
    const attempts = env.work.attempts(url(801));
    expect(attempts.map((attempt) => [attempt.body.recipes, attempt.body.retryEpoch])).toEqual([[["integrate_base"], 1], [["repair_report"], 0], [["repair_report"], 0], [["integrate_base"], 0]]);
    expect(attempts[0]!.launchKey).not.toBe(attempts[3]!.launchKey);
    // The exhausted repair's history stays: every attempt, and every transition that led to it.
    expect((env.db.prepare(`SELECT count(*) AS count FROM effort_transitions WHERE target = ?`).get(url(801)) as { count: number }).count).toBeGreaterThan(exhausted.count);
    expect(env.db.prepare(`SELECT count(*) AS count FROM effort_transitions WHERE target = ? AND cause = 'report-unrepairable'`).get(url(801))).toEqual({ count: 1 });
  });

  it("clears a settled legacy worker's report that matches fresh facts through the adapter, with no send, and launches only where it doesn't match", async () => {
    // Each legacy worker replied on its PR after the note, so its evidence is all Ready waits on.
    const env = await setup([802, 803], { live: (n) => ({ approvalFeedback: feedback(n), reviewFeedback: { openThreads: 0, comment: null, repliedAt: "2026-09-28T10:00:00Z", noteAt: "2026-09-28T09:00:00Z", followUpAt: null } }), execution: "on" });
    // 803's report names a head that is no longer the PR's.
    const { work, reconciler } = await legacyReports(env, [802, 803], (n) => n === 802 ? head(n) : head(n, 9));
    await reconciler.recoverAll();
    await reconciler.tick();
    expect(work.row(url(802))).toMatchObject({ phase: "prepared" });
    expect(work.attempts(url(802))).toEqual([]);
    expect(work.attempts(url(803))).toMatchObject([{ body: { recipes: ["address_review_feedback"] } }]);
    expect([...env.spawn.mock.calls, ...env.send.mock.calls].map(([args]) => args.pluginMetadata?.prUrl ?? args.threadId)).toEqual([expect.stringMatching(/803/u)]);
    expect(work.notes(env.effort.id, "legacy-adapter").map((note) => [(note as { target: string }).target, (note as { saved: boolean }).saved,
      (note as { compat: string[] }).compat])).toEqual(expect.arrayContaining([
      [url(802), true, ["legacy completion marker: prepared", "legacy feedback evidence line", "finalHeadOid → headOid", "approvalFeedbackFingerprint → fingerprint"]],
      [url(803), false, ["legacy completion marker: prepared", "legacy feedback evidence line"]]]));
  });

  it("stops only our worker's thread on stop N, releases its claim once BB shows the thread stopped, and pauses the row until retry N", async () => {
    const env = await setup([811, 812], { live: () => conflicting, execution: "on" });
    await env.reconciler.recoverAll();
    await env.reconciler.tick();
    const [ours] = env.work.attempts(url(811));
    const [other] = env.work.attempts(url(812));
    expect(await say(env, `stop ${env.row(811)!.body.n}`, "req-stop")).toMatchObject({ kind: "admit", acknowledgment: expect.arrayContaining([expect.stringMatching(/^Stop: /u)]) });
    expect(env.row(811)).toMatchObject({ phase: "executing", body: { modifiers: ["draining"], detail: expect.stringContaining("Stopping the worker") } });
    await env.reconciler.tick();
    // BB can't confirm the interrupt yet, so the claim holds.
    expect(env.stop.mock.calls).toEqual([[{ threadId: ours!.threadId }]]);
    expect(env.work.attempt(ours!.id)?.status).toBe("running");
    env.threads.set(ours!.threadId!, { ...env.threads.get(ours!.threadId!)!, status: "idle" });
    await env.harness.emitThreadEvent("thread.idle", { thread: env.threads.get(ours!.threadId!)!, lastAssistantText: "" });
    await settled();
    await env.reconciler.tick();
    expect(env.work.attempt(ours!.id)).toMatchObject({ status: "released", body: { releasedReason: "stopped" } });
    expect(env.row(811)).toMatchObject({ phase: "paused", body: { cause: "stopped", owner: { kind: "user" } } });
    expect(env.work.attempt(other!.id)?.status).toBe("running");
    expect(env.stop.mock.calls.every(([args]) => args.threadId === ours!.threadId)).toBe(true);
    expect(await say(env, `retry ${env.row(811)!.body.n}`, "req-retry")).toMatchObject({ kind: "admit" });
    env.at(MINUTE);
    await env.reconciler.tick();
    expect(env.work.attempts(url(811))[0]).toMatchObject({ status: "running", body: { retryEpoch: 1, recipes: ["integrate_base"] } });
  });

  it("reads a legacy worker's report once per job, head, and feedback, so evidence that leaves a gate failing lets the worker launch", async () => {
    // The legacy worker fixed the feedback, but a review thread is still open, which only a worker can resolve.
    const env = await setup([804], { live: (n) => ({ approvalFeedback: feedback(n), unresolvedThreads: 1 }), execution: "on" });
    const { work, reconciler } = await legacyReports(env, [804], head);
    await reconciler.recoverAll();
    await reconciler.tick();
    await reconciler.tick();
    expect(work.notes(env.effort.id, "legacy-adapter")).toMatchObject([{ target: url(804), saved: true }]);
    expect(work.attempts(url(804))).toMatchObject([{ status: "running", body: { recipes: ["address_review_feedback"] } }]);
  });

  it("leaves a legacy worker's report unread in a dry run, which keeps its plans in row bodies and saves no evidence", async () => {
    const env = await setup([805], { live: (n) => ({ approvalFeedback: feedback(n) }) });
    const { restarted, work, reconciler } = await legacyReports(env, [805], head);
    await reconciler.recoverAll();
    await reconciler.tick();
    await reconciler.tick();
    expect(work.row(url(805))).toMatchObject({ phase: "queued", body: { nextAction: ["address_review_feedback"], modifiers: ["plan only"] } });
    expect([work.attempts(url(805)), work.claims(), work.notes(env.effort.id, "legacy-adapter"), env.spawn.mock.calls, env.send.mock.calls]).toEqual([[], [], [], [], []]);
    expect(restarted.bb.storage.database().prepare("SELECT count(*) AS count FROM approval_feedback_verifications").get()).toEqual({ count: 0 });
  });

  it("asks BB to stop a worker whose thread already reads idle, asks nothing in a dry run, and never retries a turn you stopped", async () => {
    const env = await setup([813, 814, 815], { live: () => conflicting, execution: "on", concurrency: 3 });
    await env.reconciler.recoverAll();
    await env.reconciler.tick();
    const [idle, failing, running] = [813, 814, 815].map((n) => env.work.attempts(url(n))[0]!);
    // 814's turn fails before you stop it.
    await env.harness.emitThreadEvent("turn.failed", failed(failing.threadId!, "req-1"));
    await settled();
    for (const n of [813, 814, 815]) expect(await say(env, `stop ${env.row(n)!.body.n}`, `req-stop-${n}`)).toMatchObject({ kind: "admit" });
    // 813's thread reads idle, though BB may still run its turn, and that turn fails after you stopped it.
    env.threads.set(idle.threadId!, { ...env.threads.get(idle.threadId!)!, status: "idle" });
    await env.harness.emitThreadEvent("turn.failed", failed(idle.threadId!, "req-1"));
    await settled();
    // Back to a dry run before the reconciler acts: BB is asked nothing, and every claim holds.
    await env.harness.setSettings({ v2Execution: "dry-run" });
    await env.reconciler.tick();
    expect(env.stop).not.toHaveBeenCalled();
    expect([idle, failing, running].map((attempt) => env.work.attempt(attempt.id)?.status)).toEqual(["running", "running", "running"]);
    await env.harness.setSettings({ v2Execution: "on" });
    env.reconciler.due([813, 814, 815].map(url));
    await env.reconciler.tick();
    expect(env.stop.mock.calls.map(([args]) => args.threadId).sort()).toEqual([idle, failing, running].map((attempt) => attempt.threadId).sort());
    expect(env.work.attempt(idle.id)).toMatchObject({ status: "released", body: { releasedReason: "stopped" } });
    expect(env.work.attempt(idle.id)?.body.turnFailure ?? null).toBeNull();
    expect(env.retry).not.toHaveBeenCalled();
  });

  it("stops no one else's turn in a thread v2 reused while v2's work order waits in its queue, stops the order once it starts, and releases one gone from the queue", async () => {
    const env = await setup([816, 817], { live: () => conflicting, execution: "on" });
    await env.reconciler.recoverAll();
    await env.reconciler.tick();
    const threadOf = (n: number) => env.work.attempts(url(n))[0]!.threadId!;
    const [queued, deleted] = [threadOf(816), threadOf(817)];
    // Each worker's turn ends in prose, so its thread is asked to re-emit its report, and BB queues that message.
    env.send.mockImplementation(async () => ({ ok: true, delivery: "queued" }) as never);
    for (const threadId of [queued, deleted]) await env.finish(threadId, "Rebased onto main and pushed.");
    await env.reconciler.tick();
    await env.reconciler.tick();
    const [first, second] = [env.work.attempts(url(816))[0]!, env.work.attempts(url(817))[0]!];
    expect([first, second]).toMatchObject([816, 817].map(() => ({ status: "running", body: { recipes: ["repair_report"], mode: "send" } })));
    // A turn you started in 816's thread runs ahead of v2's message; you deleted 817's message from its queue, and BB's event for that was lost.
    env.threads.set(queued, { ...env.threads.get(queued)!, status: "active" });
    for (const n of [816, 817]) expect(await say(env, `stop ${env.row(n)!.body.n}`, `req-stop-${n}`)).toMatchObject({ kind: "admit" });
    await env.reconciler.tick();
    env.at(MINUTE + 1_000);
    env.reconciler.due([url(816), url(817)]);
    await env.reconciler.tick();
    expect(env.stop).not.toHaveBeenCalled();
    expect(env.work.attempt(first.id)?.status).toBe("running");
    expect(env.work.attempt(second.id)).toMatchObject({ status: "released", body: { releasedReason: "user-cancelled" } });
    // v2's message starts as 816's thread's next turn: that turn is v2's to stop.
    env.requests.set(queued, [{ type: "client/turn/requested", seq: 70, data: { requestId: "req-repair", input: [{ type: "text", text: first.body.marker, mentions: [] }],
      senderThreadId: null } }, ...env.requests.get(queued)!]);
    env.reconciler.due([url(816)]);
    await env.reconciler.tick();
    expect(env.stop.mock.calls).toEqual([[{ threadId: queued }]]);
  });

  it("names a failure several PRs share once among the roster's issues, with each PR's number, though decide() names each PR in its detail", async () => {
    const env = await setup([521, 522]);
    for (const n of [521, 522]) env.github.failFor.add(n);
    await env.reconciler.recoverAll();
    for (let minute = 0; minute <= 31; minute++) {
      env.at(minute * MINUTE + 1_000);
      await env.reconciler.tick();
    }
    const [first, second] = [env.row(521)!, env.row(522)!];
    expect([first.body.cause, second.body.cause]).toEqual(["source-unavailable", "source-unavailable"]);
    expect(first.body.detail).not.toBe(second.body.detail);
    const roster = await env.harness.callRpc("effort_roster_get", { effortId: env.effort.id }) as EffortRoster;
    const numbers = [first.body.n!, second.body.n!].sort();
    expect(roster.issues).toEqual([{ ref: "S1", cause: "source-unavailable", label: "source-unavailable", numbers, raisedAt: expect.any(Number), likelyThreadId: null,
      detail: numbers.map((n) => `${n}: ${(n === first.body.n ? first : second).body.detail}`).join("; "),
      recovery: [{ command: `refresh ${numbers.join(", ")}`, label: `Refresh ${numbers.join(", ")}`, confirm: false }] }]);
  });
});

describe("roster answers held for Undo", () => {
  /** Two drafts whose branches and checks are settled ask one mark-ready question, D1. */
  async function asked() {
    const env = await setup([331, 332], { live: () => ({ isDraft: true, reviewDecision: null }) });
    await env.reconciler.recoverAll();
    await env.reconciler.tick();
    const roster = async (harness = env.harness) => await harness.callRpc("effort_roster_get", { effortId: env.effort.id }) as EffortRoster;
    const d1 = (await roster()).decisions[0]!;
    expect(d1).toMatchObject({ n: 1, subkind: "mark-ready", targets: [{ n: 1 }, { n: 2 }] });
    /** Mark 1 ready from D1's card, held for Undo. */
    const card = async (requestId: string, harness = env.harness) => await harness.callRpc("effort_decision_answer", { decisionId: d1.id, numbers: [1],
      expectedRevision: d1.revision, requestId, delayMs: 10_000 }) as EffortCommandResult;
    const sent = (requestId: string, db = env.db) => (db.prepare(`SELECT count(*) AS count FROM effort_transitions WHERE cause = 'command'
      AND json_extract(detail, '$.requestId') = ?`).get(requestId) as { count: number }).count;
    return { ...env, roster, d1, card, sent, revision: env.work.lastRevision(env.effort.id) };
  }

  it("changes nothing for ten seconds, so Undo takes an answer back with nothing sent, and admits one that falls due exactly once", async () => {
    const env = await asked();
    const held = { kind: "pending", requestId: "pane-1", text: "D1 1", decisions: [1], until: START + 10_000 };
    expect(await env.card("pane-1")).toEqual(held);
    // A retried request finds the same held answer, never a second one.
    expect(await env.card("pane-1")).toEqual(held);
    expect((await env.roster()).pending).toEqual([{ requestId: "pane-1", text: "D1 1", decisions: [1], until: START + 10_000 }]);
    env.at(9_000);
    await env.reconciler.tick();
    expect(env.work.lastRevision(env.effort.id)).toBe(env.revision);
    expect((await env.roster()).decisions.map((decision) => decision.n)).toEqual([1]);
    expect(await env.harness.callRpc("effort_command_undo", { effortId: env.effort.id, requestId: "pane-1" }))
      .toEqual({ undone: true, message: "Took back D1 1; nothing was sent." });
    env.at(11_000);
    await env.reconciler.tick();
    expect(env.work.lastRevision(env.effort.id)).toBe(env.revision);
    expect(await env.roster()).toMatchObject({ pending: [], decisions: [{ n: 1, revision: env.d1.revision }] });
    expect(env.sent("pane-1")).toBe(0);
    expect(await env.card("pane-1")).toMatchObject({ kind: "clarify", message: "You took this answer back with Undo, so nothing was sent." });

    expect(await env.card("pane-2")).toMatchObject({ kind: "pending", until: START + 21_000 });
    env.at(21_000);
    await env.reconciler.tick();
    await env.reconciler.tick();
    expect(env.sent("pane-2")).toBe(1);
    expect(env.work.lastRevision(env.effort.id)).toBe(env.revision + 1);
    expect(await env.roster()).toMatchObject({ pending: [], decisions: [], lastCommand: { requestId: "pane-2", text: "D1 1", origin: "panel", result: { kind: "admit" } } });
    expect(await env.harness.callRpc("effort_command_undo", { effortId: env.effort.id, requestId: "pane-2" }))
      .toEqual({ undone: false, message: "That answer was already sent. Answer the decision again to change it." });
  });

  it("holds one answer per decision, so changing your mind means Undo and answer again, and the answer you picked last is the one admitted", async () => {
    const env = await asked();
    expect(await env.card("pane-1")).toMatchObject({ kind: "pending" });
    const other = async (requestId: string) => await env.harness.callRpc("effort_decision_answer", { decisionId: env.d1.id, numbers: [2],
      expectedRevision: env.d1.revision, requestId, delayMs: 10_000 }) as EffortCommandResult;
    expect(await other("pane-2")).toEqual({ kind: "clarify", normalized: null, message: "An answer to D1 is already waiting: D1 1. Undo it, then answer again. Nothing was admitted." });
    expect((await env.roster()).pending.map((item) => item.requestId)).toEqual(["pane-1"]);
    await env.harness.callRpc("effort_command_undo", { effortId: env.effort.id, requestId: "pane-1" });
    expect(await other("pane-2")).toMatchObject({ kind: "pending", text: "D1 2" });
    env.at(11_000);
    await env.reconciler.tick();
    expect(await env.roster()).toMatchObject({ pending: [], decisions: [],
      lastCommand: { requestId: "pane-2", result: { kind: "admit", parts: { answers: [{ n: 1, answer: "mark ready 2; keep as a draft 1" }] } } } });
  });

  it("ends a held answer that can no longer apply with one journaled clarification, so it leaves the queue and the reconciler never retries it", async () => {
    const env = await asked();
    expect(await env.card("pane-1")).toMatchObject({ kind: "pending" });
    // The parent thread's banner answered D1 at once while the pane's answer waited.
    expect(await env.harness.callRpc("effort_command", { effortId: env.effort.id, snapshotId: (await env.roster()).snapshotId, text: "D1 2", requestId: "banner-1",
      source: "banner", decisions: [{ n: 1, revision: env.d1.revision }] })).toMatchObject({ kind: "admit" });
    env.at(11_000);
    await env.reconciler.tick();
    await env.reconciler.tick();
    expect((await env.roster()).pending).toEqual([]);
    expect(env.sent("pane-1")).toBe(1);
    // Its request has that one final answer.
    expect(await env.card("pane-1")).toMatchObject({ kind: "clarify", message: expect.stringContaining("D1 was already answered: mark ready 2; keep as a draft 1") });
  });

  it("admits an answer that fell due while the plugin was stopped at the next start, once", async () => {
    const env = await asked();
    expect(await env.card("pane-1")).toMatchObject({ kind: "pending" });
    const restarted = await env.harness.lifecycle.reload(plugin);
    cleanups.push(() => restarted.harness.lifecycle.dispose());
    env.at(15_000);
    const reconciler = reconcilers.at(-1)!;
    await reconciler.recoverAll();
    await reconciler.tick();
    const db = restarted.bb.storage.database();
    expect(env.sent("pane-1", db)).toBe(1);
    expect(createEffortWorkStore(db).lastRevision(env.effort.id)).toBe(env.revision + 1);
    expect((await env.roster(restarted.harness)).pending).toEqual([]);
  });

  it("holds only a roster pane answer: a command box answer may wait, the banner never does, and a command that does more than answer sends at once or not at all", async () => {
    const env = await asked();
    const roster = await env.roster();
    const command = async (text: string, requestId: string, source = "panel") => await env.harness.callRpc("effort_command", { effortId: env.effort.id,
      snapshotId: roster.snapshotId, text, requestId, source, decisions: [{ n: 1, revision: env.d1.revision }], delayMs: 10_000 }) as EffortCommandResult;
    await expect(command("D1 1", "banner-1", "banner")).rejects.toThrow("Only an answer from the roster pane waits for Undo");
    expect(await command("D1 1, hold 2", "pane-mixed")).toMatchObject({ kind: "clarify", message: "Only a decision answer waits for Undo; send the rest at once. Nothing was admitted." });
    // An answer that can't apply is clarified now, not ten seconds later.
    expect(await command("D1 3", "pane-outside")).toMatchObject({ kind: "clarify", message: expect.stringContaining("D1 asks about 1, 2; 3 isn't part of it.") });
    expect(await command("D1 all but 2", "pane-1")).toEqual({ kind: "pending", requestId: "pane-1", text: "D1 all but 2", decisions: [1], until: START + 10_000 });
    env.at(10_000);
    await env.reconciler.tick();
    expect(await env.roster()).toMatchObject({ decisions: [], lastCommand: { requestId: "pane-1", text: "D1 all but 2", snapshotId: roster.snapshotId,
      result: { kind: "admit", parts: { answers: [{ n: 1, answer: "mark ready 1; keep as a draft 2" }] } } } });
    expect([env.sent("banner-1"), env.sent("pane-mixed"), env.sent("pane-outside")]).toEqual([0, 0, 0]);
  });
});

/**
 * The plugin restarts over the same database, BB, and GitHub. A call the old instance still waits on never answers it, its handles close,
 * and its background service is aborted, as a host reload leaves them.
 */
async function restart(from: Pick<Awaited<ReturnType<typeof setup>>, "harness">) {
  const restarted = await from.harness.lifecycle.reload(plugin);
  cleanups.push(() => restarted.harness.lifecycle.dispose());
  const work = createEffortWorkStore(restarted.bb.storage.database());
  expect((await restarted.harness.runCli(["refresh"])).exitCode).toBe(0);
  return { harness: restarted.harness, work, reconciler: reconcilers.at(-1)!, row: (n: number) => work.row(url(n)) };
}

describe("one writer across restarts, disposal, and a second reconciler", () => {
  /** The BB threads started to work a PR for v2, by their spawn metadata. */
  const workers = (env: Awaited<ReturnType<typeof setup>>, n: number) => [...env.metadata].filter(([, meta]) => meta.prUrl === url(n)).map(([id]) => id);
  /** One tick a minute past every poll: whatever was going to start has. */
  async function quiet(env: Awaited<ReturnType<typeof setup>>, next: Awaited<ReturnType<typeof restart>>, from: number, minutes = 20) {
    for (let minute = 1; minute <= minutes; minute++) {
      env.at(from + minute * MINUTE);
      await next.reconciler.tick();
    }
  }
  const followedUp = (): Partial<Live> => ({ reviewDecision: "CHANGES_REQUESTED", reviewFollowupPosted: true, mergeStateStatus: "BLOCKED", reviewRequests: [],
    latestReviews: [{ login: "ada", state: "CHANGES_REQUESTED" }] });

  it("attaches a launch the service was disposed in the middle of to the one worker BB started, and never starts a second", async () => {
    const env = await setup([901], { live: () => conflicting, execution: "on" });
    // BB starts the worker, but its answer never reaches the service: the plugin reloads while the spawn is out.
    const land = env.spawn.getMockImplementation()!;
    env.spawn.mockImplementationOnce(async (args) => { await land(args); return never(); });
    const { controller } = env.harness.runService("effort-v2");
    await vi.waitFor(() => expect(env.spawn).toHaveBeenCalledTimes(1));
    expect(env.work.attempts(url(901))).toMatchObject([{ status: "launching", threadId: null }]);
    const next = await restart(env);
    expect(controller.signal.aborted).toBe(true);
    // Pass 0 finds the launch no process is finishing, and reads BB back by its spawn metadata before any launch is admitted.
    await next.reconciler.recoverAll();
    const [worker] = workers(env, 901);
    expect(next.work.attempts(url(901))).toMatchObject([{ status: "running", threadId: worker }]);
    await next.reconciler.tick();
    expect(next.row(901)).toMatchObject({ phase: "executing", body: { cause: "worker", owner: { kind: "v2-attempt" } } });
    await quiet(env, next, 0);
    expect([env.spawn.mock.calls.length, env.send.mock.calls.length, next.work.attempts(url(901)).length, workers(env, 901)]).toEqual([1, 0, 1, [worker]]);
  });

  it("starts work a restart cut off once more only after two readbacks a minute apart find no worker, and never a third time", async () => {
    const env = await setup([902], { live: () => conflicting, execution: "on" });
    // The spawn never reaches BB before the plugin reloads.
    env.spawn.mockImplementationOnce(() => never());
    env.harness.runService("effort-v2");
    await vi.waitFor(() => expect(env.spawn).toHaveBeenCalledTimes(1));
    const next = await restart(env);
    await next.reconciler.recoverAll();
    const [lost] = next.work.attempts(url(902));
    expect(lost).toMatchObject({ status: "uncertain", body: { emptyReadbackAt: expect.any(Number) } });
    // Within the minute every readback finds nothing, and the claim holds: nothing starts.
    for (const at of [15_000, 45_000]) {
      env.at(at);
      next.reconciler.due([url(902)]);
      await next.reconciler.tick();
    }
    expect([env.spawn.mock.calls.length, next.work.attempt(lost!.id)?.status, next.work.claims().map((claim) => claim.id)]).toEqual([1, "uncertain", [lost!.id]]);
    // The second empty readback, a minute after the first, releases the claim, and the work starts once more under a new launch key.
    await quiet(env, next, 0);
    const attempts = next.work.attempts(url(902));
    expect(attempts.map((attempt) => [attempt.status, attempt.body.releasedReason])).toEqual([["running", null], ["released", "no-worker"]]);
    expect(attempts[0]!.launchKey).not.toBe(attempts[1]!.launchKey);
    expect([env.spawn.mock.calls.length, workers(env, 902)]).toEqual([2, [attempts[0]!.threadId]]);
  });

  it("finds a work order sent to a reused thread just before a restart by its marker, and never sends it twice", async () => {
    const env = await setup([903], { live: () => conflicting, execution: "on" });
    await env.reconciler.recoverAll();
    await env.reconciler.tick();
    const [first] = env.work.attempts(url(903));
    env.set(903, { ...ready(903), headOid: head(903, 1) });
    await env.finish(first!.threadId!, result(first!.id, 903, head(903, 1)));
    await env.reconciler.tick();
    expect(env.row(903)?.phase).toBe("prepared");
    // New review feedback goes to the thread that did the work. BB queues the order, but the plugin reloads before BB answers.
    env.set(903, { reviewDecision: "CHANGES_REQUESTED", unresolvedThreads: 2, mergeStateStatus: "BLOCKED" });
    const deliver = env.send.getMockImplementation()!;
    env.send.mockImplementationOnce(async (args) => { await deliver(args); return never(); });
    env.at(5 * MINUTE + 1_000);
    void env.reconciler.tick();
    await vi.waitFor(() => expect(env.send).toHaveBeenCalledTimes(1));
    const next = await restart(env);
    await next.reconciler.recoverAll();
    expect(next.work.attempts(url(903))[0]).toMatchObject({ status: "running", threadId: first!.threadId, body: { mode: "send", recipes: ["address_review_feedback"] } });
    await quiet(env, next, 5 * MINUTE);
    expect([env.send.mock.calls.length, env.spawn.mock.calls.length, next.work.attempts(url(903)).length]).toEqual([1, 1, 2]);
    expect(next.row(903)).toMatchObject({ phase: "executing", body: { owner: { kind: "v2-attempt", ref: next.work.attempts(url(903))[0]!.id } } });
  });

  it("reads a finished worker's report once after a restart cut its reading short, and verifies the PR on a fresh read with no new worker", async () => {
    const env = await setup([904], { live: () => conflicting, execution: "on" });
    await env.reconciler.recoverAll();
    await env.reconciler.tick();
    const [attempt] = env.work.attempts(url(904));
    env.set(904, { ...ready(904), headOid: head(904, 1) });
    env.at(MINUTE);
    await env.finish(attempt!.threadId!, result(attempt!.id, 904, head(904, 1)));
    // The turn is read complete, and the fresh read its report is judged against never answers: the plugin reloads.
    let reads = 0;
    env.github.fullHangs = (n) => n === 904 && ++reads === 2;
    void env.reconciler.tick();
    await vi.waitFor(() => expect(reads).toBe(2));
    expect(env.work.attempt(attempt!.id)).toMatchObject({ status: "completed", body: { report: { key: null } } });
    env.github.fullHangs = null;
    const next = await restart(env);
    await next.reconciler.recoverAll();
    await quiet(env, next, MINUTE, 3);
    expect(next.work.attempt(attempt!.id)).toMatchObject({ status: "completed", body: { report: { key: "changed", headOid: head(904, 1) } } });
    expect(next.row(904)).toMatchObject({ phase: "prepared", body: { observedHead: head(904, 1) } });
    expect([env.spawn.mock.calls.length, env.send.mock.calls.length, next.work.attempts(url(904)).length]).toEqual([1, 0, 1]);
  });

  it("verifies a merge candidate whose full read a restart cut off on a fresh read after it, with no worker", async () => {
    const env = await setup([905], { live: () => ({ checks: "pending", mergeStateStatus: "BLOCKED" }) });
    await env.reconciler.recoverAll();
    await env.reconciler.tick();
    expect(env.row(905)).toMatchObject({ phase: "waiting", body: { cause: "ci" } });
    env.set(905, { checks: "passed", mergeStateStatus: "CLEAN" });
    env.at(2 * MINUTE + 1_000);
    env.github.fullHangs = (n) => n === 905;
    void env.reconciler.tick();
    await vi.waitFor(() => expect(env.calls("advanceInspect")).toHaveLength(2));
    env.github.fullHangs = null;
    const next = await restart(env);
    await next.reconciler.recoverAll();
    // The cheap read the cut tick kept shows the PR changed since its last full read, so no stale read makes it Ready.
    await next.reconciler.tick();
    expect(next.row(905)?.phase).not.toBe("prepared");
    await quiet(env, next, 2 * MINUTE, 2);
    expect(next.row(905)).toMatchObject({ phase: "prepared", body: { cause: "merge-candidate" } });
    expect([env.spawn.mock.calls, env.send.mock.calls, next.work.attempts(url(905))]).toEqual([[], [], []]);
  });

  it.each([[true, 1], [false, 2]])("reads a code action a restart cut off back from GitHub before writing again, and lands it once (the first write landed: %s)",
    async (lands, writes) => {
      const env = await setup([906], { live: followedUp, execution: "on" });
      env.github.write = () => ({ lands, answer: "never" });
      await env.reconciler.recoverAll();
      void env.reconciler.tick();
      await vi.waitFor(() => expect(env.calls("prWrite")).toHaveLength(1));
      // The action's key was in the row before the write went out.
      expect(env.row(906)?.body.codeActions).toMatchObject([{ recipe: "request_rereview", status: "pending", tries: 0 }]);
      env.github.write = null;
      const next = await restart(env);
      await next.reconciler.recoverAll();
      // A write that landed shows on the board's read after the restart, so the PR is read in full before the key is read back, once the
      // key's lease has passed.
      await quiet(env, next, 0, 4);
      expect(env.calls("prWrite")).toHaveLength(1);
      await quiet(env, next, 4 * MINUTE, 6);
      expect(env.calls("prWrite").map((call) => call.input)).toEqual(Array.from({ length: writes }, () => ({ kind: "nudge", prUrl: url(906), reviewers: ["ada"], comment: null })));
      expect(env.lives.get(906)!.reviewRequests).toEqual(["ada"]);
      expect(next.row(906)).toMatchObject({ phase: "waiting", body: { cause: "review", codeActions: [{ recipe: "request_rereview", status: "done" }] } });
      // Someone takes ada's request off again on this head: it already had its one re-request, so v2 doesn't write another.
      env.set(906, { reviewRequests: [] });
      env.at(20 * MINUTE);
      next.reconciler.due([url(906)]);
      await next.reconciler.tick();
      await next.reconciler.tick();
      expect(env.calls("prWrite")).toHaveLength(writes);
    });

  /** Bring a PR to its code action: a granted review request, or a rerun after its worker reports an environment blocker on failing checks. */
  async function toCodeAction(env: Awaited<ReturnType<typeof setup>>, n: number, recipe: "request_review" | "request_rereview" | "rerun_failed_checks") {
    await env.reconciler.recoverAll();
    if (recipe === "request_review") expect(await say(env, `request review ${env.row(n)!.body.n} from @ada`, "req-review")).toMatchObject({ kind: "admit" });
    if (recipe !== "rerun_failed_checks") return;
    await env.reconciler.tick();
    const [attempt] = env.work.attempts(url(n));
    await env.finish(attempt!.threadId!, `Workstreams result v1: ${JSON.stringify({ attemptId: attempt!.id, target: url(n), actions: ["fix_failing_checks"], outcome: "blocked",
      headOid: head(n), baseOid: BASE, blockers: [{ kind: "environment", summary: "The shelf index runner lost its cache", checks: ["ci/shelf-index"] }] })}`);
    await env.reconciler.tick();
  }
  const failingChecks = (): Partial<Live> => ({ checks: "failed", mergeStateStatus: "BLOCKED" });

  it.each<[string, number, "request_review" | "rerun_failed_checks", Partial<Live>, number, string]>([
    ["a rerun whose checks then passed", 921, "rerun_failed_checks", { checks: "passed", mergeStateStatus: "CLEAN" }, 1, "prepared:merge-candidate"],
    // The next instance's call is the host's own check, which finds the head's run already rerun and reruns nothing.
    ["a rerun whose checks failed again", 922, "rerun_failed_checks", { checks: "failed" }, 2, "repair-needed:ci-infrastructure"],
    ["a review request its reviewer then approved", 923, "request_review",
      { reviewDecision: "APPROVED", mergeStateStatus: "CLEAN", reviewRequests: [], latestReviews: [{ login: "ada", state: "APPROVED" }] }, 1, "prepared:merge-candidate"],
  ])("settles a code action a restart cut off whose effect changed while the plugin was down, and GitHub has it once: %s", async (_, n, recipe, whileDown, calls, final) => {
    const env = await setup([n], { live: () => recipe === "request_review" ? { reviewDecision: null, mergeStateStatus: "BLOCKED" } : failingChecks(), execution: "on" });
    await toCodeAction(env, n, recipe);
    // The write lands, and a restart loses its answer.
    env.github.write = () => ({ lands: true, answer: "never" });
    void env.reconciler.tick();
    await vi.waitFor(() => expect(env.calls("prWrite")).toHaveLength(1));
    env.github.write = null;
    const next = await restart(env);
    env.set(n, whileDown);
    await next.reconciler.recoverAll();
    await quiet(env, next, 0, 10);
    expect(env.calls("prWrite")).toHaveLength(calls);
    // GitHub reran the head once, and asked ada for review once, before she approved.
    expect(recipe === "request_review" ? env.calls("prWrite").map((call) => call.input.reviewers) : env.github.reran).toEqual(recipe === "request_review" ? [["ada"]] : [head(n)]);
    expect([`${next.row(n)?.phase}:${next.row(n)?.body.cause}`, next.row(n)?.body.codeActions]).toEqual([final, [expect.objectContaining({ recipe, status: "done" })]]);
  });

  it.each([["request_rereview", 924], ["rerun_failed_checks", 925]] as const)(
    "writes no second %s while the instance that keyed it may still be writing it, as when a reload runs the new instance beside the old one", async (recipe, n) => {
      const env = await setup([n], { live: recipe === "request_rereview" ? followedUp : failingChecks, execution: "on" });
      await toCodeAction(env, n, recipe);
      // The old instance's write is out: it hasn't reached GitHub or answered.
      env.github.write = () => ({ lands: false, answer: "never" });
      void env.reconciler.tick();
      await vi.waitFor(() => expect(env.calls("prWrite")).toHaveLength(1));
      env.github.write = null;
      let fresh!: typeof env.reconciler;
      const next = await env.harness.lifecycle.reload(async (bb) => {
        await plugin(bb);
        fresh = reconcilers.at(-1)!;
        await fresh.recoverAll();
        await fresh.tick();
        env.at(MINUTE);
        fresh.due([url(n)]);
        await fresh.tick();
      });
      cleanups.push(() => next.harness.lifecycle.dispose());
      expect(env.calls("prWrite")).toHaveLength(1);
      // The old write lands late. Past the key's lease, the new instance reads it back and writes nothing.
      env.set(n, recipe === "request_rereview" ? { reviewRequests: ["ada"] } : { checks: "pending" });
      for (let minute = 2; minute <= 12; minute++) {
        env.at(minute * MINUTE);
        await fresh.tick();
      }
      expect(env.calls("prWrite")).toHaveLength(1);
      expect(createEffortWorkStore(next.bb.storage.database()).row(url(n))?.body.codeActions?.[0]).toMatchObject({ recipe, status: "done" });
    });

  it("leaves nothing half-written when disposed between planning a launch and committing it, and the next instance launches it once", async () => {
    const env = await setup([911], { live: () => conflicting, execution: "on" });
    const journal = () => env.db.prepare(`SELECT count(*) AS count FROM effort_transitions`).get() as { count: number };
    const before = journal();
    // The pass has planned the launch and is reading where it would run when the plugin reloads.
    env.github.duringCheckoutRead = () => never();
    env.harness.runService("effort-v2");
    await vi.waitFor(() => expect(env.calls("inspectCheckout")).toHaveLength(1));
    expect([journal(), env.work.claims(), env.row(911)?.body.plan]).toEqual([before, [], undefined]);
    env.github.duringCheckoutRead = null;
    const next = await restart(env);
    expect([next.work.attempts(url(911)), next.work.claims()]).toEqual([[], []]);
    await next.reconciler.recoverAll();
    await quiet(env, next, 0, 5);
    expect(next.work.attempts(url(911))).toMatchObject([{ status: "running" }]);
    expect([env.spawn.mock.calls.length, workers(env, 911)]).toEqual([1, [next.work.attempts(url(911))[0]!.threadId]]);
  });

  it("gives two reconcilers planning the same first launches at once one claim and one worker per PR", async () => {
    const env = await setup([909, 910], { live: () => conflicting, execution: "on" });
    await env.reconciler.recoverAll();
    // A reload briefly runs the new instance beside the old one over the same database: both tick at once, twice.
    const next = await env.harness.lifecycle.reload(async (bb) => {
      await plugin(bb);
      const [old, fresh] = reconcilers.slice(-2) as [typeof env.reconciler, typeof env.reconciler];
      await fresh.recoverAll();
      await Promise.all([old.tick(), fresh.tick()]);
      env.at(MINUTE);
      fresh.due([url(909), url(910)]);
      await Promise.all([fresh.tick(), old.tick()]);
    });
    cleanups.push(() => next.harness.lifecycle.dispose());
    const work = createEffortWorkStore(next.bb.storage.database());
    for (const n of [909, 910]) {
      expect(work.attempts(url(n))).toMatchObject([{ status: "running" }]);
      expect(workers(env, n)).toEqual([work.attempts(url(n))[0]!.threadId]);
    }
    expect(env.spawn).toHaveBeenCalledTimes(2);
  });

  /**
   * Hold both instances' runners as each plans the write it is about to commit for a PR (a launch's claim, or a code action's key) until
   * both have: the interleaving the row's compare-and-swap and the claims' unique indexes must settle. Returns which PRs both reached.
   */
  function together(deps: readonly Parameters<typeof createEffortRunner>[0][]) {
    const arrivals = new Map<string, { count: number; open: () => void; reached: Promise<void> }>();
    for (const item of deps) {
      const plan = item.plan;
      item.plan = async (effortId, target, change) => {
        const planned = await plan(effortId, target, change);
        if (change.attempts[0]?.status === "launching" || change.codeActions?.[0]?.status === "pending") {
          let gate = arrivals.get(target);
          if (!gate) {
            let open!: () => void;
            const reached = new Promise<void>((resolve) => { open = resolve; });
            arrivals.set(target, gate = { count: 0, open, reached });
          }
          if (++gate.count === deps.length) gate.open();
          // Should only one instance get here, it goes on alone, and the test sees the race never happened.
          await Promise.race([gate.reached, new Promise((resolve) => setTimeout(resolve, 2_000))]);
        }
        return planned;
      };
    }
    return () => [...arrivals].filter(([, gate]) => gate.count >= deps.length).map(([target]) => target).sort();
  }

  it("keeps one writer when two reconcilers act on the same planned step at once: one claim and one order in the worker's thread, and one GitHub write", async () => {
    // 907's worker ends its turn in prose, so its thread is to be asked for its report; 908's re-request of review got an unclear answer.
    const env = await setup([907, 908], { live: (n) => n === 907 ? conflicting : followedUp(), execution: "on" });
    env.github.write = () => ({ lands: false, answer: new Error("socket hang up") });
    await env.reconciler.recoverAll();
    await env.reconciler.tick();
    const [work] = env.work.attempts(url(907));
    await env.finish(work!.threadId!, "Rebased onto main and pushed. Ready to merge.");
    await env.reconciler.tick();
    expect(env.row(907)).toMatchObject({ phase: "queued", body: { cause: "report-repair" } });
    expect(env.row(908)).toMatchObject({ phase: "executing", body: { cause: "code-action", codeActions: [{ status: "pending", tries: 1 }] } });
    env.github.write = null;
    // Both instances plan the steps the rows already hold, so neither pass writes, and both act on them at once: each plans its claim or its
    // action's key before either commits it. 907's report repair races first; 908's key is taken over only once its lease has passed.
    let raced: () => string[] = () => [];
    const next = await env.harness.lifecycle.reload(async (bb) => {
      await plugin(bb);
      const [old, fresh] = reconcilers.slice(-2) as [typeof env.reconciler, typeof env.reconciler];
      raced = together(runnerDeps.slice(-2));
      fresh.due([url(907), url(908)]);
      await Promise.all([old.tick(), fresh.tick()]);
      expect(env.calls("prWrite")).toHaveLength(1);
      // A tick within the lease writes nothing; its pass records that the full reads went stale, so the next passes have nothing to write.
      env.at(4 * MINUTE);
      fresh.due([url(907), url(908)]);
      await fresh.tick();
      expect(env.calls("prWrite")).toHaveLength(1);
      env.at(5 * MINUTE);
      fresh.due([url(908)]);
      await Promise.all([old.tick(), fresh.tick()]);
    });
    expect(raced()).toEqual([url(907), url(908)]);
    cleanups.push(() => next.harness.lifecycle.dispose());
    const store = createEffortWorkStore(next.bb.storage.database());
    expect(store.attempts(url(907)).map((attempt) => [attempt.status, attempt.body.recipes])).toEqual([["running", ["repair_report"]], ["completed", ["integrate_base"]]]);
    expect(env.send.mock.calls.map(([args]) => args.threadId)).toEqual([work!.threadId]);
    expect(env.calls("prWrite")).toHaveLength(2);
    expect(env.lives.get(908)!.reviewRequests).toEqual(["ada"]);
    expect(store.row(url(908))?.body.codeActions?.[0]).toMatchObject({ status: "done", tries: 2 });
  });
});
