// The decisive acceptance case (plan C25): legacy Advance's 22 PRs, 37 job rows in 15 batches, restated for effort ownership
// as three instructions, run through the real plugin from a dry run to v2 execution. The PRs, batches, and ownership copy
// only the shape of the recorded failure, in the fictional Inkwell domain. Every SDK and host call is a test double.
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdvanceFacts } from "./advance-contract.js";
import type { AdvanceBatch } from "./bulk-advance.js";
import type { RawUnit } from "./contract.js";
import type { EffortRoster } from "./effort-roster.js";
import { createEffortStore, type EstablishedEffort } from "./effort-store.js";
import type { createEffortV2, EffortCommandResult } from "./effort-v2-server.js";
import { createEffortWorkStore, type WorkRow } from "./effort-work-store.js";
import { parsePrList } from "./gh.js";
import { INKWELL_ADVANCE_BATCHES, INKWELL_ADVANCE_EFFORTS, INKWELL_ADVANCE_PR_URLS } from "./inkwell-fixtures.js";
import plugin, { type Board } from "./server.js";

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
const SOURCE = "/Users/reader/src";
const START = Date.UTC(2026, 8, 28, 16);
const MINUTE = 60_000;
const BASE = "b".repeat(40);
/** Legacy Advance's 22 PRs, by the fixture's index. */
const PR = INKWELL_ADVANCE_PR_URLS;
const JOBS = INKWELL_ADVANCE_BATCHES.flatMap((batch) => batch.jobs);
/** A PR on the board that legacy Advance never touched and no effort owns: nothing may start on it. */
const UNRELATED = "https://github.com/inkwell/folio/pull/315";
const PULLS = new Map([...PR.map((url) => {
  const job = JOBS.find((item) => item.prUrl === url)!;
  return [url, { repo: job.repo, number: job.number, title: job.title, branch: job.headRefName, head: job.headOid }] as const;
}), [UNRELATED, { repo: "inkwell/folio", number: 315, title: "ABC-342 Sort shelves by author", branch: "abc-342", head: "d".repeat(40) }] as const]);
const fingerprint = (number: number) => number.toString(16).padStart(64, "e");

/** GitHub's side of one PR. */
type Live = { state: "OPEN" | "MERGED" | "CLOSED"; headOid: string; checks: "passed" | "pending" | "failed"; mergeStateStatus: string; mergeable: string;
  reviewDecision: string | null; unresolvedThreads: number; basePrNumber: number | null; isDraft: boolean; isCrossRepository: boolean; reviewRequests: string[];
  latestReviews: { login: string; state: string }[]; reviewFollowupPosted?: boolean; approvalFeedback?: AdvanceFacts["approvalFeedback"];
  reviewFeedback?: AdvanceFacts["reviewFeedback"] };
const conflicting = { mergeStateStatus: "DIRTY", mergeable: "CONFLICTING" } satisfies Partial<Live>;
const feedback = (number: number) => ({ status: "present" as const, fingerprint: fingerprint(number), sourceIds: [`review:${number}`] });
/** The legacy worker replied on the PR after the approval's note, so only verification stood between it and Ready. */
const REPLIED = { openThreads: 0, comment: null, repliedAt: "2026-09-28T10:00:00Z", noteAt: "2026-09-28T09:00:00Z", followUpAt: null };
/** GitHub as the case starts, by fixture index; every other PR is an approved, green merge candidate. */
const SHAPE: Record<number, Partial<Live>> = {
  0: { unresolvedThreads: 1 },
  1: { approvalFeedback: feedback(312), reviewFeedback: REPLIED },
  2: { checks: "failed", mergeStateStatus: "BLOCKED" },
  3: { reviewDecision: "REVIEW_REQUIRED", reviewRequests: ["ada"], latestReviews: [], mergeStateStatus: "BLOCKED" },
  4: { basePrNumber: 95 },
  5: conflicting,
  6: { checks: "pending", mergeStateStatus: "BLOCKED" },
  7: conflicting,
  8: { approvalFeedback: feedback(404), reviewFeedback: REPLIED },
  9: { basePrNumber: 404 },
  11: conflicting,
  12: { reviewDecision: "CHANGES_REQUESTED", reviewFollowupPosted: true, mergeStateStatus: "BLOCKED", latestReviews: [{ login: "bea", state: "CHANGES_REQUESTED" }] },
  13: { ...conflicting, isCrossRepository: true },
  14: { mergeStateStatus: "BLOCKED" },
  17: { reviewDecision: "REVIEW_REQUIRED", reviewRequests: ["dee"], latestReviews: [], mergeStateStatus: "BLOCKED" },
  18: { checks: "pending", mergeStateStatus: "BLOCKED" },
  19: { checks: "pending", mergeStateStatus: "BLOCKED" },
  20: { reviewDecision: "CHANGES_REQUESTED", unresolvedThreads: 2, mergeStateStatus: "BLOCKED", latestReviews: [{ login: "cy", state: "CHANGES_REQUESTED" }] },
  21: { basePrNumber: 313 },
};
const ready = (url: string): Live => ({ state: "OPEN", headOid: PULLS.get(url)!.head, checks: "passed", mergeStateStatus: "CLEAN", mergeable: "MERGEABLE",
  reviewDecision: "APPROVED", unresolvedThreads: 0, basePrNumber: null, isDraft: false, isCrossRepository: false, reviewRequests: [], latestReviews: [{ login: "ada", state: "APPROVED" }] });
/** The cheap read: what the board's inventory and inspectPrs see. */
function cheap(url: string, live: Live) {
  const pull = PULLS.get(url)!;
  return { ...parsePrList(JSON.stringify([{ number: pull.number, url, state: live.state, title: pull.title, reviewDecision: live.reviewDecision ?? "", isDraft: live.isDraft,
    headRefName: pull.branch, baseRefName: "main", headRefOid: live.headOid, baseRefOid: BASE, mergeStateStatus: live.mergeStateStatus, mergeable: live.mergeable,
    statusCheckRollup: [live.checks === "passed" ? { conclusion: "SUCCESS" } : live.checks === "failed" ? { conclusion: "FAILURE" } : { status: "IN_PROGRESS", conclusion: "" }],
    latestReviews: live.latestReviews.map(({ login, state }) => ({ author: { login }, state })), reviewRequests: live.reviewRequests.map((login) => ({ login })) }]))!.pr,
    unresolvedReviewThreads: live.unresolvedThreads, resolvedReviewThreads: 0 };
}
/** The full read: what advanceInspect sees. */
function full(url: string, live: Live): AdvanceFacts {
  const pull = PULLS.get(url)!;
  return { prUrl: url, number: pull.number, title: pull.title, repo: pull.repo, headRefName: pull.branch, baseRefName: "main",
    headOid: live.state === "OPEN" ? live.headOid : "", baseOid: live.state === "OPEN" ? BASE : "", state: live.state, isDraft: live.isDraft,
    isCrossRepository: live.isCrossRepository, reviewDecision: live.reviewDecision, mergeStateStatus: live.mergeStateStatus, mergeable: live.mergeable,
    needsPreparation: false, readiness: "ready", detail: "", unresolvedThreads: live.unresolvedThreads, threadsComplete: true, reviewFeedback: live.reviewFeedback ?? { openThreads: 0, comment: null, repliedAt: null, noteAt: null, followUpAt: null }, checks: live.checks,
    basePrNumber: live.basePrNumber, ...live.reviewFollowupPosted === undefined ? {} : { reviewFollowupPosted: live.reviewFollowupPosted },
    approvalFeedback: live.approvalFeedback ?? { status: "none", fingerprint: null, sourceIds: [] } };
}
const checkoutOf = (url: string) => `${SOURCE}/${PULLS.get(url)!.repo.split("/")[1]}-${PULLS.get(url)!.number}`;
/** A legacy job in the newest batch that holds the PR: the current legacy attempt, which the roster reads as history. */
const currentJob = (url: string) => INKWELL_ADVANCE_BATCHES.find((batch) => batch.jobs.some((job) => job.prUrl === url))!.jobs.find((job) => job.prUrl === url)!;
/**
 * The two legacy workers' last outputs: each reported its review feedback addressed on the live head, in one of the older field names
 * legacy Advance rejected, so its job stayed short of Ready.
 */
function aliasReport(url: string, alias: "finalHeadOid" | "approvalFeedbackFingerprint") {
  const job = currentJob(url);
  const number = PULLS.get(url)!.number;
  const evidence = { attemptId: job.attemptId, ...alias === "finalHeadOid" ? { finalHeadOid: job.headOid, fingerprint: fingerprint(number) }
    : { headOid: job.headOid, approvalFeedbackFingerprint: fingerprint(number) }, blockers: [],
  findings: [{ sourceId: `review:${number}`, resolution: "fixed", evidence: "The reviewer's case now passes", validation: { outcome: "passed", detail: "npm test" } }] };
  return `Addressed the review and pushed.\nWorkstreams approval feedback evidence: ${JSON.stringify(evidence)}\nWorkstreams job ${job.attemptId} complete: prepared`;
}

/** Legacy Advance's saved form of a fixture batch: its jobs, with the routing facts each was started or checked with. */
const saved = (batch: AdvanceBatch, index: number) => ({ ...batch, instruction: "", token: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  pollUntil: batch.createdAt, prepared: {}, repairs: {}, facts: Object.fromEntries(batch.jobs.map((job) => [job.id, { prUrl: job.prUrl, repo: job.repo, number: job.number,
    title: job.title, headOid: job.headOid, baseOid: job.baseOid ?? BASE, baseRefName: job.baseRefName, headRefName: job.headRefName, needsPreparation: job.needsPreparation,
    needsFeedback: false, needsChecks: false, eligible: true, detail: job.detail, workspace: job.workspace, projectId: PROJECT, hostId: HOST, sourcePath: checkoutOf(job.prUrl),
    path: job.path, effortId: null, effortKey: null, effortMembers: null, reviewDecision: "APPROVED", isDraft: false, readiness: "needs-attention", blockedBy: null }])) });

const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(START); });
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.useRealTimers(); });

async function acceptance() {
  const lives = new Map([...PULLS.keys()].map((url) => [url, { ...ready(url), ...SHAPE[PR.indexOf(url)], ...url === UNRELATED ? conflicting : {} }]));
  const threads = new Map<string, ReturnType<typeof makeThreadResponse> & { environment: { hostId: string; path: string; branchName: string | null } }>();
  const metadata = new Map<string, Record<string, unknown>>();
  const outputs = new Map<string, string>();
  const requests = new Map<string, unknown[]>();
  const hostCalls: { method: string; input: any }[] = [];
  const thread = (id: string, path: string, status: "active" | "idle") => threads.set(id, { ...makeThreadResponse({ id, projectId: PROJECT, providerId: "codex", status,
    originPluginId: "workstreams" }), environment: { hostId: HOST, path, branchName: null } });
  // The legacy workers: two still running, and two idle with the reports their jobs rejected.
  for (const index of [5, 11]) thread(currentJob(PR[index]!).threadId!, currentJob(PR[index]!).path!, "active");
  for (const [index, alias] of [[1, "finalHeadOid"], [8, "approvalFeedbackFingerprint"]] as const) {
    const job = currentJob(PR[index]!);
    thread(job.threadId!, job.path!, "idle");
    outputs.set(job.threadId!, aliasReport(PR[index]!, alias));
  }
  let spawned = 0;
  /** Whether a spawn's answer is lost after BB started the thread, by PR. */
  const lost = new Set<string>();
  const spawn = vi.fn(async (args: Record<string, any>) => {
    const id = `thr-worker-${++spawned}`;
    thread(id, args.environment.workspace.path, "active");
    metadata.set(id, args.pluginMetadata);
    requests.set(id, [{ type: "client/turn/requested", seq: 1, data: { requestId: "req-1", input: [{ type: "text", text: args.prompt }], senderThreadId: null } }]);
    if (lost.delete(args.pluginMetadata.prUrl)) throw new Error("socket hang up");
    return threads.get(id) as never;
  });
  const send = vi.fn(async () => ({ ok: true, delivery: "sent" }) as never);
  const unit = (url: string): RawUnit => ({ path: checkoutOf(url), dirName: checkoutOf(url).split("/").at(-1)!, repo: PULLS.get(url)!.repo.split("/")[1]!,
    githubRepo: PULLS.get(url)!.repo, branch: PULLS.get(url)!.branch, dirty: false, ahead: 0, behind: 0, lastCommitAt: "2026-09-27T12:00:00Z", defaultBranch: "main",
    pr: cheap(url, lives.get(url)!), shipped: null, changedPaths: [], observed: { status: true, pr: true } });
  const open = () => [...lives].filter(([, live]) => live.state === "OPEN").map(([url]) => url);
  const { bb, harness } = createFakePluginHost({ pluginId: "workstreams", settings: { scanRoots: SOURCE }, sdk: {
    system: { config: async () => ({ primaryHostId: HOST }) as never },
    projects: { list: async () => [{ id: PROJECT, name: "Inkwell", sources: [{ hostId: HOST, path: SOURCE }] }] as never },
    threads: {
      list: async () => [...threads.values()].map((item) => ({ ...item, environmentPath: item.environment.path, environmentHostId: item.environment.hostId,
        queuedWork: "none", hasPendingInteraction: false })) as never,
      spawn, send,
      get: async ({ threadId }: { threadId: string }) => {
        const found = threads.get(threadId);
        if (!found) throw Object.assign(new Error("missing thread"), { status: 404 });
        return found as never;
      },
      getPluginMetadata: async ({ threadId }: { threadId: string }) => (metadata.get(threadId) ?? {}) as never,
      output: async ({ threadId }: { threadId: string }) => ({ output: outputs.get(threadId) ?? null }),
      context: async () => ({ usage: null }) as never,
      events: { list: async ({ threadId, types }: { threadId: string; types?: readonly string[] }) => (types?.includes("client/turn/requested") ? requests.get(threadId) ?? [] : []) as never },
      queuedMessages: { list: async () => [] as never },
      interactions: { list: async () => [] as never },
    },
  }, experimental_callHostRpc: async ({ method, input }) => {
    hostCalls.push({ method, input });
    if (method === "scan") return { units: open().map(unit), warnings: [] };
    if (method === "inspectPaths") return { units: open().map(unit).filter((item) => (input as { paths: string[] }).paths.includes(item.path)), warnings: [] };
    if (method === "authoredPrs") return { owners: ["inkwell"], entries: open().map((url) => ({ repo: PULLS.get(url)!.repo, pr: cheap(url, lives.get(url)!) })),
      discoveryComplete: true, complete: true, repositories: [...new Set([...PULLS.values()].map((pull) => pull.repo))].map((repo) => ({ repo, complete: true })), warnings: [] };
    if (method === "linkbacks") return { found: [], warnings: [] };
    if (method === "inspectPrs") {
      const read = (input as { prUrls: string[] }).prUrls.filter((url) => lives.has(url));
      return { entries: read.filter((url) => lives.get(url)!.state === "OPEN").map((url) => ({ repo: PULLS.get(url)!.repo, pr: cheap(url, lives.get(url)!) })),
        closed: read.filter((url) => lives.get(url)!.state !== "OPEN"), failed: [], warnings: [] };
    }
    if (method === "advanceInspect") {
      const url = (input as { prUrl: string }).prUrl;
      return { ok: true, facts: full(url, lives.get(url)!) };
    }
    if (method === "inspectCheckout") {
      // Legacy worktrees are gone from disk; the authors' checkouts sit at their PRs' heads.
      const { path } = input as { path: string };
      const url = [...PULLS.keys()].find((item) => checkoutOf(item) === path);
      if (!url) return { ok: false, error: `${path} is not a git worktree` };
      return { ok: true, head: lives.get(url)!.headOid, branch: PULLS.get(url)!.branch, clean: true, commonDir: `${path}/.git`, relation: "at-head" };
    }
    if (method === "githubRateLimit") return { resetAt: null };
    if (method === "prReviewers") return { ok: true, reviewers: lives.get((input as { prUrl: string }).prUrl)!.reviewRequests };
    if (method === "prWrite") {
      const request = input as { kind: string; prUrl: string; reviewers?: string[] };
      const live = lives.get(request.prUrl)!;
      if (request.kind === "nudge") live.reviewRequests = [...new Set([...live.reviewRequests, ...request.reviewers!])];
      return { ok: true, detail: "written" };
    }
    if (method === "contextWorkspace") return { path: "/synthetic/workstreams/context" };
    throw new Error(`Unexpected host call ${method}`);
  } });
  await plugin(bb);
  cleanups.push(() => harness.lifecycle.dispose());
  expect((await harness.runCli(["refresh"])).exitCode).toBe(0);
  // Legacy Advance's saved batches and the three efforts; the plugin restarts, so Advance loads the batches as history.
  const setupDb = bb.storage.database();
  INKWELL_ADVANCE_BATCHES.forEach((batch, index) => setupDb.prepare(`INSERT INTO advance_batches (id, body) VALUES (?, ?)`).run(batch.id, JSON.stringify(saved(batch, index))));
  const store = createEffortStore(setupDb);
  const efforts = Object.fromEntries(Object.entries(INKWELL_ADVANCE_EFFORTS).map(([name, prUrls]) => [name, store.establish({ sourceKey: name, name,
    goal: `${name} goal`, projectId: PROJECT, coordinatorState: "none", members: { tickets: [], prUrls } })])) as Record<keyof typeof INKWELL_ADVANCE_EFFORTS, EstablishedEffort>;
  const restarted = await harness.lifecycle.reload(plugin);
  cleanups.push(() => restarted.harness.lifecycle.dispose());
  const db = restarted.bb.storage.database();
  const work = createEffortWorkStore(db);
  for (const effort of Object.values(efforts)) work.setMode(effort.id, "v2", 0, () => []);
  expect((await restarted.harness.runCli(["refresh"])).exitCode).toBe(0);
  const reconciler = reconcilers.at(-1)!;
  const rpc = (method: string, value: unknown) => restarted.harness.callRpc(method as never, value as never) as Promise<any>;
  const roster = (effort: EstablishedEffort) => rpc("effort_roster_get", { effortId: effort.id }) as Promise<EffortRoster>;
  let requestId = 0;
  /** One command against the roster as it stands, answering the decisions it shows. */
  const say = async (effort: EstablishedEffort, text: string) => {
    const current = await roster(effort);
    const active = work.instruction(effort.id);
    return await rpc("effort_command", { effortId: effort.id, snapshotId: current.snapshotId, text, requestId: `req-${++requestId}`, source: "panel",
      ...active ? { expectedRevision: active.revision } : {}, decisions: current.decisions.map(({ n, revision }) => ({ n, revision })) }) as EffortCommandResult;
  };
  let clock = 0;
  return {
    harness: restarted.harness, db, work, efforts, reconciler, rpc, roster, say, lives, spawn, send, threads, metadata, outputs, hostCalls, lost,
    row: (index: number) => work.row(PR[index]!),
    calls: (method: string) => hostCalls.filter((call) => call.method === method),
    /** A tick a minute, for this many minutes: past the reads' budget of four a minute and each wait's poll. */
    minutes: async (count: number) => {
      for (let minute = 0; minute < count; minute++) {
        vi.setSystemTime(START + ++clock * MINUTE);
        await reconciler.tick();
      }
    },
    /** A worker's turn ends: its thread goes idle with this output, and BB says so. */
    finish: async (threadId: string, output: string) => {
      outputs.set(threadId, output);
      threads.set(threadId, { ...threads.get(threadId)!, status: "idle" });
      await restarted.harness.emitThreadEvent("thread.idle", { thread: threads.get(threadId)!, lastAssistantText: output });
      await new Promise((resolve) => setTimeout(resolve, 10));
    },
  };
}

/**
 * What an admitted unfinished row is doing, by the spec's four outcomes: a scheduled or running authorized action, an external wait
 * naming its owner and wake, a concrete decision with its answer path, or a system repair with its recovery. Any other count is a row
 * the user can't act on or wait out.
 */
function outcomes(row: WorkRow, open: readonly { key: string; targets: string[] }[]): string[] {
  const { phase, body } = row;
  const recovering = phase === "repair-needed" && body.modifiers.includes("recovering");
  return [
    ...(["queued", "executing", "verifying"].includes(phase) || recovering) && body.nextAction !== null && body.wake !== null ? ["action"] : [],
    ...["waiting", "paused", "prepared"].includes(phase) && body.owner !== null && Boolean(body.wake?.event) ? ["wait"] : [],
    ...phase === "decision-needed" && body.decision !== null && body.decision.options.length > 0
      && open.some((decision) => decision.key === body.decision!.key && decision.targets.includes(row.target)) ? ["decision"] : [],
    ...phase === "repair-needed" && !recovering && body.recovery.length > 0 ? ["repair"] : [],
  ];
}

describe("the 22-PR acceptance case", () => {
  // One test runs the whole case, about forty ticks over 23 PRs, which a loaded test run can slow past the default five seconds.
  it("keeps one current row per PR, clears the alias reports with no send, asks the product choice once, and starts or merges nothing unrelated", async () => {
    const env = await acceptance();
    const { "Reader accounts": reader, "Catalog follow-ups": catalog, "Vault audits": vault } = env.efforts;
    const efforts = [reader, catalog, vault];
    const byIndex = (index: number) => PR[index]!;

    // One command naming all 22 in Reader accounts admits nothing, and returns the command for each effort that owns some of them.
    await Promise.all(efforts.map((effort) => env.roster(effort)));
    const crossing = await env.say(reader, `move ${PR.join(", ")} forward`);
    expect(crossing).toMatchObject({ kind: "clarify" });
    const lines = crossing.kind === "clarify" ? crossing.message.split("\n") : [];
    expect(lines[0]).toMatch(/^Nothing was admitted: .* belong to other efforts/u);
    expect(env.db.prepare(`SELECT count(*) AS count FROM effort_pr_work`).get()).toEqual({ count: 0 });
    const part = (name: string) => lines.find((line) => line.startsWith(`${name}: `))!.slice(name.length + 2);
    expect(part("Vault audits")).toBe(`move ${INKWELL_ADVANCE_EFFORTS["Vault audits"].join(", ")} forward`);
    expect(part("Catalog follow-ups")).toBe(`move ${INKWELL_ADVANCE_EFFORTS["Catalog follow-ups"].join(", ")} forward`);
    // Each part, sent in its own effort, is admitted: Reader accounts takes its 3 members and the 15 PRs no effort owns, from outside membership.
    for (const [effort, text] of [[reader, part("Here")], [catalog, part("Catalog follow-ups")], [vault, part("Vault audits")]] as const)
      expect(await env.say(effort, text)).toMatchObject({ kind: "admit" });
    const held = (await env.roster(reader)).rows.find((row) => row.target === byIndex(20))!.n;
    expect(await env.say(reader, `hold ${held} because the gift-wrap copy is still in review`)).toMatchObject({ kind: "admit" });
    const rosters = await Promise.all(efforts.map((effort) => env.roster(effort)));
    expect(rosters.map((item) => [item.effort.name, item.rows.length, item.rows.filter((row) => row.outsideMembership).length]))
      .toEqual([["Reader accounts", 18, 15], ["Catalog follow-ups", 1, 0], ["Vault audits", 3, 0]]);
    expect(new Set(rosters.flatMap((item) => item.rows.map((row) => row.target)))).toEqual(new Set(PR));

    // A dry run plans every step and claims, prepares, starts, sends, and writes nothing.
    await env.reconciler.recoverAll();
    await env.minutes(10);
    const all = () => efforts.flatMap((effort) => env.work.rows(effort.id));
    const openDecisions = () => efforts.flatMap((effort) => env.work.decisions(effort.id)).map((decision) => ({ key: decision.key,
      targets: decision.body.targets.map((item) => item.target) }));
    const unfinished = () => all().filter((row) => row.phase !== "finished");
    const check = () => unfinished().map((row) => [PR.indexOf(row.target), outcomes(row, openDecisions()).length]);
    expect(all()).toHaveLength(22);
    expect(check()).toEqual(unfinished().map((row) => [PR.indexOf(row.target), 1]));
    expect([env.db.prepare(`SELECT count(*) AS count FROM effort_attempts`).get(), env.work.claims(), env.spawn.mock.calls, env.send.mock.calls,
      env.calls("prWrite"), env.calls("advanceWorkspace")]).toEqual([{ count: 0 }, [], [], [], [], []]);
    expect([1, 8].map((index) => env.row(index))).toMatchObject([1, 8].map(() => ({ phase: "queued", body: { nextAction: ["address_review_feedback"], modifiers: ["plan only"] } })));

    // v2 execution on. quill #208's spawn reaches BB, but its answer is lost: that launch is uncertain until BB is read back.
    env.lost.add(byIndex(2));
    await env.harness.setSettings({ v2Execution: "on", workerConcurrency: 3 });
    env.reconciler.due(all().map((row) => row.target));
    await env.minutes(6);

    // The two alias reports clear through the compatibility adapter against the live head and feedback, with no send and no worker.
    expect([1, 8].map((index) => env.row(index)?.phase)).toEqual(["prepared", "prepared"]);
    const adapted = efforts.flatMap((effort) => env.work.notes(effort.id, "legacy-adapter")) as { target: string; saved: boolean; compat: string[] }[];
    expect(adapted.map((note) => [PR.indexOf(note.target), note.saved, note.compat.filter((item) => item.includes("→"))]).sort())
      .toEqual([[1, true, ["finalHeadOid → headOid"]], [8, true, ["approvalFeedbackFingerprint → fingerprint"]]]);
    // The cleared uncertain launch attached to the one worker BB started, and no second one was spawned.
    expect((env.db.prepare(`SELECT count(*) AS count FROM effort_transitions WHERE target = ? AND cause = 'launch-uncertain'`).get(byIndex(2)) as { count: number }).count)
      .toBeGreaterThan(0);
    const quill = env.work.attempts(byIndex(2));
    expect(quill).toMatchObject([{ status: "running", body: { recipes: ["fix_failing_checks"] } }]);
    expect([...env.metadata].filter(([, meta]) => meta.prUrl === byIndex(2)).map(([id]) => id)).toEqual([quill[0]!.threadId]);
    // Work runs only where the instruction authorizes it and a gate needs it: a review thread, failing checks, and conflicts.
    expect(env.spawn.mock.calls.map(([args]) => PR.indexOf(args.pluginMetadata.prUrl)).sort((a, b) => a - b)).toEqual([0, 2, 7]);
    expect(env.send).not.toHaveBeenCalled();
    // The re-request of review runs as code, once, with no model turn.
    expect(env.calls("prWrite").map((call) => call.input)).toEqual([{ kind: "nudge", prUrl: byIndex(12), reviewers: ["bea"], comment: null }]);

    // The worker on atlas #403 pushes a new head, whose checks are running, and stops on a product choice.
    const [atlas] = env.work.attempts(byIndex(7));
    const pushed = "7".repeat(40);
    env.lives.set(byIndex(7), { ...env.lives.get(byIndex(7))!, headOid: pushed, mergeStateStatus: "BLOCKED", mergeable: "MERGEABLE", checks: "pending" });
    const question = "Show a gift card's balance before or after pending holds?";
    await env.finish(atlas!.threadId!, `Integrated main; the balance rule is undecided.\nWorkstreams result v1: ${JSON.stringify({ attemptId: atlas!.id, target: byIndex(7),
      actions: ["integrate_base"], outcome: "blocked", headOid: pushed, baseOid: BASE, blockers: [{ kind: "product-decision", summary: "Two balance rules fit the ticket",
        question, options: [{ id: "a", label: "Before pending holds" }, { id: "b", label: "After pending holds" }], recommendation: "b" }] })}`);
    // spine #152 merges on GitHub, outside v2.
    env.lives.set(byIndex(16), { ...env.lives.get(byIndex(16))!, state: "MERGED" });
    await env.minutes(20);

    // The product choice is one decision, asked once however many passes read it, and every unfinished row has exactly one outcome.
    const decisions = env.work.decisions(reader.id);
    expect(decisions.map((decision) => [decision.n, decision.body.kind, decision.body.question, decision.body.targets.map((item) => PR.indexOf(item.target))]))
      .toEqual([[1, "product", question, [7]]]);
    expect([catalog, vault].flatMap((effort) => env.work.decisions(effort.id))).toEqual([]);
    const midway = Object.fromEntries(unfinished().map((row) => [PR.indexOf(row.target), outcomes(row, openDecisions())]));
    expect(midway).toEqual(Object.fromEntries(unfinished().map((row) => [PR.indexOf(row.target),
      [PR.indexOf(row.target) === 7 ? "decision" : PR.indexOf(row.target) === 13 ? "repair" : [0, 2].includes(PR.indexOf(row.target)) ? "action" : "wait"]])));
    expect(env.row(16)).toMatchObject({ phase: "finished", body: { cause: "merged", userState: "done" } });
    const numbered = (await env.roster(reader)).rows;
    const n = (index: number) => numbered.find((row) => row.target === byIndex(index))!.n;
    expect((await env.roster(reader)).rollup![3]).toBe(`Needs a decision: D1 ${question} (${n(7)})`);

    // Answering it starts a new epoch, and the running checks on the new head are the named wait: never Ready.
    expect(await env.say(reader, "D1 b")).toMatchObject({ kind: "admit" });
    await env.minutes(3);
    expect(env.row(7)).toMatchObject({ phase: "waiting", body: { cause: "ci", owner: { kind: "ci" }, observedHead: pushed } });

    // Every admitted unfinished row now has exactly one outcome, the one its PR's facts call for.
    const expected: Record<number, [phase: string, cause: string]> = {
      0: ["executing", "worker"], 1: ["prepared", "merge-candidate"], 2: ["executing", "worker"], 3: ["waiting", "review"], 4: ["waiting", "parent"],
      5: ["waiting", "legacy-drain"], 6: ["waiting", "ci"], 7: ["waiting", "ci"], 8: ["prepared", "merge-candidate"], 9: ["waiting", "parent"],
      10: ["prepared", "merge-candidate"], 11: ["waiting", "legacy-drain"], 12: ["waiting", "review"], 13: ["repair-needed", "fork"],
      14: ["waiting", "merge-blocked"], 15: ["prepared", "merge-candidate"], 17: ["waiting", "review"], 18: ["waiting", "ci"], 19: ["waiting", "ci"],
      20: ["paused", "hold"], 21: ["waiting", "parent"],
    };
    expect(Object.fromEntries(unfinished().map((row) => [PR.indexOf(row.target), [row.phase, row.body.cause]]))).toEqual(expected);
    expect(check()).toEqual(unfinished().map((row) => [PR.indexOf(row.target), 1]));

    // The counts agree and explain each other: 22 current rows; 37 legacy job rows in 15 batches behind them; v2's attempts; no row runs or dispatch.
    const final = await Promise.all(efforts.map((effort) => env.roster(effort)));
    expect(final.reduce((sum, item) => sum + item.rows.length, 0)).toBe(22);
    expect(final.map((item) => item.history)).toEqual([{ legacyJobs: 30, legacyPrs: 18, v2Attempts: 2 }, { legacyJobs: 1, legacyPrs: 1, v2Attempts: 0 },
      { legacyJobs: 6, legacyPrs: 3, v2Attempts: 1 }]);
    const batches = (env.db.prepare(`SELECT body FROM advance_batches`).all() as { body: string }[]).map(({ body }) => JSON.parse(body) as { jobs: unknown[] });
    expect([batches.length, batches.reduce((sum, batch) => sum + batch.jobs.length, 0)]).toEqual([15, 37]);
    expect(env.db.prepare(`SELECT count(*) AS count FROM effort_attempts`).get()).toEqual({ count: 3 });
    const board = await env.rpc("board_get", null) as Board;
    expect([board.runs, board.dispatch.attempts]).toEqual([[], []]);
    // Each instruction's rollup names what is validated and what remains: a ticket holds only through its PRs being Ready or merged.
    for (const item of final) expect(item.rollup?.map((line) => line.split(":")[0])).toEqual(["Outcome", "Validated", "Still needed", "Needs a decision"]);
    const [readerRollup, catalogRollup, vaultRollup] = final.map((item) => item.rollup!);
    expect(vaultRollup[1]).toBe("Validated: branch current, approved, dependencies merged on 3 PRs; tickets OPS-42");
    expect(vaultRollup[2]).toMatch(/^Still needed: checks, merge: wait: ci \(3\) · CI · wake: check results change; feedback: worker running \(1\)/u);
    expect(catalogRollup[2]).toMatch(/^Still needed: dependencies: wait: parent \(1\) · inkwell\/catalog#95/u);
    expect(readerRollup[1]).toBe("Validated: tickets 4 tickets");
    expect(readerRollup[2]).toContain(`system issue: fork (${n(13)})`);
    expect(readerRollup[2]).toContain(`paused: hold (${n(20)})`);
    expect(readerRollup[3]).toBe("Needs a decision: none");

    // Nothing started on a PR no instruction names, and no merge was written: merging stays a separately authorized action.
    const touched = [...env.spawn.mock.calls.map(([args]) => args.pluginMetadata.prUrl), ...env.hostCalls.filter((call) => ["prWrite", "advanceWorkspace"].includes(call.method))
      .map((call) => call.input.prUrl)];
    expect(touched).not.toContain(UNRELATED);
    expect(env.work.row(UNRELATED)).toBeNull();
    expect(env.calls("prWrite").filter((call) => call.input.kind === "merge")).toEqual([]);
    expect(env.spawn.mock.calls.map(([args]) => PR.indexOf(args.pluginMetadata.prUrl)).sort((a, b) => a - b)).toEqual([0, 2, 7]);
    expect(env.send).not.toHaveBeenCalled();
  }, 30_000);
});
