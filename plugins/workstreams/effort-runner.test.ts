// One writer per PR, checkout, and thread, held by the database; an ambiguous
// launch keeps its claim until BB is read back; a dry run holds and sends
// nothing. A worker's turn completes only by the completion rule, and its
// report only routes: the PR is judged on a fresh read. Every SDK and host call
// here is a test double.
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdvanceFacts, AdvanceWorkspace } from "./advance-contract.js";
import { DEFAULT_EFFECTS, VERBS, type InstructionScope } from "./effort-command.js";
import { decide, type DecideInput, type Next } from "./effort-phase.js";
import type { ResourceInput, ResourceWriter } from "./effort-resources.js";
import { createEffortRunner, type Admission, type AttemptSignal, type V2Execution } from "./effort-runner.js";
import { rowBody } from "./effort-v2-server.js";
import { createEffortWorkStore, decideAttempt, EFFORT_ATTEMPT_MIGRATIONS, EFFORT_DECISION_MIGRATIONS, EFFORT_EXECUTION_MIGRATIONS, EFFORT_INSTRUCTION_MIGRATIONS,
  sameBody, type AttemptBody, type ExecutionMode, type StoredAttempt } from "./effort-work-store.js";
import type { ModelChoice } from "./execution.js";

const START = Date.UTC(2026, 8, 28, 12);
const MINUTE = 60_000;
const EFFORT = "e-shelving";
const HOST = "host_reader";
const PROJECT = "proj_folio";
const SOURCE = "/Users/reader/src/folio";
const AUTHOR = "/Users/reader/src/folio-abc-340";
const LEGACY = "/Users/reader/.bb/plugins/workstreams/worktrees/b-7/inkwell--folio/j-313";
const HEAD = "3".repeat(40);
const url = (number: number) => `https://github.com/inkwell/folio/pull/${number}`;
const PR = url(313);
const codex = (reasoningLevel: ModelChoice["reasoningLevel"]): ModelChoice => ({ providerId: "codex", model: "gpt-6-sol", reasoningLevel });
const MODELS = { code: codex("high"), planning: codex("medium") };

/** A conflicting PR, so the next step is integrate_base. */
const facts = (): AdvanceFacts => ({ prUrl: PR, number: 313, title: "ABC-340 Keep shelf order on reload", repo: "inkwell/folio", headRefName: "abc-340", baseRefName: "main",
  headOid: HEAD, baseOid: "b".repeat(40), state: "OPEN", isDraft: false, isCrossRepository: false, reviewDecision: "APPROVED", mergeStateStatus: "DIRTY",
  mergeable: "CONFLICTING", needsPreparation: true, readiness: "needs-attention", detail: "", unresolvedThreads: 0, threadsComplete: true, checks: "passed",
  basePrNumber: null, approvalFeedback: { status: "none", fingerprint: null, sourceIds: [] } });
const scope: InstructionScope = { revision: 1, exclude: [], removed: [], stopAt: "prepared", reportMode: "changes", outcome: null, criteria: [], answers: [],
  include: [{ target: PR, n: 4, outsideMembership: false, work: [...VERBS["move forward"].work], effects: [...DEFAULT_EFFECTS], reviewers: [], addedInRevision: 1 }] };
const author = { path: AUTHOR, githubRepo: "inkwell/folio", branch: "abc-340", prUrl: PR, projectId: PROJECT, hostId: HOST };
const source = { ...author, path: SOURCE, branch: "main", prUrl: null };
/** The author's clean checkout at the head, with the idle origin thread in it: a reuse. */
const RESOURCES: Omit<ResourceInput, "effortId" | "pr" | "model" | "attempt"> = {
  hostId: HOST, units: [source, author], origin: "thr_origin", linked: [], writers: [], legacy: null, unpushedAllowed: false,
  inspections: new Map([[SOURCE, { ok: true, head: "a".repeat(40), branch: "main", clean: true, commonDir: `${SOURCE}/.git`, relation: "diverged" }],
    [AUTHOR, { ok: true, head: HEAD, branch: "abc-340", clean: true, commonDir: `${SOURCE}/.git`, relation: "at-head" }]]),
  threads: [{ id: "thr_origin", providerId: "codex", status: "idle", archived: false, projectId: PROJECT, hostId: HOST, environmentPath: AUTHOR, updatedAt: 1, contextUsed: 0.3 }],
};
/** No thread in the author's checkout: a new thread there. */
const SPAWN = { ...RESOURCES, threads: [] };
/** No author checkout: a new worktree from the source at the effort's stable key. */
const WORKTREE = { ...RESOURCES, units: [source], threads: [] };

const databases: Database.Database[] = [];
afterEach(() => { databases.splice(0).forEach((db) => db.close()); });

type Options = { execution?: V2Execution; concurrency?: number; resources?: DecideInput["resources"] };
function setup(options: Options = {}) {
  const db = new Database(":memory:");
  databases.push(db);
  [...EFFORT_EXECUTION_MIGRATIONS, ...EFFORT_INSTRUCTION_MIGRATIONS, ...EFFORT_DECISION_MIGRATIONS, ...EFFORT_ATTEMPT_MIGRATIONS].forEach((sql) => db.exec(sql));
  const clock = { now: START };
  const work = createEffortWorkStore(db, () => clock.now);
  work.commit({ effortId: EFFORT, baseRevision: 0, source: "command", instruction: { scope, text: "move 4 forward", source: { kind: "panel", threadId: null, eventId: null },
    snapshotId: null, requestId: "req-1" }, rows: [], journal: null });
  const settings = { execution: options.execution ?? "on", concurrency: options.concurrency ?? 2 };
  const statuses = new Map<string, string>();
  const legacy: { writer: ResourceWriter | null } = { writer: null };
  /** Stored facts each plan reads afresh, which a test moves between planning a step and launching it. `readAt` is the last fresh full read. */
  const world = { held: false, mode: "v2" as ExecutionMode, archived: false, owner: EFFORT, pr: {} as Partial<AdvanceFacts>, readAt: null as number | null };
  /** decide() over a fresh full read of the PR, as the reconciler would call it. */
  const input = (change: { attempts?: DecideInput["attempts"]; writer?: ResourceWriter; admission?: Admission } = {}): DecideInput => ({
    now: clock.now, target: PR, effort: { id: EFFORT, mode: world.mode, archived: world.archived }, ownerId: world.owner, instruction: scope, held: world.held,
    full: { facts: { ...facts(), ...world.pr }, at: world.readAt ?? clock.now - 30_000 }, feedback: null, reviewers: { reviewRequests: [], latestReviews: [{ login: "ada", state: "APPROVED" }] },
    attempts: change.attempts ?? work.attempts(PR).map(decideAttempt), codeActions: [], retryEpoch: work.row(PR)?.body.retryEpoch ?? 0, decision: null, declined: [],
    criteriaPending: false, settledDependencies: new Set(), admission: change.admission ?? { capacityFull: false, breakerOpen: false }, models: MODELS,
    resources: change.writer ? { ...RESOURCES, writers: [change.writer], inspections: null } : { ...options.resources ?? RESOURCES } });
  const body = (step: Next) => rowBody(step, { n: 4, retryEpoch: work.row(PR)?.body.retryEpoch ?? 0, observedHead: HEAD, observedAt: clock.now - 30_000, gates: null, tickets: [] },
    settings.execution);
  const plan = (change: Parameters<typeof input>[0]) => { const step = decide(input(change)); return { phase: step.phase, body: body(step), dueAt: step.wake?.dueAt ?? null }; };
  const sdk = {
    workspace: vi.fn(async (request: { batchId: string; jobId: string }): Promise<AdvanceWorkspace> =>
      ({ ok: true, path: `/Users/reader/.bb/plugins/workstreams/worktrees/${request.batchId}/inkwell--folio/${request.jobId}`, workerPath: "/w", sourcePath: SOURCE, created: true })),
    spawn: vi.fn(async (_args: Record<string, unknown>) => ({ id: "thr_worker" })),
    send: vi.fn(async (_args: Record<string, unknown>, _role: string) => ({ delivery: "sent" })),
    spawned: vi.fn(async (_projectId: string, _attemptId: string): Promise<string[]> => []),
    marked: vi.fn(async (_threadId: string, _marker: string) => false),
    /** The worker's thread: idle, with no turn requests yet, until a test sets its turn. */
    turn: vi.fn(async (_threadId: string) => ({ status: "idle", requests: [] as { seq: number; id: string | null; text: string }[], lastSeq: null as number | null, output: null as string | null })),
    interactions: vi.fn(async (_threadId: string) => 0),
    retrying: vi.fn(async (_threadId: string, _requestId: string | null) => false),
    retry: vi.fn(async (_args: { threadId: string; turnRequestId?: string; sendAt: number }) => ({ ok: true })),
    /** A fresh full read returns the facts the test set, read now. */
    read: vi.fn(async (_prUrl: string): Promise<AdvanceFacts | null> => { world.readAt = clock.now; return { ...facts(), ...world.pr }; }),
    feedback: vi.fn(),
  };
  const writerCalls = vi.fn();
  /** Runs while a launch plans its claim, between its first admission read and its claim's transaction. */
  const hooks: { beforePlan?: () => void } = {};
  const runner = () => createEffortRunner({
    now: () => clock.now, work, settings: async () => settings, models: async () => MODELS,
    writer: (prUrl, path) => { writerCalls(prUrl, path); return legacy.writer; },
    threadStatus: (threadId) => statuses.get(threadId) ?? null,
    plan: async (_effortId, _target, change) => { hooks.beforePlan?.(); return plan(change); },
    settle: async () => {
      const current = work.row(PR)!;
      const next = plan({});
      if (current.phase !== next.phase || !sameBody(current.body, next.body))
        work.commit({ effortId: EFFORT, baseRevision: 1, source: "settle", instruction: null, journal: null, rows: [{ target: PR, expectedRevision: current.revision, ...next }] });
    },
    workspace: (request) => sdk.workspace(request), spawn: (args) => sdk.spawn(args), send: (args, role) => sdk.send(args, role),
    spawned: (projectId, attemptId) => sdk.spawned(projectId, attemptId), marked: (threadId, marker) => sdk.marked(threadId, marker),
    turn: (threadId) => sdk.turn(threadId), interactions: (threadId) => sdk.interactions(threadId), retrying: (threadId, requestId) => sdk.retrying(threadId, requestId),
    retry: (args) => sdk.retry(args), read: (prUrl) => sdk.read(prUrl), feedback: (prUrl, threadId, report) => sdk.feedback(prUrl, threadId, report), publish: () => {},
  });
  const first = runner();
  /** A BB event, then the reconciler's next tick for the attempt that heard it, which takes the attempt's next step. */
  const signal = async (threadId: string, event: AttemptSignal) => {
    const heard = await first.signal(threadId, event);
    const [attempt] = heard ? work.attempts(heard.target) : [];
    if (attempt) await first.advance(attempt.id);
  };
  /** The queued step as the reconciler plans it now, at the revisions it read. */
  const planned = (resource?: Next["resource"]) => {
    const step = decide(input());
    const queued = resource ? { ...step, resource } : step;
    return { effortId: EFFORT, target: PR, baseRevision: work.lastRevision(EFFORT), expectedRevision: work.row(PR)?.revision ?? 0, step: queued, body: body(queued),
      order: { revision: 1, facts: facts(), granted: scope.include[0]!.effects, parentMerged: false, tickets: [], criteria: [], threads: [], answers: [], direction: null } };
  };
  /** Plan the row as the reconciler would, and hand its queued step to a runner. */
  const launch = (by = first, resource?: Next["resource"]) => by.launch(planned(resource));
  const count = (table: string) => (db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count;
  /** Another PR's claim, seeded as its launch would leave it. */
  const other = (id: string, number: number, status: StoredAttempt["status"], patch: Partial<AttemptBody> & { path?: string | null; threadId?: string | null } = {}) => {
    const { path = null, threadId = null, ...rest } = patch;
    const attemptBody: AttemptBody = { instructionRevision: 1, recipes: ["integrate_base"], role: "code", retryEpoch: 0, retryIndex: 0,
      start: { headOid: HEAD, baseOid: "b".repeat(40), fingerprint: null, sourceIds: [] }, resource: { kind: "spawn", threadId, path, hostId: HOST, projectId: PROJECT, reason: null, workspace: null },
      mode: "spawn", marker: `[Workstreams attempt ${id}]`, settledAt: null, uncertainAt: null, emptyReadbackAt: null, failure: null, error: null, releasedReason: null, ...rest };
    work.claim({ id, target: url(number), effortId: EFFORT, instructionId: "I-e-shelving-r1", launchKey: `key-${id}`, threadId, hostId: HOST, path, body: attemptBody });
    if (status !== "launching") work.recordAttempt(id, ["launching"], { status, body: attemptBody });
  };
  return { db, clock, work, settings, statuses, legacy, world, sdk, runner, first, signal, planned, launch, count, other, writerCalls, plan, hooks };
}
const claimOf = (env: ReturnType<typeof setup>) => env.work.claimOn(PR, null);

describe("claiming and launching", () => {
  it("claims the PR, checkout, and thread together with the row, then spawns in the checkout on the code model with no parent", async () => {
    const env = setup({ resources: SPAWN });
    expect(await env.launch()).toBe("launched");
    expect(env.sdk.spawn).toHaveBeenCalledTimes(1);
    const [args] = env.sdk.spawn.mock.calls[0]!;
    const attempt = env.work.attempts(PR)[0]!;
    expect(args).toEqual({ providerId: "codex", model: "gpt-6-sol", reasoningLevel: "high", projectId: PROJECT, title: "inkwell/folio #313",
      prompt: expect.stringMatching(new RegExp(`^\\[Workstreams attempt ${attempt.id} · inkwell/folio#313 · instruction r1\\]\\n`, "u")),
      environment: { type: "host", hostId: HOST, workspace: { type: "unmanaged", path: AUTHOR } },
      pluginMetadata: { workAttemptId: attempt.id, role: "v2-worker", prUrl: PR, effortId: EFFORT } });
    // A child's every outcome would start a turn in the effort parent, so a worker never goes under it.
    expect(args).not.toHaveProperty("parentThreadId");
    expect(attempt).toMatchObject({ status: "running", threadId: "thr_worker", hostId: HOST, path: AUTHOR, body: { mode: "spawn", retryIndex: 0 } });
    expect(env.work.row(PR)).toMatchObject({ phase: "executing", body: { cause: "worker", owner: { kind: "v2-attempt", ref: attempt.id } } });
    // The claim and its row landed in one commit, before the spawn.
    expect(env.db.prepare(`SELECT to_phase AS phase, cause, attempt_id AS attemptId FROM effort_transitions WHERE target = ? ORDER BY seq`).all(PR))
      .toEqual([{ phase: "executing", cause: "launching", attemptId: attempt.id }, { phase: "executing", cause: "worker", attemptId: null }]);
    // The legacy check ran inside the claim, against the PR and the checkout it claims.
    expect(env.writerCalls).toHaveBeenCalledWith(PR, AUTHOR);
  });

  it("sends a reused thread its work order through the role's model, and a report repair on the planning model", async () => {
    const env = setup();
    const queued = env.planned();
    expect(await env.first.launch(queued)).toBe("launched");
    expect(env.sdk.spawn).not.toHaveBeenCalled();
    expect(env.sdk.send).toHaveBeenCalledWith({ threadId: "thr_origin", mode: "queue-if-active", input: [{ type: "text", text: expect.stringContaining("integrate_base"), mentions: [] }] }, "code");
    const worker = env.work.attempts(PR)[0]!;
    env.work.recordAttempt(worker.id, ["running"], { status: "completed", body: worker.body });
    // The worker that did the work re-emits its report in its own thread.
    const step: Next = { ...queued.step, cause: "report-repair", nextAction: ["repair_report"], resource: { kind: "same-thread", threadId: "thr_origin" } };
    expect(await env.first.launch({ ...queued, expectedRevision: env.work.row(PR)!.revision, step })).toBe("launched");
    expect(env.sdk.send.mock.calls.map(([args, role]) => [args.threadId, role])).toEqual([["thr_origin", "code"], ["thr_origin", "planning"]]);
    expect(env.work.attempts(PR)[0]).toMatchObject({ status: "running", path: AUTHOR, body: { recipes: ["repair_report"], role: "planning", mode: "send" } });
  });

  it("in a dry run records the launch it would make, and claims, prepares, starts, and sends nothing", async () => {
    const env = setup({ execution: "dry-run", resources: WORKTREE });
    expect(await env.launch()).toBe("planned");
    expect(env.count("effort_attempts")).toBe(0);
    expect([claimOf(env), env.work.claimOn(null, SOURCE), env.work.claims()]).toEqual([null, null, []]);
    for (const call of Object.values(env.sdk)) expect(call).not.toHaveBeenCalled();
    const planned = env.work.row(PR)!;
    expect(planned).toMatchObject({ phase: "queued", body: { modifiers: ["plan only"], plan: { recipes: ["integrate_base"], role: "code", launchKey: expect.stringMatching(/^[0-9a-f]{64}$/u),
      resource: { kind: "worktree", threadId: null, path: null, hostId: HOST, reason: `no checkout on ${HOST}` } } } });
    // Planning again changes nothing, so a dry run doesn't churn the journal.
    const transitions = env.count("effort_transitions");
    expect(await env.launch()).toBe("planned");
    expect(env.count("effort_transitions")).toBe(transitions);
    // The plan names exactly the launch that execution would claim.
    env.settings.execution = "on";
    expect(await env.launch()).toBe("launched");
    expect(env.work.attempts(PR)[0]!.launchKey).toBe(planned.body.plan!.launchKey);
    expect(env.sdk.workspace).toHaveBeenCalledWith(expect.objectContaining({ batchId: `effort-${EFFORT}`, jobId: "pr-313", sourcePath: SOURCE, reuseOnly: false }));
  });

  it("makes one attempt and one spawn from concurrent launches of the same work, in one instance or two", async () => {
    const env = setup({ resources: SPAWN });
    expect(await Promise.all([env.launch(), env.launch()])).toEqual(["launched", "launched"]);
    expect([env.sdk.spawn.mock.calls.length, env.count("effort_attempts")]).toEqual([1, 1]);

    const race = setup({ resources: SPAWN });
    let finish!: () => void;
    race.sdk.spawn.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({ id: "thr_worker" }); }));
    // Two instances plan the same step from the same revisions; one claims and starts spawning.
    const late = race.planned();
    const winner = race.launch();
    await vi.waitFor(() => expect(race.sdk.spawn).toHaveBeenCalledTimes(1));
    expect(await race.runner().launch(late)).toBe("stale");
    // Even at the row revision it now reads, the other instance's claim holds the PR: it attaches instead of launching.
    expect(await race.runner().launch({ ...late, expectedRevision: race.work.row(PR)!.revision })).toBe("waiting");
    expect(race.work.row(PR)).toMatchObject({ phase: "executing", body: { cause: "launching", nextAction: "attach" } });
    finish();
    expect(await winner).toBe("launched");
    expect([race.sdk.spawn.mock.calls.length, race.count("effort_attempts")]).toEqual([1, 1]);
  });

  it("waits for a legacy reservation found inside the claim, and claims nothing", async () => {
    const env = setup();
    env.legacy.writer = { owner: "legacy-job", ref: "b-7/j-313", path: null };
    expect(await env.launch()).toBe("waiting");
    expect(env.count("effort_attempts")).toBe(0);
    expect(env.work.row(PR)).toMatchObject({ phase: "waiting", body: { cause: "legacy-drain", detail: "Legacy Advance job b-7/j-313 is writing this PR" } });
    expect([env.sdk.spawn, env.sdk.send, env.sdk.workspace].map((call) => call.mock.calls.length)).toEqual([0, 0, 0]);
    // A legacy job reserves the PR while the launch plans its claim: only a check inside the claim's own transaction sees it.
    const race = setup();
    race.hooks.beforePlan = () => { race.hooks.beforePlan = undefined; race.legacy.writer = { owner: "legacy-job", ref: "b-8/j-313", path: null }; };
    expect(await race.launch()).toBe("waiting");
    expect(race.count("effort_attempts")).toBe(0);
    expect(race.work.row(PR)).toMatchObject({ phase: "waiting", body: { cause: "legacy-drain", detail: "Legacy Advance job b-8/j-313 is writing this PR" } });
    expect([race.sdk.spawn, race.sdk.send, race.sdk.workspace].map((call) => call.mock.calls.length)).toEqual([0, 0, 0]);
  });

  it("claims and starts nothing when a hold, a merge, an opt-out, an archive, or a membership move lands after the step was planned", async () => {
    const moves = [[{ held: true }, "paused", "hold"], [{ pr: { state: "MERGED" } }, "finished", "merged"], [{ mode: "legacy" }, "paused", "v2-off"],
      [{ archived: true }, "paused", "archived"], [{ owner: "e-atlas" }, "paused", "membership-moved"]] as const;
    for (const [move, phase, cause] of moves) {
      const env = setup({ resources: SPAWN });
      const queued = env.planned();
      Object.assign(env.world, move);
      // decide() lets a running claim drain through each of these; a launch that hasn't started has nothing to drain, so it never starts.
      expect(await env.first.launch(queued)).toBe("waiting");
      expect([env.count("effort_attempts"), env.sdk.spawn.mock.calls.length, claimOf(env)]).toEqual([0, 0, null]);
      expect(env.work.row(PR)).toMatchObject({ phase, body: { cause, modifiers: [] } });
    }
  });

  it("binds a new worktree's path to the claim once it exists, so that checkout is fenced and the worker starts there", async () => {
    const env = setup({ resources: WORKTREE });
    expect(await env.launch()).toBe("launched");
    const worktree = `/Users/reader/.bb/plugins/workstreams/worktrees/effort-${EFFORT}/inkwell--folio/pr-313`;
    const attempt = env.work.attempts(PR)[0]!;
    expect(attempt).toMatchObject({ status: "running", path: worktree, body: { resource: { kind: "worktree", path: worktree } } });
    expect(env.work.claimOn(null, worktree)?.id).toBe(attempt.id);
    expect(env.sdk.spawn.mock.calls[0]![0]).toMatchObject({ environment: { workspace: { path: worktree } } });
  });

  it("backs off a checkout that couldn't be prepared on its head, reverifies on a new head, and names a repair only after six tries", async () => {
    const env = setup({ resources: WORKTREE });
    env.sdk.workspace.mockRejectedValueOnce(new Error("The host call timed out"));
    expect(await env.launch()).toBe("failed");
    expect(env.work.attempts(PR)[0]).toMatchObject({ status: "failed", body: { failure: "workspace", error: "The host call timed out" } });
    // Nothing started, so it waits and tries again instead of becoming an issue only retry N clears.
    expect(env.work.row(PR)).toMatchObject({ phase: "waiting", dueAt: START + MINUTE, body: { cause: "source-unavailable", userState: "waiting" } });
    expect(claimOf(env)).toBeNull();
    // A new head is new work: GitHub is read after the failure, and the launch is planned again at once.
    env.world.pr = { headOid: "4".repeat(40) };
    expect(env.plan({})).toMatchObject({ phase: "verifying", body: { cause: "observe" } });
    env.clock.now += 31_000;
    expect(env.plan({})).toMatchObject({ phase: "queued", body: { cause: "launching" } });

    // On one head the waits grow, the tries don't count against the recipe's bound, and the sixth failure is a repair.
    const head = setup({ resources: WORKTREE });
    const waits: number[] = [];
    for (let tries = 1; tries <= 6; tries++) {
      head.sdk.workspace.mockResolvedValueOnce({ ok: false, error: "Could not fetch the PR and base: network unreachable" });
      expect(await head.launch()).toBe("failed");
      const row = head.work.row(PR)!;
      if (tries === 6) expect(row).toMatchObject({ phase: "repair-needed", body: { cause: "workspace", recovery: ["retry N"] } });
      else {
        waits.push((row.dueAt! - head.clock.now) / MINUTE);
        head.clock.now = row.dueAt!;
      }
    }
    expect(waits).toEqual([1, 2, 4, 8, 15]);
    expect(head.sdk.spawn).not.toHaveBeenCalled();
  });

  it("waits for another PR's attempt that holds the checkout or the thread, naming it, and starts nothing", async () => {
    const env = setup();
    env.other("A-spine", 150, "running", { path: AUTHOR, threadId: "thr_spine" });
    expect(await env.launch()).toBe("waiting");
    expect(env.work.row(PR)).toMatchObject({ phase: "waiting", body: { cause: "writer-available", detail: "Thread thr_spine is writing this PR" } });
    const thread = setup();
    thread.other("A-quill", 151, "running", { path: "/Users/reader/src/folio-151", threadId: "thr_origin" });
    expect(await thread.launch()).toBe("waiting");
    expect(thread.work.row(PR)).toMatchObject({ body: { cause: "writer-available", detail: "Thread thr_origin is writing this PR" } });
    expect([env.count("effort_attempts"), thread.count("effort_attempts")]).toEqual([1, 1]);
    expect([env, thread].flatMap((item) => [...item.sdk.spawn.mock.calls, ...item.sdk.send.mock.calls])).toEqual([]);
  });

  it("prepares a legacy worktree only in place, moving it to the head, and ends the launch for good when it holds unpushed work", async () => {
    const env = setup();
    const checkout = { path: LEGACY, kind: "worktree" as const, hostId: HOST, projectId: PROJECT, workspace: { batchId: "b-7", jobId: "j-313", sourcePath: SOURCE }, moveCleanToHead: true };
    env.sdk.workspace.mockResolvedValueOnce({ ok: false, error: `The checkout at ${LEGACY} holds unpushed or rewritten commits. It was preserved for inspection.` });
    expect(await env.launch(env.first, { kind: "spawn", checkout, reason: "no idle thread", references: ["thr_legacy"] })).toBe("failed");
    expect(env.sdk.workspace).toHaveBeenCalledWith({ sourcePath: SOURCE, prUrl: PR, expectedHeadOid: HEAD, expectedBaseOid: "b".repeat(40), batchId: "b-7", jobId: "j-313",
      reuseOnly: true, moveCleanToHead: true });
    expect(env.sdk.spawn).not.toHaveBeenCalled();
    expect(env.work.attempts(PR)[0]).toMatchObject({ status: "failed", body: { failure: "unpushed-worktree" } });
    expect([claimOf(env), env.work.row(PR)?.phase, env.work.row(PR)?.body.cause]).toEqual([null, "repair-needed", "unpushed-worktree"]);
  });
});

describe("launch recovery", () => {
  it("keeps an ambiguous spawn's claim as uncertain, and after a reload attaches the one thread readback finds", async () => {
    const env = setup({ resources: SPAWN });
    env.sdk.spawn.mockRejectedValueOnce(new Error("socket hang up"));
    expect(await env.launch()).toBe("uncertain");
    const attempt = env.work.attempts(PR)[0]!;
    expect(attempt).toMatchObject({ status: "uncertain", body: { settledAt: START, uncertainAt: START, error: "socket hang up" } });
    expect(claimOf(env)?.id).toBe(attempt.id);
    expect(env.work.row(PR)).toMatchObject({ phase: "repair-needed", body: { cause: "launch-uncertain", modifiers: ["recovering"], nextAction: "recover-launch" } });
    // A reloaded runner never launches it again: it reads BB back by the spawn metadata.
    env.sdk.spawned.mockResolvedValueOnce(["thr_found"]);
    await env.runner().recover(attempt.id);
    expect(env.sdk.spawned).toHaveBeenCalledWith(PROJECT, attempt.id);
    expect(env.work.attempt(attempt.id)).toMatchObject({ status: "running", threadId: "thr_found", body: { failure: null } });
    expect(env.sdk.spawn).toHaveBeenCalledTimes(1);
  });

  it("releases a claim only when two complete readbacks a minute apart after the call settled find no worker, and requeues it once", async () => {
    const env = setup({ resources: SPAWN });
    const lose = async () => {
      env.sdk.spawn.mockRejectedValueOnce(new Error("request timed out"));
      expect(await env.launch()).toBe("uncertain");
      const { id } = env.work.attempts(PR)[0]!;
      await env.first.recover(id);
      env.clock.now += 30_000;
      await env.first.recover(id);
      // Time alone never proves there is no worker: under a minute between empty reads keeps the claim.
      expect(env.work.attempt(id)).toMatchObject({ status: "uncertain" });
      env.clock.now += 31_000;
      await env.first.recover(id);
      return env.work.attempt(id)!;
    };
    const first = await lose();
    expect(first).toMatchObject({ status: "released", body: { releasedReason: "no-worker", retryIndex: 0 } });
    expect(claimOf(env)).toBeNull();
    const requeued = env.plan({});
    expect([requeued.phase, requeued.body.cause]).toEqual(["queued", "launching"]);
    // The requeued launch is new work: a new index and launch key, never the old claim reused.
    const second = await lose();
    expect(second).toMatchObject({ status: "released", body: { retryIndex: 1 } });
    expect(second.launchKey).not.toBe(first.launchKey);
    expect(env.sdk.spawned).toHaveBeenCalledTimes(6);
    // Neither lost launch counted as an attempt; losing a second one on the same work ends the requeues.
    const exhausted = env.plan({});
    expect([exhausted.phase, exhausted.body.cause, exhausted.body.detail]).toEqual(["repair-needed", "retry-exhausted",
      "integrate_base launched twice on this head and readback found no worker either time"]);
    expect(env.sdk.spawn).toHaveBeenCalledTimes(2);
  });

  it("names a duplicate writer when readback finds more than one thread, and keeps the claim", async () => {
    const env = setup({ resources: SPAWN });
    env.sdk.spawn.mockRejectedValueOnce(new Error("socket hang up"));
    await env.launch();
    const { id } = env.work.attempts(PR)[0]!;
    env.sdk.spawned.mockResolvedValueOnce(["thr_one", "thr_two"]);
    await env.first.recover(id);
    expect(env.work.attempt(id)).toMatchObject({ status: "uncertain", body: { failure: "duplicate-writer", error: `Threads thr_one, thr_two answer to ${id}.` } });
    expect(claimOf(env)?.id).toBe(id);
    const row = env.plan({});
    expect([row.phase, row.body.cause, row.body.userState, row.body.recovery]).toEqual(["repair-needed", "duplicate-writer", "issue", ["reset N release"]]);
  });

  it("resolves a send timeout by the marker in the thread's turn requests, without sending twice", async () => {
    const env = setup();
    env.sdk.send.mockRejectedValueOnce(Object.assign(new Error("The operation timed out"), { status: 504 }));
    expect(await env.launch()).toBe("uncertain");
    const attempt = env.work.attempts(PR)[0]!;
    env.sdk.marked.mockResolvedValueOnce(true);
    await env.runner().recover(attempt.id);
    expect(env.sdk.marked).toHaveBeenCalledWith("thr_origin", attempt.body.marker);
    expect(env.work.attempt(attempt.id)).toMatchObject({ status: "running", threadId: "thr_origin" });
    expect(env.sdk.send).toHaveBeenCalledTimes(1);
  });

  it("keeps the claim and waits when BB can't be read back", async () => {
    const env = setup({ resources: SPAWN });
    env.sdk.spawn.mockRejectedValueOnce(new Error("socket hang up"));
    await env.launch();
    const { id } = env.work.attempts(PR)[0]!;
    env.sdk.spawned.mockRejectedValueOnce(new Error("BB is restarting"));
    await env.first.recover(id);
    expect(env.work.attempt(id)).toMatchObject({ status: "uncertain", body: { failure: "source-unavailable", emptyReadbackAt: null } });
    const row = env.plan({});
    expect([row.phase, row.body.cause]).toEqual(["waiting", "source-unavailable"]);
  });

  it("treats HTTP 409 for a project source with no usable git branch as definitive: no readback, no claim, a named repair", async () => {
    // BB states the 409 as the error's status or only in its message; both are the same refusal.
    for (const error of [Object.assign(new Error("Project source has no usable git branch"), { status: 409 }), new Error("HTTP 409: Project source has no usable git branch")]) {
      const env = setup({ resources: SPAWN });
      env.sdk.spawn.mockRejectedValueOnce(error);
      expect(await env.launch()).toBe("failed");
      const attempt = env.work.attempts(PR)[0]!;
      expect(attempt).toMatchObject({ status: "failed", body: { failure: "project-source" } });
      await env.first.recover(attempt.id);
      expect([env.sdk.spawned, env.sdk.marked].map((call) => call.mock.calls.length)).toEqual([0, 0]);
      expect([claimOf(env), env.work.row(PR)?.phase, env.work.row(PR)?.body.cause]).toEqual([null, "repair-needed", "project-source"]);
    }
  });

  it("starts nothing for a claim released while its checkout was prepared", async () => {
    const env = setup();
    const checkout = { path: LEGACY, kind: "worktree" as const, hostId: HOST, projectId: PROJECT, workspace: { batchId: "b-7", jobId: "j-313", sourcePath: SOURCE }, moveCleanToHead: true };
    let prepared!: () => void;
    env.sdk.workspace.mockImplementationOnce(() => new Promise((resolve) => { prepared = () => resolve({ ok: true, path: LEGACY, workerPath: "/w", sourcePath: SOURCE, created: false }); }));
    const launching = env.launch(env.first, { kind: "spawn", checkout, reason: "no idle thread", references: [] });
    await vi.waitFor(() => expect(env.sdk.workspace).toHaveBeenCalled());
    // The server refuses `reset 4 release` while this process is launching it; a reloaded instance can't see this launch, and releases it.
    expect(env.first.launching(PR)).toBe(true);
    env.db.transaction(() => env.work.release(PR))();
    prepared();
    expect(await launching).toBe("stale");
    expect(env.sdk.spawn).not.toHaveBeenCalled();
    expect([env.work.attempts(PR)[0]?.status, env.first.launching(PR)]).toEqual(["released", false]);
  });

  it("keeps what BB answers for a launch another instance released while the call was out, so the work never starts twice", async () => {
    const lose = async (answer: "thread" | "throw", requeue: boolean) => {
      const env = setup({ resources: SPAWN });
      let finish!: () => void;
      env.sdk.spawn.mockImplementationOnce(() => new Promise((resolve, reject) => {
        finish = () => answer === "thread" ? resolve({ id: "thr_worker" }) : reject(new Error("socket hang up"));
      }));
      const launching = env.launch();
      await vi.waitFor(() => expect(env.sdk.spawn).toHaveBeenCalled());
      const { id } = env.work.attempts(PR)[0]!;
      // A reloaded instance can't see this spawn: it marks the launch uncertain and, after two empty reads a minute apart, releases it.
      const other = env.runner();
      await other.recover(id);
      env.clock.now += 61_000;
      await other.recover(id);
      expect(env.work.attempt(id)?.status).toBe("released");
      if (requeue) {
        env.sdk.spawn.mockResolvedValueOnce({ id: "thr_second" });
        expect(await other.launch(env.planned())).toBe("launched");
      }
      finish();
      return { env, id, outcome: await launching };
    };
    // The thread BB returned proves the worker: the claim is back, and the row attaches to it instead of launching again.
    const landed = await lose("thread", false);
    expect(landed.outcome).toBe("launched");
    expect(landed.env.work.attempt(landed.id)).toMatchObject({ status: "running", threadId: "thr_worker" });
    expect(landed.env.plan({})).toMatchObject({ phase: "executing", body: { cause: "worker", owner: { kind: "v2-attempt", ref: landed.id } } });
    expect(landed.env.sdk.spawn).toHaveBeenCalledTimes(1);
    // An ambiguous answer reopens the question: the claim is uncertain again until readback settles it.
    const threw = await lose("throw", false);
    expect(threw.outcome).toBe("uncertain");
    expect(threw.env.work.attempt(threw.id)).toMatchObject({ status: "uncertain", body: { releasedReason: null, emptyReadbackAt: null } });
    // A later launch took the PR first: the thread stays on the released attempt as a duplicate writer, never dropped.
    const taken = await lose("thread", true);
    expect(taken.outcome).toBe("stale");
    expect(taken.env.work.attempt(taken.id)).toMatchObject({ status: "released", threadId: "thr_worker", body: { failure: "duplicate-writer",
      error: "BB answered after this launch was released, and a later launch holds its PR, checkout, or thread now." } });
    expect(taken.env.work.claims().map((attempt) => attempt.threadId)).toEqual(["thr_second"]);
  });

  it("recovers a launch a stopped process left launching, but never one this process is still making", async () => {
    const env = setup({ resources: SPAWN });
    let finish!: () => void;
    env.sdk.spawn.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({ id: "thr_worker" }); }));
    const launching = env.launch();
    await vi.waitFor(() => expect(env.sdk.spawn).toHaveBeenCalled());
    const { id } = env.work.attempts(PR)[0]!;
    await env.first.recover(id);
    expect(env.work.attempt(id)?.status).toBe("launching");
    // Another process (a restart) finds it launching with no one finishing it: it is uncertain from then on.
    await env.runner().recover(id);
    expect(env.work.attempt(id)).toMatchObject({ status: "uncertain", body: { settledAt: START, emptyReadbackAt: START } });
    // Then BB answers: the thread it returned attaches the launch, and nothing launches again.
    finish();
    expect(await launching).toBe("launched");
    expect(env.work.attempt(id)).toMatchObject({ status: "running", threadId: "thr_worker" });
    expect(env.sdk.spawn).toHaveBeenCalledTimes(1);
  });
});

describe("launch admission", () => {
  it("stops launches at two uncertain attempts, or after three launches in a row went uncertain, and clears once readback resolves them", async () => {
    const env = setup({ resources: SPAWN });
    env.other("A-150", 150, "uncertain", { uncertainAt: START - MINUTE, settledAt: START - MINUTE });
    env.other("A-151", 151, "uncertain", { uncertainAt: START - MINUTE, settledAt: START - MINUTE });
    expect(await env.first.admission()).toEqual({ capacityFull: false, breakerOpen: true });
    expect(await env.launch()).toBe("waiting");
    expect(env.work.row(PR)).toMatchObject({ phase: "waiting", body: { cause: "launch-breaker", detail: "Launch outcomes uncertain; new launches paused" } });
    expect(env.sdk.spawn).not.toHaveBeenCalled();
    env.sdk.spawned.mockResolvedValueOnce(["thr_150"]);
    await env.first.recover("A-150");
    expect(await env.first.admission()).toEqual({ capacityFull: false, breakerOpen: false });

    // Three launches in a row went uncertain within half an hour; one still is, so nothing new starts until it resolves.
    const streak = setup({ resources: SPAWN });
    streak.other("A-160", 160, "running", { uncertainAt: START - 20 * MINUTE });
    streak.clock.now += 1;
    streak.other("A-161", 161, "released", { uncertainAt: START - 10 * MINUTE, releasedReason: "no-worker" });
    streak.clock.now += 1;
    streak.other("A-162", 162, "uncertain", { uncertainAt: START - MINUTE, settledAt: START - MINUTE });
    expect(await streak.first.admission()).toMatchObject({ breakerOpen: true });
    streak.sdk.spawned.mockResolvedValueOnce(["thr_162"]);
    await streak.first.recover("A-162");
    expect(await streak.first.admission()).toMatchObject({ breakerOpen: false });
    // The same run of uncertain launches an hour ago no longer counts.
    const old = setup();
    old.other("A-170", 170, "released", { uncertainAt: START - 90 * MINUTE });
    old.other("A-171", 171, "released", { uncertainAt: START - 80 * MINUTE });
    old.other("A-172", 172, "uncertain", { uncertainAt: START - 70 * MINUTE });
    expect(await old.first.admission()).toMatchObject({ breakerOpen: false });
  });

  it("holds launches at the configured worker count, counting active worker threads but not idle or uncertain ones", async () => {
    const env = setup({ resources: SPAWN, concurrency: 1 });
    env.other("A-150", 150, "running", { threadId: "thr_150" });
    env.statuses.set("thr_150", "active");
    expect(await env.launch()).toBe("waiting");
    expect(env.work.row(PR)).toMatchObject({ phase: "waiting", body: { cause: "capacity" } });
    // The worker went idle without reporting yet: its slot is free, though its claim on its own PR holds.
    env.statuses.set("thr_150", "idle");
    expect(await env.launch()).toBe("launched");
    const uncertain = setup({ resources: SPAWN, concurrency: 1 });
    uncertain.other("A-151", 151, "uncertain", { uncertainAt: START });
    expect(await uncertain.launch()).toBe("launched");
    // Another launch takes the last slot while this one plans its claim: the claim's own transaction reads the slots again.
    const race = setup({ resources: SPAWN, concurrency: 1 });
    race.hooks.beforePlan = () => { race.hooks.beforePlan = undefined; race.other("A-153", 153, "launching"); };
    expect(await race.launch()).toBe("waiting");
    expect(race.work.row(PR)).toMatchObject({ phase: "waiting", body: { cause: "capacity" } });
    expect([race.sdk.spawn.mock.calls, race.work.claims().map((attempt) => attempt.id)]).toEqual([[], ["A-153"]]);
    // Raising the setting admits more at once.
    const two = setup({ resources: SPAWN, concurrency: 2 });
    two.other("A-152", 152, "running", { threadId: "thr_152" });
    two.statuses.set("thr_152", "active");
    expect(await two.launch()).toBe("launched");
  });
});

describe("worker results and SDK signals", () => {
  const NEXT = "4".repeat(40);
  const BASE = "b".repeat(40);
  /** GitHub after the worker rebased and pushed: mergeable, still approved, checks running on the new head. */
  const pushed: Partial<AdvanceFacts> = { headOid: NEXT, mergeStateStatus: "BLOCKED", mergeable: "MERGEABLE", checks: "pending" };
  const result = (attemptId: string, patch: Record<string, unknown> = {}) =>
    `Workstreams result v1: ${JSON.stringify({ attemptId, target: PR, actions: ["integrate_base"], outcome: "changed", headOid: NEXT, baseOid: BASE, ...patch })}`;
  /** Send the work order to the idle origin thread, then let its turn end with this output. */
  async function finished(env: ReturnType<typeof setup>, output: (attemptId: string) => string | null) {
    expect(await env.launch()).toBe("launched");
    const attempt = env.work.attempts(PR)[0]!;
    env.sdk.turn.mockResolvedValue({ status: "idle", requests: [{ seq: 12, id: "req-12", text: `${attempt.body.marker}\nPrepare exactly one PR toward merge.` }], lastSeq: 30, output: output(attempt.id) });
    return attempt;
  }

  it("reads a changed report against a fresh read of GitHub, where checks still running make the row wait on CI", async () => {
    const env = setup();
    const attempt = await finished(env, (id) => `Rebased onto main and pushed.\n${result(id)}`);
    env.world.pr = pushed;
    env.clock.now += 20 * MINUTE;
    await env.signal("thr_origin", { kind: "idle" });
    expect(env.sdk.read).toHaveBeenCalledWith(PR);
    expect(env.work.attempt(attempt.id)).toMatchObject({ status: "completed", body: { endedAt: env.clock.now, report: { source: "v1", key: "changed", rejection: null, headOid: NEXT } } });
    // The report only routed the row back to the gates; running checks on the pushed head are a CI wait, not Ready.
    expect(env.work.row(PR)).toMatchObject({ phase: "waiting", body: { cause: "ci", owner: { kind: "ci" } } });
    expect([claimOf(env), env.sdk.spawn.mock.calls.length, env.sdk.send.mock.calls.length]).toEqual([null, 0, 1]);
  });

  it("never takes prose that says ready to merge as Ready: an idle turn with no result line asks the worker to re-emit its report", async () => {
    for (const output of ["All review feedback is addressed and checks pass. This PR is ready to merge!", null]) {
      const env = setup();
      const attempt = await finished(env, () => output);
      // GitHub shows a merge candidate, and still a report that can't be read never clears the row.
      env.world.pr = { headOid: NEXT, mergeStateStatus: "CLEAN", mergeable: "MERGEABLE", checks: "passed" };
      await env.signal("thr_origin", { kind: "idle" });
      expect(env.work.attempt(attempt.id)).toMatchObject({ status: "completed",
        body: { report: { key: "report-invalid", rejection: "The output has no Workstreams result line.", raw: output ?? "" } } });
      expect(env.work.row(PR)).toMatchObject({ phase: "queued", body: { cause: "report-repair", nextAction: ["repair_report"] } });
    }
  });

  it("records each older field name the adapter reads, and rejects one that doesn't name the live head", async () => {
    const env = setup();
    const attempt = await finished(env, (id) => result(id, { headOid: undefined, finalHeadOid: NEXT }));
    env.world.pr = pushed;
    await env.signal("thr_origin", { kind: "idle" });
    expect(env.work.attempt(attempt.id)?.body.report).toMatchObject({ key: "changed", rejection: null, compat: ["finalHeadOid → headOid"], headOid: NEXT });
    const stale = setup();
    const other = await finished(stale, (id) => result(id, { headOid: undefined, finalHeadOid: "5".repeat(40) }));
    stale.world.pr = pushed;
    await stale.signal("thr_origin", { kind: "idle" });
    expect(stale.work.attempt(other.id)?.body.report).toMatchObject({ key: "report-invalid", compat: [], rejection: "finalHeadOid 555555555555 isn't the live headOid 444444444444." });
  });

  it("completes a turn only once a turn request carries its marker, keeps where it began and ended, and reads the latest output past your own prompt", async () => {
    const env = setup();
    expect(await env.launch()).toBe("launched");
    const attempt = env.work.attempts(PR)[0]!;
    // The thread went idle from an earlier turn while the work order still waited in its queue: not this attempt's turn.
    env.sdk.turn.mockResolvedValue({ status: "idle", requests: [{ seq: 9, id: "req-9", text: "What changed on the shelf?" }], lastSeq: 11, output: "The shelf order changed." });
    await env.signal("thr_origin", { kind: "idle" });
    expect(env.work.attempt(attempt.id)?.status).toBe("running");
    expect(env.sdk.read).not.toHaveBeenCalled();
    // You prompted the thread after the work order: the latest output is read anyway.
    env.sdk.turn.mockResolvedValue({ status: "idle", lastSeq: 57, output: `Also reran the shelf tests.\n${result(attempt.id)}`,
      requests: [{ seq: 41, id: "req-41", text: "Also rerun the shelf tests." }, { seq: 12, id: "req-12", text: attempt.body.marker }, { seq: 9, id: "req-9", text: "What changed on the shelf?" }] });
    env.world.pr = pushed;
    await env.signal("thr_origin", { kind: "idle" });
    expect(env.work.attempt(attempt.id)).toMatchObject({ status: "completed", body: { startSeq: 12, endSeq: 57, report: { key: "changed" } } });
  });

  it("reverifies on fresh facts when the base moved after the worker finished, instead of rejecting its report", async () => {
    const env = setup();
    const attempt = await finished(env, (id) => result(id));
    // main moved on after the rebase: GitHub now shows the pushed head behind a new base.
    env.world.pr = { headOid: NEXT, baseOid: "c".repeat(40), mergeStateStatus: "BEHIND", mergeable: "MERGEABLE", checks: "passed" };
    await env.signal("thr_origin", { kind: "idle" });
    expect(env.work.attempt(attempt.id)?.body.report).toMatchObject({ key: "changed", rejection: null, baseMoved: true });
    // The fresh gates find the branch behind, so integrating the base is queued again, for the new head.
    expect(env.work.row(PR)).toMatchObject({ phase: "queued", body: { cause: "launching", nextAction: ["integrate_base"] } });
  });

  it("asks you to answer a worker waiting on input in its thread, and returns the row to executing once its interactions clear", async () => {
    const env = setup();
    expect(await env.launch()).toBe("launched");
    const attempt = env.work.attempts(PR)[0]!;
    env.sdk.interactions.mockResolvedValue(1);
    await env.signal("thr_origin", { kind: "interaction" });
    expect(env.work.row(PR)).toMatchObject({ phase: "decision-needed", body: { cause: "worker-interaction",
      decision: { key: `worker-interaction:${attempt.id}`, answer: "open-thread", options: [{ id: "open", label: "Open thread" }] } } });
    // The thread's events move while you answer; the row asks until none is pending.
    await env.signal("thr_origin", { kind: "events" });
    expect(env.work.row(PR)?.phase).toBe("decision-needed");
    env.sdk.interactions.mockResolvedValue(0);
    await env.signal("thr_origin", { kind: "events" });
    expect(env.work.row(PR)).toMatchObject({ phase: "executing", body: { cause: "worker", owner: { kind: "v2-attempt", ref: attempt.id } } });
    // Once nothing is pending, the thread's events read nothing more.
    const reads = env.sdk.interactions.mock.calls.length;
    await env.signal("thr_origin", { kind: "events" });
    expect(env.sdk.interactions).toHaveBeenCalledTimes(reads);
  });

  it("releases an attempt whose queued work order you deleted, pauses its row, and never reads a later turn in that thread as its result", async () => {
    const env = setup();
    expect(await env.launch()).toBe("launched");
    const attempt = env.work.attempts(PR)[0]!;
    // Another message deleted from the same queue isn't ours.
    await env.signal("thr_origin", { kind: "cancelled", text: "Also rerun the shelf tests." });
    expect(env.work.attempt(attempt.id)?.status).toBe("running");
    await env.signal("thr_origin", { kind: "cancelled", text: `${attempt.body.marker}\nPrepare exactly one PR toward merge.` });
    expect(env.work.attempt(attempt.id)).toMatchObject({ status: "released", body: { releasedReason: "user-cancelled" } });
    expect(claimOf(env)).toBeNull();
    expect(env.work.row(PR)).toMatchObject({ phase: "paused", body: { cause: "user-cancelled" } });
    // A later turn in that thread, even one naming the marker with a valid report, is never this attempt's result.
    env.sdk.turn.mockResolvedValue({ status: "idle", requests: [{ seq: 20, id: "req-20", text: attempt.body.marker }], lastSeq: 25, output: result(attempt.id) });
    await env.signal("thr_origin", { kind: "idle" });
    expect(env.work.attempt(attempt.id)).toMatchObject({ status: "released", body: { releasedReason: "user-cancelled" } });
    expect(env.work.attempt(attempt.id)?.body.report).toBeUndefined();
    expect([env.sdk.turn.mock.calls.length, env.sdk.read.mock.calls.length, env.work.row(PR)?.body.cause]).toEqual([0, 0, "user-cancelled"]);
  });

  it("retries a failed turn when its rate limit resets, at most twice, leaves a retry core queued alone, then names a system issue", async () => {
    const env = setup();
    expect(await env.launch()).toBe("launched");
    const attempt = env.work.attempts(PR)[0]!;
    const reset = START + 45 * MINUTE;
    const limited = { status: "blocked", windows: [{ status: "blocked", resetsAtMs: reset }, { status: "allowed", resetsAtMs: START + 300 * MINUTE }] };
    await env.signal("thr_origin", { kind: "turn-failed", requestId: "req-1", rateLimits: limited });
    expect(env.sdk.retry).toHaveBeenLastCalledWith({ threadId: "thr_origin", turnRequestId: "req-1", sendAt: reset });
    expect(env.work.attempt(attempt.id)).toMatchObject({ status: "running", body: { turnRetries: 1, turnFailure: null } });
    expect(env.work.row(PR)).toMatchObject({ phase: "executing", body: { cause: "worker" } });
    // Core queued its own retry of the next failure: v2 asks for none, and spends none of its bound.
    env.sdk.retrying.mockResolvedValueOnce(true);
    await env.signal("thr_origin", { kind: "turn-failed", requestId: "req-2", rateLimits: null });
    expect(env.sdk.retry).toHaveBeenCalledTimes(1);
    expect(env.work.attempt(attempt.id)?.body).toMatchObject({ turnRetries: 1, turnFailure: null });
    // With no rate limit to wait out, the retry goes a minute later; an answer that is lost still spends it.
    env.sdk.retry.mockRejectedValueOnce(new Error("socket hang up"));
    await env.signal("thr_origin", { kind: "turn-failed", requestId: "req-3", rateLimits: null });
    expect(env.sdk.retry).toHaveBeenLastCalledWith({ threadId: "thr_origin", turnRequestId: "req-3", sendAt: START + MINUTE });
    expect(env.work.attempt(attempt.id)?.body).toMatchObject({ turnRetries: 2, turnFailure: { requestId: "req-3" }, error: "socket hang up" });
    // The bound is spent: no more retries, and the failure is a system issue. The attempt ends, so its claim goes and retry N can start anew.
    await env.signal("thr_origin", { kind: "turn-failed", requestId: "req-4", rateLimits: null });
    expect(env.sdk.retry).toHaveBeenCalledTimes(2);
    expect(env.work.attempt(attempt.id)).toMatchObject({ status: "failed", body: { failure: "turn-failed", turnFailure: null } });
    expect(claimOf(env)).toBeNull();
    expect(env.work.row(PR)).toMatchObject({ phase: "repair-needed", body: { cause: "turn-failed", userState: "issue", recovery: ["retry N"] } });
  });

  it("asks BB for no retry in a dry run, even for a claim made while execution was on, and asks once execution is on again", async () => {
    const env = setup();
    expect(await env.launch()).toBe("launched");
    const attempt = env.work.attempts(PR)[0]!;
    env.settings.execution = "dry-run";
    await env.signal("thr_origin", { kind: "turn-failed", requestId: "req-1", rateLimits: null });
    expect(env.sdk.retry).not.toHaveBeenCalled();
    expect(env.work.attempt(attempt.id)?.body).toMatchObject({ turnFailure: { requestId: "req-1" } });
    expect(env.work.attempt(attempt.id)?.body.turnRetries ?? 0).toBe(0);
    env.settings.execution = "on";
    await env.first.advance(attempt.id);
    expect(env.sdk.retry).toHaveBeenCalledWith({ threadId: "thr_origin", turnRequestId: "req-1", sendAt: START + MINUTE });
  });

  it("retries a turn whose failure no event reported, as across a reload, unless a retry is already queued", async () => {
    const env = setup();
    expect(await env.launch()).toBe("launched");
    const attempt = env.work.attempts(PR)[0]!;
    // The thread landed in error while nothing listened; core had queued its own retry.
    env.sdk.turn.mockResolvedValue({ status: "error", requests: [{ seq: 12, id: "req-12", text: attempt.body.marker }], lastSeq: 13, output: null });
    env.sdk.retrying.mockResolvedValueOnce(true);
    await env.first.advance(attempt.id);
    expect([env.work.attempt(attempt.id)?.body.turnFailure ?? null, env.sdk.retry.mock.calls.length]).toEqual([null, 0]);
    // With no retry queued, the error is the failure turn.failed would have reported, retried within the same bound.
    await env.first.advance(attempt.id);
    expect(env.sdk.retrying).toHaveBeenLastCalledWith("thr_origin", "req-12");
    expect(env.work.row(PR)).toMatchObject({ phase: "repair-needed", body: { cause: "turn-retry", nextAction: "retry-turn" } });
    env.sdk.retry.mockImplementationOnce(async () => { env.sdk.retrying.mockResolvedValue(true); return { ok: true }; });
    await env.first.advance(attempt.id);
    expect(env.sdk.retry).toHaveBeenCalledWith({ threadId: "thr_origin", turnRequestId: "req-12", sendAt: START + MINUTE });
    // Its retry waits in the queue, so the thread still in error is no new failure.
    await env.first.advance(attempt.id);
    expect(env.sdk.retry).toHaveBeenCalledTimes(1);
    expect(env.work.attempt(attempt.id)?.body).toMatchObject({ turnRetries: 1, turnFailure: null });
  });

  it("reads no failure into the retry it just asked for, though the thread still shows the error beside the retry's turn request", async () => {
    const env = setup();
    expect(await env.launch()).toBe("launched");
    const attempt = env.work.attempts(PR)[0]!;
    env.sdk.turn.mockResolvedValue({ status: "error", lastSeq: 15, output: null,
      requests: [{ seq: 14, id: "req-14", text: "Retry of req-12" }, { seq: 12, id: "req-12", text: attempt.body.marker }] });
    await env.signal("thr_origin", { kind: "turn-failed", requestId: "req-12", rateLimits: null });
    expect(env.sdk.retry).toHaveBeenCalledTimes(1);
    expect(env.work.attempt(attempt.id)?.body).toMatchObject({ turnRetries: 1, turnFailure: null });
  });

  it("releases a work order you deleted from the queue while no event reached us, once two reads a minute apart find it neither queued nor in a turn", async () => {
    const env = setup();
    expect(await env.launch()).toBe("launched");
    const attempt = env.work.attempts(PR)[0]!;
    expect(attempt.body.mode).toBe("send");
    env.sdk.turn.mockResolvedValue({ status: "idle", requests: [{ seq: 9, id: "req-9", text: "What changed on the shelf?" }], lastSeq: 11, output: "The shelf order changed." });
    await env.first.advance(attempt.id);
    expect(env.work.attempt(attempt.id)).toMatchObject({ status: "running", body: { emptyReadbackAt: START } });
    // Still queued on the next read: one read can fall between the queue and the turn request, so nothing is released.
    env.clock.now += 2 * MINUTE;
    env.sdk.marked.mockResolvedValueOnce(true);
    await env.first.advance(attempt.id);
    expect(env.work.attempt(attempt.id)).toMatchObject({ status: "running", body: { emptyReadbackAt: null } });
    await env.first.advance(attempt.id);
    env.clock.now += 30_000;
    await env.first.advance(attempt.id);
    expect(env.work.attempt(attempt.id)?.status).toBe("running");
    env.clock.now += 30_000;
    await env.first.advance(attempt.id);
    expect(env.work.attempt(attempt.id)).toMatchObject({ status: "released", body: { releasedReason: "user-cancelled" } });
    expect(claimOf(env)).toBeNull();
    expect(env.work.row(PR)).toMatchObject({ phase: "paused", body: { cause: "user-cancelled" } });
  });

  it("keeps a signal recorded while a failed turn's retry waited on BB", async () => {
    const env = setup();
    expect(await env.launch()).toBe("launched");
    const attempt = env.work.attempts(PR)[0]!;
    env.sdk.interactions.mockResolvedValue(1);
    let answer!: (moved: boolean) => void;
    env.sdk.retrying.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const failing = env.signal("thr_origin", { kind: "turn-failed", requestId: "req-1", rateLimits: null });
    await vi.waitFor(() => expect(env.sdk.retrying).toHaveBeenCalled());
    await env.first.signal("thr_origin", { kind: "interaction" });
    answer(false);
    await failing;
    expect(env.work.attempt(attempt.id)?.body).toMatchObject({ interactionPending: true, turnRetries: 1, turnFailure: null });
    expect(env.work.row(PR)).toMatchObject({ phase: "decision-needed", body: { cause: "worker-interaction" } });
  });

  it("reads the latest report again on recheck, so a report GitHub couldn't confirm yet is adapted once it can", async () => {
    const env = setup();
    const attempt = await finished(env, (id) => result(id, { headOid: undefined, finalHeadOid: NEXT }));
    // The turn ended before GitHub showed the pushed head, so the older field name couldn't be checked against it.
    await env.signal("thr_origin", { kind: "idle" });
    expect(env.work.attempt(attempt.id)?.body.report).toMatchObject({ key: "report-invalid", rejection: expect.stringContaining("isn't the live headOid") });
    await env.first.recheck(PR, { ...facts(), ...pushed });
    expect(env.work.attempt(attempt.id)?.body.report).toMatchObject({ key: "changed", rejection: null, compat: ["finalHeadOid → headOid"] });
  });

  it("ends an attempt as a system issue when its thread is archived or deleted before its turn finished, and reads a finished one first", async () => {
    const env = setup();
    expect(await env.launch()).toBe("launched");
    const attempt = env.work.attempts(PR)[0]!;
    env.sdk.turn.mockRejectedValueOnce(Object.assign(new Error("missing thread"), { status: 404 }));
    await env.signal("thr_origin", { kind: "gone" });
    expect(env.work.attempt(attempt.id)).toMatchObject({ status: "failed", body: { failure: "thread-gone" } });
    expect([claimOf(env), env.work.row(PR)?.phase, env.work.row(PR)?.body.cause]).toEqual([null, "repair-needed", "thread-gone"]);
    const archived = setup();
    const done = await finished(archived, (id) => result(id));
    archived.world.pr = pushed;
    await archived.signal("thr_origin", { kind: "gone" });
    expect(archived.work.attempt(done.id)).toMatchObject({ status: "completed", body: { report: { key: "changed" } } });
  });

  it("hears nothing on a thread no claim of ours holds", async () => {
    const env = setup({ execution: "dry-run" });
    expect(await env.launch()).toBe("planned");
    for (const signal of [{ kind: "idle" }, { kind: "interaction" }, { kind: "events" }, { kind: "turn-failed", requestId: "req-1", rateLimits: null },
      { kind: "cancelled", text: "anything" }] as const) expect(await env.first.signal("thr_origin", signal)).toBeNull();
    for (const call of Object.values(env.sdk)) expect(call).not.toHaveBeenCalled();
    expect(env.count("effort_attempts")).toBe(0);
  });
});
