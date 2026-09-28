// The effort roster: one permanently numbered row per PR an effort owns or its
// instruction includes, projected from the facts the board already keeps. A PR
// in the instruction shows its v2 row's state. Outside it nothing is authorized
// work, so an open row is Doing only while a writer holds it, a system issue
// only while a legacy launch is uncertain, and otherwise it shows the need its
// observed gates name. Legacy attempts stay history: they explain counts and
// never become current state.
import { z } from "zod";
import type { AdvanceFacts } from "./advance-contract.js";
import type { ApprovalFeedbackRecord } from "./approval-feedback.js";
import type { Pr } from "./contract.js";
import type { DispatchAttempt } from "./dispatch.js";
import { dryRunStopRefusal, effortCommandResultSchema, formatTargets, interventionRefusal, legacyRefusal, type CommandRow, type InstructionScope } from "./effort-command.js";
import { PLANNED_POLL, wakePoll } from "./effort-phase.js";
import { recipe } from "./effort-recipes.js";
import { cheapSignature, type StoredPrFacts } from "./effort-roster-store.js";
import type { Admission, V2Execution } from "./effort-runner.js";
import type { EstablishedEffort } from "./effort-store.js";
import { currentRow, USER_STATES, workRowBodySchema, type Execution, type StoredAttempt, type WorkRow } from "./effort-work-store.js";
import { prTarget } from "./ghactions.js";
import type { PrObservation } from "./inventory-store.js";
import type { LegacyAttempt } from "./legacy-history.js";
import { checkCounts, checksFailed, checksGreen } from "./pr-checks.js";
import { GATE_IDS, mergeWait, prGates, type GateId, type Gates } from "./pr-gates.js";
import { canonicalPrUrl, prHoldFor, prHoldSchema, type PrHolds } from "./pr-holds.js";
import { STATE_LABEL } from "./roster-shared.js";
import type { Run } from "./runs.js";
import type { ThreadFacts } from "./threads.js";
import { prWorkItemKey } from "./work-item-index.js";
import { displayTitle } from "./workstreams.js";

const ticketSchema = z.object({ id: z.string(), title: z.string().nullable(), url: z.string().nullable() });
const actionSchema = z.object({ ok: z.boolean(), why: z.string().nullable() });
export const rosterRowSchema = z.object({
  n: z.number(), provisional: z.boolean(), target: z.string(), repo: z.string(), number: z.number(), title: z.string(),
  state: z.enum([...USER_STATES, "not-in-instruction"]), cause: z.string(), label: z.string(),
  owner: z.enum(["you", "ci", "reviewer", "parent", "github", "legacy-job", "run", "dispatch", "thread", "v2"]).nullable(),
  /** Included by the instruction without being a member; membership is unchanged. */
  outsideMembership: z.boolean(),
  modifiers: z.array(z.string()),
  hold: prHoldSchema.nullable(), reviewers: z.array(z.object({ login: z.string(), state: z.string() })), requested: z.array(z.string()),
  head: z.string().nullable(), checks: z.enum(["passed", "pending", "failed", "unknown"]).nullable(), reviewDecision: z.string().nullable(),
  gates: z.record(z.enum(GATE_IDS), z.boolean().nullable()).nullable(),
  observedAt: z.number().nullable(), failedAt: z.number().nullable(),
  tickets: z.array(ticketSchema), checkouts: z.array(z.string()),
  legacy: z.object({ batchId: z.string(), jobId: z.string(), cause: z.string(), label: z.string(), jobs: z.number() }).nullable(),
  /** What wakes the row's v2 step, and when the reconciler looks again regardless; null outside the instruction and once finished. */
  wake: z.object({ event: z.string(), dueAt: z.number() }).nullable(),
  nextAction: workRowBodySchema.shape.nextAction,
  /**
   * Who performs the v2 step: a worker, a code action, or a code procedure (a GitHub read, a report read, a launch readback), where it
   * runs and why there, and whether it is only planned (a dry run). Null outside the instruction.
   */
  work: z.object({ executor: z.enum(["worker", "code", "procedure"]).nullable(), recipes: z.array(z.string()),
    resource: z.object({ kind: z.string(), threadId: z.string().nullable(), reason: z.string().nullable() }).nullable(), planned: z.boolean() }).nullable(),
  /** Our attempt's writer claim on the PR. */
  claim: z.object({ attemptId: z.string(), status: z.enum(["launching", "running", "uncertain"]), threadId: z.string().nullable(), since: z.number() }).nullable(),
  /** The PR this one is stacked on, and its number when it is on this roster. */
  stack: z.object({ parentTarget: z.string(), parentN: z.number().nullable() }).nullable(),
  checkCounts: z.object({ done: z.number(), total: z.number(), failed: z.number() }).nullable(),
  /** The last observation is at least twice the row's poll old, or a failed read is newer than it. */
  stale: z.boolean(),
  /**
   * When the row goes stale unless a newer read lands first; null when it never does (a done row, or one never read). A read that finds
   * nothing new signals no one, so a pane refetches once when a row's staleAt passes rather than trusting its copy's age.
   */
  staleAt: z.number().nullable(),
  /** How the active instruction names the PR; null with no active instruction. */
  membership: z.enum(["included", "excluded", "removed", "outside"]).nullable(), membershipReason: z.string().nullable(),
  /** Whether `recheck N`, `reset N` (with `release` for an unfinished launch), `retry N`, and `stop N` would be admitted now, and why not. */
  actions: z.object({ recheck: actionSchema, reset: actionSchema.extend({ release: z.boolean() }), retry: actionSchema, stop: actionSchema }),
});
export const effortRosterSchema = z.object({
  effort: z.object({ id: z.string(), key: z.string(), name: z.string(), goal: z.string(), archivedAt: z.number().nullable(),
    redirectedFrom: z.string().nullable(), coordinatorThreadId: z.string().nullable() }),
  snapshotId: z.string().nullable(),
  execution: z.object({ mode: z.enum(["legacy", "v2"]), revision: z.number() }),
  /** The v2Execution setting: a dry run plans every step and claims, starts, sends, and writes nothing. */
  v2Execution: z.enum(["dry-run", "on"]),
  instruction: z.object({ id: z.string(), revision: z.number(), text: z.string(), reportMode: z.string(), outcome: z.string().nullable(),
    /** Row numbers the instruction includes, and the rows it leaves alone for this instruction only. */
    included: z.array(z.number()), excluded: z.array(z.object({ target: z.string(), n: z.number().nullable(), reason: z.string() })) }).nullable(),
  /** Outcome, Validated, Still needed, and Needs a decision; null without an active instruction. */
  rollup: z.array(z.string()).nullable(),
  /** The evidence contract the rollup is written from: each criterion, the rows still short of it, and what moves it next; null without an active instruction. */
  contract: z.object({
    criteria: z.array(z.object({ id: z.string(), source: z.enum(["gate", "ticket", "user"]), label: z.string(), status: z.enum(["satisfied", "missing", "invalidated", "blocked"]),
      affected: z.array(z.object({ target: z.string(), n: z.number().nullable() })), next: z.object({ action: z.string(), owner: z.string(), wake: z.string() }).nullable() })),
    outcomeValidated: z.boolean(), completed: z.boolean() }).nullable(),
  observedAt: z.number(),
  rows: z.array(rosterRowSchema),
  /**
   * System issues, S1, S2, … in the order they were raised: a failure one or more PRs share, or new launches paused while launch outcomes
   * are uncertain. `ref` and `raisedAt` stay while the issue is open; both are null where nothing numbers issues (a database copy).
   * `detail` names each PR's own detail when they differ. Each recovery is a command, and `confirm` marks one that drops a claim.
   */
  issues: z.array(z.object({ ref: z.string().nullable(), cause: z.string(), label: z.string(), detail: z.string().nullable(), numbers: z.array(z.number()),
    raisedAt: z.number().nullable(), recovery: z.array(z.object({ command: z.string(), label: z.string(), confirm: z.boolean() })), likelyThreadId: z.string().nullable() })),
  /** Whether new v2 launches may start: the breaker opens while launch outcomes are uncertain. The uncertain launches listed are this effort's. */
  launches: z.object({ breakerOpen: z.boolean(), capacityFull: z.boolean(),
    uncertain: z.array(z.object({ n: z.number().nullable(), target: z.string(), attemptId: z.string(), threadId: z.string().nullable(), since: z.number() })) }).nullable(),
  ticketsWithoutPrs: z.array(ticketSchema),
  /** Derived board groups that already reach into this roster: suggestions, never membership. */
  suggestions: z.array(z.object({ key: z.string(), name: z.string(), tickets: z.array(z.string()), prUrls: z.array(z.string()), overlap: z.array(z.string()) })),
  /** Legacy job rows and v2 attempts behind these PRs: why Advance's and the attempts' counts exceed the roster's. */
  history: z.object({ legacyJobs: z.number(), legacyPrs: z.number(), v2Attempts: z.number() }),
  /**
   * Open decisions, one per real choice, each answered by `Dn …` or effort_decision_answer at its revision. A worker's question carries
   * its evidence from every PR that asked it, its recommendation and reason, what each option means for the work, and the attempt that
   * asked first. A mark-ready question recommends the drafts that are settled with no worker note, and gives each draft's note.
   * `answer` says where it is answered: by command, or in the worker's thread.
   */
  decisions: z.array(z.object({ id: z.string(), n: z.number(), revision: z.number(), kind: z.string(), subkind: z.enum(["mark-ready", "request-review"]).nullable(),
    question: z.string(), createdAt: z.number().nullable(), answer: z.enum(["command", "open-thread"]),
    options: z.array(z.object({ id: z.string(), label: z.string(), consequence: z.string().nullable() })),
    recommendation: z.object({ optionId: z.string().nullable(), numbers: z.array(z.number()).nullable(), reason: z.string().nullable() }).nullable(),
    evidence: z.array(z.object({ label: z.string(), url: z.string().nullable() })),
    source: z.object({ attemptId: z.string(), threadId: z.string().nullable(), label: z.string() }).nullable(),
    targets: z.array(z.object({ target: z.string(), n: z.number().nullable(), note: z.string().nullable(), recommended: z.boolean().nullable() })) })),
  /** The newest admitted command: its text, the surface it came from (null when journaled before surfaces were kept), when, the revision after it, the snapshot it read, and its result. */
  lastCommand: z.object({ requestId: z.string(), text: z.string(), origin: z.enum(["panel", "banner", "thread", "cli"]).nullable(), at: z.number(), revision: z.number().nullable(),
    snapshotId: z.string().nullable(), result: effortCommandResultSchema }).nullable(),
  /** Roster answers held for Undo, oldest first: each is admitted at `until` unless taken back with effort_command_undo. */
  pending: z.array(z.object({ requestId: z.string(), text: z.string(), decisions: z.array(z.number()), until: z.number() })),
  /** The effort's newest journal sequence: pass it back as `since` to read what changed after this roster. */
  through: z.number(),
  /**
   * What changed after the `since` the read named, or null without one: each row's first and last phase since then, decisions
   * asked and system issues raised since and still open, rows on a new head, and the steps v2 took without a command.
   */
  since: z.object({ rows: z.array(z.object({ n: z.number(), from: z.string().nullable(), to: z.string(), cause: z.string(), at: z.number() })),
    decisionsOpened: z.array(z.number()), issuesOpened: z.array(z.string()), newHeads: z.array(z.number()), handled: z.number() }).nullable(),
});
export type EffortRoster = z.infer<typeof effortRosterSchema>;
export type RosterRow = z.infer<typeof rosterRowSchema>;
export type RosterState = RosterRow["state"];
type RosterNeed = Pick<RosterRow, "state" | "cause" | "label" | "owner"> & { modifiers?: string[] };
type RosterSuggestion = EffortRoster["suggestions"][number];
export type SuggestionGroup = { key: string; name: string; clusters: readonly { ticket: string; units: readonly { pr: { url: string } | null }[] }[] };

/** What the server reads live, and the dry-run script reads from a database copy. */
export type RosterSources = {
  now: number;
  work: { items: ReadonlyMap<string, { paths: readonly string[]; tickets: readonly string[] }>; ownerForPr(prUrl: string): { id: string } | null };
  /** The freshest cheap facts: the authored-PR inventory, else a scanned checkout. */
  facts(prUrl: string): Pr | null;
  /** The last full read a refresh kept. */
  full(prUrl: string): StoredPrFacts | null;
  observation(prUrl: string): PrObservation | null;
  feedback(prUrl: string): ApprovalFeedbackRecord | null;
  holds: PrHolds;
  legacy: ReadonlyMap<string, LegacyAttempt>;
  runs: readonly Pick<Run, "id" | "path" | "prUrl" | "status" | "action">[];
  dispatch: readonly Pick<DispatchAttempt, "id" | "path" | "prUrl" | "status" | "action">[];
  /** Null when thread state is unknown, as it is offline without an export. */
  threads: readonly Pick<ThreadFacts, "id" | "status" | "environmentPath">[] | null;
  tickets(ids: readonly string[]): ReadonlyMap<string, { title: string | null; url: string | null }>;
  /** Derived effort-level board groups; null when the board cannot be derived. */
  groups: readonly SuggestionGroup[] | null;
  /** How often the board reads PRs outside an instruction: the refresh interval setting, 10 minutes when absent. */
  refreshMs?: number;
};

const byRepoAndNumber = (a: string, b: string) => {
  const [left, right] = [prTarget(a), prTarget(b)];
  return (left?.slug ?? a).localeCompare(right?.slug ?? b) || (left?.number ?? 0) - (right?.number ?? 0);
};

/** Every PR the effort owns: explicit PR members, and PRs whose tickets it alone owns; then the PRs its instruction includes from outside. */
export function rosterTargets(effort: EstablishedEffort, work: RosterSources["work"], included: readonly string[] = []): string[] {
  const targets = new Set([...effort.members.prUrls, ...included].map(prWorkItemKey));
  for (const key of work.items.keys()) if (work.ownerForPr(key)?.id === effort.id) targets.add(key);
  return [...targets].sort(byRepoAndNumber);
}

/** The board's cheap read in full-read shape. */
function cheapFacts(pr: Pr): AdvanceFacts {
  return {
    prUrl: pr.url, number: pr.number, title: pr.title, repo: prTarget(pr.url)?.slug ?? "",
    headRefName: pr.headRefName ?? "", baseRefName: pr.baseRefName ?? "", headOid: pr.headRefOid ?? "", baseOid: pr.baseRefOid ?? "",
    state: pr.state === "MERGED" || pr.state === "CLOSED" ? pr.state : "OPEN", isDraft: pr.isDraft, isCrossRepository: false,
    reviewDecision: pr.reviewDecision, mergeStateStatus: pr.mergeStateStatus, mergeable: pr.mergeable ?? "UNKNOWN",
    needsPreparation: false, readiness: "needs-attention", detail: "",
    unresolvedThreads: pr.unresolvedReviewThreads ?? 0, threadsComplete: pr.resolvedReviewThreads !== null,
    checks: checksFailed(pr.checkConclusions) ? "failed" : checksGreen(pr.checkConclusions) ? "passed" : "pending",
    basePrNumber: null, reviewFollowupPosted: pr.reviewFollowupPosted,
    approvalFeedback: pr.approvalFeedback ?? { status: "unknown", fingerprint: null, sourceIds: [] },
  };
}

/**
 * Gates from the board's cheap read. It never proves what only a full read
 * knows (fork, stack parent, every review-thread page), and it is never fresh,
 * so a cheap read alone can name a need but never a merge candidate.
 */
function cheapGates(facts: AdvanceFacts, pr: Pr, held: boolean, feedback: ApprovalFeedbackRecord | null, now: number): Gates {
  const gates = prGates({ facts, observedAt: -Infinity, now, held, feedback, reviewers: pr });
  const openThreads = pr.unresolvedReviewThreads;
  return { ...gates, "not-fork": null, "parent-merged": null,
    "threads-resolved": openThreads === null || (openThreads === 0 && pr.resolvedReviewThreads === null) ? null : gates["threads-resolved"] };
}

/** The gates a merge candidate must pass that facts alone decide; freshness shows as age instead. */
const CANDIDATE: GateId[] = ["checks-green", "threads-resolved", "feedback-verified", "changes-addressed", "approved", "not-draft", "parent-merged", "merge-clean"];

/** What the observed gates ask for next, in decide()'s order: work before waits, waits before readiness. */
function observedNeed(gates: Gates, facts: Pick<AdvanceFacts, "mergeStateStatus" | "basePrNumber">, requested: readonly string[]): Omit<RosterNeed, "state"> {
  if (gates["no-conflict"] === false || gates["base-current"] === false) return { cause: "branch", label: "Branch needs updating", owner: "you" };
  if (gates["checks-settled"] === true && gates["checks-green"] === false) return { cause: "checks-failed", label: "Checks failed", owner: "you" };
  if (gates["threads-resolved"] === false || gates["feedback-verified"] === false || gates["changes-addressed"] === false)
    return { cause: "review-feedback", label: "Review feedback open", owner: "you" };
  if (gates["checks-settled"] === false) return { cause: "ci", label: "Checks running", owner: "ci" };
  if (gates["parent-merged"] === false) return { cause: "parent", label: `Waiting for parent #${facts.basePrNumber}`, owner: "parent" };
  if (gates["not-draft"] === false) return { cause: "draft", label: "Draft", owner: "you" };
  if (gates.approved === false) return requested.length > 0
    ? { cause: "review", label: `Waiting for review from ${requested.map((login) => `@${login}`).join(", ")}`, owner: "reviewer" }
    : gates["review-requested"] === false ? { cause: "review", label: "No review requested", owner: "you" }
    : { cause: "review", label: "Waiting for approval", owner: "reviewer" };
  if (gates["merge-clean"] === false) {
    const cause = mergeWait(facts);
    return { cause, label: cause === "merge-blocked" ? "Merge blocked by branch protection" : "Waiting for merge requirements", owner: "github" };
  }
  const unknown = CANDIDATE.filter((gate) => gates[gate] === null);
  if (unknown.length > 0) return { cause: "observe", label: `Refresh to verify ${unknown.join(", ")}`, owner: null };
  return { cause: "merge-candidate", label: "Ready to merge", owner: "you" };
}

const normalizePath = (path: string) => path.replace(/\/+$/u, "");
const latest = (...times: (number | null | undefined)[]) => times.reduce<number | null>((max, time) => time == null ? max : Math.max(max ?? time, time), null);

export type ActiveWriter = { owner: "run" | "dispatch" | "thread"; ref: string; cause: "worker" | "verifying"; label: string };
/**
 * Everyone else writing a PR, as stored facts show it: a running action or a live dispatch on the PR or in one of its
 * checkouts, or a thread active in one. The roster shows the first as Doing; v2 waits for all of them. Legacy Advance is read apart.
 */
export function activeWriters(target: string, checkouts: readonly string[], sources: Pick<RosterSources, "runs" | "dispatch" | "threads">): ActiveWriter[] {
  const paths = new Set(checkouts.map(normalizePath));
  const touches = (prUrl: string | null, path: string | null) => (prUrl !== null && prWorkItemKey(prUrl) === target) || (path !== null && paths.has(normalizePath(path)));
  return [
    ...sources.runs.filter((run) => run.status === "running" && touches(run.prUrl, run.path))
      .map((run): ActiveWriter => ({ owner: "run", ref: String(run.id), cause: "worker", label: `Action running: ${run.action}` })),
    ...sources.dispatch.filter((attempt) => ["launching", "running", "verifying"].includes(attempt.status) && touches(attempt.prUrl, attempt.path))
      .map((attempt): ActiveWriter => ({ owner: "dispatch", ref: String(attempt.id), cause: attempt.status === "verifying" ? "verifying" : "worker",
        label: `Dispatch ${attempt.status}: ${attempt.action}` })),
    ...(sources.threads ?? []).filter((thread) => !["idle", "error"].includes(thread.status) && touches(null, thread.environmentPath))
      .map((thread): ActiveWriter => ({ owner: "thread", ref: thread.id, cause: "worker", label: `Thread ${thread.id} is active in its checkout` })),
  ];
}

/** The writer that makes a row Doing: a live legacy worker or verification, else the first active writer. */
function writer(target: string, checkouts: readonly string[], legacy: LegacyAttempt | null, sources: RosterSources): Omit<RosterNeed, "state"> | null {
  if (legacy?.cause === "running") return { cause: legacy.job.status === "verifying" ? "verifying" : "worker", label: `Legacy Advance: ${legacy.label}`, owner: "legacy-job" };
  const [first] = activeWriters(target, checkouts, sources);
  return first ? { cause: first.cause, label: first.label, owner: first.owner } : null;
}

/**
 * What is known about a PR now: the board's cheap read, and the last full read
 * while it stands. A full read stands until a later cheap read shows the PR
 * changed; a PR gone from the board reads as no longer open.
 */
export function observedFacts(target: string, sources: Pick<RosterSources, "facts" | "full" | "observation">) {
  const pr = sources.facts(target);
  const observation = sources.observation(target);
  const cheapAt = observation?.checkedAt ? Date.parse(observation.checkedAt) : null;
  const stored = sources.full(target);
  const full = stored?.facts && stored.fullAt !== null && (cheapAt === null || stored.fullAt >= cheapAt || cheapSignature(pr) === stored.signature)
    ? { facts: stored.facts, at: stored.fullAt } : null;
  return { pr, observation, cheapAt, stored, full, facts: full?.facts ?? (pr && cheapFacts(pr)) };
}

const WORK_OWNER: Record<NonNullable<WorkRow["body"]["owner"]>["kind"], RosterRow["owner"]> = { user: "you", ci: "ci", reviewer: "reviewer", pr: "parent",
  github: "github", "legacy-job": "legacy-job", thread: "thread", "v2-attempt": "v2" };
/**
 * The effort's v2 rows, by PR, the PRs its active instruction includes, the instruction's scope (null with none active), and our
 * writer claims, by PR.
 */
export type RosterInstruction = { rows: ReadonlyMap<string, WorkRow>; included: ReadonlySet<string>; scope: InstructionScope | null;
  claims: ReadonlyMap<string, StoredAttempt> };
/** How the effort runs, which decides whether a command item can be admitted at all. */
type RosterMode = { name: string; execution: Execution; v2Execution: V2Execution };
const DEFAULT_REFRESH = 10 * 60_000;
/** The issue that holds new launches while readback resolves uncertain ones. */
export const BREAKER = "launch-breaker";
/** A recovery command; one that drops a claim needs you to confirm no worker is writing first. */
const recovery = (command: string): EffortRoster["issues"][number]["recovery"][number] => {
  const confirm = /\brelease$/u.test(command);
  return { command, label: confirm ? `${command[0]!.toUpperCase()}${command.slice(1).replace(/ release$/u, "")}…` : `${command[0]!.toUpperCase()}${command.slice(1)}`, confirm };
};

/** Who performs a v2 step, where, and why there: the running claim's place, else the dry run's planned launch. */
function workOf(body: WorkRow["body"], claim: StoredAttempt | null): NonNullable<RosterRow["work"]> {
  const next = body.nextAction;
  const executor = Array.isArray(next) ? next.every((id) => recipe(id).executor === "worker") ? "worker" : "code"
    : next === "attach" || next === "retry-turn" ? "worker" : next === null ? null : "procedure";
  const resource = claim?.body.resource ?? body.plan?.resource ?? null;
  return { executor, recipes: Array.isArray(next) ? [...next] : claim ? [...claim.body.recipes] : [],
    resource: resource && { kind: resource.kind, threadId: resource.threadId, reason: resource.reason }, planned: body.modifiers.includes("plan only") };
}

/** How the active instruction names a PR, and why when that isn't plain inclusion. */
function membershipOf(target: string, scope: InstructionScope | null, outside: boolean): Pick<RosterRow, "membership" | "membershipReason"> {
  if (!scope) return { membership: null, membershipReason: null };
  const named = (item: { target: string }) => prWorkItemKey(item.target) === target;
  if (scope.include.some(named)) return { membership: "included", membershipReason: outside ? "included from outside membership" : null };
  if (scope.exclude.some(named)) return { membership: "excluded", membershipReason: "this instruction only" };
  const removed = scope.removed.find(named);
  return removed ? { membership: "removed", membershipReason: `${removed.reason} in r${removed.revision}` } : { membership: "outside", membershipReason: null };
}

function rosterRow(target: string, number: { n: number; provisional: boolean }, sources: RosterSources, instruction: RosterInstruction | null, outside: ReadonlySet<string>,
  context: { mode: RosterMode; numberOf: ReadonlyMap<string, number>; heads: ReadonlyMap<string, string> }): RosterRow {
  const item = sources.work.items.get(target);
  const checkouts = [...item?.paths ?? []];
  const hold = prHoldFor(target, sources.holds);
  const legacy = sources.legacy.get(target) ?? null;
  const { pr, observation, cheapAt, stored, full, facts } = observedFacts(target, sources);
  // A PR the instruction let go (dropped, superseded, or cancelled) shows its observed need again.
  const work = instruction?.rows.get(target);
  const current = work && currentRow(work) ? work : null;
  const feedback = sources.feedback(target);
  const gates = full ? prGates({ facts: full.facts, observedAt: full.at, now: sources.now, held: hold !== null, feedback, reviewers: pr })
    : pr && facts ? cheapGates(facts, pr, hold !== null, feedback, sources.now) : null;
  const need = ((): RosterNeed => {
    if (current) return { state: current.body.userState, cause: current.body.cause, label: current.body.detail,
      owner: current.body.owner && WORK_OWNER[current.body.owner.kind], modifiers: current.body.modifiers };
    if (facts && facts.state !== "OPEN") return { state: "done", cause: facts.state === "MERGED" ? "merged" : "closed", label: facts.state === "MERGED" ? "Merged" : "Closed", owner: null };
    const active = writer(target, checkouts, legacy, sources);
    if (active) return { state: "doing", ...active };
    if (legacy?.cause === "uncertain") return { state: "issue", cause: "legacy-uncertain", label: "Legacy launch outcome uncertain; recheck it", owner: "legacy-job" };
    const outside = (observed: Omit<RosterNeed, "state">): RosterNeed => ({ state: "not-in-instruction", ...observed });
    if (hold) return outside({ cause: "hold", label: hold.reason ? `On hold: ${hold.reason}` : "On hold", owner: "you" });
    if (legacy?.cause === "queued") return outside({ cause: "capacity", label: "Queued in legacy Advance", owner: "legacy-job" });
    if (!facts || !gates) return outside(observation?.failedAt || stored?.failedAt ? { cause: "source-unavailable", label: "GitHub read failed", owner: "github" }
      // The board read it and then dropped it: it merged or closed, or its only checkout went away.
      : observation?.checkedAt ? { cause: "observe", label: "No longer on the board; refresh to read it", owner: null }
      : { cause: "source-unavailable", label: "Not observed yet", owner: "github" });
    return outside(observedNeed(gates, facts, pr?.reviewRequests ?? []));
  })();
  const tickets = sources.tickets(item?.tickets ?? []);
  const parsed = prTarget(target);
  const { modifiers = [], ...shown } = need;
  // The reconciler's own cheap read of a PR the board doesn't track counts once it confirmed the full read shown.
  const observedAt = latest(cheapAt, full?.at, full && stored?.cheapAt);
  const failedAt = latest(observation?.failedAt ? Date.parse(observation.failedAt) : null, stored?.failedAt);
  // A v2 step is read at its wake's poll, counted as no shorter than a planned step's; any other row at the board's refresh interval.
  const poll = shown.state === "done" ? null : current ? Math.max(wakePoll(current.phase, current.body.cause) ?? 0, PLANNED_POLL) : sources.refreshMs ?? DEFAULT_REFRESH;
  const staleAt = poll === null ? null : failedAt !== null && (observedAt === null || failedAt > observedAt) ? failedAt : observedAt !== null ? observedAt + 2 * poll : null;
  const stale = staleAt !== null && sources.now >= staleAt;
  // A full read names the stack parent; a cheap read only its base branch, which another roster PR's head may be.
  const base = full?.facts.basePrNumber ?? null;
  const parentTarget = base !== null && parsed ? canonicalPrUrl(`https://github.com/${parsed.slug}/pull/${base}`)
    : !full && pr?.baseRefName && parsed ? context.heads.get(`${parsed.slug}:${pr.baseRefName}`) ?? null : null;
  const claim = instruction?.claims.get(target) ?? null;
  const membership = membershipOf(target, instruction?.scope ?? null, outside.has(target));
  // The same rules a typed command meets, so the row menu never offers what the grammar would clarify.
  const own = instruction?.rows.get(target) ?? null;
  const state: Pick<CommandRow, "issue" | "stopped" | "claim"> = { issue: own?.body.userState === "issue",
    stopped: own?.phase === "paused" && ["stopped", "user-cancelled"].includes(own.body.cause), claim: claim && { status: claim.status as "launching" | "running" | "uncertain", threadId: claim.threadId } };
  const { mode } = context;
  const check = (action: "recheck" | "reset" | "retry" | "stop", release = false) => {
    const why = mode.execution.mode !== "v2" ? legacyRefusal(mode.name) : interventionRefusal(action, { target, n: number.n }, state, membership.membership === "included", release)
      ?? (action === "stop" && mode.v2Execution !== "on" ? dryRunStopRefusal(formatTargets([{ target, n: number.n }]), claim?.threadId ?? "its worker's thread") : null);
    return { ok: why === null, why };
  };
  const unfinished = claim?.status === "launching" || claim?.status === "uncertain";
  return {
    ...shown, modifiers, outsideMembership: outside.has(target),
    n: number.n, provisional: number.provisional, target, repo: parsed?.slug ?? "", number: parsed?.number ?? 0,
    title: facts ? displayTitle(facts.title) : "", hold, reviewers: pr?.latestReviews ?? [], requested: pr?.reviewRequests ?? [],
    head: facts?.headOid || null, checks: facts?.checks ?? null, reviewDecision: facts?.reviewDecision ?? null, gates, observedAt, failedAt,
    tickets: (item?.tickets ?? []).map((id) => ({ id, title: tickets.get(id)?.title ?? null, url: tickets.get(id)?.url ?? null })),
    checkouts, legacy: legacy && { batchId: legacy.batchId, jobId: legacy.job.id, cause: legacy.cause, label: legacy.label, jobs: legacy.jobs },
    wake: current?.body.wake ? { event: current.body.wake.event, dueAt: current.body.wake.dueAt } : null, nextAction: current?.body.nextAction ?? null,
    work: current ? workOf(current.body, claim) : null,
    claim: claim && { attemptId: claim.id, status: claim.status as "launching" | "running" | "uncertain", threadId: claim.threadId, since: claim.createdAt },
    stack: parentTarget && parentTarget !== target ? { parentTarget, parentN: context.numberOf.get(parentTarget) ?? null } : null,
    checkCounts: pr ? checkCounts(pr.checkConclusions) : null, stale, staleAt, ...membership,
    actions: { recheck: check("recheck"), reset: { ...check("reset", unfinished), release: unfinished }, retry: check("retry"), stop: check("stop") },
  };
}

export function effortRoster(input: {
  effort: EstablishedEffort; redirectedFrom: string | null; sources: RosterSources;
  /** Numbers the targets in display order; see the roster store. */
  number(targets: string[]): { rows: { n: number; target: string; provisional: boolean }[]; snapshotId: string | null };
  /** The effort's execution mode and the v2Execution setting; legacy and a dry run when absent, as for a copy without them. */
  execution?: Execution; v2Execution?: V2Execution;
  /** Whether a new launch may start, this effort's uncertain launches, and the other efforts with any; absent for a copy that can't tell. */
  launches?: Admission & { uncertain: readonly StoredAttempt[]; elsewhere?: readonly string[] };
  /** The active instruction, its rows, its rollup, its open decisions, and our attempts on a PR; absent for a legacy effort or a copy without them. */
  v2?: RosterInstruction & { active: Omit<NonNullable<EffortRoster["instruction"]>, "included" | "excluded"> | null; rollup: string[] | null;
    contract: EffortRoster["contract"]; decisions: EffortRoster["decisions"]; attempts(target: string): number };
}): EffortRoster {
  const { effort, sources, v2 = null } = input;
  const execution = input.execution ?? { mode: "legacy", revision: 0 };
  const v2Execution = input.v2Execution ?? "dry-run";
  const owned = new Set(rosterTargets(effort, sources.work));
  // Ownership is read now: a PR included from outside that later joins the effort is simply a member.
  const outside = new Set([...v2?.included ?? []].filter((target) => !owned.has(target)));
  const numbered = input.number(rosterTargets(effort, sources.work, [...outside]));
  const numberOf = new Map(numbered.rows.map((row) => [row.target, row.n]));
  // Each roster PR's head branch, so a cheap read's base branch can name the PR it is stacked on.
  const heads = new Map(numbered.rows.flatMap((row) => {
    const branch = sources.facts(row.target)?.headRefName ?? sources.full(row.target)?.facts?.headRefName;
    const slug = prTarget(row.target)?.slug;
    return branch && slug ? [[`${slug}:${branch}`, row.target] as const] : [];
  }));
  const context = { mode: { name: effort.name, execution, v2Execution }, numberOf, heads };
  const rows = numbered.rows.map((row) => rosterRow(row.target, row, sources, v2, outside, context)).sort((a, b) => a.n - b.n);
  // A failure several PRs share is one issue naming each of them. Each row's detail names its own PR's facts (its head, its tries, its run),
  // so issues group by cause, labeled with the detail only when every PR in the issue shares it.
  const issues = new Map<string, EffortRoster["issues"][number]>();
  const recoveries = new Map<string, Map<string, number[]>>();
  const shared = new Map<string, { n: number; label: string }[]>();
  for (const row of rows) if (row.state === "issue") {
    const issue = issues.get(row.cause) ?? { ref: null, cause: row.cause, label: row.label, detail: null, numbers: [], raisedAt: null, recovery: [], likelyThreadId: null };
    if (issue.label !== row.label) issue.label = row.cause;
    issue.numbers.push(row.n);
    issue.likelyThreadId ??= row.claim?.threadId ?? null;
    issues.set(row.cause, issue);
    shared.set(row.cause, [...shared.get(row.cause) ?? [], { n: row.n, label: row.label }]);
    const byCommand = recoveries.get(row.cause) ?? new Map<string, number[]>();
    for (const command of v2?.rows.get(row.target)?.body.recovery ?? []) byCommand.set(command, [...byCommand.get(command) ?? [], row.n]);
    recoveries.set(row.cause, byCommand);
  }
  for (const [cause, issue] of issues) {
    if (issue.label === cause && shared.get(cause)!.length > 1) issue.detail = shared.get(cause)!.map((item) => `${item.n}: ${item.label}`).join("; ");
    issue.recovery = [...recoveries.get(cause)!].map(([command, numbers]) => recovery(command.replace(/\bN\b/u, formatTargets(numbers.map((n) => ({ target: "", n }))))));
  }
  // While the breaker is open no launch starts anywhere, and readback is how it closes: one issue for the effort, naming its own uncertain launches.
  // `recheck launches` reads back only this effort's launches, so when only other efforts' are uncertain the issue names them and offers nothing here.
  const uncertain = (input.launches?.uncertain ?? []).map((attempt) => ({ n: numberOf.get(attempt.target) ?? null, target: attempt.target, attemptId: attempt.id,
    threadId: attempt.threadId, since: attempt.body.uncertainAt ?? attempt.createdAt })).sort((a, b) => a.since - b.since);
  if (input.launches?.breakerOpen) {
    const mine = uncertain.flatMap((item) => item.n === null ? [] : [{ target: item.target, n: item.n }]);
    const others = input.launches.elsewhere ?? [];
    issues.set(BREAKER, { ref: null, cause: BREAKER, label: "Launch outcomes uncertain; new launches paused", numbers: mine.map((item) => item.n), raisedAt: null,
      detail: mine.length ? `Readback hasn't found the worker for ${formatTargets(mine)} or ruled one out; running work continues`
        : `Launch outcomes in ${others.join(", ") || "another effort"} are uncertain; recheck launches from ${others.length > 1 ? "their rosters" : "its roster"}. Running work continues`,
      recovery: mine.length ? [recovery("recheck launches"), ...mine.map((item) => recovery(`reset ${item.n} release`))] : [],
      likelyThreadId: uncertain.find((item) => item.threadId)?.threadId ?? null });
  }
  const covered = new Set(rows.flatMap((row) => row.tickets.map((ticket) => ticket.id)));
  const uncovered = effort.members.tickets.filter((ticket) => !covered.has(ticket));
  const details = sources.tickets(uncovered);
  const targets = new Set(rows.map((row) => row.target));
  const suggestions = (sources.groups ?? []).flatMap((group): RosterSuggestion[] => {
    const prUrls = [...new Set(group.clusters.flatMap((cluster) => cluster.units.flatMap((unit) => unit.pr ? [prWorkItemKey(unit.pr.url)] : [])))].sort(byRepoAndNumber);
    const overlap = prUrls.filter((url) => targets.has(url));
    return overlap.length === 0 ? [] : [{ key: group.key, name: group.name, tickets: [...new Set(group.clusters.map((cluster) => cluster.ticket))].sort(), prUrls, overlap }];
  });
  const legacy = rows.flatMap((row) => row.legacy ? [row.legacy.jobs] : []);
  return {
    effort: { id: effort.id, key: effort.key, name: effort.name, goal: effort.goal, archivedAt: effort.archivedAt ?? null,
      redirectedFrom: input.redirectedFrom, coordinatorThreadId: effort.coordinatorThreadId },
    snapshotId: numbered.snapshotId, execution, v2Execution,
    instruction: v2?.active ? { ...v2.active, included: rows.filter((row) => row.membership === "included").map((row) => row.n),
      excluded: (v2.scope?.exclude ?? []).map(({ target, reason }) => ({ target: prWorkItemKey(target), n: numberOf.get(prWorkItemKey(target)) ?? null, reason })) } : null,
    rollup: v2?.rollup ?? null, contract: v2?.contract ?? null, observedAt: sources.now, rows, issues: [...issues.values()],
    launches: input.launches ? { breakerOpen: input.launches.breakerOpen, capacityFull: input.launches.capacityFull, uncertain } : null,
    ticketsWithoutPrs: uncovered.map((id) => ({ id, title: details.get(id)?.title ?? null, url: details.get(id)?.url ?? null })),
    suggestions, history: { legacyJobs: legacy.reduce((sum, jobs) => sum + jobs, 0), legacyPrs: legacy.length,
      v2Attempts: v2 ? rows.reduce((sum, row) => sum + v2.attempts(row.target), 0) : 0 }, decisions: v2?.decisions ?? [],
    lastCommand: null, pending: [], through: 0, since: null,
  };
}

/** The numbered plain list the CLI prints: `n · repo #num · reviewer · summary · state · next`. */
export function rosterText(roster: EffortRoster): string {
  const { effort } = roster;
  const state = STATE_LABEL satisfies Record<RosterState, string>;
  const open = roster.rows.filter((row) => row.state !== "done").length;
  const lines = [
    `${effort.name} · ${effort.key}${roster.snapshotId ? ` · ${roster.snapshotId}` : ""}${effort.archivedAt ? " · archived" : ""}${effort.redirectedFrom ? ` · merged from effort:${effort.redirectedFrom}` : ""}`,
    `${open} open · ${roster.rows.length - open} done · ${roster.ticketsWithoutPrs.length} tickets without PRs · ${roster.history.legacyJobs} legacy Advance jobs over ${roster.history.legacyPrs} PRs`,
    ...roster.instruction ? [`Instruction r${roster.instruction.revision}: ${roster.instruction.text}`, ...roster.rollup ?? []] : [],
    ...roster.rows.map((row) => [row.n, `${row.repo} #${row.number}`,
      row.requested.map((login) => `@${login}`).join(" ") || row.reviewers.map((review) => `@${review.login}`).join(" ") || "—",
      row.title.slice(0, 120) || "—", [state[row.state], ...row.hold ? ["held"] : [], ...row.modifiers, ...row.outsideMembership ? ["outside membership"] : []].join(" · "),
      row.label].join(" · ")),
  ];
  for (const decision of roster.decisions) lines.push(`D${decision.n} · ${decision.question} (${decision.targets.map((item) => item.n ?? item.target).join(", ")}) · ${decision.options.map((option) => option.id).join(" | ")}`);
  if (roster.issues.length > 0) lines.push(...roster.issues.map((issue) => `System issue: ${issue.label} (${issue.numbers.join(", ")})`));
  if (roster.ticketsWithoutPrs.length > 0) lines.push(`Tickets without PRs: ${roster.ticketsWithoutPrs.map((ticket) => ticket.title ? `${ticket.id} ${ticket.title}` : ticket.id).join("; ")}`);
  for (const suggestion of roster.suggestions) lines.push(`Suggestion: ${suggestion.name} (${suggestion.tickets.join(", ")}) already covers ${suggestion.overlap.length} roster PRs`);
  return lines.join("\n");
}
