// Launch v2 attempts and recover uncertain ones. The database, not an
// in-memory set, holds the one writer per PR, checkout, and thread: a launch
// commits its claim together with its row, checking every legacy writer in the
// same synchronous transaction, and only then prepares a worktree and spawns or
// sends. An ambiguous SDK answer keeps the claim as uncertain; only reading BB
// back by the launch key attaches it, or, after two empty readbacks a minute
// apart, releases it to be launched once more. In a dry run a launch records
// its plan and holds, starts, and sends nothing.
import { createHash } from "node:crypto";
import type { AdvanceWorkspace, AdvanceWorkspaceInput } from "./advance-contract.js";
import type { Attempt, Next, Phase } from "./effort-phase.js";
import { buildWorkOrder, recipe, type WorkerRecipe, type WorkerRecipeId, type WorkOrderInput } from "./effort-recipes.js";
import type { ResourceWriter } from "./effort-resources.js";
import { ClaimConflictError, decideAttempt, instructionId, sameBody, StaleWriteError, type AttemptBody, type AttemptStatus, type createEffortWorkStore,
  type StoredAttempt, type WorkRowBody } from "./effort-work-store.js";
import type { ModelChoice, ModelRole } from "./execution.js";
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
type Store = Pick<ReturnType<typeof createEffortWorkStore>, "attempts" | "attempt" | "claims" | "launches" | "claim" | "recordAttempt" | "commit" | "row">;

export type EffortRunnerDeps = {
  now(): number;
  work: Store;
  settings(): Promise<{ execution: V2Execution; concurrency: number }>;
  models(): Promise<Record<ModelRole, ModelChoice>>;
  /**
   * Anyone outside v2 writing the PR or checkout now: a legacy reservation, a manual action or launch, dispatch,
   * or an open run. It must read synchronously: it runs inside the claim's transaction.
   */
  writer(prUrl: string, path: string | null): ResourceWriter | null;
  /** A thread's last observed status, or null when unknown. */
  threadStatus(threadId: string): string | null;
  /** One row planned as decide() plans it from stored facts, with these attempts and any writer or admission found at claim time. */
  plan(effortId: string, target: string, change: { attempts: readonly Attempt[]; writer?: ResourceWriter; admission?: Admission }):
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
  publish(effortId: string): void;
};

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
  function write(input: Launch, row: { phase: Phase; body: WorkRowBody; dueAt: number | null }, also?: () => void, attemptId?: string): boolean {
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
  function record(attempt: StoredAttempt, from: readonly AttemptStatus[], next: { status: AttemptStatus; threadId?: string; path?: string; body: AttemptBody }): StoredAttempt | null {
    try { return deps.work.recordAttempt(attempt.id, from, next); }
    catch (error) {
      if (!(error instanceof ClaimConflictError)) throw error;
      // A thread or checkout another attempt holds: our launch's outcome is uncertain, and never a second writer. A released
      // claim that a later launch has taken since stays released, and keeps what BB answered rather than dropping it.
      const released = deps.work.attempt(attempt.id)?.status === "released";
      return deps.work.recordAttempt(attempt.id, from, { status: released ? "released" : "uncertain", ...released ? { threadId: next.threadId } : {},
        body: { ...next.body, failure: "duplicate-writer", uncertainAt: next.body.uncertainAt ?? deps.now(), error: released
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
        attempt = record(attempt, ["launching"], { status: "uncertain", body: { ...attempt.body, settledAt: at, uncertainAt: at } });
        if (!attempt || attempt.status !== "uncertain") return;
      }
      const { body } = attempt;
      let matches: string[];
      try {
        matches = body.mode === "spawn" ? await deps.spawned(body.resource.projectId ?? "", attempt.id)
          : await deps.marked(body.resource.threadId ?? "", body.marker) ? [body.resource.threadId!] : [];
      } catch (error) {
        record(attempt, ["uncertain"], { status: "uncertain", body: { ...body, failure: "source-unavailable", error: message(error) } });
        return;
      }
      const at = deps.now();
      const clear = { ...body, failure: null, error: null };
      if (matches.length === 1) record(attempt, ["uncertain"], { status: "running", threadId: matches[0]!, body: { ...clear, emptyReadbackAt: null } });
      else if (matches.length > 1) record(attempt, ["uncertain"], { status: "uncertain", body: { ...body, failure: "duplicate-writer", error: `Threads ${matches.join(", ")} answer to ${attempt.id}.` } });
      else if (body.emptyReadbackAt === null || body.settledAt === null || body.emptyReadbackAt < body.settledAt)
        record(attempt, ["uncertain"], { status: "uncertain", body: { ...clear, emptyReadbackAt: at } });
      else if (at - body.emptyReadbackAt >= READBACK_GAP) record(attempt, ["uncertain"], { status: "released", body: { ...clear, releasedReason: "no-worker" } });
      else record(attempt, ["uncertain"], { status: "uncertain", body: clear });
    });
  }

  /** Whether this process is making a launch on the PR now, which settles its claim when BB answers. */
  const launching = (target: string) => flights.has(`launch:${prWorkItemKey(target)}`);

  return { launch, recover, admission: open, launching };
}
