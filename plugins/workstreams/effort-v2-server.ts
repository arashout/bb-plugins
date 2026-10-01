// Effort v2 surfaces: RPC methods and CLI commands that server.ts spreads into
// its single contract and CLI. The roster read writes only its own numbering,
// and a refresh only observes; neither starts, messages, or updates a thread,
// and neither writes to GitHub. Opting in only links or starts the parent
// thread and fences the roster's PRs from legacy launchers; it never changes
// membership, reparents a thread, or starts work.
//
// A numbered command is admitted in one step: code resolves it, plans each
// PR's next step with decide(), and commits the instruction revision, the rows
// that changed, and the acknowledgment together. A command launches nothing:
// the reconciler's next tick acts on the rows it planned.
//
// The reconciler (the `effort-v2` service) is the one v2 scheduler: events only
// mark rows due, and each tick reads GitHub within its budgets, plans the due
// rows, commits them at the revisions it read, and launches or takes an
// attempt's next step. In a dry run a launch is only planned.
//
// Rows that ask the same question share one numbered decision. An answer
// (`Dn …` or effort_decision_answer) applies only to the decision's revision its
// surface showed. It writes the next instruction revision with what it granted
// or declined, and re-plans only the PRs that asked, unless it took a PR out of
// the instruction.
import { PluginCliError, cliCommand } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { AdvanceFacts } from "./advance-contract.js";
import type { AdvanceJob } from "./bulk-advance.js";
import { capAcknowledgment, dryRunStopRefusal, EFFECTS, effortCommandResultSchema, formatTargets, interpretEffortCommand, legacyRefusal, NO_PARTS, WORK_RECIPES,
  type AckParts, type CommandResult, type CommandRow, type CommandTarget, type DecisionAnswer, type EffortCommandResult, type InstructionScope } from "./effort-command.js";
import { decide, PLANNED_POLL, PREPARED, RECOVERING_CAUSES, type Attempt, type DecideInput, type Next, type RowDecision } from "./effort-phase.js";
import type { ResourceInput, ResourceWriter } from "./effort-resources.js";
import { activeWriters, BREAKER, effortRoster, effortRosterSchema, observedFacts, rosterRowSchema, rosterTargets, rosterText, type EffortRoster,
  type RosterSources } from "./effort-roster.js";
import type { createEffortRosterStore } from "./effort-roster-store.js";
import { recipe, RECIPES, type CodeRecipeId } from "./effort-recipes.js";
import type { Admission, CodeOutcome, CodeRun, Launch, LaunchOutcome, V2Execution } from "./effort-runner.js";
import type { EffortStore, EstablishedEffort } from "./effort-store.js";
import { attemptEvidence, decideAttempt, decisionId, holdsPr, sameBody, StaleWriteError, USER_STATES, type createEffortWorkStore, type Decision, type DecisionWrite, type Execution,
  type ExecutionMode, type RowWrite, type StoredAttempt, type StoredCodeAction, type UserState, type WorkRow, type WorkRowBody } from "./effort-work-store.js";
import type { ModelChoice, ModelRole } from "./execution.js";
import { githubRateLimit, prTarget } from "./ghactions.js";
import type { LegacyAttempt } from "./legacy-history.js";
import { evidenceContract, pendingCriteria, stepPhrase, type ContractRow, type Criterion, type CriterionEvidence } from "./outcome-evidence.js";
import { prGates, type Gates } from "./pr-gates.js";
import { canonicalPrUrl, prHoldFor } from "./pr-holds.js";
import { ROSTER_CHANGED } from "./roster-shared.js";
import { prWorkItemKey } from "./work-item-index.js";

export type { EffortCommandResult } from "./effort-command.js";

/** Realtime: `{ effortId, prUrl }` names the one row a refresh recomputed. */
export const EFFORT_ROSTER_CHANGED = ROSTER_CHANGED;

const MINUTE = 60_000;
/** Journal sources a person started: their steps aren't ones v2 took on its own. */
const USER_SOURCES = new Set(["command", "refresh", "hold", "archive", "restore", "mode"]);
/** The reconciler's budgets (plan §2.6 and §7 item 14). */
const RECONCILE = {
  tick: 15_000,
  duePerTick: 20,
  /** A PR the board or the reconciler read cheaply this recently isn't read again. */
  cheapFresh: MINUTE,
  /** A launch, a code action, or Ready needs a full read this fresh. */
  fullFresh: 2 * MINUTE,
  fullPerMinute: 4,
  plannedPoll: PLANNED_POLL,
  legacyRecheckEvery: 10 * MINUTE,
  /** Minutes a secondary rate limit, which names no reset, or a PR GitHub couldn't read, backs off. */
  backoff: [1, 2, 4, 8, 15],
};

const executionSchema = z.object({ mode: z.enum(["legacy", "v2"]), revision: z.number().int().nonnegative() });
const legacyJobSchema = z.object({ batchId: z.string(), jobId: z.string(), prUrl: z.string(), repo: z.string(), number: z.number(),
  status: z.string(), uncertain: z.boolean() });
const parentCandidateSchema = z.object({ threadId: z.string(), title: z.string(), reason: z.enum(["coordinator", "origin", "linked"]), canSpawnChild: z.boolean() });
export type ParentCandidate = z.infer<typeof parentCandidateSchema>;
type LegacyJob = z.infer<typeof legacyJobSchema>;
export const effortV2PreviewSchema = z.object({
  effort: z.object({ id: z.string(), key: z.string(), name: z.string(), coordinatorThreadId: z.string().nullable() }),
  execution: executionSchema,
  /** The v2Execution setting: a dry run plans every step and claims, starts, sends, and writes nothing. */
  v2Execution: z.enum(["dry-run", "on"]),
  consequence: z.string(),
  /** Why opting in is refused now; empty when it is allowed. */
  blockers: z.array(z.string()),
  /** Explicit members, and the roster PRs they resolve to, including PRs owned through tickets. */
  members: z.object({ tickets: z.number(), prUrls: z.number(), prs: z.number(), open: z.number() }),
  /** A null recommendation starts one new parent. While a coordinator launch is unresolved, the threads it started count as the coordinator. */
  parent: z.object({ candidates: z.array(parentCandidateSchema), recommended: z.string().nullable(), reason: z.string() }),
  /** Queued jobs are cancelled one by one at opt-in; started or uncertain ones drain. */
  legacy: z.object({ queued: z.array(legacyJobSchema), draining: z.array(legacyJobSchema) }),
  active: z.object({ runs: z.array(z.object({ prUrl: z.string(), action: z.string(), status: z.string() })),
    dispatch: z.array(z.object({ prUrl: z.string(), action: z.string(), status: z.string() })) }),
});
export type EffortV2Preview = z.infer<typeof effortV2PreviewSchema>;
const effortV2SetResultSchema = z.object({ execution: executionSchema, parentThreadId: z.string().nullable(),
  cancelled: z.array(legacyJobSchema), draining: z.array(legacyJobSchema) });
/** How long the roster pane holds an answer for Undo before it is admitted. */
export const ANSWER_DELAY = 10_000;
/**
 * Only the roster pane holds an answer, and only a decision answer: `ANSWER_DELAY` holds it for Undo, and 0 or none admits it at once.
 * The banner and the thread always admit at once.
 */
const delaySchema = z.union([z.literal(0), z.literal(ANSWER_DELAY)]).optional();
/** An open decision as a surface showed it. */
const shownDecisionSchema = z.object({ n: z.number().int().positive(), revision: z.number().int().positive() }).strict();
const parentContextSchema = z.object({
  effort: z.object({ id: z.string(), key: z.string(), name: z.string(), archived: z.boolean() }),
  /** The snapshot a command typed here resolves its numbers against. */
  snapshotId: z.string().nullable(),
  revision: z.number().nullable(), lastRevision: z.number(),
  /** The open decisions the rollup names, which a command typed here answers. */
  decisions: z.array(shownDecisionSchema),
  counts: z.record(z.enum(USER_STATES), z.number()),
  /** Open system issues as the roster lists them: one per failure cause its rows share, and one while new launches are paused. */
  issues: z.number(),
  rollup: z.array(z.string()).nullable(),
});

export const effortV2Contract = {
  /** `since` is a `through` an earlier read returned: the roster then says what changed after it. */
  effort_roster_get: { input: z.object({ effortId: z.string().min(1).max(500), since: z.number().int().nonnegative().optional() }).strict(), output: effortRosterSchema },
  /** Every saved effort's roster: how it runs, and the parent thread a v2 effort reports to. Surfaces find a thread's roster here without a read per thread. */
  effort_roster_list: { input: z.null(), output: z.array(z.object({ id: z.string(), key: z.string(), name: z.string(), archived: z.boolean(),
    mode: z.enum(["legacy", "v2"]), parentThreadId: z.string().nullable() })) },
  effort_reconcile: { input: z.object({ effortId: z.string().min(1).max(500), prUrl: z.string().max(500) }).strict(),
    output: z.object({ status: z.enum(["checked", "failed"]), error: z.string().optional(), row: rosterRowSchema }) },
  effort_v2_preview: { input: z.object({ effortId: z.string().min(1).max(500) }).strict(), output: effortV2PreviewSchema },
  /** `parentThreadId` names a preview candidate, or null to start one new parent; opting in requires one. */
  effort_v2_set: { input: z.object({ effortId: z.string().min(1).max(500), mode: z.enum(["legacy", "v2"]), expectedRevision: z.number().int().nonnegative(),
    parentThreadId: z.string().min(1).max(200).nullable().optional() }).strict(), output: effortV2SetResultSchema },
  /**
   * One numbered command against the snapshot the surface rendered; `expectedRevision` is the instruction revision it showed,
   * and `decisions` the open decisions it showed, each at its revision. A `Dn` answer applies only to the revision shown.
   */
  effort_command: { input: z.object({ effortId: z.string().min(1).max(500), snapshotId: z.string().max(100).nullable(), text: z.string().min(1).max(4_000),
    requestId: z.string().min(1).max(200), source: z.enum(["panel", "banner"]), expectedRevision: z.number().int().nonnegative().optional(),
    decisions: z.array(shownDecisionSchema).max(1_000).optional(), delayMs: delaySchema }).strict(), output: effortCommandResultSchema },
  /**
   * Answer one decision by id, as the roster showed it at `expectedRevision`: an option, the row numbers a lifecycle
   * question applies to (empty for none), or your own words. The same as `Dn …` in a command.
   */
  effort_decision_answer: { input: z.object({ decisionId: z.string().min(1).max(600), optionId: z.string().min(1).max(100).optional(),
    numbers: z.array(z.number().int().positive()).max(1_000).optional(), text: z.string().min(1).max(4_000).optional(),
    expectedRevision: z.number().int().positive(), requestId: z.string().min(1).max(200), delayMs: delaySchema }).strict(), output: effortCommandResultSchema },
  /** Take back a roster answer still held for Undo. Nothing it answered changes; one already admitted stays. */
  effort_command_undo: { input: z.object({ effortId: z.string().min(1).max(500), requestId: z.string().min(1).max(200) }).strict(),
    output: z.object({ undone: z.boolean(), message: z.string() }) },
  /** What the composer banner shows in an effort's parent thread; null in any other thread. */
  effort_parent_context: { input: z.object({ threadId: z.string().min(1).max(200) }).strict(), output: parentContextSchema.nullable() },
};

type CommandInput = z.infer<typeof effortV2Contract.effort_command.input>;
type AnswerInput = z.infer<typeof effortV2Contract.effort_decision_answer.input>;

/** The one prompt a new parent receives: it holds rosters and decisions and takes no model turn beyond this reply. */
export const parentPrompt = (name: string) => `This is the effort parent thread for ${name}. Workstreams posts rosters and decisions here. Reply only: Ready.`;

/** A PR's step as decide() plans it, the row body recording it, and the user criteria it still lacks proof of. */
export type PlannedRow = { target: string; phase: Next["phase"]; step: Next; body: WorkRowBody; criteria: string[] };
/** What a launch or code action sees for its PR that the stored row doesn't show yet. */
export type RowChange = { attempts: readonly Attempt[]; writer?: ResourceWriter; admission?: Admission; codeActions?: readonly StoredCodeAction[] };
/** The checkouts and threads a launch could use, as the reconciler reads them. */
export type ResourceParts = Omit<ResourceInput, "effortId" | "pr" | "model" | "attempt" | "legacy" | "writers" | "unpushedAllowed">;
/** A worker launch, as opposed to a code action or a wait. */
const isLaunch = (step: Next) => step.phase === "queued" && Array.isArray(step.nextAction) && step.nextAction.every((id) => recipe(id).executor === "worker");
/** A GitHub write code runs: queued, or waiting on an answer to read back. */
const isCode = (step: Pick<Next, "nextAction">) => Array.isArray(step.nextAction) && step.nextAction.length > 0 && step.nextAction.every((id) => recipe(id).executor === "code");

/**
 * The user state a step shows. The reconciler reads GitHub and BB in any mode, and launches a worker, writes to GitHub,
 * or asks BB to retry a failed turn only with v2 execution on; in a dry run those steps wait, marked as a plan.
 */
function shown(step: Next, execution: V2Execution): Pick<WorkRowBody, "userState" | "modifiers"> {
  const planned = execution !== "on" && (step.phase === "queued" || step.nextAction === "retry-turn" || isCode(step));
  const userState: UserState = step.phase === "prepared" ? "ready" : step.phase === "finished" ? "done" : step.phase === "decision-needed" ? "decision"
    : step.phase === "repair-needed" ? step.modifiers.includes("recovering") ? planned ? "waiting" : "doing" : "issue"
    : ["executing", "verifying", "queued"].includes(step.phase) && !planned ? "doing" : "waiting";
  return { userState, modifiers: planned ? [...step.modifiers, "plan only"] : step.modifiers };
}

/** The row body recording a step, with the facts it was planned from and the code actions it carries. */
export function rowBody(step: Next, row: Pick<WorkRowBody, "n" | "retryEpoch" | "observedHead" | "observedAt" | "gates" | "tickets" | "codeActions">, execution: V2Execution): WorkRowBody {
  return { n: row.n, cause: step.cause, detail: step.detail, ...shown(step, execution), nextAction: step.nextAction, owner: step.owner, wake: step.wake, decision: step.decision,
    recovery: step.recovery, offers: step.offers, retryEpoch: row.retryEpoch, observedHead: row.observedHead, observedAt: row.observedAt, gates: row.gates, tickets: row.tickets,
    ...row.codeActions?.length ? { codeActions: row.codeActions } : {} };
}

/**
 * Plan each PR's step from stored facts and our attempts on it. This reads no checkout or thread, so a launch plans
 * its recipes and leaves the checkout and thread to the reconciler's reads. A criterion has proof only from a
 * worker's accepted report on the PR's current head.
 */
export function planRows(input: { effort: EstablishedEffort; mode: ExecutionMode; execution: V2Execution; scope: InstructionScope | null; sources: RosterSources;
  models: Record<ModelRole, ModelChoice>; held(target: string): boolean;
  targets: readonly { target: string; n: number | null; retryEpoch: number; codeActions?: readonly StoredCodeAction[] }[];
  /** The open decision a PR asked, and the head it asked on. */
  open?(target: string): { decision: RowDecision; head: string | null } | null;
  /** Our attempts on a PR, newest first; none when absent. */
  attempts?(target: string): readonly Attempt[];
  /** Criteria evidence from our attempts' reports; none when absent. */
  evidence?: readonly CriterionEvidence[];
  /** Whether a new launch may start now; open when absent. */
  admission?: Admission;
  /** A writer found outside the board's facts, such as the holder of a claim that just failed. */
  writer?(target: string): ResourceWriter | null;
  /** The reconciler's reads of a launch's checkouts and threads; without them a launch plans its recipes and leaves where it runs to those reads. */
  resources?(target: string): ResourceParts | undefined;
  /** GitHub's rate limit holds reads until then. */
  rateLimitedUntil?: number | null;
  /** How often the reconciler rechecked the uncertain legacy Advance job that holds a PR. */
  legacyRechecks?(target: string): number;
  /** A PR GitHub couldn't read in full on its last reads. */
  unreadable?(target: string): DecideInput["unreadable"] }): PlannedRow[] {
  const { sources, scope } = input;
  const read = input.targets.map(({ target, n, retryEpoch, codeActions = [] }) => {
    const observed = observedFacts(target, sources);
    const item = sources.work.items.get(target);
    const details = sources.tickets(item?.tickets ?? []);
    const tickets = (item?.tickets ?? []).map((id) => ({ id, title: details.get(id)?.title ?? null, url: details.get(id)?.url ?? null }));
    const feedback = sources.feedback(target);
    const gates = observed.full && prGates({ facts: observed.full.facts, observedAt: observed.full.at, now: sources.now, held: input.held(target), feedback, reviewers: observed.pr });
    const contract: ContractRow = { target, n, state: observed.facts?.state ?? null, heads: observed.facts?.headOid ? [observed.facts.headOid] : [],
      checkout: (item?.paths.length ?? 0) > 0, tickets, gates };
    return { target, n, retryEpoch, codeActions, observed, item, tickets, feedback, gates, contract };
  });
  // Every active writer counts against the PR itself; the runner checks the chosen checkout's writers again inside its claim.
  const resourcesOf = (target: string, paths: readonly string[]): DecideInput["resources"] => {
    const legacy = sources.legacy.get(target) ?? null;
    const writers = [...activeWriters(target, paths, sources).map(({ owner, ref }): ResourceWriter => ({ owner, ref, path: null })),
      ...[input.writer?.(target)].filter((writer) => writer != null)];
    const parts = input.resources?.(target);
    // Allow on "Unpushed commits in <path>" lets v2 push beside the author's unpushed work.
    return parts ? { ...parts, legacy, writers, unpushedAllowed: (scope?.answers ?? []).some((answer) => answer.targets.includes(target)
      && answer.question.startsWith("Unpushed commits in ") && answer.answer === "Allow") } : { legacy, inspections: null, writers };
  };
  const included = new Set(scope?.include.map((grant) => prWorkItemKey(grant.target)));
  const pending = scope ? pendingCriteria(scope, read.filter((row) => included.has(row.target)).map((row) => row.contract), input.evidence ?? []) : new Map<string, string[]>();
  return read.map((row) => {
    const attempts = input.attempts?.(row.target) ?? [];
    // A PR a worker reported blocking this one settles once it merges or closes.
    const settledDependencies = new Set(attempts.flatMap((attempt) => attempt.blocker?.prUrl ? [prWorkItemKey(attempt.blocker.prUrl)] : [])
      .filter((url) => ["MERGED", "CLOSED"].includes(observedFacts(url, sources).facts?.state ?? "OPEN")));
    const decideInput: DecideInput = { now: sources.now, target: row.target, effort: { id: input.effort.id, mode: input.mode, archived: Boolean(input.effort.archivedAt) },
      ownerId: sources.work.ownerForPr(row.target)?.id ?? null, instruction: scope, held: input.held(row.target), full: row.observed.full, feedback: row.feedback,
      reviewers: row.observed.pr, attempts, codeActions: row.codeActions, retryEpoch: row.retryEpoch, decision: null,
      declined: (scope?.answers ?? []).flatMap((answer) => answer.subkind && answer.declined.includes(row.target) ? [answer.subkind] : []),
      criteriaPending: (pending.get(row.target)?.length ?? 0) > 0, settledDependencies, admission: input.admission ?? { capacityFull: false, breakerOpen: false },
      models: input.models, rateLimitedUntil: input.rateLimitedUntil ?? null, legacyRechecks: input.legacyRechecks?.(row.target) ?? 0,
      unreadable: input.unreadable?.(row.target) ?? null, resources: resourcesOf(row.target, row.item?.paths ?? []) };
    let step = decide(decideInput);
    // An open decision holds its row while the facts that asked it are read again, so its number stays put. Once they are
    // read, decide() asks again only if the question still applies; a new head never inherits the old head's question.
    const open = step.nextAction === "observe" ? input.open?.(row.target) : null;
    if (open && open.head === (row.observed.facts?.headOid || null)) step = decide({ ...decideInput, decision: open.decision });
    return { target: row.target, phase: step.phase, step, criteria: pending.get(row.target) ?? [],
      body: rowBody(step, { n: row.n, retryEpoch: row.retryEpoch, observedHead: row.observed.facts?.headOid || null, observedAt: row.observed.full?.at ?? null,
        gates: row.gates, tickets: row.tickets, codeActions: [...row.codeActions] }, input.execution) };
  });
}

/** The evidence contract over the instruction's rows as stored, so the rollup reads exactly what the roster shows, naming each open decision by number. */
export function rowContract(effort: Pick<EstablishedEffort, "goal">, scope: InstructionScope, rows: readonly Pick<WorkRow, "target" | "phase" | "body">[], work: RosterSources["work"],
  decisions: readonly Pick<Decision, "n" | "key">[] = [], evidence: readonly CriterionEvidence[] = []) {
  const byTarget = new Map(rows.map((row) => [row.target, row]));
  return evidenceContract({ scope, goal: effort.goal, evidence, ordinal: (key) => decisions.find((decision) => decision.key === key)?.n ?? null, rows: scope.include.flatMap((grant) => {
    const row = byTarget.get(prWorkItemKey(grant.target));
    if (!row) return [];
    const { body } = row;
    const state = row.phase === "finished" && body.cause === "merged" ? "MERGED" as const : row.phase === "finished" && body.cause === "closed" ? "CLOSED" as const
      : body.observedHead ? "OPEN" as const : null;
    return [{ target: row.target, n: body.n ?? grant.n, state, heads: body.observedHead ? [body.observedHead] : [], checkout: (work.items.get(row.target)?.paths.length ?? 0) > 0,
      tickets: body.tickets, gates: body.gates,
      step: { phase: row.phase, cause: body.cause, modifiers: body.modifiers, nextAction: body.nextAction, owner: body.owner, wake: body.wake, decision: body.decision } }];
  }) });
}

/**
 * The decisions after these rows are written: each row joins the open decision its step asks, at the head it asked on,
 * and leaves any other. A decision no row asks any more is withdrawn: its PRs merged, left the instruction, or a new
 * head stopped asking. Numbers are never reused. Rows not written keep their step, so their decisions stand.
 */
export function syncDecisions(effortId: string, open: readonly Decision[], next: number, rows: readonly Pick<RowWrite, "target" | "phase" | "body">[]): DecisionWrite[] {
  const byKey = new Map(open.map((decision) => [decision.key, { ...decision, body: structuredClone(decision.body), expectedRevision: decision.revision, changed: false }]));
  for (const row of rows) {
    const target = prWorkItemKey(row.target);
    const asked = row.phase === "decision-needed" ? row.body.decision : null;
    for (const decision of byKey.values()) if (decision.key !== asked?.key && decision.body.targets.some((item) => item.target === target)) {
      decision.body.targets = decision.body.targets.filter((item) => item.target !== target);
      decision.changed = true;
    }
    if (!asked) continue;
    let decision = byKey.get(asked.key);
    if (!decision) {
      const n = next++;
      decision = { id: decisionId(effortId, n), effortId, n, key: asked.key, status: "open", revision: 0, expectedRevision: 0, changed: true,
        body: { kind: asked.kind, subkind: asked.subkind, question: asked.question, options: asked.options, grants: asked.grants, targets: [], answer: null, answeredVia: null } };
      byKey.set(asked.key, decision);
    }
    const entry = { target, n: row.body.n, head: row.body.observedHead };
    if (JSON.stringify(decision.body.targets.find((item) => item.target === target)) !== JSON.stringify(entry)) {
      decision.body.targets = [...decision.body.targets.filter((item) => item.target !== target), entry]
        .sort((a, b) => (a.n ?? Infinity) - (b.n ?? Infinity) || a.target.localeCompare(b.target));
      decision.changed = true;
    }
  }
  return [...byKey.values()].filter((decision) => decision.changed).map(({ id, n, key, body, expectedRevision }) =>
    ({ id, n, key, body, expectedRevision, status: body.targets.length ? "open" as const : "withdrawn" as const }));
}

/**
 * A decision as its card shows it. A question a worker asked carries, from the newest report of each PR that asked it, the evidence
 * they gave, the first recommendation and its reason, what each option means for the work, and the attempt that asked first. A
 * mark-ready question recommends each draft that is settled (checks green, no conflict, no open review thread) and whose worker left
 * no note on its head; a note is a validation it didn't pass or didn't run. Nothing here is stored: the reports and rows are.
 */
export function decisionCard(decision: Decision, input: { createdAt: number | null; row(target: string): WorkRow | null; attempts(target: string): readonly StoredAttempt[] }):
  EffortRoster["decisions"][number] {
  const { body } = decision;
  const same = (question: string | null | undefined) => question?.trim().toLowerCase() === body.question.trim().toLowerCase();
  const asked = body.targets.flatMap((item) => {
    const attempt = input.attempts(item.target).find((candidate) => candidate.status === "completed" && candidate.body.report?.envelope?.blockers[0]
      && same(candidate.body.report.blocker?.question ?? candidate.body.report.blocker?.summary));
    return attempt ? [{ item, attempt, blocker: attempt.body.report!.envelope!.blockers[0]! }] : [];
  });
  const notes = body.subkind === "mark-ready" ? new Map(body.targets.map((item) => {
    const row = input.row(item.target);
    const gates = row?.body.gates;
    const report = input.attempts(item.target).find((attempt) => attempt.status === "completed" && attempt.body.report?.envelope
      && attempt.body.report.headOid !== null && attempt.body.report.headOid === row?.body.observedHead)?.body.report;
    const unvalidated = report?.envelope?.validation.find((check) => check.result !== "passed");
    const note = unvalidated ? unvalidated.detail || `${unvalidated.command}: ${unvalidated.result}` : gates?.["checks-green"] !== true ? "checks aren't green"
      : gates["no-conflict"] !== true ? "it conflicts with its base" : gates["threads-resolved"] === false ? "review threads are open" : null;
    return [item.target, note] as const;
  })) : null;
  const left = body.targets.filter((item) => notes?.get(item.target) != null);
  const recommended = body.targets.filter((item) => notes !== null && notes.get(item.target) === null && item.n !== null);
  const advised = asked.find(({ blocker }) => body.options.some((option) => option.id === blocker.recommendation));
  return {
    id: decision.id, n: decision.n, revision: decision.revision, kind: body.kind, subkind: body.subkind, question: body.question, createdAt: input.createdAt,
    answer: body.kind === "worker-interaction" ? "open-thread" : "command",
    options: body.options.map((option) => ({ ...option,
      consequence: asked.map(({ blocker }) => blocker.options.find((offered) => offered.id === option.id)?.consequence).find((value) => value) ?? null })),
    recommendation: notes ? { optionId: null, numbers: recommended.map((item) => item.n!), reason: left.length
      ? `Leaves out ${left.map((item) => `${formatTargets([item])}: ${notes.get(item.target)}`).join("; ")}` : "Checks green, no conflicts, and no open review threads on each" }
      : advised ? { optionId: advised.blocker.recommendation, numbers: null, reason: advised.blocker.recommendationReason } : null,
    evidence: [...new Set(asked.flatMap(({ blocker }) => blocker.evidence))].map((text) => ({ label: text, url: /^https?:\/\//u.test(text) ? text : null })),
    source: asked[0] ? { attemptId: asked[0].attempt.id, threadId: asked[0].attempt.threadId,
      label: `${prTarget(asked[0].item.target)?.name ?? asked[0].item.target} #${prTarget(asked[0].item.target)?.number ?? ""}` } : null,
    targets: body.targets.map(({ target, n: number }) => ({ target, n: number, note: notes?.get(target) ?? null, recommended: notes ? notes.get(target) === null : null })),
  };
}

type Answer = { option: string } | { numbers: number[] } | { text: string };
/**
 * What one answer does to the instruction. It reaches only the PRs its question named and grants only what the
 * question named: a lifecycle answer grants the action to the numbers it lists and declines it for the rest; allow
 * grants an authority question's work and effects; leave it takes the PR out of this instruction, as `leave N alone`
 * does. A question's answer is recorded for its worker's next work order. Any other reading is clarified.
 */
export function answerDecision(decision: Decision, answer: Answer, scope: InstructionScope, revision: number):
  { clarify: string } | { scope: InstructionScope; answer: string; targets: string[] } {
  const { body } = decision;
  const name = `D${decision.n}`;
  const targets = body.targets.map((item) => item.target);
  const ids = body.options.map((option) => option.id).join(", ");
  const option = "option" in answer ? body.options.find((item) => item.id.toLowerCase() === answer.option.toLowerCase()) ?? null : null;
  if ("option" in answer && !option) return { clarify: `${name}'s options are ${ids}.` };
  if (body.kind === "worker-interaction") return { clarify: `${name} is answered in its worker's thread; open it from the roster.` };
  const next = structuredClone(scope);
  const grantOf = (target: string) => next.include.find((grant) => prWorkItemKey(grant.target) === target);
  const give = (target: string, grants: NonNullable<Decision["body"]["grants"]>) => {
    const grant = grantOf(target);
    if (!grant) return;
    grant.work = WORK_RECIPES.filter((id) => grant.work.includes(id) || grants.work.includes(id));
    grant.effects = EFFECTS.filter((effect) => grant.effects.includes(effect) || grants.effects.includes(effect));
  };
  let declined: CommandTarget[] = [];
  let reading: string;
  if (body.subkind) {
    if ("text" in answer) return { clarify: `${name} takes the rows to ${body.subkind === "mark-ready" ? "mark ready" : "request review on"}, all, or none, for example: ${name} ${formatTargets(body.targets)}.` };
    const numbers = "numbers" in answer ? answer.numbers : [];
    const outside = numbers.filter((n) => !body.targets.some((item) => item.n === n));
    if (outside.length) return { clarify: `${name} asks about ${formatTargets(body.targets)}; ${outside.join(", ")} ${outside.length === 1 ? "isn't" : "aren't"} part of it.` };
    const chosen = body.targets.filter((item) => option?.id === "ready" || numbers.includes(item.n ?? 0));
    // A review request names its reviewers, so here an answer can only decline; the request itself is a command.
    if (body.subkind === "request-review" && (chosen.length || option?.id === "name"))
      return { clarify: `Name the reviewers with: request review ${formatTargets(chosen.length ? chosen : body.targets)} from @login. ${name} none requests no review.` };
    for (const item of chosen) give(item.target, body.grants!);
    declined = body.targets.filter((item) => !chosen.includes(item));
    reading = [chosen.length ? `mark ready ${formatTargets(chosen)}` : null,
      declined.length ? `${body.subkind === "mark-ready" ? "keep as a draft" : "request no review on"} ${formatTargets(declined)}` : null].filter(Boolean).join("; ");
  } else if (body.kind === "authority" && option?.id === "leave") {
    for (const item of body.targets) {
      next.include = next.include.filter((grant) => prWorkItemKey(grant.target) !== item.target);
      if (!next.exclude.some((other) => prWorkItemKey(other.target) === item.target)) next.exclude.push({ target: item.target, n: item.n, reason: `${name}: leave it` });
    }
    reading = `leave ${formatTargets(body.targets)} alone this instruction`;
  } else if ("numbers" in answer) {
    return { clarify: `${name} takes one of its options (${ids}) or your own words.` };
  } else {
    if (option?.id === "allow" && body.grants) for (const target of targets) give(target, body.grants);
    reading = "text" in answer ? JSON.stringify(answer.text) : option!.label;
  }
  next.answers.push({ decisionId: decision.id, n: decision.n, subkind: body.subkind, question: body.question, answer: reading, targets,
    declined: declined.map((item) => item.target), revision });
  return { scope: { ...next, revision }, answer: reading, targets };
}

export type EffortV2Deps = {
  efforts: Pick<EffortStore, "get" | "getRecord" | "list">;
  numbers: ReturnType<typeof createEffortRosterStore>["numbers"];
  snapshots: Pick<ReturnType<typeof createEffortRosterStore>, "snapshot" | "issued" | "latest">;
  work: Pick<ReturnType<typeof createEffortWorkStore>, "instruction" | "lastRevision" | "rows" | "row" | "command" | "commit" | "decisions" | "decision" | "nextDecision"
    | "attempts" | "attempt" | "claims" | "release" | "requestStop" | "due" | "markDue" | "reschedule" | "note" | "notes" | "completeInstruction" | "journal" | "asked"
    | "lastCommand" | "entered" | "held" | "undone">;
  /**
   * v2 launches: the v2Execution setting, whether a new one may start now, reading one whose outcome is uncertain back from BB, and
   * whether this process is making one on a PR now.
   */
  launches: { execution(): Promise<V2Execution>; admission(): Promise<Admission>; recover(attemptId: string): Promise<void>; launching(target: string): boolean;
    /** Recheck: read the latest attempt's turn again, and its report against these fresh facts. */
    recheck(target: string, fresh: AdvanceFacts): Promise<void>;
    launch(input: Launch): Promise<LaunchOutcome>;
    /** A code action's GitHub write, its key recorded first, or its read back after an unclear answer. */
    code(input: CodeRun): Promise<CodeOutcome>;
    /** The compatibility adapter over a settled legacy worker's last output: whether it saved feedback evidence; null when BB can't read it now. */
    adopt(target: string, legacy: { attemptId: string; threadId: string }, facts: AdvanceFacts): Promise<{ saved: boolean; compat: string[]; rejection: string | null } | null>;
    /** An attempt's next step: read back its launch, retry its failed turn, read its finished turn, or read its report. */
    advance(attemptId: string): Promise<void> };
  /** The reconciler's reads and clock. */
  reconciler: {
    now(): number;
    /** When the board or the reconciler last read this PR cheaply. */
    cheapAt(prUrl: string): number | null;
    /**
     * One cheap read of these PRs, written through the board's stores where the board tracks them: the PRs whose signature
     * differs from their last full read's, including any that left the open list, and why the read failed.
     */
    cheap(prUrls: readonly string[]): Promise<{ changed: string[]; error: string | null }>;
    /** One full read, kept in pr_facts. */
    full(prUrl: string): Promise<{ status: "checked" } | { status: "failed"; error: string }>;
    /** When GitHub's exhausted primary rate limits reset. */
    rateLimitReset(): Promise<number | null>;
    /** The checkouts and threads a launch could use: scanned checkouts and legacy worktrees read in place, and the threads in them. */
    resources(target: string, facts: AdvanceFacts, attempt: StoredAttempt | null): Promise<ResourceParts>;
    /** Recheck one legacy Advance job, as its own Recheck would, without revealing it in progress. */
    recheckLegacy(batchId: string, jobId: string): Promise<void>;
    warn(message: string): void;
  };
  /** Holds write through the existing store, inside the command's transaction; `changed` tells the board afterward. */
  holds: { set(prUrl: string, held: boolean, reason?: string): unknown; changed(): void };
  models(): Promise<Record<ModelRole, ModelChoice>>;
  /** The board's inventory lists the PR as yours; anyone else's is a teammate's. */
  authored(prUrl: string): boolean;
  /** Live board facts; see RosterSources. */
  sources(): Promise<RosterSources>;
  /** Re-observe one PR's GitHub, thread, and checkout facts now. */
  observe(prUrl: string, checkouts: readonly string[]): Promise<{ status: "checked" } | { status: "failed"; error: string }>;
  realtime: { publish(channel: string, payload: unknown): void };
  execution: {
    get(effortId: string): Execution;
    /** Only at the revision the caller saw; the roster's PRs are fenced or released in the same write. */
    set(effortId: string, mode: ExecutionMode, expectedRevision: number): Promise<Execution>;
  };
  parent: {
    /**
     * Existing threads that can become the parent: unarchived, idle unless already the coordinator, and on the planning provider.
     * While a coordinator launch is unresolved, any thread it started is offered as the coordinator.
     */
    candidates(effort: EstablishedEffort, targets: readonly string[]): Promise<ParentCandidate[]>;
    adopt(effortId: string, threadId: string): Promise<EstablishedEffort>;
    start(effortId: string, prompt: string): Promise<EstablishedEffort>;
  };
  legacy: {
    jobs(): readonly { batchId: string; job: Pick<AdvanceJob, "id" | "prUrl" | "repo" | "number" | "status" | "uncertain"> }[];
    /** Cancel one job that never started; false when it has moved on. */
    cancelQueued(batchId: string, jobId: string): boolean;
  };
  autoDispatches(effortId: string): boolean;
};

export function createEffortV2(deps: EffortV2Deps) {
  /** A saved effort by id or key; a merged source redirects to its destination. Derived groups are not efforts. */
  function resolve(effortId: string): { effort: EstablishedEffort; redirectedFrom: string | null } {
    const effort = deps.efforts.get(effortId);
    if (!effort) throw new Error("That effort does not exist. Choose a saved effort; derived groups are only suggestions.");
    const requested = deps.efforts.getRecord(effortId);
    return { effort, redirectedFrom: requested && requested.id !== effort.id ? requested.id : null };
  }
  /** The effort's v2 rows and active instruction for the roster, or nothing before its first instruction. */
  function instructionView(effort: EstablishedEffort, sources: RosterSources) {
    const active = deps.work.instruction(effort.id);
    const rows = deps.work.rows(effort.id);
    if (!active && rows.length === 0) return undefined;
    const decisions = deps.work.decisions(effort.id);
    const asked = deps.work.asked(effort.id);
    const byTarget = new Map(rows.map((row) => [row.target, row]));
    // One contract gives the rollup and its criteria, so they can't disagree.
    const contract = active ? rowContract(effort, active.scope, rows, sources.work, decisions, evidenceOf(rows.map((row) => row.target))) : null;
    return { rows: new Map(rows.map((row) => [row.target, row])), included: new Set(active?.scope.include.map((grant) => prWorkItemKey(grant.target))),
      scope: active?.scope ?? null, claims: new Map(deps.work.claims(effort.id).map((attempt) => [attempt.target, attempt])),
      active: active && { id: active.id, revision: active.revision, text: active.text, reportMode: active.scope.reportMode, outcome: active.scope.outcome },
      rollup: contract?.rollup ?? null,
      contract: contract && { criteria: contract.criteria, outcomeValidated: contract.outcomeValidated, completed: contract.completed },
      decisions: decisions.map((decision) => decisionCard(decision, { createdAt: asked.get(decision.id) ?? null, row: (target) => byTarget.get(target) ?? null,
        attempts: (target) => deps.work.attempts(target) })),
      attempts: (target: string) => deps.work.attempts(target).length };
  }
  /** PRs a roster showed Done only on a legacy Advance job's word, with the effort that showed each; a tick reads each in full. */
  const confirming = new Map<string, string>();
  async function roster(effortId: string, since?: number): Promise<EffortRoster> {
    const { effort, redirectedFrom } = resolve(effortId);
    const sources = await deps.sources();
    const admission = await deps.launches.admission();
    const uncertain = deps.work.claims().filter((attempt) => attempt.status === "uncertain");
    const read = effortRoster({ effort, redirectedFrom, sources, number: (targets) => deps.numbers(effort.id, targets, { assign: true }),
      execution: deps.execution.get(effort.id), v2Execution: await deps.launches.execution(), v2: instructionView(effort, sources),
      launches: { ...admission, uncertain: uncertain.filter((attempt) => attempt.effortId === effort.id),
        elsewhere: [...new Set(uncertain.flatMap((attempt) => attempt.effortId === effort.id ? [] : [deps.efforts.get(attempt.effortId)?.name ?? attempt.effortId]))].sort() },
      confirm: (target) => {
        if (confirming.has(target)) return;
        confirming.set(target, effort.id);
        nudge();
      } });
    const issues = numberIssues(effort.id, read);
    const changes = changesSince(effort.id, read.rows, since);
    return { ...read, issues: issues.list, lastCommand: lastCommand(effort.id), ...changes,
      pending: (deps.work.held(effort.id) as Held[]).map(({ requestId, text, decisions, until }) => ({ requestId, text, decisions, until })),
      since: changes.since && { ...changes.since, issuesOpened: issues.opened(since!) } };
  }
  type IssueRefs = { refs: Record<string, { ref: string; raisedAt: number; openedAfter: number }>; next: number };
  /**
   * Number the roster's open system issues S1, S2, … the way rows are numbered at read: an issue keeps its ref and when it was raised
   * while it stays open, and a ref is never reused. A row issue was raised when its first PR entered it; the launch breaker, when its
   * oldest uncertain launch went uncertain. The refs live in the effort's journal, so `since` can tell which opened after a read.
   */
  function numberIssues(effortId: string, read: EffortRoster) {
    const [latest = { refs: {}, next: 1 }] = deps.work.notes(effortId, "issue-refs", 1) as IssueRefs[];
    const through = deps.work.journal(effortId, Number.MAX_SAFE_INTEGER).through;
    const targetOf = new Map(read.rows.map((row) => [row.n, row.target]));
    let next = latest.next;
    const refs: IssueRefs["refs"] = {};
    for (const issue of read.issues) refs[issue.cause] = latest.refs[issue.cause] ?? { ref: `S${next++}`, openedAfter: through,
      raisedAt: issue.cause === BREAKER ? Math.min(...read.launches?.uncertain.map((item) => item.since) ?? [], read.observedAt)
        : Math.min(...issue.numbers.map((n) => deps.work.entered(targetOf.get(n)!, "repair-needed", issue.cause) ?? read.observedAt)) };
    const canonical = (value: IssueRefs["refs"]) => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
    if (canonical(refs) !== canonical(latest.refs)) deps.work.note(effortId, "issue-refs", { refs, next } satisfies IssueRefs);
    const ordinal = (ref: string) => Number(ref.slice(1));
    return { list: read.issues.map((issue) => ({ ...issue, ref: refs[issue.cause]!.ref, raisedAt: refs[issue.cause]!.raisedAt }))
        .sort((a, b) => ordinal(a.ref) - ordinal(b.ref)),
      opened: (since: number) => Object.values(refs).filter((item) => item.openedAfter >= since).map((item) => item.ref).sort((a, b) => ordinal(a) - ordinal(b)) };
  }
  /** The newest admitted command, with the revision it left active. */
  function lastCommand(effortId: string): EffortRoster["lastCommand"] {
    const entry = deps.work.lastCommand(effortId);
    if (!entry) return null;
    const result = effortCommandResultSchema.parse(entry.result);
    return { ...entry, result, revision: result.kind === "admit" ? result.revision : null };
  }
  /**
   * The journal after `since`: each roster row's first and last phase since then, the decisions asked since that are still open,
   * rows observed on a new head, and how many steps v2 took on its own. Only a move to a new phase or cause is a change: a rewrite
   * that keeps a row's step (a new observation, a dry run's plan) isn't. A launch or code action only queued hasn't been taken yet,
   * and a step ending in a decision or a system issue waits on you, so neither is a step v2 took.
   */
  function changesSince(effortId: string, rows: readonly Pick<EffortRoster["rows"][number], "n" | "target">[], since: number | undefined):
    { through: number; since: Omit<NonNullable<EffortRoster["since"]>, "issuesOpened"> | null } {
    const { through, transitions, headBefore } = deps.work.journal(effortId, since ?? Number.MAX_SAFE_INTEGER);
    if (since === undefined) return { through, since: null };
    const numberOf = new Map(rows.map((row) => [row.target, row.n]));
    const byTarget = new Map<string, typeof transitions>();
    for (const item of transitions) if (numberOf.has(item.target)) byTarget.set(item.target, [...byTarget.get(item.target) ?? [], item]);
    const moved = (item: (typeof transitions)[number]) => item.fromPhase !== item.toPhase || item.fromCause !== item.cause;
    const byNumber = (a: number, b: number) => a - b;
    const first = transitions[0]?.at ?? Infinity;
    const opened = deps.work.asked(effortId);
    return { through, since: {
      rows: [...byTarget].filter(([, list]) => list.some(moved))
        .map(([target, list]) => ({ n: numberOf.get(target)!, from: list[0]!.fromPhase, to: list.at(-1)!.toPhase, cause: list.at(-1)!.cause, at: list.at(-1)!.at }))
        .sort((a, b) => a.n - b.n),
      decisionsOpened: deps.work.decisions(effortId).filter((decision) => (opened.get(decision.id) ?? -Infinity) >= first).map((decision) => decision.n).sort(byNumber),
      newHeads: [...byTarget].filter(([target, list]) => {
        const head = list.map((item) => item.head).filter((value) => value !== null).at(-1) ?? null;
        return head !== null && headBefore.has(target) && headBefore.get(target) !== head;
      }).map(([target]) => numberOf.get(target)!).sort(byNumber),
      handled: transitions.filter((item) => moved(item) && !USER_SOURCES.has(item.source) && item.toPhase !== "queued" && item.toPhase !== "decision-needed"
        && !(item.toPhase === "repair-needed" && !(RECOVERING_CAUSES as readonly string[]).includes(item.cause))).length,
    } };
  }
  const queues = new Map<string, Promise<unknown>>();
  /** One command or event at a time per effort, so each plans from the rows the last one wrote. */
  function serial<T>(effortId: string, run: () => Promise<T>): Promise<T> {
    const next = (queues.get(effortId) ?? Promise.resolve()).then(run, run);
    queues.set(effortId, next.catch(() => undefined));
    return next;
  }
  /** PRs GitHub couldn't read in full on the reconciler's last reads, which back off until `retryAt`. A read that succeeds clears one. */
  const unreadable = new Map<string, NonNullable<DecideInput["unreadable"]>>();
  /** Criteria evidence from our attempts' reports on these PRs. */
  const evidenceOf = (targets: Iterable<string>) => attemptEvidence([...targets].flatMap((target) => deps.work.attempts(target)));
  /** Our attempts on a PR as decide() reads them; a claim `reset N release` drops is read as released, and a worker `stop N` stops as stopping. */
  function attemptsOf(target: string, released?: ReadonlySet<string>, stopping?: ReadonlySet<string>): Attempt[] {
    return deps.work.attempts(target).map(decideAttempt).map((attempt) => released?.has(target) && (attempt.status === "launching" || attempt.status === "uncertain")
      ? { ...attempt, status: "released" as const, releasedReason: "no-worker" as const }
      : stopping?.has(target) && attempt.status === "running" ? { ...attempt, stopRequested: true } : attempt);
  }
  /**
   * Plan the included PRs and any row still open under the effort, the writes for the rows whose step changed, and the
   * decisions those writes ask or leave. A retry, reset, or answer starts a row's new epoch and makes it due now.
   * `change` plans one PR with other attempts, a writer, or an admission than the stored ones, as a launch about to claim sees them.
   */
  async function replan(effort: EstablishedEffort, scope: InstructionScope | null, sources: RosterSources,
    options: { held(target: string): boolean; retry: ReadonlySet<string>; only?: ReadonlySet<string>; decisions: readonly Decision[]; released?: ReadonlySet<string>;
      stopping?: ReadonlySet<string>;
      change?: RowChange & { target: string };
      resources?: ReadonlyMap<string, ResourceParts>; rateLimitedUntil?: number | null; legacyRechecks?(target: string): number }) {
    const open = deps.work.rows(effort.id).filter((row) => row.phase !== "finished").map((row) => row.target);
    const numberOf = new Map([...deps.snapshots.issued(effort.id)].map(([n, target]) => [target, n]));
    // A row another effort holds is that effort's to plan, even while this instruction still names its PR.
    const stored = new Map([...new Set([...scope?.include.map((grant) => prWorkItemKey(grant.target)) ?? [], ...open])].map((target) => [target, deps.work.row(target)]));
    const targets = [...stored].filter(([, row]) => !row || row.effortId === effort.id || !holdsPr(row)).map(([target]) => target);
    // Another effort's row starts over here, number and epoch alike; this effort's row keeps its epoch unless a retry or reset starts a new one.
    const { change } = options;
    const planned = planRows({ effort, mode: deps.execution.get(effort.id).mode, execution: await deps.launches.execution(), scope, sources, models: await deps.models(), held: options.held,
      admission: change?.admission ?? await deps.launches.admission(),
      attempts: (target) => change?.target === target ? change.attempts : attemptsOf(target, options.released, options.stopping), evidence: evidenceOf(targets),
      writer: (target) => change?.target === target ? change.writer ?? null : null,
      resources: (target) => options.resources?.get(target), rateLimitedUntil: options.rateLimitedUntil ?? null, ...options.legacyRechecks ? { legacyRechecks: options.legacyRechecks } : {},
      unreadable: (target) => unreadable.get(target) ?? null,
      targets: targets.map((target) => {
        const row = stored.get(target);
        const mine = row?.effortId === effort.id ? row : null;
        return { target, n: numberOf.get(target) ?? mine?.body.n ?? null, retryEpoch: (mine?.body.retryEpoch ?? 0) + (options.retry.has(target) ? 1 : 0),
          codeActions: change?.target === target && change.codeActions ? change.codeActions : mine?.body.codeActions ?? [] };
      }),
      open: (target) => {
        const decision = options.decisions.find((item) => item.body.targets.some((entry) => entry.target === target));
        return decision ? { decision: { key: decision.key, kind: decision.body.kind, subkind: decision.body.subkind, question: decision.body.question,
          options: decision.body.options, grants: decision.body.grants }, head: decision.body.targets.find((entry) => entry.target === target)!.head } : null;
      } });
    // Every row is planned, so a criterion bound to the whole effort still lands on its lowest-numbered PR; `only` limits the writes.
    const writes = planned.flatMap((row) => {
      if (options.only && !options.only.has(row.target)) return [];
      const current = stored.get(row.target);
      // A dry run's plan is the launch pass's to write, so a step that is otherwise unchanged keeps it instead of dropping it every pass.
      if (current?.effortId === effort.id && current.phase === row.phase && sameBody({ ...current.body, plan: undefined }, row.body)) return [];
      return [{ target: row.target, expectedRevision: current?.revision ?? 0, phase: row.phase, body: row.body,
        dueAt: options.retry.has(row.target) ? sources.now : row.step.wake?.dueAt ?? null }];
    });
    return { planned, writes, decisions: syncDecisions(effort.id, options.decisions, deps.work.nextDecision(effort.id), writes) };
  }
  /**
   * After an event (archive, restore, a mode change, a hold, a refresh): plan the effort's rows again from stored
   * facts and commit the ones whose step changed, each with its transition.
   */
  function settle(effortId: string, source: string, only?: ReadonlySet<string>): Promise<void> {
    const found = deps.efforts.get(effortId);
    if (!found) return Promise.resolve();
    return serial(found.id, async () => {
      const lastRevision = deps.work.lastRevision(found.id);
      const effort = deps.efforts.get(found.id);
      if (lastRevision === 0 || !effort) return;
      const sources = await deps.sources();
      const { writes, decisions } = await replan(effort, deps.work.instruction(effort.id)?.scope ?? null, sources,
        { held: (target) => prHoldFor(target, sources.holds) !== null, retry: new Set(), decisions: deps.work.decisions(effort.id), ...only ? { only } : {} });
      if (writes.length === 0) return;
      deps.work.commit({ effortId: effort.id, baseRevision: lastRevision, source, rows: writes, instruction: null, decisions, journal: null });
      deps.realtime.publish(EFFORT_ROSTER_CHANGED, { effortId: effort.id });
      nudge();
    });
  }
  /**
   * One PR's row as a launch about to claim it, or a code action about to record its key or result, would write it: planned from stored facts,
   * with the attempts, writer, admission, and code actions it sees.
   */
  async function planRow(effortId: string, target: string, change: RowChange) {
    const effort = deps.efforts.get(effortId);
    if (effort?.id !== effortId) return null;
    const key = prWorkItemKey(target);
    const sources = await deps.sources();
    const { planned } = await replan(effort, deps.work.instruction(effort.id)?.scope ?? null, sources, { held: (item) => prHoldFor(item, sources.holds) !== null,
      retry: new Set(), decisions: deps.work.decisions(effort.id), only: new Set([key]), change: { target: key, ...change } });
    const row = planned.find((item) => item.target === key);
    return row ? { phase: row.phase, body: row.body, dueAt: row.step.wake?.dueAt ?? null } : null;
  }
  /** The effort that owns a PR now: one whose row holds it, else its member owner. */
  function ownerOf(target: string, sources: RosterSources): { effortId: string; name: string } | null {
    const row = deps.work.row(target);
    const effort = deps.efforts.get(row && holdsPr(row) ? row.effortId : sources.work.ownerForPr(target)?.id ?? "");
    return effort ? { effortId: effort.id, name: effort.name } : null;
  }
  function commandRow(target: string, sources: RosterSources): CommandRow {
    const row = deps.work.row(target);
    const facts = observedFacts(target, sources).facts;
    const claim = deps.work.attempts(target).find((attempt) => attempt.status === "launching" || attempt.status === "running" || attempt.status === "uncertain");
    return { finished: facts !== null && facts.state !== "OPEN", teammate: !deps.authored(target), issue: row?.body.userState === "issue",
      stopped: row?.phase === "paused" && ["stopped", "user-cancelled"].includes(row.body.cause),
      claim: claim ? { status: claim.status as "launching" | "running" | "uncertain", threadId: claim.threadId } : null };
  }
  /** Numbers, else URLs, with each group's step: `1, 2 read GitHub; 5 paused: hold`. */
  function steps(rows: readonly PlannedRow[]): string {
    const groups = new Map<string, CommandTarget[]>();
    for (const row of [...rows].sort((a, b) => (a.body.n ?? Infinity) - (b.body.n ?? Infinity)))
      groups.set(stepPhrase(row.step).action, [...groups.get(stepPhrase(row.step).action) ?? [], { target: row.target, n: row.body.n }]);
    return [...groups].map(([action, targets]) => `${formatTargets(targets)} ${action}`).join("; ");
  }
  /**
   * The same groups as `steps`, each with where its work would run and why there, once that is known: the step's own resource, or the
   * launch a dry run already planned for a step this command leaves as it was.
   */
  function starting(rows: readonly PlannedRow[], written: ReadonlySet<string>): AckParts["starting"] {
    const groups = new Map<string, AckParts["starting"][number]>();
    for (const row of [...rows].sort((a, b) => (a.body.n ?? Infinity) - (b.body.n ?? Infinity))) {
      const resource = row.step.resource ?? (written.has(row.target) ? null : deps.work.row(row.target)?.body.plan?.resource ?? null);
      const place = resource && ["reuse", "spawn", "worktree", "same-thread"].includes(resource.kind)
        ? { kind: resource.kind, reason: "reason" in resource ? resource.reason ?? null : null } : null;
      const step = stepPhrase(row.step).action;
      const key = JSON.stringify([step, place]);
      const group = groups.get(key) ?? { targets: [], step, resource: place };
      group.targets.push({ target: row.target, n: row.body.n });
      groups.set(key, group);
    }
    return [...groups.values()];
  }
  /** Recheck names exactly what keeps a PR from Ready, from the read it just took. */
  function recheckLine(item: CommandTarget, read: Awaited<ReturnType<EffortV2Deps["observe"]>>, row: PlannedRow | undefined, sources: RosterSources): string {
    const name = formatTargets([item]);
    if (read.status === "failed") return `Recheck ${name}: the GitHub read failed: ${read.error}`;
    if (row?.phase === "prepared") return `Recheck ${name}: Ready`;
    const { full, pr } = observedFacts(item.target, sources);
    const gates: Gates | null = row?.body.gates ?? (full && prGates({ facts: full.facts, observedAt: full.at, now: sources.now,
      held: prHoldFor(item.target, sources.holds) !== null, feedback: sources.feedback(item.target), reviewers: pr }));
    const missing = [...PREPARED.filter((gate) => gates?.[gate] !== true), ...row?.criteria ?? []];
    return `Recheck ${name}: short of Ready: ${missing.join(", ") || row?.body.detail || "it isn't in the instruction"}`;
  }
  const refuse = (message: string): EffortCommandResult => ({ kind: "clarify", message, normalized: null });
  /**
   * A request to an effort, in its queue: a repeated request gets its first result, or its held answer while it waits, and a legacy
   * effort takes none. A request you took back with Undo stays taken back. `due` runs a held request that fell due.
   */
  function request(effort: EstablishedEffort, requestId: string, run: () => Promise<EffortCommandResult>, due = false): Promise<EffortCommandResult> {
    return serial(effort.id, async () => {
      const replay = deps.work.command(effort.id, requestId);
      if (replay !== null) return effortCommandResultSchema.parse(replay);
      if (deps.work.undone(effort.id, requestId)) return refuse("You took this answer back with Undo, so nothing was sent.");
      const waiting = due ? undefined : (deps.work.held(effort.id) as Held[]).find((item) => item.requestId === requestId);
      if (waiting) return { kind: "pending", requestId, text: waiting.text, decisions: waiting.decisions, until: waiting.until };
      if (deps.execution.get(effort.id).mode !== "v2") return refuse(legacyRefusal(effort.name));
      return run();
    });
  }
  /** A roster answer held for Undo, as the journal keeps it: the request that runs when it falls due. */
  type Held = { requestId: string; text: string; decisions: number[]; until: number;
    request: { kind: "command"; input: CommandInput } | { kind: "answer"; input: AnswerInput } };
  /**
   * Hold a roster answer for Undo. It changes nothing until the reconciler admits it when it falls due. A decision holds one answer at a
   * time: a second would be refused once the first is admitted, so the one you picked last would never apply.
   */
  function hold(effort: EstablishedEffort, item: Omit<Held, "until">): EffortCommandResult {
    const waiting = (deps.work.held(effort.id) as Held[]).find((other) => other.decisions.some((n) => item.decisions.includes(n)));
    if (waiting) return refuse(`An answer to ${item.decisions.filter((n) => waiting.decisions.includes(n)).map((n) => `D${n}`).join(", ")} is already waiting: ${waiting.text}. `
      + "Undo it, then answer again. Nothing was admitted.");
    const until = deps.reconciler.now() + ANSWER_DELAY;
    deps.work.note(effort.id, "held", { ...item, until } satisfies Held, "panel");
    deps.realtime.publish(EFFORT_ROSTER_CHANGED, { effortId: effort.id });
    nudge();
    return { kind: "pending", requestId: item.requestId, text: item.text, decisions: item.decisions, until };
  }
  /** Take back a held answer before it is admitted. */
  function undo({ effortId, requestId }: z.infer<typeof effortV2Contract.effort_command_undo.input>): Promise<{ undone: boolean; message: string }> {
    const { effort } = resolve(effortId);
    return serial(effort.id, async () => {
      if (deps.work.command(effort.id, requestId) !== null) return { undone: false, message: "That answer was already sent. Answer the decision again to change it." };
      if (deps.work.undone(effort.id, requestId)) return { undone: true, message: "That answer was already taken back; nothing was sent." };
      const item = (deps.work.held(effort.id) as Held[]).find((entry) => entry.requestId === requestId);
      if (!item) return { undone: false, message: "No answer is waiting under that request." };
      deps.work.note(effort.id, "undone", { requestId }, "panel");
      deps.realtime.publish(EFFORT_ROSTER_CHANGED, { effortId: effort.id });
      return { undone: true, message: `Took back ${item.text}; nothing was sent.` };
    });
  }
  /**
   * Admit each held answer that fell due, once. One that can no longer apply (its decision changed or closed, the effort left v2) is
   * journaled with its clarification, so its request has one final answer and is never tried again.
   */
  async function commitDue(): Promise<void> {
    const now = deps.reconciler.now();
    for (const effort of deps.efforts.list()) for (const item of deps.work.held(effort.id) as Held[]) {
      if (item.until > now) continue;
      let result: EffortCommandResult;
      try { result = item.request.kind === "answer" ? await answer(item.request.input, true) : await command(item.request.input, true); }
      catch (error) { result = refuse(`${error instanceof Error ? error.message : String(error)} Nothing was admitted.`); }
      if (result.kind === "clarify") await serial(effort.id, async () => {
        if (deps.work.command(effort.id, item.requestId) !== null || deps.work.undone(effort.id, item.requestId)) return;
        deps.work.commit({ effortId: effort.id, baseRevision: deps.work.lastRevision(effort.id), source: "command", rows: [], instruction: null, journal: { requestId: item.requestId,
          text: item.text, result, origin: "panel", snapshotId: item.request.kind === "command" ? item.request.input.snapshotId : null } });
        deps.realtime.publish(EFFORT_ROSTER_CHANGED, { effortId: effort.id });
      });
    }
  }
  /** When the next held answer falls due, or Infinity. */
  const nextDue = () => Math.min(...deps.efforts.list().flatMap((effort) => (deps.work.held(effort.id) as Held[]).map((item) => item.until)));
  /**
   * A command's answers applied in order to the scope its other clauses leave. The first that can't apply clarifies, and nothing is admitted.
   */
  function applyAnswers(effort: EstablishedEffort, result: Extract<CommandResult, { kind: "admit" }>, scope: InstructionScope | null, open: readonly Decision[],
    lastRevision: number, source: "panel" | "banner"): { ok: false; clarify: EffortCommandResult }
    | { ok: true; scope: InstructionScope | null; answered: DecisionWrite[]; lines: string[]; parts: AckParts["answers"]; asked: Set<string> } {
    const answered: DecisionWrite[] = [];
    const lines: string[] = [];
    const parts: AckParts["answers"] = [];
    const asked = new Set<string>();
    if (effort.archivedAt && result.answers.length) return { ok: false, clarify: refuse(`Restore ${effort.name} before changing its instruction. Nothing was admitted.`) };
    for (const reply of result.answers) {
      const decision = open.find((item) => item.n === reply.decision);
      if (!decision || !scope) return { ok: false, clarify: refuse(`D${reply.decision} isn't an open decision.`) };
      const applied = answerDecision(decision, reply, scope, lastRevision + 1);
      if ("clarify" in applied) return { ok: false, clarify: { kind: "clarify", message: `${applied.clarify} Nothing was admitted.`, normalized: result.normalized } };
      scope = applied.scope;
      answered.push({ id: decision.id, n: decision.n, key: decision.key, status: "answered", expectedRevision: decision.revision,
        body: { ...decision.body, answer: applied.answer, answeredVia: source } });
      lines.push(`D${decision.n}: ${applied.answer}`);
      parts.push({ n: decision.n, answer: applied.answer });
      for (const target of applied.targets) asked.add(target);
    }
    return { ok: true, scope, answered, lines, parts, asked };
  }
  async function command(input: CommandInput, due = false): Promise<EffortCommandResult> {
    const { effort } = resolve(input.effortId);
    if (input.delayMs && input.source !== "panel") throw new Error("Only an answer from the roster pane waits for Undo; the banner and the thread send at once.");
    return request(effort, input.requestId, async () => {
      const sources = await deps.sources();
      const active = deps.work.instruction(effort.id);
      const issued = deps.snapshots.issued(effort.id);
      const known = new Set([...issued.values(), ...active?.scope.include.map((grant) => prWorkItemKey(grant.target)) ?? []]);
      const open = deps.work.decisions(effort.id);
      const result = interpretEffortCommand(input.text, {
        effortId: effort.id, snapshot: input.snapshotId === null ? null : deps.snapshots.snapshot(input.snapshotId), issued,
        rows: new Map([...known].map((target) => [target, commandRow(target, sources)])), holds: sources.holds,
        instruction: active?.scope ?? null, lastRevision: deps.work.lastRevision(effort.id),
        decisions: open.map(({ n, body }) => ({ n, options: body.options.map((option) => option.id), targets: body.targets.flatMap((item) => item.n ?? []) })),
        ...input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision },
        ownerOf: (target) => ownerOf(target, sources),
      });
      if (result.kind === "clarify") return result;
      // An answer reaches only the rows its decision showed: `all`, a range, or an option never reaches a PR that joined since.
      const shown = new Map(input.decisions?.map((item) => [item.n, item.revision]));
      for (const { n, revision, body } of open.filter((item) => result.answers.some((reply) => reply.decision === item.n))) {
        if (shown.get(n) === revision) continue;
        const reread = shown.has(n) ? `D${n} changed since you read it; it now asks about ${formatTargets(body.targets)}. Read it again, then answer.`
          : `D${n} isn't on the roster you answered from; it asks about ${formatTargets(body.targets)}. Read it, then answer.`;
        return { kind: "clarify", normalized: result.normalized, message: `${reread} Nothing was admitted.` };
      }
      if (input.delayMs && !due) {
        const answersOnly = result.answers.length > 0 && result.instruction === null && !result.cancel && !result.recheckLaunches && !result.postRoster
          && [result.holds, result.releases, result.interventions, result.mergePreviews].every((list) => list.length === 0);
        if (!answersOnly) return { kind: "clarify", normalized: result.normalized, message: "Only a decision answer waits for Undo; send the rest at once. Nothing was admitted." };
        const applied = applyAnswers(effort, result, active?.scope ?? null, open, deps.work.lastRevision(effort.id), "panel");
        if (!applied.ok) return applied.clarify;
        const { delayMs: _delay, ...now } = input;
        return hold(effort, { requestId: input.requestId, text: input.text, decisions: result.answers.map((reply) => reply.decision), request: { kind: "command", input: now } });
      }
      return admit(effort, result, input, sources);
    }, due);
  }
  /** Answer one decision as the roster showed it; a decision that changed since is read again first. */
  async function answer(input: AnswerInput, due = false): Promise<EffortCommandResult> {
    const found = deps.work.decision(input.decisionId);
    if (!found) throw new Error("That decision does not exist. Reload the roster.");
    const given: DecisionAnswer[] = [...input.optionId === undefined ? [] : [{ decision: found.n, option: input.optionId }],
      ...input.numbers === undefined ? [] : [{ decision: found.n, numbers: input.numbers }], ...input.text === undefined ? [] : [{ decision: found.n, text: input.text }]];
    if (given.length !== 1) throw new Error("Answer with exactly one of an option, row numbers, or text.");
    const { effort } = resolve(found.effortId);
    return request(effort, input.requestId, async () => {
      const decision = deps.work.decision(found.id)!;
      const name = `D${decision.n}`;
      if (decision.status !== "open") return refuse(decision.status === "answered" ? `${name} was already answered: ${decision.body.answer}. Nothing changed.`
        : `${name} was withdrawn: no PR asks it any more. Nothing changed.`);
      if (decision.revision !== input.expectedRevision) return refuse(`${name} changed since you read it; it now asks about ${formatTargets(decision.body.targets)}. Read it again, then answer.`);
      const reply = given[0]!;
      const text = `${name} ${"option" in reply ? reply.option : "numbers" in reply ? reply.numbers.join(", ") || "none" : reply.text}`;
      const result: Extract<CommandResult, { kind: "admit" }> = { kind: "admit", normalized: text, acknowledgment: [], parts: NO_PARTS, instruction: null, cancel: false, holds: [],
        releases: [], interventions: [], recheckLaunches: false, postRoster: false, mergePreviews: [], answers: [reply] };
      if (input.delayMs && !due) {
        const applied = applyAnswers(effort, result, deps.work.instruction(effort.id)?.scope ?? null, [decision], deps.work.lastRevision(effort.id), "panel");
        if (!applied.ok) return applied.clarify;
        const { delayMs: _delay, ...now } = input;
        return hold(effort, { requestId: input.requestId, text, decisions: [decision.n], request: { kind: "answer", input: now } });
      }
      return admit(effort, result, { requestId: input.requestId, text, source: "panel", snapshotId: null }, await deps.sources());
    }, due);
  }
  /** Admit a read command in one commit: the revision its changes and answers write, its holds, and the rows whose step changed. */
  async function admit(effort: EstablishedEffort, result: Extract<CommandResult, { kind: "admit" }>,
    input: { requestId: string; text: string; source: "panel" | "banner"; snapshotId: string | null }, read: RosterSources): Promise<EffortCommandResult> {
    let sources = read;
    const active = deps.work.instruction(effort.id);
    const lastRevision = deps.work.lastRevision(effort.id);
    if (result.postRoster) return refuse("post roster arrives with parent-thread reports; open the roster instead. Nothing was admitted.");
    // `stop N` interrupts our running worker through BB, which a dry run never writes to.
    const stops = result.interventions.filter((item) => item.action === "stop");
    if (stops.length && await deps.launches.execution() !== "on") return refuse(`${dryRunStopRefusal(formatTargets(stops),
      stops.map((item) => deps.work.attempts(item.target).find((attempt) => attempt.status === "running")?.threadId ?? "its worker's thread").join(", "))} Nothing was admitted.`);
    if (effort.archivedAt && result.instruction) return refuse(`Restore ${effort.name} before changing its instruction. Nothing was admitted.`);
    // A launch this process is still making settles its own claim when BB answers; releasing it first would let its worker start unrecorded.
    const making = result.interventions.filter((item) => item.release && deps.launches.launching(item.target));
    if (making.length) return refuse(`${formatTargets(making)}'s launch is still waiting on BB, and settles as running or uncertain on its own. `
      + `If it stays uncertain, send reset ${formatTargets(making)} release again. Nothing was admitted.`);
    // Answers amend what the rest of the command leaves, in the same revision.
    let scope = result.cancel ? null : result.instruction ?? active?.scope ?? null;
    const includeOf = (value: InstructionScope | null) => JSON.stringify(value?.include.map((grant) => grant.target));
    const before = includeOf(scope);
    const open = deps.work.decisions(effort.id);
    const applied = applyAnswers(effort, result, scope, open, lastRevision, input.source);
    if (!applied.ok) return applied.clarify;
    const { answered, lines: answerLines, parts: answerParts, asked } = applied;
    scope = applied.scope;
    // The revision holds the command's changes and its answers together.
    const revised = result.instruction !== null || answered.length > 0 ? scope : null;
    // Refresh and recheck read GitHub, the threads, and the checkouts first. Recheck then reads the latest attempt's turn
    // and its report again against that read, and recheck launches reads BB back for each unfinished launch; every other
    // step plans from stored facts.
    const reads = new Map<string, Awaited<ReturnType<EffortV2Deps["observe"]>>>();
    for (const item of result.interventions) if (item.action === "refresh" || item.action === "recheck") {
      const read = await observeOnce(item.target, sources.work.items.get(item.target)?.paths ?? []);
      reads.set(item.target, read);
      const fresh = read.status === "checked" && item.action === "recheck" ? (await deps.sources()).full(item.target)?.facts : null;
      if (fresh) await deps.launches.recheck(item.target, fresh);
    }
    if (reads.size) sources = await deps.sources();
    const readback: string[] = [];
    if (result.recheckLaunches) for (const claim of deps.work.claims(effort.id).filter((attempt) => attempt.status !== "running")) {
      await deps.launches.recover(claim.id);
      const after = deps.work.attempt(claim.id)!;
      readback.push(`${formatTargets([{ target: claim.target, n: deps.work.row(claim.target)?.body.n ?? null }])} ${after.status === "running" ? `attached to ${after.threadId}`
        : after.status === "released" ? "released: two readbacks found no worker" : after.body.failure === "duplicate-writer" ? "has more than one worker"
        : after.body.failure === "source-unavailable" ? "still uncertain: BB couldn't be read" : "still uncertain"}`);
    }
    // `reset N release`: you confirmed no worker holds the launch, so its claim drops in this command's own commit.
    const released = new Set(result.interventions.filter((item) => item.release).map((item) => prWorkItemKey(item.target)));
    const held = (target: string) => result.holds.some((item) => item.target === target)
      || (!result.releases.some((item) => item.target === target) && prHoldFor(target, sources.holds) !== null);
    const touched = new Set([...result.holds, ...result.releases, ...result.interventions].map((item) => item.target));
    const stopping = new Set(stops.map((item) => prWorkItemKey(item.target)));
    const { planned, writes, decisions } = await replan(effort, scope, sources, { held, released, stopping, decisions: open.filter((item) => !answered.some((other) => other.id === item.id)),
      retry: new Set([...result.interventions.filter((item) => item.action === "reset" || item.action === "retry").map((item) => item.target), ...asked]),
      // An answer alone re-plans only the PRs that asked it, and other rows keep their revisions, unless it changed which PRs the
      // instruction includes: a whole-effort criterion follows that set to another PR.
      ...result.instruction === null && !result.cancel && touched.size === 0 && asked.size > 0 && includeOf(scope) === before ? { only: asked } : {} });
    const byTarget = new Map(planned.map((row) => [row.target, row]));
    const included = new Set(scope?.include.map((grant) => prWorkItemKey(grant.target)));
    const next = planned.filter((row) => included.has(row.target) && (result.instruction !== null || touched.has(row.target) || asked.has(row.target)));
    const after = [...decisions, ...open.filter((item) => ![...answered, ...decisions].some((other) => other.id === item.id))].filter((item) => item.status === "open");
    const answer: EffortCommandResult = {
      kind: "admit", normalized: result.normalized, revision: scope?.revision ?? null, mergePreviews: result.mergePreviews,
      parts: { ...result.parts, answers: answerParts, starting: starting(next, new Set(writes.map((write) => prWorkItemKey(write.target)))) },
      acknowledgment: capAcknowledgment([...result.acknowledgment, ...answerLines,
        ...result.interventions.filter((item) => item.action === "recheck").map((item) => recheckLine(item, reads.get(item.target)!, byTarget.get(item.target), sources)),
        ...result.recheckLaunches ? [`Readback: ${readback.join("; ") || "no launch is unfinished"}`] : [],
        ...next.length ? [`Next${await deps.launches.execution() === "on" ? "" : " (planned; nothing runs until v2 execution is on)"}: ${steps(next)}`] : []]),
      rollup: scope ? rowContract(effort, scope, planned, sources.work, after, evidenceOf(planned.map((row) => row.target))).rollup : null,
    };
    deps.work.commit({ effortId: effort.id, baseRevision: lastRevision, source: "command", rows: writes,
      instruction: result.cancel ? "cancel" : revised && { scope: revised, text: input.text,
        source: { kind: input.source, threadId: null, eventId: null }, snapshotId: input.snapshotId, requestId: input.requestId },
      // An answered decision closes before any row asks a new one.
      decisions: [...answered, ...decisions],
      journal: { requestId: input.requestId, text: input.text, result: answer, origin: input.source, snapshotId: input.snapshotId },
      also: () => {
        for (const item of result.holds) deps.holds.set(item.target, true, item.reason);
        for (const item of result.releases) deps.holds.set(item.target, false);
        for (const target of released) deps.work.release(target);
        for (const target of stopping) deps.work.requestStop(target);
      } });
    if (result.holds.length || result.releases.length) deps.holds.changed();
    deps.realtime.publish(EFFORT_ROSTER_CHANGED, { effortId: effort.id });
    // The reconciler's next tick stops the worker; commands only record what to do.
    if (stopping.size) markDue([...stopping]);
    nudge();
    return answer;
  }
  /** The banner's view of an effort parent thread: its counts, open system issues, rollup, and the snapshot and revision a command there reads. */
  async function parentContext(threadId: string): Promise<z.infer<typeof parentContextSchema> | null> {
    const effort = deps.efforts.list().find((item) => item.coordinatorThreadId === threadId);
    if (!effort || deps.execution.get(effort.id).mode !== "v2") return null;
    const active = deps.work.instruction(effort.id);
    const included = new Set(active?.scope.include.map((grant) => prWorkItemKey(grant.target)));
    const rows = deps.work.rows(effort.id).filter((row) => included.has(row.target));
    const decisions = deps.work.decisions(effort.id);
    const { breakerOpen } = await deps.launches.admission();
    return { effort: { id: effort.id, key: effort.key, name: effort.name, archived: Boolean(effort.archivedAt) }, snapshotId: deps.snapshots.latest(effort.id),
      revision: active?.revision ?? null, lastRevision: deps.work.lastRevision(effort.id), decisions: decisions.map(({ n, revision }) => ({ n, revision })),
      counts: Object.fromEntries(USER_STATES.map((state) => [state, rows.filter((row) => row.body.userState === state).length])) as Record<UserState, number>,
      issues: new Set(rows.flatMap((row) => row.body.userState === "issue" ? [row.body.cause] : [])).size + (breakerOpen ? 1 : 0),
      rollup: active ? rowContract(effort, active.scope, rows, (await deps.sources()).work, decisions, evidenceOf(rows.map((row) => row.target))).rollup : null };
  }
  const observing = new Map<string, ReturnType<EffortV2Deps["observe"]>>();
  /** Concurrent reads of one PR share one read. */
  function observeOnce(target: string, paths: readonly string[]): ReturnType<EffortV2Deps["observe"]> {
    let observed = observing.get(target);
    if (!observed) {
      observed = deps.observe(target, paths).then((read) => {
        if (read.status === "checked") unreadable.delete(prWorkItemKey(target));
        return read;
      }).finally(() => observing.delete(target));
      observing.set(target, observed);
    }
    return observed;
  }
  /** The Refresh escape hatch: re-observe one roster row and recompute it. */
  async function reconcile(effortId: string, prUrl: string) {
    const { effort } = resolve(effortId);
    const target = canonicalPrUrl(prUrl);
    const { work } = await deps.sources();
    const included = deps.work.instruction(effort.id)?.scope.include.map((grant) => grant.target) ?? [];
    if (target === null || !rosterTargets(effort, work, included).includes(target)) throw new Error("That PR is not on this effort's roster.");
    const result = await observeOnce(target, work.items.get(target)?.paths ?? []);
    await settle(effort.id, "refresh", new Set([target]));
    markDue([target]);
    deps.realtime.publish(EFFORT_ROSTER_CHANGED, { effortId: effort.id, prUrl: target });
    const row = (await roster(effort.id)).rows.find((item) => item.target === target);
    // A full read keeps a PR placed after the board drops it, so a row leaves only when ownership moved or no read succeeded.
    if (!row) throw new Error(`That PR is no longer on this effort's roster${result.status === "failed" ? `: ${result.error}` : "."}`);
    return { ...result, row };
  }
  // The reconciler: the one v2 scheduler. It ticks every 15 seconds, or sooner when an event makes a row due; events
  // only mark rows due, and only a tick reads GitHub, launches, or takes an attempt's next step. Pass 0 reads every
  // unfinished launch back before the first tick, so no launch is admitted until it finishes.
  let fullReads: number[] = [];
  let limitedUntil: number | null = null;
  let secondaryLimits = 0;
  let wake: (() => void) | null = null;
  let nudged = false;
  const v2Rows = () => deps.efforts.list().filter((effort) => deps.execution.get(effort.id).mode === "v2").flatMap((effort) => deps.work.rows(effort.id));
  /** Tick now instead of at the next 15 seconds. */
  function nudge(): void {
    if (wake) wake();
    else nudged = true;
  }
  /** Events only mark rows due; the next tick acts on them. */
  function markDue(targets: readonly string[]): void {
    if (targets.length === 0) return;
    deps.work.markDue(targets, deps.reconciler.now());
    nudge();
  }
  /** The PR a waiting row waits on: its stack parent (`owner/repo#N`), or the PR a worker reported blocking it. */
  function waitsOn(row: WorkRow): string | null {
    const ref = row.phase === "waiting" && ["parent", "dependency"].includes(row.body.cause) && row.body.owner?.kind === "pr" ? row.body.owner.ref : null;
    const stack = ref && /^(.+)#(\d+)$/u.exec(ref);
    if (!stack) return ref && prWorkItemKey(ref);
    const slug = stack[1]!.split("/");
    return prWorkItemKey(slug.length === 3 ? `https://${slug[0]}/${slug[1]}/${slug[2]}/pull/${stack[2]}` : `https://github.com/${stack[1]}/pull/${stack[2]}`);
  }
  /** A thread went idle, failed, or went away: rows waiting on it as a writer look again, and when it was our worker, its row and rows waiting for a worker slot. */
  function threadChanged(threadId: string, heard: { target: string } | null): void {
    markDue([...heard ? [heard.target] : [], ...v2Rows().filter((row) => row.body.owner?.ref === threadId
      || (heard !== null && row.phase === "waiting" && ["capacity", "launch-breaker"].includes(row.body.cause))).map((row) => row.target)]);
  }
  /** The board read these PRs: their rows, and rows waiting on them, look again. */
  function observed(urls: readonly string[]): void {
    const read = new Set(urls.map(prWorkItemKey));
    if (read.size) markDue(v2Rows().filter((row) => read.has(row.target) || read.has(waitsOn(row) ?? "")).map((row) => row.target));
  }
  const isLimited = (now: number) => limitedUntil !== null && now < limitedUntil;
  /** A read that hit GitHub's rate limit holds every read until the reported reset, or backs off when GitHub names none; true when it was one. */
  async function limit(error: string, now: number): Promise<boolean> {
    const kind = githubRateLimit(error);
    if (kind === "primary") limitedUntil = ((await deps.reconciler.rateLimitReset()) ?? now + MINUTE) + 30_000;
    else if (kind === "secondary") limitedUntil = now + RECONCILE.backoff[Math.min(secondaryLimits++, RECONCILE.backoff.length - 1)]! * MINUTE;
    return kind !== null;
  }
  /** One full read within the budget of four a minute, unless a rate limit holds reads or the PR backs off after failed reads; true when it read. */
  async function readFull(prUrl: string): Promise<boolean> {
    const now = deps.reconciler.now();
    const key = prWorkItemKey(prUrl);
    fullReads = fullReads.filter((at) => at > now - MINUTE);
    if (isLimited(now) || now < (unreadable.get(key)?.retryAt ?? now) || fullReads.length >= RECONCILE.fullPerMinute) return false;
    fullReads.push(now);
    const read = await deps.reconciler.full(prUrl);
    if (read.status === "checked") {
      secondaryLimits = 0;
      unreadable.delete(key);
      return true;
    }
    // Any other failure backs this PR off 1, 2, 4, 8, then 15 minutes, so a PR GitHub can't read never takes the other PRs' reads.
    if (!await limit(read.error, now)) {
      const tries = (unreadable.get(key)?.tries ?? 0) + 1;
      unreadable.set(key, { tries, error: read.error.slice(0, 300), retryAt: now + RECONCILE.backoff[Math.min(tries, RECONCILE.backoff.length) - 1]! * MINUTE });
    }
    return false;
  }
  type Recheck = { target: string; job: string; at: number };
  /** The reconciler's rechecks of the uncertain legacy job that holds a PR now, newest first. */
  const rechecks = (effortId: string, target: string, legacy: LegacyAttempt | null): Recheck[] => legacy?.cause !== "uncertain" ? []
    : (deps.work.notes(effortId, "legacy-recheck") as Recheck[]).filter((note) => note.target === target && note.job === `${legacy.batchId}/${legacy.job.id}`);
  /**
   * After a pass: journal the instruction's criteria when a status changes (so "outcome validated" is journaled once, as it
   * becomes true, and the instruction stays active), and complete the instruction once every included PR finished with its
   * criteria held on its final head.
   */
  function evaluate(effort: EstablishedEffort, sources: RosterSources): void {
    const active = deps.work.instruction(effort.id);
    if (!active) return;
    const rows = deps.work.rows(effort.id);
    const contract = rowContract(effort, active.scope, rows, sources.work, deps.work.decisions(effort.id), evidenceOf(rows.map((row) => row.target)));
    const state = { instructionId: active.id, criteria: Object.fromEntries(contract.criteria.map((item) => [item.id, item.status])),
      outcomeValidated: contract.outcomeValidated, completed: contract.completed };
    if (JSON.stringify(deps.work.notes(effort.id, "criteria", 1)[0]) !== JSON.stringify(state)) deps.work.note(effort.id, "criteria", state);
    if (contract.completed) deps.work.completeInstruction(active.id);
  }
  type Due = { row: WorkRow; step: Next; criteria: string[]; facts: AdvanceFacts | null; legacy: LegacyAttempt | null; reviews: readonly { login: string; state: string }[] };
  /**
   * One pass over an effort's due rows: plan them from stored facts, read checkouts and threads for each launch so the row
   * says where it would run, commit the rows whose step changed at the revisions they were read at, and set when the rest
   * look again. A pass that loses the compare-and-swap to another instance or a command writes nothing.
   */
  function pass(effortId: string, targets: ReadonlySet<string>): Promise<Due[]> {
    return serial(effortId, async () => {
      const effort = deps.efforts.get(effortId);
      const lastRevision = deps.work.lastRevision(effortId);
      if (effort?.id !== effortId || lastRevision === 0) return [];
      const sources = await deps.sources();
      const scope = deps.work.instruction(effortId)?.scope ?? null;
      const options = { held: (target: string) => prHoldFor(target, sources.holds) !== null, retry: new Set<string>(), decisions: deps.work.decisions(effortId), only: targets,
        rateLimitedUntil: limitedUntil, legacyRechecks: (target: string) => rechecks(effortId, target, sources.legacy.get(target) ?? null).length };
      let plan = await replan(effort, scope, sources, options);
      const resources = new Map<string, ResourceParts>();
      for (const row of plan.planned) {
        const facts = targets.has(row.target) && isLaunch(row.step) && !row.step.resource ? sources.full(row.target)?.facts : null;
        if (facts) resources.set(row.target, await deps.reconciler.resources(row.target, facts, deps.work.attempts(row.target)[0] ?? null));
      }
      if (resources.size) plan = await replan(effort, scope, sources, { ...options, resources });
      try {
        if (plan.writes.length) deps.work.commit({ effortId, baseRevision: lastRevision, source: "reconciler", rows: plan.writes, instruction: null, decisions: plan.decisions, journal: null });
      } catch (error) {
        if (error instanceof StaleWriteError) return [];
        throw error;
      }
      if (plan.writes.length) deps.realtime.publish(EFFORT_ROSTER_CHANGED, { effortId });
      const written = new Set(plan.writes.map((write) => prWorkItemKey(write.target)));
      const due: Due[] = [];
      for (const planned of plan.planned) {
        const row = targets.has(planned.target) ? deps.work.row(planned.target) : null;
        if (row?.effortId !== effortId) continue;
        if (!written.has(row.target)) deps.work.reschedule(row.target, row.revision, planned.step.wake?.dueAt ?? null);
        due.push({ row, step: planned.step, criteria: planned.criteria, facts: sources.full(row.target)?.facts ?? null, legacy: sources.legacy.get(row.target) ?? null,
          reviews: sources.facts(row.target)?.latestReviews ?? [] });
      }
      evaluate(effort, sources);
      return due;
    });
  }
  type Adapted = { target: string; job: string; head: string; fingerprint: string | null; saved: boolean; compat: string[]; rejection: string | null };
  /**
   * Before a launch that would address review feedback, the compatibility adapter reads the PR's settled legacy Advance worker's last
   * output, once per head and feedback fingerprint, with no model turn and no send. Evidence it proves on fresh facts clears the feedback
   * gate, so no worker starts for work a legacy worker already did. Each read is journaled. True when it saved evidence. A dry run keeps
   * its plans in row bodies, so the adapter saves nothing until v2 execution is on.
   */
  async function adoptLegacy(effortId: string, target: string, step: Next, legacy: LegacyAttempt | null, facts: AdvanceFacts): Promise<boolean> {
    const job = legacy?.job;
    if (!legacy || !job?.threadId || legacy.cause === "uncertain" || ["queued", "launching", "running", "verifying"].includes(job.status)
      || facts.approvalFeedback.status !== "present" || !(step.nextAction as string[]).includes("address_review_feedback")
      || await deps.launches.execution() !== "on") return false;
    const read = { target, job: `${legacy.batchId}/${job.id}`, head: facts.headOid, fingerprint: facts.approvalFeedback.fingerprint };
    if ((deps.work.notes(effortId, "legacy-adapter") as Adapted[]).some((note) => note.target === read.target && note.job === read.job && note.head === read.head
      && note.fingerprint === read.fingerprint)) return false;
    const adapted = await deps.launches.adopt(target, { attemptId: job.attemptId ?? job.id, threadId: job.threadId }, facts);
    if (!adapted) return false;
    deps.work.note(effortId, "legacy-adapter", { ...read, ...adapted } satisfies Adapted);
    return adapted.saved;
  }
  /** Act on one row a pass planned: take its attempt's next step, launch its work order, run its code action, or recheck the legacy job it waits on. */
  async function act(effortId: string, { row, step, criteria, facts, legacy, reviews }: Due): Promise<void> {
    const now = deps.reconciler.now();
    const [latest] = deps.work.attempts(row.target);
    // A pending worker interaction is read again at its poll too.
    if (latest && ((typeof step.nextAction === "string" && ["attach", "parse-report", "retry-turn", "recover-launch"].includes(step.nextAction))
      || step.cause === "worker-interaction")) return deps.launches.advance(latest.id);
    if (isLaunch(step) && step.resource) {
      const scope = deps.work.instruction(effortId)?.scope;
      const grant = scope?.include.find((item) => prWorkItemKey(item.target) === row.target);
      if (!scope || !grant || !facts) return;
      if (await adoptLegacy(effortId, row.target, step, legacy, facts)) return settle(effortId, "legacy-adapter", new Set([row.target]));
      const outcome = await deps.launches.launch({ effortId, target: row.target, baseRevision: deps.work.lastRevision(effortId), expectedRevision: row.revision, step, body: row.body,
        order: { revision: scope.revision, facts, granted: grant.effects, parentMerged: false, tickets: row.body.tickets, threads: [], direction: null,
          criteria: criteria.map((id) => ({ id, text: scope.criteria.find((item) => item.id === id)?.text ?? id, fixAuthorized: false })),
          answers: scope.answers.filter((answer) => answer.targets.includes(row.target)).map((answer) => ({ decision: `D${answer.n}`, question: answer.question, answer: answer.answer })) } });
      if (outcome !== "planned") return;
    } else if (isCode(step)) {
      const grant = deps.work.instruction(effortId)?.scope.include.find((item) => prWorkItemKey(item.target) === row.target);
      if (!grant || !facts) return;
      const [id] = step.nextAction as CodeRecipeId[];
      // A re-request names each reviewer whose latest review asks for changes or was dismissed; a new request names each reviewer you granted
      // who hasn't reviewed, so a request that landed and was answered isn't made again.
      const reviewed = new Set(reviews.filter((review) => review.state !== "PENDING").map((review) => review.login.toLowerCase()));
      const reviewers = id === "request_rereview" ? reviews.filter((review) => ["CHANGES_REQUESTED", "DISMISSED"].includes(review.state)).map((review) => review.login)
        : id === "request_review" ? grant.reviewers.filter((login) => !reviewed.has(login.toLowerCase())) : [];
      if (await deps.launches.code({ effortId, target: row.target, baseRevision: deps.work.lastRevision(effortId), expectedRevision: row.revision, step, body: row.body,
        facts, reviewers }) !== "planned") return;
    } else if (step.phase === "waiting" && step.cause === "legacy-drain" && legacy?.cause === "uncertain") {
      // An uncertain legacy job is rechecked every 10 minutes; after six, decide() names it a system issue.
      if ((rechecks(effortId, row.target, legacy)[0]?.at ?? -Infinity) > now - RECONCILE.legacyRecheckEvery) return;
      deps.work.note(effortId, "legacy-recheck", { target: row.target, job: `${legacy.batchId}/${legacy.job.id}`, at: now } satisfies Recheck);
      return deps.reconciler.recheckLegacy(legacy.batchId, legacy.job.id);
    } else if (step.phase !== "queued") return;
    // A launch or code action planned in a dry run looks again later, or at an event.
    const current = deps.work.row(row.target);
    if (current?.phase === "queued" || (current && isCode(current.body))) deps.work.reschedule(row.target, current.revision, now + RECONCILE.plannedPoll);
  }
  /**
   * One tick: select due rows, oldest first. Read them cheaply (skipping any read in the last minute) along with every PR a
   * waiting row waits on, so a parent's merge wakes its child in this tick. Read in full only what changed, left the open
   * list, has no full read, or needs one under two minutes old for its next step, at most four a minute. Then plan, commit,
   * and act, and confirm what rosters showed Done on a legacy job's word.
   */
  async function tick(): Promise<void> {
    await commitDue();
    const now = deps.reconciler.now();
    let due = deps.work.due(now, RECONCILE.duePerTick);
    const watched = v2Rows().flatMap((row) => { const on = waitsOn(row); return on ? [{ on, row }] : []; });
    const unread = [...new Set([...due.map((row) => row.target), ...watched.map((item) => item.on)])]
      .filter((url) => (deps.reconciler.cheapAt(url) ?? -Infinity) <= now - RECONCILE.cheapFresh);
    const changed = new Set<string>();
    if (unread.length && !isLimited(now)) {
      const read = await deps.reconciler.cheap(unread);
      for (const url of read.changed) changed.add(prWorkItemKey(url));
      if (read.error) await limit(read.error, now);
    }
    // A PR a worker reported blocking a row has no row of its own to read it in full, so its change is read here: a merge settles the wait.
    for (const on of new Set(watched.filter((item) => item.row.body.cause === "dependency" && changed.has(prWorkItemKey(item.on))).map((item) => item.on))) await readFull(on);
    const woken = watched.filter((item) => changed.has(prWorkItemKey(item.on))).map((item) => item.row);
    for (const row of woken) changed.add(row.target);
    due = [...new Map([...due, ...woken].map((row) => [row.target, row])).values()];
    if (due.length === 0) return confirmSettled();
    const sources = await deps.sources();
    for (const row of due) {
      const fullAt = sources.full(row.target)?.fullAt ?? null;
      // A launch, a code action, Ready, and a wait that ends in a launch all decide on a read under two minutes old.
      const needsFresh = row.phase === "queued" || row.phase === "prepared" || row.body.nextAction === "observe"
        || (row.phase === "waiting" && ["capacity", "launch-breaker", "writer-available", "legacy-drain"].includes(row.body.cause));
      if (changed.has(row.target) || fullAt === null || (needsFresh && fullAt <= now - RECONCILE.fullFresh)) await readFull(row.target);
    }
    for (const effortId of new Set(due.map((row) => row.effortId)))
      for (const item of await pass(effortId, new Set(due.filter((row) => row.effortId === effortId).map((row) => row.target)))) await act(effortId, item);
    await confirmSettled();
  }
  /**
   * After the due rows, read in full each PR a roster showed Done only on a legacy job's word, within what the budget leaves; one
   * not read yet waits for the next tick. A read tells its roster to look again, and its full read now places the row.
   */
  async function confirmSettled(): Promise<void> {
    for (const [target, effortId] of confirming) {
      if (!await readFull(target)) continue;
      confirming.delete(target);
      deps.realtime.publish(EFFORT_ROSTER_CHANGED, { effortId, prUrl: target });
    }
  }
  /** Pass 0, on every start: read every unfinished launch back, then make every open row due. */
  async function recoverAll(): Promise<void> {
    for (const claim of deps.work.claims()) if (claim.status !== "running") {
      try { await deps.launches.recover(claim.id); }
      catch (error) { deps.reconciler.warn(`v2 readback of ${claim.id} failed: ${String(error).slice(0, 300)}`); }
    }
    deps.work.markDue(v2Rows().map((row) => row.target), deps.reconciler.now());
    // An answer held for Undo that fell due while the plugin was stopped is admitted now, once.
    await commitDue();
  }
  /** The `effort-v2` background service: pass 0, then a tick every 15 seconds or at the next event, until stopped. */
  async function run(signal: AbortSignal): Promise<void> {
    await recoverAll();
    while (!signal.aborted) {
      nudged = false;
      try { await tick(); }
      catch (error) { deps.reconciler.warn(`v2 reconciler tick failed: ${String(error).slice(0, 300)}`); }
      if (signal.aborted || nudged) continue;
      // A plain setTimeout would sleep through the stop and leave the plugin degraded on reload.
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); wake = null; resolve(); };
        // A held answer falls due sooner than the next tick: wake for it.
        const timer = setTimeout(done, Math.max(0, Math.min(RECONCILE.tick, nextDue() - deps.reconciler.now())));
        signal.addEventListener("abort", done, { once: true });
        wake = done;
      });
    }
  }

  /** Legacy Advance jobs on these PRs: queued ones never started and are cancelled one by one; started or uncertain ones drain. */
  function legacyJobs(targets: ReadonlySet<string>): EffortV2Preview["legacy"] {
    const jobs = deps.legacy.jobs().filter(({ job }) => targets.has(prWorkItemKey(job.prUrl)))
      .map(({ batchId, job }): LegacyJob => ({ batchId, jobId: job.id, prUrl: job.prUrl, repo: job.repo, number: job.number, status: job.status, uncertain: job.uncertain }));
    return { queued: jobs.filter((job) => job.status === "queued" && !job.uncertain),
      draining: jobs.filter((job) => job.uncertain || ["launching", "running", "verifying"].includes(job.status)) };
  }
  /** The preview, and the roster PRs it read, which opting in reads legacy jobs for again once they are fenced. */
  async function inspect(effortId: string): Promise<{ preview: EffortV2Preview; targets: Set<string> }> {
    const { effort, redirectedFrom } = resolve(effortId);
    const execution = deps.execution.get(effort.id);
    const sources = await deps.sources();
    // Provisional numbers: a preview reads the roster without numbering it.
    const { rows } = effortRoster({ effort, redirectedFrom, sources, number: (targets) => deps.numbers(effort.id, targets, { assign: false }) });
    const targets = new Set(rows.map((row) => row.target));
    const candidates = await deps.parent.candidates(effort, [...targets]);
    const coordinator = candidates.find((candidate) => candidate.reason === "coordinator");
    const origin = candidates.find((candidate) => candidate.reason === "origin" && candidate.canSpawnChild);
    const blockers = execution.mode === "v2" ? [] : [
      ...(redirectedFrom ? [`This effort was merged into ${effort.name}. Opt in ${effort.name} instead.`] : []),
      ...(effort.archivedAt ? ["Restore this effort before moving it to its roster."] : []),
      ...(deps.autoDispatches(effort.id) ? ["Turn off automatic dispatch for this effort before moving it to its roster."] : []),
      // An unresolved launch never starts a second parent, so opting in waits until the thread it started can be linked.
      ...(effort.coordinatorState === "creating" && !coordinator ? ["A coordinator launch is unresolved. Inspect it before moving this effort to its roster."] : []),
    ];
    const onRoster = (prUrl: string | null) => prUrl !== null && targets.has(prWorkItemKey(prUrl));
    const v2Execution = await deps.launches.execution();
    const summary: EffortV2Preview = {
      effort: { id: effort.id, key: effort.key, name: effort.name, coordinatorThreadId: effort.coordinatorThreadId },
      execution, v2Execution, blockers,
      consequence: execution.mode === "v2" ? "Legacy Advance and dispatch apply to this effort again. Every v2 record is kept."
        : v2Execution === "on" ? "Legacy Advance and dispatch stop for this effort. v2 claims each PR it works on and launches the work its instruction authorizes."
        : "Legacy Advance and dispatch stop for this effort. v2 plans work but runs nothing until v2 execution is on.",
      members: { tickets: effort.members.tickets.length, prUrls: effort.members.prUrls.length, prs: rows.length,
        open: rows.filter((row) => row.state !== "done").length },
      parent: { candidates, recommended: (coordinator ?? origin)?.threadId ?? null,
        reason: coordinator ? "The effort's coordinator becomes its parent." : origin ? "The thread that created this effort becomes its parent."
          : "No coordinator or originating thread is available on the planning model, so one new parent starts unless you choose a linked thread." },
      legacy: legacyJobs(targets),
      active: {
        runs: sources.runs.filter((run) => onRoster(run.prUrl) && ["running", "needs-you"].includes(run.status))
          .map((run) => ({ prUrl: run.prUrl!, action: run.action, status: run.status })),
        dispatch: sources.dispatch.filter((attempt) => onRoster(attempt.prUrl) && ["launching", "running", "verifying", "needs-you"].includes(attempt.status))
          .map(({ prUrl, action, status }) => ({ prUrl, action, status })),
      },
    };
    return { preview: summary, targets };
  }
  const preview = async (effortId: string) => (await inspect(effortId)).preview;
  const changing = new Set<string>();
  /** Opt in: link or start the parent, fence the roster's PRs, then cancel each queued legacy job. Opting out keeps every record. */
  async function setMode(input: z.infer<typeof effortV2Contract.effort_v2_set.input>) {
    const { preview: current, targets } = await inspect(input.effortId);
    const effortId = current.effort.id;
    if (changing.has(effortId)) throw new Error("This effort's execution mode is already changing. Refresh the preview after it settles.");
    // The preview awaited board and thread reads, so another change may have landed since it read the revision.
    if (current.execution.revision !== input.expectedRevision || deps.execution.get(effortId).revision !== input.expectedRevision) throw new Error("The effort's execution mode changed. Refresh the preview and try again.");
    if (current.execution.mode === input.mode) throw new Error(input.mode === "v2" ? "This effort already runs on its roster." : "This effort already runs on legacy launchers.");
    changing.add(effortId);
    try {
      if (input.mode === "legacy") {
        if (input.parentThreadId !== undefined) throw new Error("Opting out keeps the parent thread. Leave the parent out.");
        const execution = await deps.execution.set(effortId, "legacy", input.expectedRevision);
        // Its rows pause as v2-off, keeping every record, until it opts in again.
        await settle(effortId, "mode");
        deps.realtime.publish(EFFORT_ROSTER_CHANGED, { effortId });
        return { execution, parentThreadId: current.effort.coordinatorThreadId, cancelled: [], draining: [] };
      }
      if (current.blockers.length) throw new Error(current.blockers.join(" "));
      if (input.parentThreadId === undefined) throw new Error("Choose a parent thread from the preview, or null to start one new parent.");
      if (input.parentThreadId !== null && !current.parent.candidates.some((candidate) => candidate.threadId === input.parentThreadId))
        throw new Error("That thread can't be this effort's parent. Refresh the preview and choose one of its candidates.");
      const parent = input.parentThreadId === null ? await deps.parent.start(effortId, parentPrompt(current.effort.name))
        : await deps.parent.adopt(effortId, input.parentThreadId);
      const execution = await deps.execution.set(effortId, "v2", input.expectedRevision);
      await settle(effortId, "mode");
      // Read again once fenced: a queued job may have launched while the parent was linked or started, and none can launch now.
      const legacy = legacyJobs(targets);
      const cancelled = legacy.queued.filter((job) => deps.legacy.cancelQueued(job.batchId, job.jobId));
      // The roster's execution mode and parent thread changed, whether or not any row did.
      deps.realtime.publish(EFFORT_ROSTER_CHANGED, { effortId });
      return { execution, parentThreadId: parent.coordinatorThreadId, cancelled, draining: legacy.draining };
    } finally { changing.delete(effortId); }
  }
  /** The active instruction's criteria as its roster counts them; null without one. */
  function criteria(effortId: string, work: RosterSources["work"]): Criterion[] | null {
    const effort = deps.efforts.get(effortId);
    const active = effort && deps.work.instruction(effort.id);
    if (!effort || !active) return null;
    const rows = deps.work.rows(effort.id);
    return rowContract(effort, active.scope, rows, work, deps.work.decisions(effort.id), evidenceOf(rows.map((row) => row.target))).criteria;
  }
  const handlers = {
    effort_roster_get: ({ effortId, since }: { effortId: string; since?: number }) => roster(effortId, since),
    effort_roster_list: () => deps.efforts.list().map((effort) => {
      const { mode } = deps.execution.get(effort.id);
      // A legacy coordinator isn't an effort parent: nothing reports to it, and its roster only reads.
      return { id: effort.id, key: effort.key, name: effort.name, archived: Boolean(effort.archivedAt), mode, parentThreadId: mode === "v2" ? effort.coordinatorThreadId : null };
    }),
    effort_reconcile: ({ effortId, prUrl }: { effortId: string; prUrl: string }) => reconcile(effortId, prUrl),
    effort_v2_preview: ({ effortId }: { effortId: string }) => preview(effortId),
    effort_v2_set: setMode,
    effort_command: (input: CommandInput) => command(input),
    effort_decision_answer: (input: AnswerInput) => answer(input),
    effort_command_undo: undo,
    effort_parent_context: ({ threadId }: { threadId: string }) => parentContext(threadId),
  };
  /** A CLI effort argument: id, key, or exact name. */
  function effortArg(words: readonly string[]): string {
    const text = words.join(" ").trim();
    if (deps.efforts.get(text)) return text;
    const named = deps.efforts.list().filter((effort) => effort.name.toLocaleLowerCase() === text.toLocaleLowerCase());
    if (named.length === 1) return named[0]!.id;
    throw new PluginCliError(named.length > 1 ? `More than one effort is named "${text}".` : `No saved effort matches "${text}".`,
      { code: "unknown_effort", hint: "Use the effort id or key from the Efforts view." });
  }
  const jobLine = (jobs: readonly LegacyJob[]) => jobs.map((job) => `${job.repo} #${job.number}${job.uncertain ? " (uncertain)" : ""}`).join(", ") || "none";
  const commands = {
    recipes: cliCommand({
      summary: "List the action recipes v2 composes into work orders",
      options: { json: { type: "boolean", description: "Emit the catalog as JSON" } },
      async run({ options }) {
        return { exitCode: 0, stdout: options.json ? JSON.stringify(RECIPES) : RECIPES.map((item) =>
          `${item.action} · ${item.executor === "worker" ? `worker on the ${item.modelRole} model` : "code"} · effects: ${item.effects.join(", ") || "none"}`).join("\n") };
      },
    }),
    roster: cliCommand({
      summary: "List an effort's PRs as a numbered roster",
      positionals: [{ name: "effort", description: "Effort id, key, or exact name", required: true, variadic: true }],
      options: { json: { type: "boolean", description: "Emit the roster as JSON" } },
      async run({ positionals, options }) {
        const current = await roster(effortArg(positionals.effort));
        return { exitCode: 0, stdout: options.json ? JSON.stringify(current) : rosterText(current) };
      },
    }),
    "v2 preview": cliCommand({
      summary: "Show what moving an effort to its v2 roster would change",
      positionals: [{ name: "effort", description: "Effort id, key, or exact name", required: true, variadic: true }],
      options: { json: { type: "boolean", description: "Emit the preview as JSON" } },
      async run({ positionals, options }) {
        const current = await preview(effortArg(positionals.effort));
        return { exitCode: 0, stdout: options.json ? JSON.stringify(current) : [
          `${current.effort.name} · ${current.execution.mode} · revision ${current.execution.revision}`,
          current.consequence,
          `PRs: ${current.members.prs} (${current.members.open} open) from ${current.members.tickets} tickets and ${current.members.prUrls} PRs`,
          `Parent: ${current.parent.recommended ?? "a new thread"}. ${current.parent.reason}`,
          `Candidates: ${current.parent.candidates.map((candidate) => `${candidate.threadId} (${candidate.reason})`).join(", ") || "none"}`,
          `Queued legacy jobs to cancel: ${jobLine(current.legacy.queued)}`,
          `Legacy jobs that drain: ${jobLine(current.legacy.draining)}`,
          ...current.blockers.map((blocker) => `Blocked: ${blocker}`),
        ].join("\n") };
      },
    }),
    "v2 set": cliCommand({
      summary: "Move an effort to its v2 roster with a parent thread, or back to legacy launchers",
      positionals: [{ name: "effort", description: "Effort id, key, or exact name", required: true, variadic: true }],
      options: {
        mode: { type: "enum", values: ["v2", "legacy"], required: true, description: "Execution mode" },
        revision: { type: "integer", min: 0, max: Number.MAX_SAFE_INTEGER, required: true, description: "The revision `v2 preview` showed" },
        parent: { type: "string", description: "A parent candidate's thread id from `v2 preview`" },
        "new-parent": { type: "boolean", description: "Start one new parent thread instead" },
        json: { type: "boolean", description: "Emit the result as JSON" },
      },
      constraints: [{ kind: "at-most-one", options: ["parent", "new-parent"] }],
      async run({ positionals, options }) {
        const parentThreadId = options["new-parent"] ? null : options.parent;
        let result: z.infer<typeof effortV2SetResultSchema>;
        try {
          result = await setMode({ effortId: effortArg(positionals.effort), mode: options.mode, expectedRevision: options.revision,
            ...(parentThreadId === undefined ? {} : { parentThreadId }) });
        } catch (error) {
          if (error instanceof PluginCliError) throw error;
          throw new PluginCliError(error instanceof Error ? error.message : String(error), { code: "v2_set_refused" });
        }
        return { exitCode: 0, stdout: options.json ? JSON.stringify(result) : [
          `${result.execution.mode === "v2" ? "Runs on its roster" : "Runs on legacy launchers"} (revision ${result.execution.revision}). Parent: ${result.parentThreadId ?? "none"}.`,
          ...(result.execution.mode === "v2" ? [`Cancelled: ${jobLine(result.cancelled)}. Draining: ${jobLine(result.draining)}.`] : []),
        ].join("\n") };
      },
    }),
  };
  /** A GitHub write that hit a rate limit holds every read too: when the write may run again, or null when the error is no rate limit. */
  const rateLimitedUntil = async (error: string) => await limit(error, deps.reconciler.now()) ? limitedUntil : null;
  return { handlers, commands, settle, planRow, criteria, reconciler: { run, tick, recoverAll, threadChanged, observed, due: markDue, readFull, rateLimitedUntil } };
}
