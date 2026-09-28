// decide(): the one place a PR row's next step is chosen, pure and
// deterministic over its facts, instruction, attempts, and resources. The
// order is the contract (plan §2.7): finished, paused, executing, recovering,
// verifying, an open decision, observe, work, lifecycle code actions, waits,
// then prepared. A hold pauses a row under every instruction. An open stack
// parent holds back only prepared, never the preparation work under it. Every
// result is an action, a wait with its wake, a decision with its answer route,
// or a system issue with its recovery.
import type { AdvanceFacts } from "./advance-contract.js";
import type { ApprovalFeedbackRecord } from "./approval-feedback.js";
import type { Pr } from "./contract.js";
import type { Effect, InstructionScope, WorkRecipe } from "./effort-command.js";
import { authorityNeed, recipe, WORKER_RESULTS, WORKER_ROUTES, type CodeRecipe, type CodeRecipeId, type RecipeId, type WorkerRecipe, type WorkerRecipeId } from "./effort-recipes.js";
import { prBlocker, prWriter, selectResource, type Resource, type ResourceAttempt, type ResourceInput } from "./effort-resources.js";
import type { ExecutionMode } from "./effort-work-store.js";
import type { ModelChoice, ModelRole } from "./execution.js";
import { mergeWait, prGates, type GateId } from "./pr-gates.js";
import { prWorkItemKey } from "./work-item-index.js";

export type Phase = "queued" | "executing" | "verifying" | "waiting" | "paused" | "decision-needed" | "repair-needed" | "prepared" | "finished";
type WorkerResult = (typeof WORKER_RESULTS)[number];
type Lifecycle = "mark-ready" | "request-review";
type Option = { id: string; label: string };

/** A v2 attempt on this PR, as the runner stores it. */
export type Attempt = ResourceAttempt & {
  recipes: WorkerRecipeId[];
  retryEpoch: number;
  /** The head and feedback fingerprint its work order was bound to. */
  headOid: string;
  fingerprint: string | null;
  /** When its turn ended, or its launch failed. */
  endedAt: number | null;
  /** A completed attempt's report as the key its recipes route: an outcome, `blocked:<kind>`, or report-invalid. Null until parsed. */
  result: WorkerResult | null;
  /** The first blocker it reported. */
  blocker: { summary: string; question: string | null; options: Option[]; prUrl: string | null } | null;
  /** Why a launch failed for good, such as project-source for HTTP 409. */
  failure: string | null;
  releasedReason: "no-worker" | "user-cancelled" | "stopped" | null;
  interactionPending: boolean;
  /** `stop N` asked this running worker to stop; its claim holds until a read shows its thread no longer active. */
  stopRequested: boolean;
  turnFailed: boolean;
  turnRetries: number;
  /** Readbacks in a row that couldn't read BB. */
  readbackFailures: number;
};
/** A code action on this PR, once per head and retry epoch: its key is written before the GitHub write, and its result after. */
export type CodeAction = { recipe: CodeRecipeId; headOid: string; retryEpoch: number; status: "pending" | "done" | "write-refused" | "rate-limited";
  /** When a rate-limited action may run again: GitHub's reset time plus 30 s, or the secondary-limit backoff. */
  retryAt?: number | null;
  /** What GitHub answered: why it refused, or what the action did. */
  detail?: string | null;
  /** When GitHub answered. */
  at?: number };
/** `grants` is exactly what answering allow (or, for a lifecycle question, naming a PR) adds to that PR's grant; null when an answer grants nothing. */
export type RowDecision = { key: string; kind: string; subkind: Lifecycle | null; question: string; options: Option[]; grants: { work: WorkRecipe[]; effects: Effect[] } | null };

export type DecideInput = {
  now: number;
  target: string;
  effort: { id: string; mode: ExecutionMode; archived: boolean };
  /** The effort that owns the PR now, or null when none does. */
  ownerId: string | null;
  /** The effort's active instruction, or null when none is active. */
  instruction: InstructionScope | null;
  held: boolean;
  /** The last full read of the PR. */
  full: { facts: AdvanceFacts; at: number } | null;
  feedback: ApprovalFeedbackRecord | null;
  reviewers: Pick<Pr, "reviewRequests" | "latestReviews"> | null;
  /** Our attempts on the PR, newest first. */
  attempts: readonly Attempt[];
  /** Newest first. */
  codeActions: readonly CodeAction[];
  /**
   * The row's current epoch. `retry N`, `reset N`, and a decision answer start
   * a new one: attempts count toward a bound only within one, and a finished
   * attempt's routed result holds only within its own.
   */
  retryEpoch: number;
  /** The open decision that names this PR. */
  decision: RowDecision | null;
  /** Lifecycle actions an answer declined for this PR in this instruction. */
  declined: readonly Lifecycle[];
  /** A user criterion bound to this PR still lacks accepted evidence on its head. */
  criteriaPending: boolean;
  /** PRs a worker reported blocking this one that have since merged or closed. */
  settledDependencies: ReadonlySet<string>;
  admission: { capacityFull: boolean; breakerOpen: boolean };
  models: Record<ModelRole, ModelChoice>;
  /**
   * The runner's reads of checkouts and threads. Before those reads exist, only the PR's other writers
   * are known: a launch then plans its recipes and leaves the checkout and thread to the read.
   */
  resources: Omit<ResourceInput, "effortId" | "pr" | "model" | "attempt"> | (Pick<ResourceInput, "legacy" | "writers"> & { inspections: null });
  /** GitHub's rate limit holds reads until then: a step that needs a read waits for the reset instead of failing. */
  rateLimitedUntil?: number | null;
  /** How many times the reconciler rechecked the uncertain legacy Advance job that holds this PR. */
  legacyRechecks?: number;
  /** GitHub couldn't read this PR in full on its last reads: how many in a row, the last error, and when it is read again. */
  unreadable?: { tries: number; error: string; retryAt: number } | null;
};

export type Next = {
  phase: Phase;
  cause: string;
  detail: string;
  modifiers: ("draining" | "recovering")[];
  /** What runs next: one work order or code action, a code procedure, or nothing until the wake. */
  nextAction: RecipeId[] | "observe" | "attach" | "parse-report" | "recover-launch" | "retry-turn" | null;
  owner: { kind: "v2-attempt" | "legacy-job" | "thread" | "user" | "github" | "reviewer" | "ci" | "pr"; ref: string | null } | null;
  /** What wakes the row, and when the reconciler looks again regardless. Null once finished. */
  wake: { event: string; ref: string | null; dueAt: number } | null;
  resource: Resource | { kind: "same-thread"; threadId: string } | null;
  /** A decision's key groups the same question across the effort; it is answered by command (`Dn`) or in the worker's thread. */
  decision: (RowDecision & { answer: "command" | "open-thread" }) | null;
  /** How a system issue recovers. */
  recovery: string[];
  offers: "stop"[];
};

const MINUTE = 60_000;
/** Retries v2 asks for after a worker's turn fails, before the failure is a system issue. */
export const TURN_RETRIES = 2;
/** Minutes to wait after the Nth environment blocker, or checkout that couldn't be prepared, on a head before trying again. */
const BACKOFF = [1, 2, 4, 8, 15];
/** A checkout that can't be prepared on one head, a PR GitHub can't read, or a launch BB can't be read back for, this many times in a row is a repair. */
const SOURCE_TRIES = 6;
/** An uncertain legacy Advance job still holding the PR after this many rechecks is a repair. */
export const LEGACY_RECHECKS = 6;
const CLAIMS = new Set<Attempt["status"]>(["launching", "running", "uncertain"]);
/** What wakes a waiting or paused row, and the poll that backs the event up (plan §2.6). */
const WAKES: Record<string, [event: string, pollMs: number]> = {
  ci: ["check results change", 2 * MINUTE],
  review: ["the review decision, reviews, review requests, or unresolved threads change", 15 * MINUTE],
  parent: ["the parent merges, closes, or gets a new head", 5 * MINUTE],
  dependency: ["the blocking PR merges, closes, or gets a new head", 5 * MINUTE],
  draft: ["the draft state changes, or a command names this PR", 15 * MINUTE],
  "merge-blocked": ["the merge state changes", 15 * MINUTE],
  "merge-requirements": ["the merge state changes", 15 * MINUTE],
  "writer-available": ["the other writer goes idle or releases its claim", 2 * MINUTE],
  capacity: ["a v2 worker turn ends", 2 * MINUTE],
  "launch-breaker": ["readback resolves the uncertain launches", 2 * MINUTE],
  "legacy-drain": ["the legacy Advance job settles", 10 * MINUTE],
  "rate-limit": ["GitHub's rate limit resets", MINUTE],
  "source-unavailable": ["the source reads again", MINUTE],
  hold: ["the hold is released", 15 * MINUTE],
  archived: ["the effort is restored", 15 * MINUTE],
  "v2-off": ["the effort opts into v2 again", 15 * MINUTE],
  "membership-moved": ["the owning effort's instruction includes it", 15 * MINUTE],
  "user-cancelled": ["retry N, or a command that names it", 15 * MINUTE],
  stopped: ["retry N, or a command that names it", 15 * MINUTE],
};
const PHASE_WAKES: Record<Exclude<Phase, "waiting" | "paused" | "finished">, [event: string, pollMs: number]> = {
  queued: ["the next reconciler pass", 0],
  verifying: ["the next reconciler pass", 0],
  executing: ["the worker's thread goes idle, fails, or asks for input", 5 * MINUTE],
  "decision-needed": ["an answer, or the PR merging", 15 * MINUTE],
  "repair-needed": ["retry N, or the PR merging", 15 * MINUTE],
  prepared: ["the PR changes or merges", 5 * MINUTE],
};
/** A step planned but not performed (a dry run's launch, a code action) is looked at again after this, unless an event wakes it first. */
export const PLANNED_POLL = 5 * MINUTE;
/** How often the reconciler looks at a row in this step whatever events arrive; null once finished. */
export function wakePoll(phase: Phase, cause: string): number | null {
  return phase === "finished" ? null : phase === "waiting" || phase === "paused" ? WAKES[cause]?.[1] ?? null : PHASE_WAKES[phase][1];
}
/** Causes of a repair-needed step that recovers on its own: our claim's launch is read back, or its failed turn retried. Every other one is a system issue. */
export const RECOVERING_CAUSES = ["launch-uncertain", "turn-retry"] as const;
const PAUSED = { hold: "On hold", archived: "The effort is archived", "v2-off": "The effort runs on legacy Advance",
  "membership-moved": "Another effort owns this PR now", "user-cancelled": "You deleted its queued work order", stopped: "Stopped" };
const CODE_LABEL: Record<CodeRecipeId, string> = { request_rereview: "Re-request review from reviewers who asked for changes",
  request_review: "Request review", mark_ready_for_review: "Mark ready for review", rerun_failed_checks: "Rerun the failed checks once" };
/** The gates a verified merge candidate passes; `fresh` and criteria are checked beside them. */
export const PREPARED: GateId[] = ["open", "unheld", "checks-green", "threads-resolved", "feedback-verified", "changes-addressed", "approved", "not-draft", "parent-merged", "merge-clean"];

export function decide(input: DecideInput): Next {
  const { now, full, attempts } = input;
  const target = prWorkItemKey(input.target);
  const latest = attempts[0] ?? null;
  const claim = latest && CLAIMS.has(latest.status) ? latest : null;
  const grant = input.instruction?.include.find((item) => prWorkItemKey(item.target) === target) ?? null;
  const facts = full?.facts ?? null;
  const name = facts ? `${facts.repo} #${facts.number}` : target;
  const user = { kind: "user" as const, ref: null };

  const next = (phase: Phase, cause: string, detail: string, more: Partial<Next> = {}): Next => {
    const [event, poll] = phase === "waiting" || phase === "paused" ? WAKES[cause]! : phase === "finished" ? ["", 0] : PHASE_WAKES[phase];
    return { phase, cause, detail, modifiers: [], nextAction: null, owner: null, resource: null, decision: null, recovery: [], offers: [],
      wake: phase === "finished" ? null : { event, ref: null, dueAt: now + poll }, ...more };
  };
  const limited = input.rateLimitedUntil != null && now < input.rateLimitedUntil ? input.rateLimitedUntil : null;
  /**
   * A step that reads the PR in full, when GitHub couldn't read it: it waits out a backoff of 1, 2, 4, 8, then 15 minutes, and after six
   * tries in a row it is a system issue. Either way the read runs again at its wake, so the row recovers once GitHub reads it.
   */
  const unreadable = (step: Next): Next => {
    const failing = input.unreadable;
    if (!failing || (failing.tries < SOURCE_TRIES && now >= failing.retryAt)) return step;
    const detail = `${step.detail}; GitHub couldn't read ${name} ${failing.tries} ${failing.tries === 1 ? "time" : "times"} in a row: ${failing.error}`;
    return failing.tries >= SOURCE_TRIES ? { ...issue("source-unavailable", detail), nextAction: step.nextAction, recovery: ["refresh N"] }
      : waiting("source-unavailable", detail, { kind: "github", ref: null }, { nextAction: step.nextAction, wake: { event: WAKES["source-unavailable"]![0], ref: null, dueAt: failing.retryAt } });
  };
  // A rate limit is a wait with its reset time, never a repair.
  const observe = (detail: string) => limited === null ? unreadable(next("verifying", "observe", detail, { nextAction: "observe" }))
    : waiting("rate-limit", `${detail}; GitHub's rate limit is reached until it resets`, { kind: "github", ref: null }, { wake: { event: WAKES["rate-limit"]![0], ref: null, dueAt: limited } });
  const issue = (cause: string, detail: string) => next("repair-needed", cause, detail, { owner: user, recovery: ["retry N"] });
  const ask = (cause: string, question: string, options: Option[], key: string, subkind: Lifecycle | null = null, answer: "command" | "open-thread" = "command",
    grants: RowDecision["grants"] = null) => next("decision-needed", cause, question, { owner: user, decision: { key, kind: cause, subkind, question, options, grants, answer } });
  const waiting = (cause: string, detail: string, owner: Next["owner"], more: Partial<Next> = {}) => {
    const step = next("waiting", cause, detail, { owner, ...more });
    return { ...step, wake: step.wake && { ...step.wake, ref: owner?.ref ?? null } };
  };
  /** Our other attempts own a wait for a worker slot or for uncertain launches to resolve. */
  const workers = { kind: "v2-attempt" as const, ref: null };
  const fromResource = (resource: Extract<Resource, { kind: "wait" | "decision" | "repair" }>): Next =>
    resource.kind === "repair" ? { ...issue(resource.cause, resource.reason), resource }
    : resource.cause === "legacy-drain" && input.resources.legacy?.cause === "uncertain" && (input.legacyRechecks ?? 0) >= LEGACY_RECHECKS
      ? { ...issue("legacy-uncertain", `${resource.reason}, still uncertain after ${LEGACY_RECHECKS} rechecks`), resource }
    : resource.kind === "decision" ? { ...ask("authority", `${resource.reason}. Allow v2 to push to ${name} anyway?`, [{ id: "allow", label: "Allow" }, { id: "leave", label: "Leave it" }], `authority:${target}:checkout`), resource }
    : waiting(resource.cause, resource.reason, resource.cause === "legacy-drain" ? { kind: "legacy-job", ref: resource.ref }
      : resource.cause === "draft" ? user : { kind: "thread", ref: resource.ref }, { resource });
  /** The question names everything allow grants, so an answer never widens the instruction beyond what it read. */
  const authority = (work: WorkRecipe[], effects: Effect[]) => {
    const missing = [...work.map((id) => id.replaceAll("_", " ")), ...effects];
    return ask("authority", `${name} needs ${missing.join(", ")}, which this instruction doesn't grant. Allow it?`,
      [{ id: "allow", label: "Allow" }, { id: "leave", label: "Leave it" }], `authority:${target}:${missing.join(",")}`, null, "command", { work, effects });
  };

  // Our claim: attach to it, answer for it, or recover it. Never a second launch.
  const claimed = (attempt: Attempt): Next => {
    const owner = { kind: "v2-attempt" as const, ref: attempt.id };
    const recovering = (cause: (typeof RECOVERING_CAUSES)[number], detail: string, nextAction: Next["nextAction"], event: string) =>
      next("repair-needed", cause, detail, { modifiers: ["recovering"], nextAction, owner, wake: { event, ref: attempt.id, dueAt: now + 2 * MINUTE } });
    if (attempt.status === "uncertain") {
      // More than one worker answers to the launch key: the claim stays until you stop the extras and release it.
      if (attempt.failure === "duplicate-writer")
        return { ...issue("duplicate-writer", `More than one BB thread answers to attempt ${attempt.id}; stop the extras, then release its claim`), owner, recovery: ["reset N release"] };
      if (attempt.failure === "source-unavailable") {
        // Read back again after 1, 2, 4, 8, then 15 minutes; after six tries it is a system issue, still read back at its poll.
        const tries = Math.max(attempt.readbackFailures, 1);
        const detail = `BB couldn't be read back for attempt ${attempt.id} ${tries} ${tries === 1 ? "time" : "times"} in a row; its claim holds until a readback succeeds`;
        return tries >= SOURCE_TRIES ? { ...issue("source-unavailable", detail), owner, nextAction: "recover-launch", recovery: ["recheck launches", "reset N release"] }
          : waiting("source-unavailable", detail, owner, { nextAction: "recover-launch",
            wake: { event: WAKES["source-unavailable"]![0], ref: attempt.id, dueAt: now + BACKOFF[Math.min(tries, BACKOFF.length) - 1]! * MINUTE } });
      }
      return recovering("launch-uncertain", "Launch outcome uncertain; reading BB back by its launch key", "recover-launch", "readback finds or rules out its worker");
    }
    if (attempt.stopRequested) return next("executing", "worker", `Stopping the worker in ${attempt.threadId}; nothing new starts`,
      { nextAction: "attach", owner, modifiers: ["draining"] });
    // Past the bound, the runner ends the attempt, so `retry N` can start a new one.
    if (attempt.turnFailed) return recovering("turn-retry", attempt.turnRetries < TURN_RETRIES ? `The worker's turn failed; retry ${attempt.turnRetries + 1} of ${TURN_RETRIES}`
      : `The worker's turn failed ${TURN_RETRIES + 1} times; ending the attempt`, "retry-turn", "the retried turn starts");
    // Its interactions are read again at a 5-minute poll too, in case the event that cleared them never reached us.
    if (attempt.interactionPending) return { ...ask("worker-interaction", `The worker in ${attempt.threadId} is waiting for your input`, [{ id: "open", label: "Open thread" }],
      `worker-interaction:${attempt.id}`, null, "open-thread"), wake: { event: "the worker's interactions clear", ref: attempt.id, dueAt: now + 5 * MINUTE } };
    return next("executing", attempt.status === "launching" ? "launching" : "worker", attempt.status === "launching" ? "Launching the worker" : `Worker running in ${attempt.threadId}`,
      { nextAction: "attach", owner });
  };
  // Our claim drains before the row pauses or finishes. A failed turn has already ended, so its retry is a next action the step blocks.
  const drainOr = (step: Next): Next => {
    if (!claim || claim.turnFailed) return step;
    const current = claimed(claim);
    return { ...current, detail: `${step.detail}. The current turn finishes; nothing new starts.`, modifiers: [...current.modifiers, "draining"], offers: claim.status === "running" ? ["stop"] : [] };
  };

  // 1. Finished: merged or closed, or out of the instruction.
  if (facts && facts.state !== "OPEN") return drainOr(next("finished", facts.state === "MERGED" ? "merged" : "closed", facts.state === "MERGED" ? "Merged" : "Closed"));
  if (!grant) {
    const superseded = input.instruction?.removed.some((item) => prWorkItemKey(item.target) === target && item.reason === "superseded") ?? false;
    const detail = superseded ? "Superseded by a later instruction" : input.instruction ? "No longer in the instruction" : "No instruction is active";
    return drainOr(next("finished", superseded ? "superseded" : "cancelled", detail));
  }

  // 2. Paused: a hold outlasts every instruction; archive, opt-out, a membership move, or our own stop pause the row too.
  const stopped = latest?.status === "released" && latest.retryEpoch === input.retryEpoch
    && (latest.releasedReason === "user-cancelled" || latest.releasedReason === "stopped") ? latest.releasedReason : null;
  const pause = input.effort.archived ? "archived" : input.effort.mode !== "v2" ? "v2-off"
    : input.ownerId !== null && input.ownerId !== input.effort.id ? "membership-moved" : input.held ? "hold" : stopped;
  if (pause) return drainOr(next("paused", pause, PAUSED[pause], { owner: user }));

  // 3-4. Executing or recovering.
  if (claim) return claimed(claim);

  const gates = full && prGates({ facts: full.facts, observedAt: full.at, now, held: input.held, feedback: input.feedback, reviewers: input.reviewers });
  /** A code action runs once per head within the row's retry epoch, so `retry N` may run it once more. */
  const codeAction = (id: CodeRecipeId, headOid: string) =>
    input.codeActions.find((action) => action.recipe === id && action.headOid === headOid && action.retryEpoch === input.retryEpoch) ?? null;
  const effects = (id: CodeRecipeId): Effect[] => id === "request_review" && grant.reviewers.length === 0 ? grant.effects.filter((effect) => effect !== "request-review") : grant.effects;
  /** One code action per head: run it, read it back, route its result, or ask for the effect it needs. Null once done. */
  const code = (id: CodeRecipeId): Next | null => {
    if (!facts || !gates) return observe("No full read yet");
    const previous = codeAction(id, facts.headOid);
    if (previous?.status === "pending") return next("executing", "code-action", `${CODE_LABEL[id]}: waiting for GitHub's answer, or reading it back`,
      { nextAction: [id], owner: { kind: "github", ref: null } });
    // A rate limit stays a wait until it resets; then the action runs again.
    if (previous && previous.status !== "done" && !(previous.status === "rate-limited" && now >= (previous.retryAt ?? 0))) {
      const [kind, value] = (recipe(id) as CodeRecipe).otherwise[previous.status]!.split(":") as [string, string];
      return kind === "wait" ? waiting(value, `${CODE_LABEL[id]}: GitHub rate limit`, { kind: "github", ref: null },
        previous.status === "rate-limited" ? { wake: { event: WAKES[value]![0], ref: null, dueAt: previous.retryAt ?? now } } : {})
        : issue(value, `${CODE_LABEL[id]}: GitHub refused the write${previous.detail ? `: ${previous.detail}` : ""}`);
    }
    if (previous?.status === "done") return null;
    const need = authorityNeed(id, effects(id));
    if (need?.kind === "lifecycle") return input.declined.includes(need.subkind) ? null : need.subkind === "mark-ready"
      ? ask("lifecycle", "Mark these drafts ready for review? Their branches and checks are settled.", [{ id: "ready", label: "Mark ready" }, { id: "keep", label: "Keep as draft" }],
        "lifecycle:mark-ready", "mark-ready", "command", { work: [], effects: ["mark-ready"] })
      : ask("lifecycle", "Request review from whom? No review is requested on these PRs yet.", [{ id: "name", label: "Name reviewers: request review N from @login" },
        { id: "none", label: "Don't request review" }], "lifecycle:request-review", "request-review");
    if (need) return authority([], need.missing);
    if (!gates.fresh) return observe(`${CODE_LABEL[id]} needs a read under two minutes old`);
    const busy = prWriter(input.resources);
    return busy ? fromResource(busy) : next("queued", "code-action", CODE_LABEL[id], { nextAction: [id] });
  };

  // Our own GitHub write landed after the last full read, so that read no longer shows the PR: read it again before judging it.
  const wrote = facts && full ? input.codeActions.find((action) => action.status === "done" && action.headOid === facts.headOid && (action.at ?? 0) > full.at) : null;
  if (wrote) return observe(`${CODE_LABEL[wrote.recipe]}: reading GitHub after it`);

  // 5. Verifying: a finished attempt's report routes through its recipes, within its retry epoch.
  if (latest && latest.retryEpoch === input.retryEpoch) {
    // The report corrections the worker's thread was asked for since its work attempt, newest first, and that work attempt.
    const epoch = attempts.filter((item) => item.retryEpoch === input.retryEpoch);
    const leading = epoch.findIndex((item) => item.recipes.length !== 1 || item.recipes[0] !== "repair_report");
    const corrections = leading === -1 ? epoch.length : leading;
    if (latest.status === "failed" && latest.failure === "workspace") {
      // Its checkout couldn't be prepared, so nothing started: like a source that didn't read, it backs off on its head, and a new head reverifies.
      const failed = attempts.filter((item) => item.retryEpoch === input.retryEpoch && item.headOid === latest.headOid && item.status === "failed" && item.failure === "workspace").length;
      if (latest.headOid === facts?.headOid) {
        if (failed >= SOURCE_TRIES) return issue("workspace", `The checkout couldn't be prepared ${failed} times on this head`);
        const due = (latest.endedAt ?? now) + BACKOFF[Math.min(failed, BACKOFF.length) - 1]! * MINUTE;
        if (now < due) return waiting("source-unavailable", "The checkout couldn't be prepared; trying again after a backoff", { kind: "v2-attempt", ref: latest.id },
          { wake: { event: WAKES["source-unavailable"]![0], ref: latest.id, dueAt: due } });
      }
    } else if (latest.status === "failed") return issue(latest.failure ?? "turn-failed", latest.failure === "turn-failed"
      ? `The worker's turn failed ${TURN_RETRIES + 1} times` : `The launch failed: ${latest.failure ?? "unknown cause"}`);
    if (latest.status === "completed" && latest.result === null)
      return unreadable(next("verifying", "parse-report", "Reading the worker's report", { nextAction: "parse-report", owner: { kind: "v2-attempt", ref: latest.id } }));
    if (latest.status === "completed" && latest.result !== null) {
      const key = latest.result;
      const routes = latest.recipes.map((id) => (recipe(id) as WorkerRecipe).otherwise[key]);
      // A composed order takes a recipe's own route over the shared one.
      const [kind, value] = (routes.find((route) => route !== WORKER_ROUTES[key]) ?? routes[0]!).split(":") as [string, string | undefined];
      const question = latest.blocker?.question ?? latest.blocker?.summary ?? `${name}: the worker reported ${key}`;
      const worker = () => ask("worker-question", question, latest.blocker?.options.length ? latest.blocker.options : [{ id: "text", label: "Answer in your own words" }],
        `worker-question:${question.trim().toLowerCase()}`);
      if (kind === "wait" && value === "dependency") {
        const blocking = latest.blocker?.prUrl ? prWorkItemKey(latest.blocker.prUrl) : null;
        if (!blocking) return worker();
        if (!input.settledDependencies.has(blocking)) return waiting("dependency", `Waiting for ${blocking}`, { kind: "pr", ref: blocking });
      } else if (kind === "wait") {
        // Environment blockers back off 1, 2, 4, 8, then 15 minutes on one head before trying again.
        const count = attempts.filter((item) => item.retryEpoch === input.retryEpoch && item.headOid === latest.headOid && item.result === key).length;
        const due = (latest.endedAt ?? now) + BACKOFF[Math.min(count, BACKOFF.length) - 1]! * MINUTE;
        if (now < due) return waiting(value!, latest.blocker?.summary ?? "The worker couldn't reach a source", { kind: "github", ref: null }, { wake: { event: WAKES[value!]![0], ref: null, dueAt: due } });
      } else if (kind === "decision") {
        // A product question asks once across PRs; authority is granted per target.
        return value === "worker-question" ? worker() : ask(value!, question, latest.blocker?.options.length ? latest.blocker.options : [{ id: "text", label: "Answer in your own words" }],
          `${value}:${value === "authority" ? `${target}:` : ""}${question.trim().toLowerCase()}`);
      } else if (kind === "recipe" || (key === "report-invalid" && corrections > 0)) {
        // The worker that did the work re-emits its report; no one else can. Its thread gets at most the work recipes' reportCorrections
        // requests; a correction that is still unreadable after them is a named issue.
        const bound = Math.min(...(epoch[corrections]?.recipes ?? ["repair_report"]).map((id) => (recipe(id) as WorkerRecipe).bound.reportCorrections ?? 0));
        if (corrections >= bound)
          return issue("report-unrepairable", `The worker's report still can't be read after ${corrections} ${corrections === 1 ? "correction" : "corrections"} in its thread`);
        if (!latest.threadId) return issue("report-unrepairable", "The worker's report can't be corrected: its thread is unknown");
        const busy = prWriter(input.resources);
        if (busy) return fromResource(busy);
        if (input.admission.breakerOpen) return waiting("launch-breaker", "Launch outcomes uncertain; new launches paused", workers);
        if (input.admission.capacityFull) return waiting("capacity", "Waiting for a v2 worker slot", workers);
        return next("queued", "report-repair", `Asking ${latest.threadId} to re-emit its report`, { nextAction: ["repair_report"], resource: { kind: "same-thread", threadId: latest.threadId } });
      } else if (kind === "code" && latest.headOid === facts?.headOid && gates?.["checks-settled"] && gates["checks-green"] === false) {
        // An environment blocker on failing checks reruns them once on the head it reported; failing again is a CI issue.
        // A new head or checks still running go back to fresh gates.
        const rerun = codeAction("rerun_failed_checks", latest.headOid);
        if (rerun?.status === "done") return issue("ci-infrastructure", `Checks still fail on this head after its one rerun${rerun.detail ? ` (${rerun.detail})` : ""}`);
        const step = code("rerun_failed_checks");
        if (step) return step;
      } else if (kind === "repair") return issue(value!, latest.blocker?.summary ?? `The worker reported ${key}`);
      // Otherwise (reverify, retry, a settled dependency, a backoff that passed): fresh gates decide.
    }
  }

  // 6. An open decision names this PR.
  if (input.decision) return next("decision-needed", input.decision.kind, input.decision.question, { owner: user, decision: { ...input.decision, answer: "command" } });

  // 7. Observe: no full read yet, or none since the last turn ended.
  if (!facts || !gates || !full) return observe("No full read yet");
  if (latest?.endedAt && full.at < latest.endedAt) return observe("Reading GitHub after the last attempt ended");

  // 8. Work, even under an open parent or pending CI: a push reruns CI anyway. A draft gets only branch and check mechanics.
  const failing: WorkerRecipeId[] = [];
  if (gates["no-conflict"] === false || gates["base-current"] === false) failing.push("integrate_base");
  if (gates["checks-settled"] && gates["checks-green"] === false) failing.push("fix_failing_checks");
  if (!facts.isDraft) {
    // History a fresh read still can't settle is a system issue, read again at its wake rather than on every pass.
    if (gates["feedback-verified"] === null) return gates.fresh ? { ...issue("feedback-unreadable", "GitHub's review feedback history for this PR can't be read completely"), recovery: ["refresh N"] }
      : observe("Review feedback history is incomplete");
    if (gates["threads-resolved"] === false || gates["feedback-verified"] === false || gates["changes-addressed"] === false) failing.push("address_review_feedback");
    // Criteria ride along with other work; they run alone only when nothing else is due.
    if (failing.length === 0 && input.criteriaPending) failing.push("validate_criteria");
  }
  if (failing.length) {
    const allowed = failing.filter((id) => (grant.work as string[]).includes(id) && !authorityNeed(id, grant.effects));
    if (allowed.length === 0) return authority(failing.filter((id): id is WorkRecipe => !(grant.work as string[]).includes(id)),
      [...new Set(failing.flatMap((id) => (authorityNeed(id, grant.effects) as { missing: Effect[] } | null)?.missing ?? []))]);
    if (!gates.fresh) return observe("A launch needs a read under two minutes old");
    const fingerprint = facts.approvalFeedback.status === "present" ? facts.approvalFeedback.fingerprint : null;
    const same = (recipes: readonly string[]) => [...recipes].sort().join() === [...allowed].sort().join();
    const work = attempts.filter((item) => item.retryEpoch === input.retryEpoch && item.headOid === facts.headOid && item.fingerprint === fingerprint && same(item.recipes));
    // A launch that never started a worker doesn't count as an attempt. One readback proved never started requeues once, and a second is
    // exhausted; one whose checkout couldn't be prepared backs off above.
    const lost = work.filter((item) => item.status === "released" && item.releasedReason === "no-worker").length;
    if (lost >= 2) return issue("retry-exhausted", `${allowed.join(", ")} launched twice on this head and readback found no worker either time`);
    const tried = work.length - lost - work.filter((item) => item.status === "failed" && item.failure === "workspace").length;
    if (tried >= Math.min(...allowed.map((id) => recipe(id).bound.attemptsPerHead)))
      return issue("retry-exhausted", `${allowed.join(", ")} reached its bound of ${tried} attempts on this head`);
    const role: ModelRole = allowed.some((id) => (recipe(id) as WorkerRecipe).modelRole === "code") ? "code" : "planning";
    const { resources } = input;
    const resource = resources.inspections === null ? prBlocker({ ...resources, pr: facts })
      : selectResource({ ...resources, effortId: input.effort.id, pr: facts, model: input.models[role], attempt: latest });
    if (resource?.kind === "wait" || resource?.kind === "decision" || resource?.kind === "repair") return fromResource(resource);
    if (resource?.kind === "attach") return next("executing", "attached", `Attached to attempt ${resource.attemptId}`, { nextAction: "attach", resource });
    if (input.admission.breakerOpen) return waiting("launch-breaker", "Launch outcomes uncertain; new launches paused", workers, { resource });
    if (input.admission.capacityFull) return waiting("capacity", "Waiting for a v2 worker slot", workers, { resource });
    return next("queued", "launching", `${allowed.join(" + ")} ${!resource ? "once its checkout and thread are read" : resource.kind === "reuse" ? `in ${resource.threadId}` : `in a new thread: ${resource.reason}`}`,
      { nextAction: allowed, resource });
  }

  // 9. Lifecycle code actions: re-request, mark ready, or request review, each once per head and only with its effect. Unread reviewers choose none.
  // A write whose answer never came, as when a restart cut it off, is read back even once a read shows its need passed, so a later need on
  // this head can't spend its once-per-head bound again. The runner settles it with no write when GitHub shows it in effect or no longer needed.
  const unsettled = input.codeActions.find((action) => action.status === "pending" && action.headOid === facts.headOid && action.retryEpoch === input.retryEpoch);
  if (unsettled) return code(unsettled.recipe)!;
  if (!facts.isDraft) {
    const step = (gates["rereview-requested"] === false ? code("request_rereview") : null) ?? (gates["review-requested"] === false ? code("request_review") : null);
    if (step) return step;
  } else if (gates["no-conflict"] && gates["base-current"] && gates["checks-green"]) {
    const step = code("mark_ready_for_review");
    if (step) return step;
  }

  // 10. Waits, each with its owner.
  if (gates["checks-settled"] === false) return waiting("ci", `Checks running on ${facts.headOid.slice(0, 7)}`, { kind: "ci", ref: null });
  if (gates["parent-merged"] === false) return waiting("parent", `Waiting for parent #${facts.basePrNumber} to merge`, { kind: "pr", ref: `${facts.repo}#${facts.basePrNumber}` });
  if (facts.isDraft) return waiting("draft", "You kept this PR a draft", user);
  if (!gates.approved) {
    if (!input.reviewers) return waiting("review", "Waiting for approval; the PR's reviewers haven't been read yet", { kind: "github", ref: null });
    if (gates["review-requested"] === false && input.declined.includes("request-review")) return waiting("review", "You chose not to request review in this instruction", user);
    // A request this head already made names its reviewers until a read shows it.
    const requested = gates["review-requested"] === false ? grant.reviewers : input.reviewers.reviewRequests;
    return waiting("review", requested.length ? `Waiting for review from ${requested.map((login) => `@${login}`).join(", ")}` : "Waiting for approval", { kind: "reviewer", ref: requested.join(",") || null });
  }
  if (gates["merge-clean"] === null) return observe("GitHub hasn't computed mergeability yet");
  if (!gates["merge-clean"]) {
    const cause = mergeWait(facts);
    return waiting(cause, cause === "merge-blocked" ? "Merge blocked by branch protection" : "Waiting for merge requirements", { kind: "github", ref: null });
  }

  // 11. Prepared: a verified merge candidate on a fresh read. Merge stays its own confirmed action.
  if (!gates.fresh) return observe("Ready needs a read under two minutes old");
  const unmet = PREPARED.filter((gate) => gates[gate] !== true);
  if (unmet.length || input.criteriaPending) return waiting("merge-requirements", `Short of Ready: ${[...unmet, ...input.criteriaPending ? ["criteria-satisfied"] : []].join(", ")}`, { kind: "github", ref: null });
  return next("prepared", "merge-candidate", "Ready to merge through its fresh preview", { owner: user });
}
