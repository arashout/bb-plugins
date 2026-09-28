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
import { cheapSignature, type StoredPrFacts } from "./effort-roster-store.js";
import type { EstablishedEffort } from "./effort-store.js";
import { USER_STATES, type WorkRow } from "./effort-work-store.js";
import { prTarget } from "./ghactions.js";
import type { PrObservation } from "./inventory-store.js";
import type { LegacyAttempt } from "./legacy-history.js";
import { checksFailed, checksGreen } from "./pr-checks.js";
import { GATE_IDS, mergeWait, prGates, type GateId, type Gates } from "./pr-gates.js";
import { prHoldFor, prHoldSchema, type PrHolds } from "./pr-holds.js";
import type { Run } from "./runs.js";
import type { ThreadFacts } from "./threads.js";
import { prWorkItemKey } from "./work-item-index.js";
import { displayTitle } from "./workstreams.js";

const ticketSchema = z.object({ id: z.string(), title: z.string().nullable(), url: z.string().nullable() });
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
});
export const effortRosterSchema = z.object({
  effort: z.object({ id: z.string(), key: z.string(), name: z.string(), goal: z.string(), archivedAt: z.number().nullable(),
    redirectedFrom: z.string().nullable(), coordinatorThreadId: z.string().nullable() }),
  snapshotId: z.string().nullable(),
  instruction: z.object({ id: z.string(), revision: z.number(), text: z.string(), reportMode: z.string(), outcome: z.string().nullable() }).nullable(),
  /** Outcome, Validated, Still needed, and Needs a decision; null without an active instruction. */
  rollup: z.array(z.string()).nullable(),
  observedAt: z.number(),
  rows: z.array(rosterRowSchema),
  issues: z.array(z.object({ cause: z.string(), label: z.string(), numbers: z.array(z.number()) })),
  ticketsWithoutPrs: z.array(ticketSchema),
  /** Derived board groups that already reach into this roster: suggestions, never membership. */
  suggestions: z.array(z.object({ key: z.string(), name: z.string(), tickets: z.array(z.string()), prUrls: z.array(z.string()), overlap: z.array(z.string()) })),
  /** Legacy job rows behind these PRs: why Advance's counts exceed the roster's. */
  history: z.object({ legacyJobs: z.number(), legacyPrs: z.number() }),
  /** Open decisions, one per real choice, each answered by `Dn …` or effort_decision_answer at its revision. */
  decisions: z.array(z.object({ id: z.string(), n: z.number(), revision: z.number(), kind: z.string(), subkind: z.enum(["mark-ready", "request-review"]).nullable(),
    question: z.string(), options: z.array(z.object({ id: z.string(), label: z.string() })), targets: z.array(z.object({ target: z.string(), n: z.number().nullable() })) })),
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
/** The effort's v2 rows, by PR, and the PRs its active instruction includes. */
export type RosterInstruction = { rows: ReadonlyMap<string, WorkRow>; included: ReadonlySet<string> };

function rosterRow(target: string, number: { n: number; provisional: boolean }, sources: RosterSources, instruction: RosterInstruction | null, outside: ReadonlySet<string>): RosterRow {
  const item = sources.work.items.get(target);
  const checkouts = [...item?.paths ?? []];
  const hold = prHoldFor(target, sources.holds);
  const legacy = sources.legacy.get(target) ?? null;
  const { pr, observation, cheapAt, stored, full, facts } = observedFacts(target, sources);
  // A PR the instruction let go (dropped, superseded, or cancelled) shows its observed need again.
  const work = instruction?.rows.get(target);
  const current = work && (work.phase !== "finished" || ["merged", "closed"].includes(work.body.cause)) ? work : null;
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
  return {
    ...shown, modifiers, outsideMembership: outside.has(target),
    n: number.n, provisional: number.provisional, target, repo: parsed?.slug ?? "", number: parsed?.number ?? 0,
    title: facts ? displayTitle(facts.title) : "", hold, reviewers: pr?.latestReviews ?? [], requested: pr?.reviewRequests ?? [],
    head: facts?.headOid || null, checks: facts?.checks ?? null, reviewDecision: facts?.reviewDecision ?? null, gates,
    observedAt: latest(cheapAt, full?.at), failedAt: latest(observation?.failedAt ? Date.parse(observation.failedAt) : null, stored?.failedAt),
    tickets: (item?.tickets ?? []).map((id) => ({ id, title: tickets.get(id)?.title ?? null, url: tickets.get(id)?.url ?? null })),
    checkouts, legacy: legacy && { batchId: legacy.batchId, jobId: legacy.job.id, cause: legacy.cause, label: legacy.label, jobs: legacy.jobs },
  };
}

export function effortRoster(input: {
  effort: EstablishedEffort; redirectedFrom: string | null; sources: RosterSources;
  /** Numbers the targets in display order; see the roster store. */
  number(targets: string[]): { rows: { n: number; target: string; provisional: boolean }[]; snapshotId: string | null };
  /** The active instruction, its rows, its rollup, and its open decisions; absent for a legacy effort or a copy without them. */
  v2?: RosterInstruction & { active: EffortRoster["instruction"]; rollup: string[] | null; decisions: EffortRoster["decisions"] };
}): EffortRoster {
  const { effort, sources, v2 = null } = input;
  const owned = new Set(rosterTargets(effort, sources.work));
  // Ownership is read now: a PR included from outside that later joins the effort is simply a member.
  const outside = new Set([...v2?.included ?? []].filter((target) => !owned.has(target)));
  const numbered = input.number(rosterTargets(effort, sources.work, [...outside]));
  const rows = numbered.rows.map((row) => rosterRow(row.target, row, sources, v2, outside)).sort((a, b) => a.n - b.n);
  const issues = new Map<string, EffortRoster["issues"][number]>();
  for (const row of rows) if (row.state === "issue") {
    const issue = issues.get(row.cause) ?? { cause: row.cause, label: row.label, numbers: [] };
    issue.numbers.push(row.n);
    issues.set(row.cause, issue);
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
    snapshotId: numbered.snapshotId, instruction: v2?.active ?? null, rollup: v2?.rollup ?? null, observedAt: sources.now, rows, issues: [...issues.values()],
    ticketsWithoutPrs: uncovered.map((id) => ({ id, title: details.get(id)?.title ?? null, url: details.get(id)?.url ?? null })),
    suggestions, history: { legacyJobs: legacy.reduce((sum, jobs) => sum + jobs, 0), legacyPrs: legacy.length }, decisions: v2?.decisions ?? [],
  };
}

/** The numbered plain list the CLI prints: `n · repo #num · reviewer · summary · state · next`. */
export function rosterText(roster: EffortRoster): string {
  const { effort } = roster;
  const state = { doing: "Doing", waiting: "Waiting", decision: "Needs your decision", ready: "Ready", issue: "System issue", done: "Done",
    "not-in-instruction": "Not in instruction" } satisfies Record<RosterState, string>;
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
