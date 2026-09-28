// Effort v2 surfaces: RPC methods and CLI commands that server.ts spreads into
// its single contract and CLI. The roster read writes only its own numbering,
// and a refresh only observes; neither starts, messages, or updates a thread,
// and neither writes to GitHub. Opting in only links or starts the parent
// thread and fences the roster's PRs from legacy launchers; it never changes
// membership, reparents a thread, or starts work.
//
// A numbered command is admitted in one step: code resolves it, plans each
// PR's next step with decide(), and commits the instruction revision, the rows
// that changed, and the acknowledgment together. Until the reconciler runs,
// every step is a plan: nothing launches, sends, or writes to GitHub.
//
// Rows that ask the same question share one numbered decision. An answer
// (`Dn …` or effort_decision_answer) applies only to the decision's revision its
// surface showed. It writes the next instruction revision with what it granted
// or declined, and re-plans only the PRs that asked, unless it took a PR out of
// the instruction.
import { PluginCliError, cliCommand } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { AdvanceJob } from "./bulk-advance.js";
import { capAcknowledgment, EFFECTS, formatTargets, interpretEffortCommand, WORK_RECIPES, type CommandResult, type CommandRow, type CommandTarget,
  type DecisionAnswer, type InstructionScope } from "./effort-command.js";
import { decide, PREPARED, type Attempt, type DecideInput, type Next, type RowDecision } from "./effort-phase.js";
import type { ResourceWriter } from "./effort-resources.js";
import { activeWriters, effortRoster, effortRosterSchema, observedFacts, rosterRowSchema, rosterTargets, rosterText, type EffortRoster, type RosterSources } from "./effort-roster.js";
import type { createEffortRosterStore } from "./effort-roster-store.js";
import { RECIPES } from "./effort-recipes.js";
import type { Admission, V2Execution } from "./effort-runner.js";
import type { EffortStore, EstablishedEffort } from "./effort-store.js";
import { decideAttempt, decisionId, holdsPr, sameBody, USER_STATES, type createEffortWorkStore, type Decision, type DecisionWrite, type Execution, type ExecutionMode, type RowWrite,
  type UserState, type WorkRow, type WorkRowBody } from "./effort-work-store.js";
import type { ModelChoice, ModelRole } from "./execution.js";
import { evidenceContract, pendingCriteria, stepPhrase, type ContractRow } from "./outcome-evidence.js";
import { prGates, type Gates } from "./pr-gates.js";
import { canonicalPrUrl, prHoldFor } from "./pr-holds.js";
import { prWorkItemKey } from "./work-item-index.js";

/** Realtime: `{ effortId, prUrl }` names the one row a refresh recomputed. */
export const EFFORT_ROSTER_CHANGED = "effort-roster-changed";

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
const commandResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("clarify"), message: z.string(), normalized: z.string().nullable() }),
  z.object({ kind: z.literal("admit"), normalized: z.string(), acknowledgment: z.array(z.string()),
    /** Outcome, Validated, Still needed, and Needs a decision; null with no active instruction. */
    rollup: z.array(z.string()).nullable(),
    /** The active instruction's revision after the command. */
    revision: z.number().nullable(),
    /** Ready rows whose fresh merge preview the surface opens; the command grants no merge. */
    mergePreviews: z.array(z.object({ target: z.string(), n: z.number().nullable() })) }),
]);
export type EffortCommandResult = z.infer<typeof commandResultSchema>;
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
  rollup: z.array(z.string()).nullable(),
});

export const effortV2Contract = {
  effort_roster_get: { input: z.object({ effortId: z.string().min(1).max(500) }).strict(), output: effortRosterSchema },
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
    decisions: z.array(shownDecisionSchema).max(1_000).optional() }).strict(), output: commandResultSchema },
  /**
   * Answer one decision by id, as the roster showed it at `expectedRevision`: an option, the row numbers a lifecycle
   * question applies to (empty for none), or your own words. The same as `Dn …` in a command.
   */
  effort_decision_answer: { input: z.object({ decisionId: z.string().min(1).max(600), optionId: z.string().min(1).max(100).optional(),
    numbers: z.array(z.number().int().positive()).max(1_000).optional(), text: z.string().min(1).max(4_000).optional(),
    expectedRevision: z.number().int().positive(), requestId: z.string().min(1).max(200) }).strict(), output: commandResultSchema },
  /** What the composer banner shows in an effort's parent thread; null in any other thread. */
  effort_parent_context: { input: z.object({ threadId: z.string().min(1).max(200) }).strict(), output: parentContextSchema.nullable() },
};

/** The one prompt a new parent receives: it holds rosters and decisions and takes no model turn beyond this reply. */
export const parentPrompt = (name: string) => `This is the effort parent thread for ${name}. Workstreams posts rosters and decisions here. Reply only: Ready.`;

/** A PR's step as decide() plans it, the row body recording it, and the user criteria it still lacks proof of. */
export type PlannedRow = { target: string; phase: Next["phase"]; step: Next; body: WorkRowBody; criteria: string[] };

/** The user state a step shows. Nothing performs a planned step until the reconciler runs, so it waits, marked as a plan. */
function shown(step: Next): Pick<WorkRowBody, "userState" | "modifiers"> {
  const userState: UserState = step.phase === "prepared" ? "ready" : step.phase === "finished" ? "done" : step.phase === "decision-needed" ? "decision"
    : step.phase === "repair-needed" ? step.modifiers.includes("recovering") ? "doing" : "issue" : step.phase === "executing" ? "doing" : "waiting";
  return { userState, modifiers: step.phase === "queued" || step.phase === "verifying" ? [...step.modifiers, "plan only"] : step.modifiers };
}

/** The row body recording a step, with the facts it was planned from. */
export function rowBody(step: Next, row: Pick<WorkRowBody, "n" | "retryEpoch" | "observedHead" | "observedAt" | "gates" | "tickets">): WorkRowBody {
  return { n: row.n, cause: step.cause, detail: step.detail, ...shown(step), nextAction: step.nextAction, owner: step.owner, wake: step.wake, decision: step.decision,
    recovery: step.recovery, offers: step.offers, retryEpoch: row.retryEpoch, observedHead: row.observedHead, observedAt: row.observedAt, gates: row.gates, tickets: row.tickets };
}

/**
 * Plan each PR's step from stored facts and our attempts on it. This reads no checkout or thread, so a launch plans
 * its recipes and leaves the checkout and thread to the reconciler's reads. No worker has reported, so no criterion
 * has proof yet.
 */
export function planRows(input: { effort: EstablishedEffort; mode: ExecutionMode; scope: InstructionScope | null; sources: RosterSources;
  models: Record<ModelRole, ModelChoice>; held(target: string): boolean; targets: readonly { target: string; n: number | null; retryEpoch: number }[];
  /** The open decision a PR asked, and the head it asked on. */
  open?(target: string): { decision: RowDecision; head: string | null } | null;
  /** Our attempts on a PR, newest first; none when absent. */
  attempts?(target: string): readonly Attempt[];
  /** Whether a new launch may start now; open when absent. */
  admission?: Admission;
  /** A writer found outside the board's facts, such as the holder of a claim that just failed. */
  writer?(target: string): ResourceWriter | null }): PlannedRow[] {
  const { sources, scope } = input;
  const read = input.targets.map(({ target, n, retryEpoch }) => {
    const observed = observedFacts(target, sources);
    const item = sources.work.items.get(target);
    const details = sources.tickets(item?.tickets ?? []);
    const tickets = (item?.tickets ?? []).map((id) => ({ id, title: details.get(id)?.title ?? null, url: details.get(id)?.url ?? null }));
    const feedback = sources.feedback(target);
    const gates = observed.full && prGates({ facts: observed.full.facts, observedAt: observed.full.at, now: sources.now, held: input.held(target), feedback, reviewers: observed.pr });
    const contract: ContractRow = { target, n, state: observed.facts?.state ?? null, heads: observed.facts?.headOid ? [observed.facts.headOid] : [],
      checkout: (item?.paths.length ?? 0) > 0, tickets, gates };
    return { target, n, retryEpoch, observed, item, tickets, feedback, gates, contract };
  });
  const included = new Set(scope?.include.map((grant) => prWorkItemKey(grant.target)));
  const pending = scope ? pendingCriteria(scope, read.filter((row) => included.has(row.target)).map((row) => row.contract), []) : new Map<string, string[]>();
  return read.map((row) => {
    const decideInput: DecideInput = { now: sources.now, target: row.target, effort: { id: input.effort.id, mode: input.mode, archived: Boolean(input.effort.archivedAt) },
      ownerId: sources.work.ownerForPr(row.target)?.id ?? null, instruction: scope, held: input.held(row.target), full: row.observed.full, feedback: row.feedback,
      reviewers: row.observed.pr, attempts: input.attempts?.(row.target) ?? [], codeActions: [], retryEpoch: row.retryEpoch, decision: null,
      declined: (scope?.answers ?? []).flatMap((answer) => answer.subkind && answer.declined.includes(row.target) ? [answer.subkind] : []),
      criteriaPending: (pending.get(row.target)?.length ?? 0) > 0, settledDependencies: new Set(), admission: input.admission ?? { capacityFull: false, breakerOpen: false },
      models: input.models,
      // No checkout is chosen yet, so every active writer counts against the PR.
      resources: { legacy: sources.legacy.get(row.target) ?? null, inspections: null,
        writers: [...activeWriters(row.target, row.item?.paths ?? [], sources).map(({ owner, ref }): ResourceWriter => ({ owner, ref, path: null })),
          ...[input.writer?.(row.target)].filter((writer) => writer != null)] } };
    let step = decide(decideInput);
    // An open decision holds its row while the facts that asked it are read again, so its number stays put. Once they are
    // read, decide() asks again only if the question still applies; a new head never inherits the old head's question.
    const open = step.nextAction === "observe" ? input.open?.(row.target) : null;
    if (open && open.head === (row.observed.facts?.headOid || null)) step = decide({ ...decideInput, decision: open.decision });
    return { target: row.target, phase: step.phase, step, criteria: pending.get(row.target) ?? [],
      body: rowBody(step, { n: row.n, retryEpoch: row.retryEpoch, observedHead: row.observed.facts?.headOid || null, observedAt: row.observed.full?.at ?? null,
        gates: row.gates, tickets: row.tickets }) };
  });
}

/** The evidence contract over the instruction's rows as stored, so the rollup reads exactly what the roster shows, naming each open decision by number. */
export function rowContract(effort: Pick<EstablishedEffort, "goal">, scope: InstructionScope, rows: readonly Pick<WorkRow, "target" | "phase" | "body">[], work: RosterSources["work"],
  decisions: readonly Pick<Decision, "n" | "key">[] = []) {
  const byTarget = new Map(rows.map((row) => [row.target, row]));
  return evidenceContract({ scope, goal: effort.goal, evidence: [], ordinal: (key) => decisions.find((decision) => decision.key === key)?.n ?? null, rows: scope.include.flatMap((grant) => {
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
    | "attempts" | "attempt" | "claims" | "release">;
  /**
   * v2 launches: the v2Execution setting, whether a new one may start now, reading one whose outcome is uncertain back from BB, and
   * whether this process is making one on a PR now.
   */
  launches: { execution(): Promise<V2Execution>; admission(): Promise<Admission>; recover(attemptId: string): Promise<void>; launching(target: string): boolean };
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
    return { rows: new Map(rows.map((row) => [row.target, row])), included: new Set(active?.scope.include.map((grant) => prWorkItemKey(grant.target))),
      active: active && { id: active.id, revision: active.revision, text: active.text, reportMode: active.scope.reportMode, outcome: active.scope.outcome },
      rollup: active ? rowContract(effort, active.scope, rows, sources.work, decisions).rollup : null,
      decisions: decisions.map(({ id, n, revision, body }) => ({ id, n, revision, kind: body.kind, subkind: body.subkind, question: body.question, options: body.options,
        targets: body.targets.map(({ target, n: number }) => ({ target, n: number })) })) };
  }
  async function roster(effortId: string): Promise<EffortRoster> {
    const { effort, redirectedFrom } = resolve(effortId);
    const sources = await deps.sources();
    return effortRoster({ effort, redirectedFrom, sources, number: (targets) => deps.numbers(effort.id, targets, { assign: true }), v2: instructionView(effort, sources) });
  }
  const queues = new Map<string, Promise<unknown>>();
  /** One command or event at a time per effort, so each plans from the rows the last one wrote. */
  function serial<T>(effortId: string, run: () => Promise<T>): Promise<T> {
    const next = (queues.get(effortId) ?? Promise.resolve()).then(run, run);
    queues.set(effortId, next.catch(() => undefined));
    return next;
  }
  /** Our attempts on a PR as decide() reads them; a claim `reset N release` drops is read as released. */
  function attemptsOf(target: string, released?: ReadonlySet<string>): Attempt[] {
    return deps.work.attempts(target).map(decideAttempt).map((attempt) => released?.has(target) && (attempt.status === "launching" || attempt.status === "uncertain")
      ? { ...attempt, status: "released" as const, releasedReason: "no-worker" as const } : attempt);
  }
  /**
   * Plan the included PRs and any row still open under the effort, the writes for the rows whose step changed, and the
   * decisions those writes ask or leave. A retry, reset, or answer starts a row's new epoch and makes it due now.
   * `change` plans one PR with other attempts, a writer, or an admission than the stored ones, as a launch about to claim sees them.
   */
  async function replan(effort: EstablishedEffort, scope: InstructionScope | null, sources: RosterSources,
    options: { held(target: string): boolean; retry: ReadonlySet<string>; only?: ReadonlySet<string>; decisions: readonly Decision[]; released?: ReadonlySet<string>;
      change?: { target: string; attempts: readonly Attempt[]; writer?: ResourceWriter; admission?: Admission } }) {
    const open = deps.work.rows(effort.id).filter((row) => row.phase !== "finished").map((row) => row.target);
    const numberOf = new Map([...deps.snapshots.issued(effort.id)].map(([n, target]) => [target, n]));
    // A row another effort holds is that effort's to plan, even while this instruction still names its PR.
    const stored = new Map([...new Set([...scope?.include.map((grant) => prWorkItemKey(grant.target)) ?? [], ...open])].map((target) => [target, deps.work.row(target)]));
    const targets = [...stored].filter(([, row]) => !row || row.effortId === effort.id || !holdsPr(row)).map(([target]) => target);
    // Another effort's row starts over here, number and epoch alike; this effort's row keeps its epoch unless a retry or reset starts a new one.
    const { change } = options;
    const planned = planRows({ effort, mode: deps.execution.get(effort.id).mode, scope, sources, models: await deps.models(), held: options.held,
      admission: change?.admission ?? await deps.launches.admission(),
      attempts: (target) => change?.target === target ? change.attempts : attemptsOf(target, options.released),
      writer: (target) => change?.target === target ? change.writer ?? null : null,
      targets: targets.map((target) => {
        const row = stored.get(target);
        const mine = row?.effortId === effort.id ? row : null;
        return { target, n: numberOf.get(target) ?? mine?.body.n ?? null, retryEpoch: (mine?.body.retryEpoch ?? 0) + (options.retry.has(target) ? 1 : 0) };
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
    });
  }
  /** One PR's row as a launch about to claim it would write it: planned from stored facts, with the attempts, writer, and admission the launch sees. */
  async function planRow(effortId: string, target: string, change: { attempts: readonly Attempt[]; writer?: ResourceWriter; admission?: Admission }) {
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
  /** A request to an effort, in its queue: a repeated request gets its first result, and a legacy effort takes none. */
  function request(effort: EstablishedEffort, requestId: string, run: () => Promise<EffortCommandResult>): Promise<EffortCommandResult> {
    return serial(effort.id, async () => {
      const replay = deps.work.command(effort.id, requestId);
      if (replay !== null) return commandResultSchema.parse(replay);
      if (deps.execution.get(effort.id).mode !== "v2") return refuse(`${effort.name} runs on legacy launchers. Move it to its roster before instructing it there.`);
      return run();
    });
  }
  async function command(input: z.infer<typeof effortV2Contract.effort_command.input>): Promise<EffortCommandResult> {
    const { effort } = resolve(input.effortId);
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
      return admit(effort, result, input, sources);
    });
  }
  /** Answer one decision as the roster showed it; a decision that changed since is read again first. */
  async function answer(input: z.infer<typeof effortV2Contract.effort_decision_answer.input>): Promise<EffortCommandResult> {
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
      return admit(effort, { kind: "admit", normalized: text, acknowledgment: [], instruction: null, cancel: false, holds: [], releases: [], interventions: [],
        recheckLaunches: false, postRoster: false, mergePreviews: [], answers: [reply] }, { requestId: input.requestId, text, source: "panel", snapshotId: null }, await deps.sources());
    });
  }
  /** Admit a read command in one commit: the revision its changes and answers write, its holds, and the rows whose step changed. */
  async function admit(effort: EstablishedEffort, result: Extract<CommandResult, { kind: "admit" }>,
    input: { requestId: string; text: string; source: "panel" | "banner"; snapshotId: string | null }, read: RosterSources): Promise<EffortCommandResult> {
    let sources = read;
    const active = deps.work.instruction(effort.id);
    const lastRevision = deps.work.lastRevision(effort.id);
    if (result.postRoster) return refuse("post roster arrives with parent-thread reports; open the roster instead. Nothing was admitted.");
    if (result.interventions.some((item) => item.action === "stop"))
      return refuse("stop N arrives with bounded repairs; until then, hold N lets the current turn finish and starts nothing new. Nothing was admitted.");
    if (effort.archivedAt && (result.instruction || result.answers.length)) return refuse(`Restore ${effort.name} before changing its instruction. Nothing was admitted.`);
    // A launch this process is still making settles its own claim when BB answers; releasing it first would let its worker start unrecorded.
    const making = result.interventions.filter((item) => item.release && deps.launches.launching(item.target));
    if (making.length) return refuse(`${formatTargets(making)}'s launch is still waiting on BB, and settles as running or uncertain on its own. `
      + `If it stays uncertain, send reset ${formatTargets(making)} release again. Nothing was admitted.`);
    // Answers amend what the rest of the command leaves, in the same revision.
    let scope = result.cancel ? null : result.instruction ?? active?.scope ?? null;
    const includeOf = (value: InstructionScope | null) => JSON.stringify(value?.include.map((grant) => grant.target));
    const before = includeOf(scope);
    const open = deps.work.decisions(effort.id);
    const answered: DecisionWrite[] = [];
    const answerLines: string[] = [];
    const asked = new Set<string>();
    for (const reply of result.answers) {
      const decision = open.find((item) => item.n === reply.decision);
      if (!decision || !scope) return refuse(`D${reply.decision} isn't an open decision.`);
      const applied = answerDecision(decision, reply, scope, lastRevision + 1);
      if ("clarify" in applied) return { kind: "clarify", message: `${applied.clarify} Nothing was admitted.`, normalized: result.normalized };
      scope = applied.scope;
      answered.push({ id: decision.id, n: decision.n, key: decision.key, status: "answered", expectedRevision: decision.revision,
        body: { ...decision.body, answer: applied.answer, answeredVia: input.source } });
      answerLines.push(`D${decision.n}: ${applied.answer}`);
      for (const target of applied.targets) asked.add(target);
    }
    // The revision holds the command's changes and its answers together.
    const revised = result.instruction !== null || answered.length > 0 ? scope : null;
    // Refresh and recheck read GitHub, the threads, and the checkouts first, and recheck launches reads BB back for each
    // unfinished launch; every other step plans from stored facts.
    const reads = new Map<string, Awaited<ReturnType<EffortV2Deps["observe"]>>>();
    for (const item of result.interventions) if (item.action === "refresh" || item.action === "recheck")
      reads.set(item.target, await observeOnce(item.target, sources.work.items.get(item.target)?.paths ?? []));
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
    const { planned, writes, decisions } = await replan(effort, scope, sources, { held, released, decisions: open.filter((item) => !answered.some((other) => other.id === item.id)),
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
      acknowledgment: capAcknowledgment([...result.acknowledgment, ...answerLines,
        ...result.interventions.filter((item) => item.action === "recheck").map((item) => recheckLine(item, reads.get(item.target)!, byTarget.get(item.target), sources)),
        ...result.recheckLaunches ? [`Readback: ${readback.join("; ") || "no launch is unfinished"}`] : [],
        ...next.length ? [`Next (planned; nothing runs until v2 execution is on): ${steps(next)}`] : []]),
      rollup: scope ? rowContract(effort, scope, planned, sources.work, after).rollup : null,
    };
    deps.work.commit({ effortId: effort.id, baseRevision: lastRevision, source: "command", rows: writes,
      instruction: result.cancel ? "cancel" : revised && { scope: revised, text: input.text,
        source: { kind: input.source, threadId: null, eventId: null }, snapshotId: input.snapshotId, requestId: input.requestId },
      // An answered decision closes before any row asks a new one.
      decisions: [...answered, ...decisions],
      journal: { requestId: input.requestId, text: input.text, result: answer },
      also: () => {
        for (const item of result.holds) deps.holds.set(item.target, true, item.reason);
        for (const item of result.releases) deps.holds.set(item.target, false);
        for (const target of released) deps.work.release(target);
      } });
    if (result.holds.length || result.releases.length) deps.holds.changed();
    deps.realtime.publish(EFFORT_ROSTER_CHANGED, { effortId: effort.id });
    return answer;
  }
  /** The banner's view of an effort parent thread: its counts, rollup, and the snapshot and revision a command there reads. */
  async function parentContext(threadId: string): Promise<z.infer<typeof parentContextSchema> | null> {
    const effort = deps.efforts.list().find((item) => item.coordinatorThreadId === threadId);
    if (!effort || deps.execution.get(effort.id).mode !== "v2") return null;
    const active = deps.work.instruction(effort.id);
    const included = new Set(active?.scope.include.map((grant) => prWorkItemKey(grant.target)));
    const rows = deps.work.rows(effort.id).filter((row) => included.has(row.target));
    const decisions = deps.work.decisions(effort.id);
    return { effort: { id: effort.id, key: effort.key, name: effort.name, archived: Boolean(effort.archivedAt) }, snapshotId: deps.snapshots.latest(effort.id),
      revision: active?.revision ?? null, lastRevision: deps.work.lastRevision(effort.id), decisions: decisions.map(({ n, revision }) => ({ n, revision })),
      counts: Object.fromEntries(USER_STATES.map((state) => [state, rows.filter((row) => row.body.userState === state).length])) as Record<UserState, number>,
      rollup: active ? rowContract(effort, active.scope, rows, (await deps.sources()).work, decisions).rollup : null };
  }
  const observing = new Map<string, ReturnType<EffortV2Deps["observe"]>>();
  /** Concurrent reads of one PR share one read. */
  function observeOnce(target: string, paths: readonly string[]): ReturnType<EffortV2Deps["observe"]> {
    let observed = observing.get(target);
    if (!observed) {
      observed = deps.observe(target, paths).finally(() => observing.delete(target));
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
    deps.realtime.publish(EFFORT_ROSTER_CHANGED, { effortId: effort.id, prUrl: target });
    const row = (await roster(effort.id)).rows.find((item) => item.target === target);
    // A full read keeps a PR placed after the board drops it, so a row leaves only when ownership moved or no read succeeded.
    if (!row) throw new Error(`That PR is no longer on this effort's roster${result.status === "failed" ? `: ${result.error}` : "."}`);
    return { ...result, row };
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
      return { execution, parentThreadId: parent.coordinatorThreadId, cancelled, draining: legacy.draining };
    } finally { changing.delete(effortId); }
  }
  const handlers = {
    effort_roster_get: ({ effortId }: { effortId: string }) => roster(effortId),
    effort_reconcile: ({ effortId, prUrl }: { effortId: string; prUrl: string }) => reconcile(effortId, prUrl),
    effort_v2_preview: ({ effortId }: { effortId: string }) => preview(effortId),
    effort_v2_set: setMode,
    effort_command: command,
    effort_decision_answer: answer,
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
  return { handlers, commands, settle, planRow };
}
