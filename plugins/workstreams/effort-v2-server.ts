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
import { PluginCliError, cliCommand } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { AdvanceJob } from "./bulk-advance.js";
import { capAcknowledgment, formatTargets, interpretEffortCommand, type CommandRow, type CommandTarget, type InstructionScope } from "./effort-command.js";
import { decide, PREPARED, type Next } from "./effort-phase.js";
import type { ResourceWriter } from "./effort-resources.js";
import { activeWriters, effortRoster, effortRosterSchema, observedFacts, rosterRowSchema, rosterTargets, rosterText, type EffortRoster, type RosterSources } from "./effort-roster.js";
import type { createEffortRosterStore } from "./effort-roster-store.js";
import { RECIPES } from "./effort-recipes.js";
import type { EffortStore, EstablishedEffort } from "./effort-store.js";
import { holdsPr, USER_STATES, type createEffortWorkStore, type Execution, type ExecutionMode, type UserState, type WorkRow, type WorkRowBody } from "./effort-work-store.js";
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
  /** Nothing executes for a v2 effort until the reconciler ships, so execution is always a dry run. */
  v2Execution: z.literal("dry-run"),
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
const parentContextSchema = z.object({
  effort: z.object({ id: z.string(), key: z.string(), name: z.string(), archived: z.boolean() }),
  /** The snapshot a command typed here resolves its numbers against. */
  snapshotId: z.string().nullable(),
  revision: z.number().nullable(), lastRevision: z.number(),
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
  /** One numbered command against the snapshot the surface rendered; `expectedRevision` is the instruction revision it showed. */
  effort_command: { input: z.object({ effortId: z.string().min(1).max(500), snapshotId: z.string().max(100).nullable(), text: z.string().min(1).max(4_000),
    requestId: z.string().min(1).max(200), source: z.enum(["panel", "banner"]), expectedRevision: z.number().int().nonnegative().optional() }).strict(), output: commandResultSchema },
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

/**
 * Plan each PR's step from stored facts. Slice 2 reads no checkout or thread, so a launch plans its recipes and
 * leaves the checkout and thread to the reconciler's reads. No worker has reported, so no criterion has proof yet.
 */
export function planRows(input: { effort: EstablishedEffort; mode: ExecutionMode; scope: InstructionScope | null; sources: RosterSources;
  models: Record<ModelRole, ModelChoice>; held(target: string): boolean; targets: readonly { target: string; n: number | null; retryEpoch: number }[] }): PlannedRow[] {
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
    const step = decide({ now: sources.now, target: row.target, effort: { id: input.effort.id, mode: input.mode, archived: Boolean(input.effort.archivedAt) },
      ownerId: sources.work.ownerForPr(row.target)?.id ?? null, instruction: scope, held: input.held(row.target), full: row.observed.full, feedback: row.feedback,
      reviewers: row.observed.pr, attempts: [], codeActions: [], retryEpoch: row.retryEpoch, decision: null, declined: [],
      criteriaPending: (pending.get(row.target)?.length ?? 0) > 0, settledDependencies: new Set(), admission: { capacityFull: false, breakerOpen: false }, models: input.models,
      // No checkout is chosen yet, so every active writer counts against the PR.
      resources: { legacy: sources.legacy.get(row.target) ?? null, inspections: null,
        writers: activeWriters(row.target, row.item?.paths ?? [], sources).map(({ owner, ref }): ResourceWriter => ({ owner, ref, path: null })) } });
    return { target: row.target, phase: step.phase, step, criteria: pending.get(row.target) ?? [],
      body: { n: row.n, cause: step.cause, detail: step.detail, ...shown(step), nextAction: step.nextAction, owner: step.owner, wake: step.wake, decision: step.decision,
        recovery: step.recovery, offers: step.offers, retryEpoch: row.retryEpoch, observedHead: row.observed.facts?.headOid || null,
        observedAt: row.observed.full?.at ?? null, gates: row.gates, tickets: row.tickets } };
  });
}

/** The evidence contract over the instruction's rows as stored, so the rollup reads exactly what the roster shows. */
export function rowContract(effort: Pick<EstablishedEffort, "goal">, scope: InstructionScope, rows: readonly Pick<WorkRow, "target" | "phase" | "body">[], work: RosterSources["work"]) {
  const byTarget = new Map(rows.map((row) => [row.target, row]));
  return evidenceContract({ scope, goal: effort.goal, evidence: [], rows: scope.include.flatMap((grant) => {
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

/** A stable form for comparing row bodies, ignoring when the row next falls due. */
const comparable = (body: WorkRowBody) => JSON.stringify({ ...body, wake: body.wake && { ...body.wake, dueAt: 0 } },
  (_key, value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);

export type EffortV2Deps = {
  efforts: Pick<EffortStore, "get" | "getRecord" | "list">;
  numbers: ReturnType<typeof createEffortRosterStore>["numbers"];
  snapshots: Pick<ReturnType<typeof createEffortRosterStore>, "snapshot" | "issued" | "latest">;
  work: Pick<ReturnType<typeof createEffortWorkStore>, "instruction" | "lastRevision" | "rows" | "row" | "command" | "commit">;
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
    return { rows: new Map(rows.map((row) => [row.target, row])), included: new Set(active?.scope.include.map((grant) => prWorkItemKey(grant.target))),
      active: active && { id: active.id, revision: active.revision, text: active.text, reportMode: active.scope.reportMode, outcome: active.scope.outcome },
      rollup: active ? rowContract(effort, active.scope, rows, sources.work).rollup : null };
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
  /** Plan the included PRs and any row still open under the effort, and the writes for the rows whose step changed. */
  async function replan(effort: EstablishedEffort, scope: InstructionScope | null, sources: RosterSources,
    options: { held(target: string): boolean; retry: ReadonlySet<string>; only?: ReadonlySet<string> }) {
    const open = deps.work.rows(effort.id).filter((row) => row.phase !== "finished").map((row) => row.target);
    const numberOf = new Map([...deps.snapshots.issued(effort.id)].map(([n, target]) => [target, n]));
    // A row another effort holds is that effort's to plan, even while this instruction still names its PR.
    const stored = new Map([...new Set([...scope?.include.map((grant) => prWorkItemKey(grant.target)) ?? [], ...open])].map((target) => [target, deps.work.row(target)]));
    const targets = [...stored].filter(([, row]) => !row || row.effortId === effort.id || !holdsPr(row)).map(([target]) => target);
    // Another effort's row starts over here, number and epoch alike; this effort's row keeps its epoch unless a retry or reset starts a new one.
    const planned = planRows({ effort, mode: deps.execution.get(effort.id).mode, scope, sources, models: await deps.models(), held: options.held,
      targets: targets.map((target) => {
        const row = stored.get(target);
        const mine = row?.effortId === effort.id ? row : null;
        return { target, n: numberOf.get(target) ?? mine?.body.n ?? null, retryEpoch: (mine?.body.retryEpoch ?? 0) + (options.retry.has(target) ? 1 : 0) };
      }) });
    // Every row is planned, so a criterion bound to the whole effort still lands on its lowest-numbered PR; `only` limits the writes.
    const writes = planned.flatMap((row) => {
      if (options.only && !options.only.has(row.target)) return [];
      const current = stored.get(row.target);
      if (current?.effortId === effort.id && current.phase === row.phase && comparable(current.body) === comparable(row.body)) return [];
      return [{ target: row.target, expectedRevision: current?.revision ?? 0, phase: row.phase, body: row.body, dueAt: row.step.wake?.dueAt ?? null }];
    });
    return { planned, writes };
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
      const { writes } = await replan(effort, deps.work.instruction(effort.id)?.scope ?? null, sources,
        { held: (target) => prHoldFor(target, sources.holds) !== null, retry: new Set(), ...only ? { only } : {} });
      if (writes.length === 0) return;
      deps.work.commit({ effortId: effort.id, baseRevision: lastRevision, source, rows: writes, instruction: null, journal: null });
      deps.realtime.publish(EFFORT_ROSTER_CHANGED, { effortId: effort.id });
    });
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
    return { finished: facts !== null && facts.state !== "OPEN", teammate: !deps.authored(target), issue: row?.body.userState === "issue",
      stopped: row?.phase === "paused" && ["stopped", "user-cancelled"].includes(row.body.cause), claim: null };
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
  async function command(input: z.infer<typeof effortV2Contract.effort_command.input>): Promise<EffortCommandResult> {
    const { effort } = resolve(input.effortId);
    return serial(effort.id, async () => {
      const replay = deps.work.command(effort.id, input.requestId);
      if (replay !== null) return commandResultSchema.parse(replay);
      const refuse = (message: string): EffortCommandResult => ({ kind: "clarify", message, normalized: null });
      if (deps.execution.get(effort.id).mode !== "v2") return refuse(`${effort.name} runs on legacy launchers. Move it to its roster before instructing it there.`);
      let sources = await deps.sources();
      const active = deps.work.instruction(effort.id);
      const lastRevision = deps.work.lastRevision(effort.id);
      const issued = deps.snapshots.issued(effort.id);
      const known = new Set([...issued.values(), ...active?.scope.include.map((grant) => prWorkItemKey(grant.target)) ?? []]);
      const result = interpretEffortCommand(input.text, {
        effortId: effort.id, snapshot: input.snapshotId === null ? null : deps.snapshots.snapshot(input.snapshotId), issued,
        rows: new Map([...known].map((target) => [target, commandRow(target, sources)])), holds: sources.holds,
        instruction: active?.scope ?? null, lastRevision, decisions: [], ...input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision },
        ownerOf: (target) => ownerOf(target, sources),
      });
      if (result.kind === "clarify") return result;
      if (result.postRoster) return refuse("post roster arrives with parent-thread reports; open the roster instead. Nothing was admitted.");
      if (effort.archivedAt && result.instruction) return refuse(`Restore ${effort.name} before changing its instruction. Nothing was admitted.`);
      // Refresh and recheck read GitHub, the threads, and the checkouts first; every other step plans from stored facts.
      const reads = new Map<string, Awaited<ReturnType<EffortV2Deps["observe"]>>>();
      for (const item of result.interventions) if (item.action === "refresh" || item.action === "recheck")
        reads.set(item.target, await observeOnce(item.target, sources.work.items.get(item.target)?.paths ?? []));
      if (reads.size) sources = await deps.sources();
      const held = (target: string) => result.holds.some((item) => item.target === target)
        || (!result.releases.some((item) => item.target === target) && prHoldFor(target, sources.holds) !== null);
      const scope = result.cancel ? null : result.instruction ?? active?.scope ?? null;
      const { planned, writes } = await replan(effort, scope, sources,
        { held, retry: new Set(result.interventions.filter((item) => item.action === "reset" || item.action === "retry").map((item) => item.target)) });
      const byTarget = new Map(planned.map((row) => [row.target, row]));
      const included = new Set(scope?.include.map((grant) => prWorkItemKey(grant.target)));
      const touched = new Set([...result.holds, ...result.releases, ...result.interventions].map((item) => item.target));
      const next = planned.filter((row) => included.has(row.target) && (result.instruction !== null || touched.has(row.target)));
      const answer: EffortCommandResult = {
        kind: "admit", normalized: result.normalized, revision: scope?.revision ?? null, mergePreviews: result.mergePreviews,
        acknowledgment: capAcknowledgment([...result.acknowledgment,
          ...result.interventions.filter((item) => item.action === "recheck").map((item) => recheckLine(item, reads.get(item.target)!, byTarget.get(item.target), sources)),
          ...next.length ? [`Next (planned; nothing runs until v2 execution is on): ${steps(next)}`] : []]),
        rollup: scope ? rowContract(effort, scope, planned, sources.work).rollup : null,
      };
      deps.work.commit({ effortId: effort.id, baseRevision: lastRevision, source: "command", rows: writes,
        instruction: result.cancel ? "cancel" : result.instruction && { scope: result.instruction, text: input.text,
          source: { kind: input.source, threadId: null, eventId: null }, snapshotId: input.snapshotId, requestId: input.requestId },
        journal: { requestId: input.requestId, text: input.text, result: answer },
        also: () => {
          for (const item of result.holds) deps.holds.set(item.target, true, item.reason);
          for (const item of result.releases) deps.holds.set(item.target, false);
        } });
      if (result.holds.length || result.releases.length) deps.holds.changed();
      deps.realtime.publish(EFFORT_ROSTER_CHANGED, { effortId: effort.id });
      return answer;
    });
  }
  /** The banner's view of an effort parent thread: its counts, rollup, and the snapshot and revision a command there reads. */
  async function parentContext(threadId: string): Promise<z.infer<typeof parentContextSchema> | null> {
    const effort = deps.efforts.list().find((item) => item.coordinatorThreadId === threadId);
    if (!effort || deps.execution.get(effort.id).mode !== "v2") return null;
    const active = deps.work.instruction(effort.id);
    const included = new Set(active?.scope.include.map((grant) => prWorkItemKey(grant.target)));
    const rows = deps.work.rows(effort.id).filter((row) => included.has(row.target));
    return { effort: { id: effort.id, key: effort.key, name: effort.name, archived: Boolean(effort.archivedAt) }, snapshotId: deps.snapshots.latest(effort.id),
      revision: active?.revision ?? null, lastRevision: deps.work.lastRevision(effort.id),
      counts: Object.fromEntries(USER_STATES.map((state) => [state, rows.filter((row) => row.body.userState === state).length])) as Record<UserState, number>,
      rollup: active ? rowContract(effort, active.scope, rows, (await deps.sources()).work).rollup : null };
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
    const summary: EffortV2Preview = {
      effort: { id: effort.id, key: effort.key, name: effort.name, coordinatorThreadId: effort.coordinatorThreadId },
      execution, v2Execution: "dry-run", blockers,
      consequence: execution.mode === "v2" ? "Legacy Advance and dispatch apply to this effort again. Every v2 record is kept."
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
  return { handlers, commands, settle };
}
