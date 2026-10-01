// Launch v2 attempts and recover uncertain ones. The database, not an
// in-memory set, holds the one writer per PR, checkout, and thread: a launch
// commits its claim together with its row, checking every legacy writer in the
// same synchronous transaction, and only then prepares a worktree and spawns or
// sends. An ambiguous SDK answer keeps the claim as uncertain; only reading BB
// back by the launch key attaches it, or, after two empty readbacks a minute
// apart, releases it to be launched once more. In a dry run a launch records
// its plan and holds, starts, and sends nothing.
//
// BB's signals about a worker's thread are facts on the attempt that holds it:
// a pending interaction, a failed turn, a work order you deleted from the
// queue, a thread archived or deleted. The reconciler, not the event, then
// takes the attempt's next step. A turn is complete when its thread is idle, a
// turn request carries the attempt's marker, and its output reads; its report
// is then read against a fresh full read of the PR. The worker never declares
// readiness: its report only routes the next step, and decide() judges the PR
// on fresh facts.
//
// Code actions are GitHub writes no model takes a turn for: re-requesting or
// requesting review, marking a draft ready, and rerunning failed checks, each
// once per head and retry epoch. The action's key goes into its row before the
// write; an unclear answer keeps it pending until a read of GitHub shows
// whether it landed, and a rate limit is a wait until GitHub's reset.
import { createHash } from "node:crypto";
import type { AdvanceFacts, AdvanceWorkspace, AdvanceWorkspaceInput } from "./advance-contract.js";
import type { FeedbackReport } from "./approval-feedback.js";
import type { PrWrite } from "./contract.js";
import { parseCompletion, RAW_LIMIT } from "./completion-envelope.js";
import { TURN_RETRIES, type Attempt, type Next, type Phase } from "./effort-phase.js";
import { buildWorkOrder, recipe, type CodeRecipeId, type WorkerRecipe, type WorkerRecipeId, type WorkOrderInput } from "./effort-recipes.js";
import type { ResourceWriter } from "./effort-resources.js";
import { ClaimConflictError, CODE_ACTIONS_KEPT, decideAttempt, instructionId, sameBody, StaleWriteError, type AttemptBody, type AttemptStatus, type createEffortWorkStore,
  type StoredAttempt, type StoredCodeAction, type WorkRowBody } from "./effort-work-store.js";
import type { ModelChoice, ModelRole } from "./execution.js";
import { githubRateLimit, REVIEWER, writeFailure, type WriteResult } from "./ghactions.js";
import { bbConflict } from "./scratch-placement.js";
import { prWorkItemKey } from "./work-item-index.js";

/** The `v2Execution` setting: a dry run plans every step and claims, starts, sends, and writes nothing. */
export type V2Execution = "dry-run" | "on";
export type Admission = { capacityFull: boolean; breakerOpen: boolean };

const MINUTE = 60_000;
/** Readback releases a claim only when two complete reads at least this far apart find no worker. */
const READBACK_GAP = MINUTE;
const BREAKER = { uncertain: 2, run: 3, window: 30 * MINUTE };

/**
 * Whether a new launch may start. A worker slot is taken by a launch in flight, or by a worker whose thread
 * isn't idle; an uncertain launch keeps its claim but takes no slot. The breaker opens at two uncertain
 * launches, or when the last three launches all went uncertain within half an hour and one still is;
 * readback resolving them closes it.
 */
export function admission(input: { claims: readonly StoredAttempt[]; recent: readonly StoredAttempt[]; status(threadId: string): string | null;
  concurrency: number; now: number }): Admission {
  const working = input.claims.filter((attempt) => attempt.status === "launching"
    || (attempt.status === "running" && !["idle", "error"].includes((attempt.threadId && input.status(attempt.threadId)) ?? "active"))).length;
  const uncertain = input.claims.filter((attempt) => attempt.status === "uncertain").length;
  const run = input.recent.slice(0, BREAKER.run);
  const streak = run.length === BREAKER.run && run.every((attempt) => attempt.body.uncertainAt !== null && input.now - attempt.body.uncertainAt <= BREAKER.window);
  return { capacityFull: working >= input.concurrency, breakerOpen: uncertain >= BREAKER.uncertain || (streak && uncertain > 0) };
}

type SpawnArgs = ModelChoice & { projectId: string; title: string; prompt: string;
  environment: { type: "host"; hostId: string; workspace: { type: "unmanaged"; path: string } };
  pluginMetadata: { workAttemptId: string; role: "v2-worker"; prUrl: string; effortId: string } };
export type SendArgs = { threadId: string; mode: "queue-if-active"; input: [{ type: "text"; text: string; mentions: [] }] };
type Store = Pick<ReturnType<typeof createEffortWorkStore>, "attempts" | "attempt" | "claims" | "launches" | "claim" | "recordAttempt" | "commit" | "row" | "lastRevision">;

export type EffortRunnerDeps = {
  now(): number;
  work: Store;
  settings(): Promise<{ execution: V2Execution; concurrency: number }>;
  models(): Promise<Record<ModelRole, ModelChoice>>;
  /**
   * Anyone outside v2 writing the PR or checkout now: a legacy reservation, a manual action or launch,
   * or an open run. It must read synchronously: it runs inside the claim's transaction.
   */
  writer(prUrl: string, path: string | null): ResourceWriter | null;
  /** A thread's last observed status, or null when unknown. */
  threadStatus(threadId: string): string | null;
  /** One row planned as decide() plans it from stored facts, with these attempts and code actions, and any writer or admission found at claim time. */
  plan(effortId: string, target: string, change: { attempts: readonly Attempt[]; writer?: ResourceWriter; admission?: Admission; codeActions?: readonly StoredCodeAction[] }):
    Promise<{ phase: Phase; body: WorkRowBody; dueAt: number | null } | null>;
  /** Re-plan one row once its attempt changed. */
  settle(effortId: string, target: string): Promise<void>;
  workspace(input: AdvanceWorkspaceInput, hostId: string): Promise<AdvanceWorkspace>;
  /** A new thread: never under the effort parent, whose model would take a turn for every child outcome. */
  spawn(args: SpawnArgs): Promise<{ id: string }>;
  /** Every send goes through the role's configured model and provider. */
  send(args: SendArgs, role: ModelRole): Promise<unknown>;
  /** Readback: the threads whose spawn metadata names this attempt. */
  spawned(projectId: string, attemptId: string): Promise<string[]>;
  /** Readback: whether the thread's turn requests or queued messages carry this marker. */
  marked(threadId: string, marker: string): Promise<boolean>;
  /**
   * A worker thread now: its status, its newest turn requests (newest first) with their request ids, the seq of its last event, and
   * its output once idle.
   */
  turn(threadId: string): Promise<{ status: string; requests: readonly { seq: number; id: string | null; text: string }[]; lastSeq: number | null; output: string | null }>;
  /** How many interactions in the thread wait on you. */
  interactions(threadId: string): Promise<number>;
  /**
   * Whether the thread has moved past this failed turn request: core queued a retry, or a turn was requested after it (a retry, ours or
   * core's, or your next prompt).
   */
  retrying(threadId: string, requestId: string | null): Promise<boolean>;
  retry(args: { threadId: string; turnRequestId?: string; sendAt: number }): Promise<unknown>;
  /** `stop N`: interrupt the thread's running turn. BB may leave it stopping when it can't confirm the interrupt. */
  stop(threadId: string): Promise<unknown>;
  /** A fresh full read of the PR, kept where the roster reads it; null when GitHub couldn't be read. */
  read(prUrl: string): Promise<AdvanceFacts | null>;
  /** Save feedback evidence a report proved on fresh facts, with worker provenance. */
  feedback(prUrl: string, threadId: string, report: FeedbackReport): void;
  /** The reviewers GitHub shows requested on the PR now. It throws GitHub's error when GitHub can't be read. */
  requested(prUrl: string): Promise<string[]>;
  /** One GitHub write through the host's prWrite, which builds and validates its argv. A throw leaves unclear whether it landed. */
  write(request: PrWrite): Promise<WriteResult>;
  /** A write that hit GitHub's rate limit: when it may run again (and GitHub is read again); null when the error is no rate limit. */
  rateLimit(error: string): Promise<number | null>;
  publish(effortId: string): void;
};

type RateLimits = { status: string; windows: readonly { status: string; resetsAtMs: number | null }[] };
/** What BB said about a thread. Only the attempt of ours that holds the thread hears it. */
export type AttemptSignal = { kind: "idle" | "gone" | "interaction" | "events" } | { kind: "turn-failed"; requestId: string; rateLimits: RateLimits | null }
  | { kind: "cancelled"; text: string };
/** When to retry a failed turn: once the provider's blocked rate-limit windows reset, else in a minute. */
export function retryAt(rateLimits: RateLimits | null, now: number): number {
  const resets = (rateLimits?.windows ?? []).flatMap((window) => window.status === "blocked" && window.resetsAtMs !== null ? [window.resetsAtMs] : []);
  return resets.length ? Math.max(now, ...resets) : now + MINUTE;
}

/** A queued step to launch, as the reconciler planned it from live checkout and thread reads. */
export type Launch = {
  effortId: string;
  target: string;
  /** The effort's instruction revision and the row's revision the step was planned from. */
  baseRevision: number;
  expectedRevision: number;
  step: Next;
  body: WorkRowBody;
  /** The work order's bindings besides the attempt, its recipes, and its checkout. */
  order: Omit<WorkOrderInput, "attemptId" | "recipes" | "checkout">;
};
export type LaunchOutcome = "planned" | "launched" | "uncertain" | "failed" | "waiting" | "stale";

/** A code action the reconciler planned: one GitHub write, once per head and retry epoch. */
export type CodeRun = {
  effortId: string;
  target: string;
  baseRevision: number;
  /** The row's revision the step was planned from. */
  expectedRevision: number;
  step: Next;
  body: WorkRowBody;
  /** The full read the step was planned on, under two minutes old. */
  facts: AdvanceFacts;
  /**
   * Whom a review request names: for a re-request, each reviewer whose latest review asks for changes or was dismissed; for a new request,
   * each granted login with no review yet.
   */
  reviewers: readonly string[];
};
/**
 * `planned`: a dry run writes nothing. `done`, `refused`, `waiting` (a rate limit): GitHub answered. `unclear`: it may have
 * landed, so it is read back at the next pass. `stale`: the row moved on before the key was written.
 */
export type CodeOutcome = "planned" | "done" | "refused" | "waiting" | "unclear" | "stale";
/** A write whose answer stays unclear through this many tries is a refused write, a system issue that `retry N` starts over. */
const CODE_TRIES = 6;
/**
 * A pending key younger than this may be a write another instance is still making, as when a reload runs the new instance beside the old
 * one: the host waits up to 90 seconds for a review request's read and 90 more for the write. It isn't written again until then.
 */
const CODE_LEASE = 5 * MINUTE;

/** Where a work order runs: an existing thread to message, or a new thread in a checkout, prepared first when it is a worktree. */
type Place = { via: AttemptBody["resource"]["kind"]; mode: "spawn" | "send"; threadId: string | null; path: string | null; kind: "author" | "worktree"; hostId: string; projectId: string | null;
  workspace: { batchId: string; jobId: string; sourcePath: string; moveCleanToHead: boolean; create: boolean } | null;
  reason: string | null; references: string[] };
function place(step: Next, latest: StoredAttempt | null): Place | null {
  const resource = step.resource;
  if (!resource) return null;
  if (resource.kind === "same-thread") {
    // The worker that did the work re-emits its report in its own checkout.
    if (!latest?.hostId) return null;
    return { via: "same-thread", mode: "send", threadId: resource.threadId, path: latest.path, kind: latest.body.resource.workspace ? "worktree" : "author", hostId: latest.hostId,
      projectId: latest.body.resource.projectId, workspace: null, reason: null, references: [] };
  }
  if (resource.kind === "reuse" || resource.kind === "spawn") {
    const { checkout } = resource;
    return { via: resource.kind, mode: resource.kind === "reuse" ? "send" : "spawn", threadId: resource.kind === "reuse" ? resource.threadId : null, path: checkout.path, kind: checkout.kind,
      hostId: checkout.hostId, projectId: checkout.projectId, workspace: checkout.workspace && { ...checkout.workspace, moveCleanToHead: checkout.moveCleanToHead, create: false },
      reason: resource.kind === "spawn" ? resource.reason : null, references: resource.kind === "spawn" ? resource.references : [] };
  }
  if (resource.kind === "worktree") return { via: "worktree", mode: "spawn", threadId: null, path: null, kind: "worktree", hostId: resource.hostId, projectId: resource.projectId,
    workspace: { ...resource.workspace, moveCleanToHead: false, create: true }, reason: resource.reason, references: resource.references };
  return null;
}

class WriterBusy extends Error {
  constructor(readonly writer: ResourceWriter) { super(`${writer.owner} ${writer.ref} is writing`); }
}
class AdmissionClosed extends Error {
  constructor(readonly admission: Admission) { super("No new launch may start now."); }
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 800);
/** BB refuses a thread in a project source with no usable git branch: nothing started, and retrying can't help. */
const definitive = (error: unknown) => bbConflict(error) && /no usable git branch/iu.test(message(error));

export function createEffortRunner(deps: EffortRunnerDeps) {
  const flights = new Map<string, Promise<unknown>>();
  /** One launch or readback per key at a time; a second caller shares the first one's result. */
  function once<T>(key: string, run: () => Promise<T>): Promise<T> {
    const running = flights.get(key) as Promise<T> | undefined;
    if (running) return running;
    const next = run().finally(() => flights.delete(key));
    flights.set(key, next);
    return next;
  }
  /** The admission now, read synchronously from the claims, so a claim's transaction can read it again. */
  const admitted = (concurrency: number) =>
    admission({ claims: deps.work.claims(), recent: deps.work.launches(BREAKER.run), status: deps.threadStatus, concurrency, now: deps.now() });
  async function open(): Promise<Admission> {
    return admitted((await deps.settings()).concurrency);
  }
  /** Write one planned row at the revision it was planned from; false when the row or instruction moved on first. */
  function write(input: Pick<Launch, "effortId" | "target" | "baseRevision" | "expectedRevision">, row: { phase: Phase; body: WorkRowBody; dueAt: number | null },
    also?: () => void, attemptId?: string): boolean {
    const current = deps.work.row(input.target);
    if (!also && current?.revision === input.expectedRevision && current.phase === row.phase && sameBody(current.body, row.body)) return true;
    try {
      deps.work.commit({ effortId: input.effortId, baseRevision: input.baseRevision, source: "launch", instruction: null, journal: null, ...also ? { also } : {},
        rows: [{ target: input.target, expectedRevision: input.expectedRevision, ...row, ...attemptId ? { attemptId } : {} }] });
      return true;
    } catch (error) {
      if (error instanceof StaleWriteError) return false;
      throw error;
    }
  }
  /** Move an attempt on from a status it was read in. `body` patches it as it is now, so a signal recorded meanwhile is kept. */
  function record(attempt: StoredAttempt, from: readonly AttemptStatus[], next: { status: AttemptStatus; threadId?: string; path?: string; body: Partial<AttemptBody> }):
    StoredAttempt | null {
    try { return deps.work.recordAttempt(attempt.id, from, next); }
    catch (error) {
      if (!(error instanceof ClaimConflictError)) throw error;
      // A thread or checkout another attempt holds: our launch's outcome is uncertain, and never a second writer. A released
      // claim that a later launch has taken since stays released, and keeps what BB answered rather than dropping it.
      const current = deps.work.attempt(attempt.id);
      const released = current?.status === "released";
      return deps.work.recordAttempt(attempt.id, from, { status: released ? "released" : "uncertain", ...released ? { threadId: next.threadId } : {},
        body: { ...next.body, failure: "duplicate-writer", uncertainAt: next.body.uncertainAt ?? current?.body.uncertainAt ?? deps.now(), error: released
          ? "BB answered after this launch was released, and a later launch holds its PR, checkout, or thread now." : `${error.message} It answers to this launch too.` } });
    }
  }

  /** Launch one queued work order, or in a dry run record the launch it would make. */
  function launch(input: Launch): Promise<LaunchOutcome> {
    const target = prWorkItemKey(input.target);
    return once(`launch:${target}`, async () => {
      const { step } = input;
      if (step.phase !== "queued" || !Array.isArray(step.nextAction)) throw new Error(`${target} has no queued work order to launch.`);
      const recipes = step.nextAction.map((id) => recipe(id)).filter((item): item is WorkerRecipe => item.executor === "worker");
      if (recipes.length !== step.nextAction.length) throw new Error(`${target}'s next step is a code action, which no worker runs.`);
      const stored = deps.work.attempts(target);
      const where = place(step, stored[0] ?? null);
      if (!where) throw new Error(`${target}'s work order has no checkout or thread to run in yet.`);
      const { facts } = input.order;
      const ids = recipes.map((item) => item.action).sort() as WorkerRecipeId[];
      const role: ModelRole = recipes.some((item) => item.modelRole === "code") ? "code" : "planning";
      const fingerprint = facts.approvalFeedback.status === "present" ? facts.approvalFeedback.fingerprint : null;
      const epoch = input.body.retryEpoch;
      // The same work on the same head and feedback is never requested twice: each new launch of it takes the next index.
      const retryIndex = stored.filter((item) => item.body.retryEpoch === epoch && item.body.start.headOid === facts.headOid && item.body.start.fingerprint === fingerprint
        && [...item.body.recipes].sort().join() === ids.join()).length;
      const instruction = instructionId(input.effortId, input.order.revision);
      const launchKey = createHash("sha256").update(JSON.stringify([instruction, input.order.revision, target, ids, facts.headOid, fingerprint, epoch, retryIndex])).digest("hex");
      const id = `A-${launchKey.slice(0, 16)}`;
      const { execution, concurrency } = await deps.settings();

      if (execution === "dry-run") {
        const body: WorkRowBody = { ...input.body, plan: { recipes: ids, role, launchKey,
          resource: { kind: where.via, threadId: where.threadId, path: where.path, hostId: where.hostId, reason: where.reason } } };
        const current = deps.work.row(target);
        if (current && current.phase === step.phase && sameBody(current.body, body)) return "planned";
        return write(input, { phase: step.phase, body, dueAt: step.wake?.dueAt ?? null }) ? (deps.publish(input.effortId), "planned") : "stale";
      }

      const attempts = stored.map(decideAttempt);
      const hold = async (admission: Admission) => {
        const row = await deps.plan(input.effortId, target, { attempts, admission });
        return row && write(input, row) ? (deps.publish(input.effortId), "waiting" as const) : "stale" as const;
      };
      const before = admitted(concurrency);
      if (before.capacityFull || before.breakerOpen) return hold(before);
      // Everything that can refuse is read before the claim, so nothing between the claim and the SDK call throws: the
      // order's authority (a new worktree's path is bound once it exists) and the role's configured model.
      const { marker } = buildWorkOrder({ ...input.order, attemptId: id, recipes: ids, checkout: { path: where.path ?? "(new worktree)", kind: where.kind } });
      const model = (await deps.models())[role];
      const claim: StoredAttempt = { id, target, effortId: input.effortId, instructionId: instruction, launchKey, status: "launching", threadId: where.threadId,
        hostId: where.hostId, path: where.path, createdAt: deps.now(), body: {
          instructionRevision: input.order.revision, recipes: ids, role, retryEpoch: epoch, retryIndex,
          start: { headOid: facts.headOid, baseOid: facts.baseOid, fingerprint, sourceIds: facts.approvalFeedback.status === "present" ? facts.approvalFeedback.sourceIds : [] },
          resource: { kind: where.via, threadId: where.threadId, path: where.path, hostId: where.hostId, projectId: where.projectId,
            reason: where.reason, workspace: where.workspace && { batchId: where.workspace.batchId, jobId: where.workspace.jobId, sourcePath: where.workspace.sourcePath,
              moveCleanToHead: where.workspace.moveCleanToHead } },
          mode: where.mode, marker, settledAt: null, uncertainAt: null, emptyReadbackAt: null, failure: null, error: null, releasedReason: null } };
      const claimed = await deps.plan(input.effortId, target, { attempts: [decideAttempt(claim), ...attempts] });
      // The facts moved (a hold, a merge, an opt-out, a new owner) since the step was planned. decide() lets a claim drain
      // through those, so a plan that drains ours would start work nothing asks for: write what decide() says without it, and claim nothing.
      if (!claimed || claimed.phase !== "executing" || claimed.body.owner?.ref !== id || claimed.body.modifiers.includes("draining")) {
        const row = await deps.plan(input.effortId, target, { attempts });
        return row && write(input, row) ? (deps.publish(input.effortId), "waiting") : "stale";
      }
      try {
        if (!write(input, claimed, () => {
          // The same synchronous transaction as the insert: no legacy launcher can start in between, as none can between its checks and
          // its launch write, and no other launch can take the last worker slot.
          const writer = deps.writer(target, where.path);
          if (writer) throw new WriterBusy(writer);
          const now = admitted(concurrency);
          if (now.capacityFull || now.breakerOpen) throw new AdmissionClosed(now);
          const { createdAt: _createdAt, status: _status, ...row } = claim;
          deps.work.claim(row);
        }, id)) return "stale";
      } catch (error) {
        if (error instanceof AdmissionClosed) return hold(error.admission);
        if (!(error instanceof WriterBusy || error instanceof ClaimConflictError)) throw error;
        const holder = error instanceof ClaimConflictError ? error.holder : null;
        if (error instanceof ClaimConflictError && !holder) return "stale";
        // Our own attempt from another instance holds the PR: decide() attaches to it. Anyone else is a writer to wait for.
        const writer = error instanceof WriterBusy ? error.writer : holder!.target === target ? undefined : { owner: "thread" as const, ref: holder!.threadId ?? holder!.id, path: null };
        const row = await deps.plan(input.effortId, target, { attempts: deps.work.attempts(target).map(decideAttempt), ...writer ? { writer } : {} });
        return row && write(input, row) ? (deps.publish(input.effortId), "waiting") : "stale";
      }
      deps.publish(input.effortId);
      const outcome = await act(deps.work.attempt(id)!, where, input, role, model);
      await deps.settle(input.effortId, target);
      return outcome;
    });
  }

  /** The external effects, strictly after the claim committed: prepare the worktree, then spawn or send, then record what BB said. */
  async function act(attempt: StoredAttempt, where: Place, input: Launch, role: ModelRole, model: ModelChoice): Promise<LaunchOutcome> {
    const { facts } = input.order;
    const fail = (failure: string, error: string) =>
      (record(attempt, ["launching"], { status: "failed", body: { ...attempt.body, failure, error: error.slice(0, 800), settledAt: deps.now() } }), "failed" as const);
    let path = where.path;
    if (where.workspace) {
      let prepared: AdvanceWorkspace;
      try {
        prepared = await deps.workspace({ sourcePath: where.workspace.sourcePath, prUrl: facts.prUrl, expectedHeadOid: facts.headOid, expectedBaseOid: facts.baseOid,
          batchId: where.workspace.batchId, jobId: where.workspace.jobId, reuseOnly: !where.workspace.create, moveCleanToHead: where.workspace.moveCleanToHead }, where.hostId);
      } catch (error) { return fail("workspace", message(error)); }
      // No thread exists yet, so a checkout that can't be prepared ends this launch with nothing started, and the worktree and its work stay as
      // they were. Unpushed work is a repair; decide() backs anything else off on this head, and a new head reverifies.
      if (!prepared.ok) return fail(/unpushed/iu.test(prepared.error) ? "unpushed-worktree" : "workspace", prepared.error);
      path = prepared.path;
      if (path !== attempt.path) {
        // The new worktree's path joins the claim. No thread exists yet, so a checkout someone else holds ends this launch.
        let moved: StoredAttempt | null;
        try { moved = deps.work.recordAttempt(attempt.id, ["launching"], { status: "launching", path, body: { ...attempt.body, resource: { ...attempt.body.resource, path } } }); }
        catch (error) {
          if (error instanceof ClaimConflictError) return fail("workspace", `${error.message} No thread was started.`);
          throw error;
        }
        // A restarted process marked it uncertain, or you released it: readback settles it, and nothing starts here.
        if (!moved) return "stale";
        attempt = moved;
      }
    }
    const order = buildWorkOrder({ ...input.order, attemptId: attempt.id, recipes: attempt.body.recipes, checkout: { path: path!, kind: where.kind },
      threads: [...new Set([...input.order.threads, ...where.references])] });
    // The claim is still ours to act on, read in the same tick as the call: a restarted process that marked it uncertain, or you
    // releasing it, while the checkout was prepared means nothing starts here.
    if (deps.work.attempt(attempt.id)?.status !== "launching") return "stale";
    // BB's answer settles the claim even if it was released while the call was out: readback then ran before the call settled.
    const settled: AttemptStatus[] = ["launching", "uncertain", "released"];
    try {
      if (where.mode === "spawn") {
        if (!where.projectId) return fail("project-source", `${path} is in no BB project, so no thread can start there.`);
        const thread = await deps.spawn({ ...model, projectId: where.projectId, title: `${facts.repo} #${facts.number}`, prompt: order.text,
          environment: { type: "host", hostId: where.hostId, workspace: { type: "unmanaged", path: path! } },
          pluginMetadata: { workAttemptId: attempt.id, role: "v2-worker", prUrl: facts.prUrl, effortId: input.effortId } });
        // The thread BB returned is proof of exactly one worker, even when the launch was marked uncertain or released meanwhile.
        const running = record(attempt, settled, { status: "running", threadId: thread.id, body: { ...attempt.body, settledAt: deps.now() } });
        return running?.status === "running" ? "launched" : running?.status === "uncertain" ? "uncertain" : "stale";
      }
      await deps.send({ threadId: where.threadId!, mode: "queue-if-active", input: [{ type: "text", text: order.text, mentions: [] }] }, role);
      const running = record(attempt, settled, { status: "running", body: { ...attempt.body, settledAt: deps.now() } });
      return running?.status === "running" ? "launched" : "stale";
    } catch (error) {
      if (definitive(error)) return fail("project-source", message(error));
      // The call may have reached BB. The claim stays until readback by the launch key finds or rules out the worker.
      const at = deps.now();
      record(attempt, ["launching", "released"], { status: "uncertain", body: { ...attempt.body, settledAt: at, uncertainAt: at, error: message(error) } });
      return "uncertain";
    }
  }

  /**
   * Read BB back for one launching or uncertain attempt, by its spawn metadata or its marker. One match attaches
   * it; several are a duplicate writer; none on two complete reads a minute apart releases the claim, so the row
   * requeues. A failed read changes nothing but the attempt's note. Rows are re-planned by the caller.
   */
  function recover(attemptId: string): Promise<void> {
    return once(`recover:${attemptId}`, async () => {
      let attempt = deps.work.attempt(attemptId);
      if (!attempt || (attempt.status !== "launching" && attempt.status !== "uncertain")) return;
      if (attempt.status === "launching") {
        // Our own launch is still waiting on BB here; only a launch no process is finishing is uncertain.
        if (flights.has(`launch:${attempt.target}`)) return;
        const at = deps.now();
        attempt = record(attempt, ["launching"], { status: "uncertain", body: { settledAt: at, uncertainAt: at } });
        if (!attempt || attempt.status !== "uncertain") return;
      }
      const { body } = attempt;
      let matches: string[];
      try {
        matches = body.mode === "spawn" ? await deps.spawned(body.resource.projectId ?? "", attempt.id)
          : await deps.marked(body.resource.threadId ?? "", body.marker) ? [body.resource.threadId!] : [];
      } catch (error) {
        record(attempt, ["uncertain"], { status: "uncertain", body: { failure: "source-unavailable", readbackFailures: (body.readbackFailures ?? 0) + 1, error: message(error) } });
        return;
      }
      const at = deps.now();
      const clear = { failure: null, error: null, readbackFailures: 0 };
      if (matches.length === 1) record(attempt, ["uncertain"], { status: "running", threadId: matches[0]!, body: { ...clear, emptyReadbackAt: null } });
      else if (matches.length > 1) record(attempt, ["uncertain"], { status: "uncertain", body: { failure: "duplicate-writer", error: `Threads ${matches.join(", ")} answer to ${attempt.id}.` } });
      else if (body.emptyReadbackAt === null || body.settledAt === null || body.emptyReadbackAt < body.settledAt)
        record(attempt, ["uncertain"], { status: "uncertain", body: { ...clear, emptyReadbackAt: at } });
      else if (at - body.emptyReadbackAt >= READBACK_GAP) record(attempt, ["uncertain"], { status: "released", body: { ...clear, releasedReason: "no-worker" } });
      else record(attempt, ["uncertain"], { status: "uncertain", body: clear });
    });
  }

  /**
   * The completion rule: the thread is idle, one of its turn requests carries the attempt's marker, and its output
   * reads. When you prompted the thread after the work order, the latest output is read anyway. An idle turn whose
   * output holds no report is complete too: its report is repaired, never left uncertain. What no event told us is
   * read here as well: a thread in error with no retry queued failed its turn, and a work order sent to an idle thread
   * that is in no turn request and no longer queued, on two reads a minute apart, was deleted from the queue.
   */
  async function complete(attempt: StoredAttempt): Promise<void> {
    const threadId = attempt.threadId!;
    const { marker } = attempt.body;
    let turn: Awaited<ReturnType<EffortRunnerDeps["turn"]>> | null = null;
    try { turn = await deps.turn(threadId); } catch { /* An unread thread is read again at its next signal or poll; a gone one fails below. */ }
    const mine = turn?.requests.find((request) => request.text.includes(marker));
    if (turn?.status === "idle" && mine) {
      const output = turn.output ?? "";
      record(attempt, ["running"], { status: "completed", body: { startSeq: mine.seq, endSeq: turn.lastSeq, endedAt: deps.now(), interactionPending: false,
        report: { raw: output.slice(-RAW_LIMIT), source: null, envelope: null, compat: [], rejection: null, key: null, headOid: null, baseMoved: false, criteria: [], blocker: null } } });
    } else if (attempt.body.threadGone) record(attempt, ["running"], { status: "failed", body: { failure: "thread-gone", endedAt: deps.now(),
      error: "The worker's thread was archived or deleted before its turn finished." } });
    else if (turn?.status === "error") {
      // Its turn.failed never reached us, as across a reload: the newest turn failed, and is retried as that event would have it.
      const failed = turn.requests[0]?.id ?? null;
      if (!await deps.retrying(threadId, failed).catch(() => true))
        record(attempt, ["running"], { status: "running", body: { turnFailure: { requestId: failed, sendAt: retryAt(null, deps.now()) } } });
    } else if (turn?.status === "idle" && attempt.body.mode === "send") {
      // Its message.cancelled never reached us. One read can fall between the queue and the turn request, so it takes two a minute apart.
      const queued = await deps.marked(threadId, marker).catch(() => true);
      const at = deps.now();
      const first = attempt.body.emptyReadbackAt;
      if (queued) { if (first !== null) record(attempt, ["running"], { status: "running", body: { emptyReadbackAt: null } }); }
      else if (first === null) record(attempt, ["running"], { status: "running", body: { emptyReadbackAt: at } });
      else if (at - first >= READBACK_GAP) record(attempt, ["running"], { status: "released", body: { releasedReason: "user-cancelled" } });
    }
  }

  /** Read a finished turn's report against fresh facts, and save the feedback evidence it proves. Without a fresh read nothing is judged. */
  async function parse(attempt: StoredAttempt, fresh?: AdvanceFacts): Promise<void> {
    const facts = fresh ?? await deps.read(attempt.target);
    if (!facts) return;
    const { feedback, ...report } = parseCompletion(attempt.body.report?.raw ?? "", { attemptId: attempt.id, target: attempt.target, fresh: facts });
    if (feedback && attempt.threadId) deps.feedback(attempt.target, attempt.threadId, feedback);
    record(attempt, ["completed"], { status: "completed", body: { report } });
  }

  /**
   * Ask BB to retry a failed turn at the time its rate limits reset, at most TURN_RETRIES times per attempt; a failure after
   * that ends the attempt as turn-failed, and its claims go. Nothing is asked when the thread already moved past the failure,
   * or in a dry run, which asks BB for nothing even on a claim made while execution was on. True when it asked.
   */
  async function retryTurn(attempt: StoredAttempt): Promise<boolean> {
    const { turnFailure: failure, turnRetries = 0 } = attempt.body;
    if (!failure) return false;
    let moved: boolean;
    try { moved = await deps.retrying(attempt.threadId!, failure.requestId); } catch { return false; }
    // Core's own retry, or one of ours BB took though its answer was lost, runs this turn again; another would run the work order twice.
    if (moved) return (record(attempt, ["running"], { status: "running", body: { turnFailure: null } }), false);
    if (turnRetries >= TURN_RETRIES) return (record(attempt, ["running"], { status: "failed",
      body: { turnFailure: null, failure: "turn-failed", endedAt: deps.now(), error: `The worker's turn failed ${TURN_RETRIES + 1} times.` } }), false);
    if ((await deps.settings()).execution !== "on") return false;
    // Counted before the call, so a retry whose answer is lost still counts toward the bound.
    const counted = record(attempt, ["running"], { status: "running", body: { turnRetries: turnRetries + 1 } });
    if (!counted) return false;
    try {
      await deps.retry({ threadId: attempt.threadId!, ...failure.requestId ? { turnRequestId: failure.requestId } : {}, sendAt: failure.sendAt });
      record(counted, ["running"], { status: "running", body: { turnFailure: null, error: null } });
    } catch (error) {
      record(counted, ["running"], { status: "running", body: { error: message(error) } });
    }
    return true;
  }

  /**
   * One attempt's next step, then its row re-planned: read back an unfinished launch, retry a failed turn, read a
   * finished turn, or read its report against fresh facts. A turn whose thread was archived or deleted before it
   * finished fails.
   */
  function advance(attemptId: string): Promise<void> {
    return once(`advance:${attemptId}`, async () => {
      let attempt = deps.work.attempt(attemptId);
      if (!attempt) return;
      const { effortId, target } = attempt;
      if (attempt.status === "launching" || attempt.status === "uncertain") {
        await recover(attemptId);
        attempt = deps.work.attempt(attemptId)!;
      }
      // A worker you asked to stop is stopped, never retried or read for a result.
      const stopping = attempt.status === "running" && attempt.body.stopRequestedAt != null;
      if (stopping) {
        await stopWorker(attempt);
        attempt = deps.work.attempt(attemptId)!;
      }
      let asked = false;
      if (!stopping && attempt.status === "running" && attempt.body.turnFailure) {
        asked = await retryTurn(attempt);
        attempt = deps.work.attempt(attemptId)!;
      }
      // A failure the thread already moved past no longer keeps its turn from being read. A retry just asked for is read once it
      // has run: until then the thread may still show the error, beside the retry's own turn request.
      if (!stopping && attempt.status === "running" && !attempt.body.turnFailure && !asked) {
        // A pending interaction is read again at its poll, in case the event that cleared it never reached us.
        if (attempt.body.interactionPending && await deps.interactions(attempt.threadId!).catch(() => 1) === 0)
          attempt = record(attempt, ["running"], { status: "running", body: { interactionPending: false } }) ?? attempt;
        await complete(attempt);
        attempt = deps.work.attempt(attemptId)!;
      }
      if (attempt.status === "completed" && attempt.body.report?.key == null) await parse(attempt);
      await deps.settle(effortId, target);
    });
  }

  /**
   * BB said something about a thread. Only a claim of ours on that thread hears it, so a dry run, which claims
   * nothing, hears nothing. The signal is recorded on the attempt, and the attempt that heard it is returned: the
   * caller makes its row due, and the reconciler takes its next step.
   */
  async function signal(threadId: string, event: AttemptSignal): Promise<{ effortId: string; target: string } | null> {
    const attempt = deps.work.claims().find((claim) => claim.threadId === threadId);
    // A launch still in flight settles when BB answers it.
    if (!attempt || attempt.status === "launching") return null;
    const heard = { effortId: attempt.effortId, target: attempt.target };
    const note = (patch: Partial<AttemptBody>, status: AttemptStatus = attempt.status) => record(attempt, [attempt.status], { status, body: patch });
    if (event.kind === "gone") note({ threadGone: true });
    else if (event.kind === "turn-failed") {
      if (attempt.status !== "running") return null;
      // A turn you asked to stop isn't retried; its row reads the thread again.
      if (attempt.body.stopRequestedAt == null) note({ turnFailure: { requestId: event.requestId, sendAt: retryAt(event.rateLimits, deps.now()) } });
    } else if (event.kind === "interaction") note({ interactionPending: true });
    else if (event.kind === "events") {
      // BB has no "interaction answered" event; the thread's events move when you answer, so its interactions are read again then.
      if (!attempt.body.interactionPending || await deps.interactions(threadId) > 0) return null;
      note({ interactionPending: false });
    } else if (event.kind === "cancelled") {
      // You deleted our queued work order before it ran: nothing started, and no later turn in that thread is this attempt's.
      if (attempt.body.mode !== "send" || !event.text.includes(attempt.body.marker)) return null;
      note({ releasedReason: "user-cancelled" }, "released");
    }
    return heard;
  }

  /**
   * `stop N`: interrupt our running worker with threads.stop, only with v2 execution on, and release its claim as stopped once a read
   * after the stop shows its thread idle or failed. BB may leave the thread stopping when it can't confirm the interrupt; the claim then
   * holds, and the next signal or poll reads the thread again and asks again. A thread that went away has nothing left to stop.
   */
  async function stopWorker(attempt: StoredAttempt): Promise<void> {
    const threadId = attempt.threadId!;
    if (!attempt.body.threadGone) {
      // A dry run asks BB for nothing, so the claim holds until execution is on again.
      if ((await deps.settings()).execution !== "on") return;
      const turn = await deps.turn(threadId).catch(() => null);
      if (!turn) return;
      // In a thread we reused, a work order that hasn't started isn't what runs there, so it isn't ours to stop. The claim holds until ours
      // starts, or until two reads a minute apart on the idle thread find it neither queued nor started.
      if (attempt.body.mode === "send" && !turn.requests.some((request) => request.text.includes(attempt.body.marker))) {
        if (turn.status === "idle") await complete(attempt);
        return;
      }
      // Asked even when the thread already reads idle or failed: an explicit stop wins over a turn the machine still runs.
      try { await deps.stop(threadId); }
      catch (error) { record(attempt, ["running"], { status: "running", body: { error: message(error) } }); return; }
      if (!["idle", "error"].includes((await deps.turn(threadId).catch(() => null))?.status ?? "active")) return;
    }
    record(attempt, ["running"], { status: "released", body: { releasedReason: "stopped", endedAt: deps.now() } });
  }

  /**
   * The compatibility adapter over a settled legacy Advance worker's last output, with no model turn and no send: feedback evidence its
   * report proves against these fresh facts is saved with worker provenance. Null when BB can't read the thread, or it isn't idle, now.
   */
  async function adopt(target: string, legacy: { attemptId: string; threadId: string }, facts: AdvanceFacts):
    Promise<{ saved: boolean; compat: string[]; rejection: string | null } | null> {
    const turn = await deps.turn(legacy.threadId).catch(() => null);
    if (turn?.status !== "idle") return null;
    const { feedback, compat, rejection } = parseCompletion(turn.output ?? "", { attemptId: legacy.attemptId, target, fresh: facts });
    if (feedback) deps.feedback(target, legacy.threadId, feedback);
    return { saved: feedback !== null, compat, rejection };
  }

  /** Recheck: read the latest attempt's turn again, and its report against these fresh facts, even a report already read. The caller re-plans. */
  async function recheck(target: string, fresh: AdvanceFacts): Promise<void> {
    const [latest] = deps.work.attempts(target);
    if (latest?.status === "running" && !latest.body.turnFailure) await complete(latest);
    const current = latest && deps.work.attempt(latest.id);
    if (current?.status === "completed") await parse(current, fresh);
  }

  /** Whether this process is making a launch on the PR now, which settles its claim when BB answers. */
  const launching = (target: string) => flights.has(`launch:${prWorkItemKey(target)}`);

  /** A code action's key or result, written into its row re-planned with it, at `expectedRevision` or else the row's current one. False when the row moved on. */
  async function recordCode(run: CodeRun, entry: StoredCodeAction, expectedRevision?: number, also?: () => void): Promise<boolean> {
    const current = deps.work.row(run.target);
    if (!current || current.effortId !== run.effortId || (expectedRevision !== undefined && current.revision !== expectedRevision)) return false;
    const codeActions = [entry, ...(current.body.codeActions ?? []).filter((item) => item.key !== entry.key)].slice(0, CODE_ACTIONS_KEPT);
    const row = await deps.plan(run.effortId, run.target, { attempts: deps.work.attempts(run.target).map(decideAttempt), codeActions });
    // Only while the row still asks for this action: a hold, a merge, or a new head since the step was planned writes nothing to GitHub.
    if (!row || (entry.status === "pending" && (row.phase !== "executing" || JSON.stringify(row.body.nextAction) !== JSON.stringify([entry.recipe])))) return false;
    try {
      deps.work.commit({ effortId: run.effortId, baseRevision: deps.work.lastRevision(run.effortId), source: "code-action", instruction: null, journal: null, ...also ? { also } : {},
        rows: [{ target: run.target, expectedRevision: current.revision, ...row }] });
    } catch (error) {
      if (error instanceof StaleWriteError) return false;
      throw error;
    }
    deps.publish(run.effortId);
    return true;
  }
  /**
   * Record GitHub's answer. An action done changed the PR, so it is read again first, and no step is judged on the facts from before it.
   * A result that can't be recorded leaves the key pending, so the next pass reads GitHub back instead of writing blind.
   */
  async function answered(run: CodeRun, entry: StoredCodeAction, patch: Pick<StoredCodeAction, "status" | "tries" | "detail"> & { retryAt?: number }): Promise<CodeOutcome> {
    const at = deps.now();
    if (patch.status === "done") await deps.read(run.target).catch(() => null);
    await recordCode(run, { ...entry, retryAt: null, ...patch, detail: patch.detail?.slice(0, 800) ?? null, at });
    return patch.status === "done" ? "done" : patch.status === "write-refused" ? "refused" : patch.status === "rate-limited" ? "waiting" : "unclear";
  }
  /**
   * The GitHub write. A review request first reads whom GitHub already shows requested and names only the rest, so a re-request
   * never repeats and an unclear one that landed reads as done. Marking ready and the rerun check the head on the host first.
   */
  async function writeCode(run: CodeRun, entry: StoredCodeAction): Promise<CodeOutcome> {
    const tries = entry.tries + 1;
    let request: PrWrite;
    if (entry.recipe === "request_rereview" || entry.recipe === "request_review") {
      let live: string[];
      try { live = await deps.requested(run.target); }
      catch (error) {
        // Nothing was written, but a read GitHub didn't answer counts as a try, as an unclear write does, and a rate limit on it waits for the reset.
        const failure = `GitHub couldn't read whom review is requested from: ${message(error)}`;
        return failed(run, entry, tries, failure, githubRateLimit(failure) ? "rate-limited" : "unclear");
      }
      const requested = new Set(live.map((login) => login.toLowerCase()));
      // Only a login or team GitHub accepts a request for; a bot's review can't be re-requested.
      const valid = run.reviewers.filter((login) => REVIEWER.test(login));
      const missing = valid.filter((login) => !requested.has(login.toLowerCase()));
      if (missing.length === 0) return answered(run, entry, { status: "done", tries: entry.tries,
        detail: valid.length ? `Review is requested from ${valid.map((login) => `@${login}`).join(", ")}`
          : run.reviewers.length ? "No reviewer GitHub accepts a request for" : "No one is left to ask for review" });
      request = { kind: "nudge", prUrl: run.facts.prUrl, reviewers: missing, comment: null };
    } else request = { kind: entry.recipe === "mark_ready_for_review" ? "ready" : "rerun-failed", prUrl: run.facts.prUrl, headOid: entry.headOid };
    let failure: string;
    let unclear = false;
    try {
      const result = await deps.write(request);
      if (result.ok) return answered(run, entry, { status: "done", tries, detail: result.detail });
      failure = result.error;
    } catch (error) {
      failure = message(error);
      unclear = true;
    }
    const kind = unclear ? "unclear" : writeFailure(failure);
    if (kind === "unclear") {
      // It may have landed: read GitHub back once now, and until a read settles it the key stays pending for the next pass to read back.
      const landed = await readBack(run, entry);
      if (landed) return answered(run, entry, { status: "done", tries, detail: landed });
    }
    return failed(run, entry, tries, failure, kind);
  }
  /** A read or write GitHub didn't carry out: a rate limit waits for its reset, a refusal is a system issue, and anything unclear stays pending, within CODE_TRIES. */
  async function failed(run: CodeRun, entry: StoredCodeAction, tries: number, failure: string, kind: ReturnType<typeof writeFailure>): Promise<CodeOutcome> {
    if (kind === "rate-limited") return answered(run, entry, { status: "rate-limited", tries, detail: failure, retryAt: await deps.rateLimit(failure) ?? deps.now() + MINUTE });
    if (kind === "refused") return answered(run, entry, { status: "write-refused", tries, detail: failure });
    if (tries >= CODE_TRIES) return answered(run, entry, { status: "write-refused", tries, detail: `GitHub's answer stayed unclear through ${tries} tries: ${failure}` });
    return answered(run, entry, { status: "pending", tries, detail: failure });
  }
  /** Whether GitHub shows the action in effect now; null when it can't tell yet. A review request reads back in writeCode, which names only whom GitHub lacks. */
  async function readBack(run: CodeRun, entry: StoredCodeAction): Promise<string | null> {
    if (entry.recipe === "request_rereview" || entry.recipe === "request_review") {
      const live = await deps.requested(run.target).catch(() => null);
      const requested = new Set(live?.map((login) => login.toLowerCase()));
      return live !== null && run.reviewers.every((login) => !REVIEWER.test(login) || requested.has(login.toLowerCase())) ? "GitHub shows the review requested" : null;
    }
    const facts = await deps.read(run.target).catch(() => null);
    if (!facts || facts.headOid !== entry.headOid) return null;
    // Checks that passed since need no rerun. Checks that failed again can't tell a rerun from none; the host reruns a head only once.
    return entry.recipe === "mark_ready_for_review" ? (!facts.isDraft ? "GitHub shows the PR ready for review" : null)
      : facts.checks === "pending" ? "GitHub shows the failed checks running again" : facts.checks === "passed" ? "GitHub shows the checks passing" : null;
  }

  /**
   * Run one planned code action with v2 execution on: write its key into the row, then write to GitHub and record the answer.
   * A key already pending is an answer that was unclear, a write a restart cut short, or one another instance is still making: GitHub is
   * read back first, and once the key's lease passes it is written again, through the same checks as a first write, only when the read
   * shows the action didn't land. A dry run writes nothing.
   */
  function code(run: CodeRun): Promise<CodeOutcome> {
    const target = prWorkItemKey(run.target);
    return once(`code:${target}`, async () => {
      const [id] = run.step.nextAction as CodeRecipeId[];
      if (!id || recipe(id).executor !== "code") throw new Error(`${target} has no code action to run.`);
      if ((await deps.settings()).execution !== "on") return "planned";
      const epoch = run.body.retryEpoch;
      const key = createHash("sha256").update(JSON.stringify([target, id, run.facts.headOid, epoch])).digest("hex");
      const found = run.body.codeActions?.find((item) => item.key === key);
      // A rate-limited action runs again after its reset, and a pending one is read back; anything else already answered.
      if (found && found.status !== "pending" && found.status !== "rate-limited") return "stale";
      if (found?.status === "pending") {
        if (id === "mark_ready_for_review" || id === "rerun_failed_checks") {
          const landed = await readBack(run, found);
          if (landed) return answered(run, found, { status: "done", tries: found.tries, detail: landed });
        }
        if (deps.now() < found.at + CODE_LEASE) return "unclear";
      }
      // Writing again takes the key over with a new lease.
      const entry: StoredCodeAction = { ...found?.status === "pending" ? found
        : { recipe: id, headOid: run.facts.headOid, retryEpoch: epoch, key, status: "pending", retryAt: null, tries: found?.tries ?? 0, detail: null }, at: deps.now() };
      // The key goes into the row before GitHub is written, at the revision the step was planned from, in the same transaction that reads
      // every writer outside v2: nothing on the PR writes between the check and the key. A pending key is written again the same way, so a
      // hold, a new head, or another writer since the pass stops a retry as it stops a first write.
      try {
        if (!await recordCode(run, entry, run.expectedRevision, () => { const writer = deps.writer(target, null); if (writer) throw new WriterBusy(writer); })) return "stale";
      } catch (error) {
        if (!(error instanceof WriterBusy)) throw error;
        const row = await deps.plan(run.effortId, target, { attempts: deps.work.attempts(target).map(decideAttempt), writer: error.writer });
        return row && write(run, row) ? (deps.publish(run.effortId), "waiting") : "stale";
      }
      return writeCode(run, entry);
    });
  }

  return { launch, recover, admission: open, launching, signal, advance, recheck, code, adopt };
}
