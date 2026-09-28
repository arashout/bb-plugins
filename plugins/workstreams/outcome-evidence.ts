// The outcome evidence contract (plan §2.11): what validation an instruction
// really needs before it is done. Code derives it from the stopping point's PR
// gates, the tickets the included PRs implement, and the user's `done when`
// lines. It is a projection over rows, accepted worker evidence, and current
// heads, so nothing is stored, and proof that still applies stays accepted
// without a worker or model turn. A ticket names a requirement and is never
// proof; a head change invalidates only that PR's head-bound proof.
import { formatTargets, type CommandTarget, type InstructionScope } from "./effort-command.js";
import type { Next } from "./effort-phase.js";
import type { GateId, Gates } from "./pr-gates.js";
import { prWorkItemKey } from "./work-item-index.js";

export type CriterionStatus = "satisfied" | "missing" | "invalidated" | "blocked";
/** An included PR as the contract reads it. */
export type ContractRow = CommandTarget & {
  /** Null until a read. */
  state: "OPEN" | "MERGED" | "CLOSED" | null;
  /** Heads whose proof applies: the current head, then earlier heads with the same tree. Empty until a read. */
  heads: readonly string[];
  /** A scanned checkout exists, so a criterion bound to the whole effort prefers this PR. */
  checkout: boolean;
  tickets: readonly { id: string; title: string | null }[];
  gates: Gates | null;
};
/** The row's current step, as decide() chose it; a stored row may add display modifiers. */
export type RowStep = Pick<Next, "phase" | "cause" | "nextAction" | "owner" | "wake" | "decision"> & { modifiers: readonly string[] };
/** One `criteria` entry of a worker report, bound to the head that report named. Newest first. */
export type CriterionEvidence = { criterion: string; target: string; headOid: string; outcome: "passed" | "failed" | "not-run";
  /** False when its report was rejected: kept as history, never proof. */
  accepted: boolean };
export type Criterion = {
  id: string; source: "gate" | "ticket" | "user"; label: string; status: CriterionStatus;
  /** Included PRs still short of it. */
  affected: CommandTarget[];
  /** What moves it next, who owns that, and what wakes it; null once satisfied. */
  next: { action: string; owner: string; wake: string } | null;
};
export type EvidenceContract = {
  criteria: Criterion[];
  /** Outcome, Validated, Still needed, and Needs a decision, in that order. */
  rollup: [string, string, string, string];
  /** Every included PR is Ready or finished and every criterion holds. Reported once; the instruction stays active, so a regression re-enters work. */
  outcomeValidated: boolean;
  /** Every included PR is finished and every user criterion held on its final head, which can't change again. */
  completed: boolean;
};

/** The stopping point's gate families. A draft waits under review: it can't be a merge candidate until it is marked ready. */
const FAMILIES: [id: string, label: string, gates: GateId[]][] = [
  ["branch", "branch current", ["no-conflict", "base-current"]],
  ["checks", "checks green", ["checks-green"]],
  ["feedback", "review feedback addressed", ["threads-resolved", "feedback-verified", "changes-addressed"]],
  ["review", "approved", ["approved", "rereview-requested", "not-draft"]],
  ["dependencies", "dependencies merged", ["parent-merged"]],
  ["merge", "mergeable", ["merge-clean"]],
];
const PROCEDURE: Record<Extract<Next["nextAction"], string>, string> = { observe: "read GitHub", attach: "worker running", "parse-report": "read the worker's report",
  "recover-launch": "recover the launch", "retry-turn": "retry the worker's turn" };
const OWNER: Record<NonNullable<Next["owner"]>["kind"], string> = { "v2-attempt": "v2 worker", "legacy-job": "legacy Advance", thread: "another thread",
  user: "you", github: "GitHub", reviewer: "reviewers", ci: "CI", pr: "another PR" };
const blocking = (step: RowStep) => step.phase === "decision-needed" || (step.phase === "repair-needed" && !step.modifiers.includes("recovering"));
/** Which short row moves a criterion first: a decision or system issue, then our own step, then a wait, then a pause or a closed PR. */
const rank = (step: RowStep) => blocking(step) ? 0 : ["queued", "verifying", "executing", "repair-needed"].includes(step.phase) ? 1 : step.phase === "waiting" ? 2 : 3;
const byNumber = (a: CommandTarget, b: CommandTarget) => (a.n ?? Infinity) - (b.n ?? Infinity);

/** One row's next step in a few words, who owns it, and what wakes it. */
export function stepPhrase(step: RowStep): { action: string; owner: string; wake: string } {
  const action = Array.isArray(step.nextAction) ? step.nextAction.join(" + ") : step.nextAction ? PROCEDURE[step.nextAction]
    : step.phase === "waiting" ? `wait: ${step.cause}` : step.phase === "paused" ? `paused: ${step.cause}`
    : step.phase === "decision-needed" ? `decide: ${step.decision?.question ?? step.cause}` : step.phase === "repair-needed" ? `system issue: ${step.cause}`
    : step.phase === "prepared" ? "merge through its fresh preview" : step.cause;
  const owner = step.owner === null ? step.phase === "finished" ? "you" : "v2"
    : step.owner.kind === "reviewer" && step.owner.ref ? step.owner.ref.split(",").map((login) => `@${login}`).join(" ")
    : step.owner.kind === "pr" && step.owner.ref ? step.owner.ref : OWNER[step.owner.kind];
  return { action, owner, wake: step.wake?.event ?? "a command that names it" };
}

/** The first short row's step, shared by every short row that has the same one; the rest are named after it. */
function nextFor(short: readonly (ContractRow & { step: RowStep })[]): Criterion["next"] {
  const ordered = [...short].sort((a, b) => rank(a.step) - rank(b.step) || byNumber(a, b));
  const first = stepPhrase(ordered[0]!.step);
  const same = ordered.filter((row) => JSON.stringify(stepPhrase(row.step)) === JSON.stringify(first));
  const others = ordered.filter((row) => !same.includes(row));
  return { ...first, action: `${first.action} (${formatTargets(same)})${others.length ? `; also ${formatTargets(others)}` : ""}` };
}

type Proof = "passed" | "failed" | "stale" | "none";
/** A criterion's newest accepted result on a head that still applies; earlier passing proof on an older head is stale. */
function proof(id: string, row: ContractRow, evidence: readonly CriterionEvidence[]): Proof {
  const mine = evidence.filter((item) => item.accepted && item.criterion === id && prWorkItemKey(item.target) === prWorkItemKey(row.target));
  const current = mine.find((item) => row.heads.includes(item.headOid) && item.outcome !== "not-run");
  if (current) return current.outcome as "passed" | "failed";
  return mine.some((item) => item.outcome === "passed") ? "stale" : "none";
}

type UserCriterion = InstructionScope["criteria"][number];
/**
 * The rows a user criterion needs proof on: its numbers, or for the whole
 * effort, the row already proving it, else the lowest-numbered PR not yet
 * merged or closed, preferring one with a checkout; without one, resource
 * selection makes a worktree. `left` names bound numbers no longer in the instruction.
 */
function assigned<T extends ContractRow>(criterion: UserCriterion, rows: readonly T[], evidence: readonly CriterionEvidence[]): { rows: T[]; left: number[] } {
  if (criterion.binding.kind === "targets") {
    const found = criterion.binding.n.map((n) => rows.find((row) => row.n === n));
    return { rows: found.filter((row) => row !== undefined), left: criterion.binding.n.filter((_, index) => !found[index]) };
  }
  const proving = rows.find((row) => proof(criterion.id, row, evidence) === "passed");
  const open = rows.filter((row) => row.state !== "MERGED" && row.state !== "CLOSED").sort((a, b) => Number(b.checkout) - Number(a.checkout) || byNumber(a, b))[0];
  return { rows: proving ? [proving] : open ? [open] : [], left: [] };
}

/** The user criteria each included PR still lacks accepted proof of on its current head, by PR: decide()'s criteriaPending, and the work order's criteria. */
export function pendingCriteria(scope: InstructionScope, rows: readonly ContractRow[], evidence: readonly CriterionEvidence[]): Map<string, string[]> {
  const pending = new Map<string, string[]>();
  for (const criterion of scope.criteria.filter((item) => item.droppedInRevision === null))
    for (const row of assigned(criterion, rows, evidence).rows) if (proof(criterion.id, row, evidence) !== "passed") {
      const key = prWorkItemKey(row.target);
      pending.set(key, [...pending.get(key) ?? [], criterion.id]);
    }
  return pending;
}

/** The contract for the included PRs (`rows`), each with its current step. Pure: no reads, no model, no SDK. */
export function evidenceContract(input: { scope: InstructionScope; goal: string; rows: readonly (ContractRow & { step: RowStep })[]; evidence: readonly CriterionEvidence[];
  /** The number of the open decision a question belongs to, so the rollup names it the way an answer does. */
  ordinal?(key: string): number | null }): EvidenceContract {
  const { scope, rows, evidence } = input;
  const finished = (row: ContractRow) => row.state === "MERGED" || row.state === "CLOSED";
  const fromRows = (id: string, source: Criterion["source"], label: string, short: readonly (ContractRow & { step: RowStep })[]): Criterion => ({
    id, source, label, status: short.length === 0 ? "satisfied" : short.some((row) => blocking(row.step)) ? "blocked" : "missing",
    affected: short.map(({ target, n }) => ({ target, n })).sort(byNumber), next: short.length ? nextFor(short) : null,
  });

  // A family holds once every included PR passes its gates or is finished; an unread PR can't prove one.
  const gates = FAMILIES.map(([id, label, family]) => fromRows(id, "gate", label, rows.filter((row) => !finished(row)
    && (row.gates === null || family.some((gate) => row.gates![gate] !== true) || (id === "dependencies" && row.step.phase === "waiting" && row.step.cause === "dependency")))));
  // A ticket holds once every included PR implementing it is Ready or merged; the ticket itself proves nothing.
  const tickets = [...new Map(rows.flatMap((row) => row.tickets.map((ticket) => [ticket.id, ticket] as const))).values()].sort((a, b) => a.id.localeCompare(b.id))
    .map((ticket) => fromRows(`ticket:${ticket.id}`, "ticket", ticket.title ? `${ticket.id} ${ticket.title}` : ticket.id,
      rows.filter((row) => row.tickets.some((item) => item.id === ticket.id) && row.state !== "MERGED" && row.step.phase !== "prepared")));
  const users = scope.criteria.filter((item) => item.droppedInRevision === null).map((criterion): Criterion => {
    const { rows: bound, left } = assigned(criterion, rows, evidence);
    const base = { id: criterion.id, source: "user" as const, label: criterion.text };
    if (left.length) return { ...base, status: "missing", affected: [],
      next: { action: `${left.join(", ")} left the instruction: include ${left.length === 1 ? "it" : "them"} again, or drop ${criterion.id}`, owner: "you", wake: "a command" } };
    if (bound.length === 0) return { ...base, status: "missing", affected: [],
      next: { action: "no included PR is open to validate it in", owner: "you", wake: "a command that includes an open one" } };
    const short = bound.map((row) => ({ row, proof: proof(criterion.id, row, evidence) })).filter((item) => item.proof !== "passed");
    if (short.length === 0) return { ...base, status: "satisfied", affected: [], next: null };
    const failed = short.find((item) => item.proof === "failed" && !blocking(item.row.step));
    return { ...base, affected: short.map(({ row }) => ({ target: row.target, n: row.n })).sort(byNumber),
      status: short.some((item) => item.proof === "failed" || blocking(item.row.step)) ? "blocked" : short.some((item) => item.proof === "stale") ? "invalidated" : "missing",
      // A failed criterion needs your call; otherwise it rides the PR's next step, which runs validate_criteria when nothing else is due.
      next: failed ? { action: `authorize a fix on ${formatTargets([failed.row])}, or drop ${criterion.id}`, owner: "you", wake: "your answer" } : nextFor(short.map((item) => item.row)) };
  });
  const criteria = [...gates, ...tickets, ...users];

  const name = (criterion: Criterion) => criterion.source === "ticket" ? criterion.id.slice("ticket:".length) : criterion.id;
  /** Many tickets compress to a count. */
  const names = (list: readonly Criterion[]) => {
    const ticketCount = list.filter((item) => item.source === "ticket").length;
    return [...list.filter((item) => item.source !== "ticket" || ticketCount <= 3).map(name), ...ticketCount > 3 ? [`${ticketCount} tickets`] : []].join(", ");
  };
  const satisfied = criteria.filter((item) => item.status === "satisfied");
  const satisfiedGates = satisfied.filter((item) => item.source === "gate");
  const validated = [
    satisfiedGates.length ? `${satisfiedGates.map((item) => item.label).join(", ")} on ${rows.length} PRs` : null,
    satisfied.some((item) => item.source === "ticket") ? `tickets ${names(satisfied.filter((item) => item.source === "ticket"))}` : null,
    ...satisfied.filter((item) => item.source === "user").map((item) => `${item.label} (${item.id})`),
  ].filter((segment) => segment !== null);
  const short = new Map<string, Criterion[]>();
  for (const item of criteria.filter((criterion) => criterion.next && criterion.source !== "ticket")) {
    const key = JSON.stringify(item.next);
    short.set(key, [...short.get(key) ?? [], item]);
  }
  // A ticket's next step is its PRs' steps, so the rollup names the tickets once and points at their PRs.
  const shortTickets = criteria.filter((item) => item.next && item.source === "ticket");
  const ticketPrs = [...new Map(shortTickets.flatMap((item) => item.affected).map((target) => [target.target, target])).values()].sort(byNumber);
  const decisions = new Map<string, { question: string; rows: CommandTarget[] }>();
  for (const row of rows) if (row.step.phase === "decision-needed" && row.step.decision) {
    const n = input.ordinal?.(row.step.decision.key) ?? null;
    const decision = decisions.get(row.step.decision.key) ?? { question: `${n ? `D${n} ` : ""}${row.step.decision.question}`, rows: [] };
    decisions.set(row.step.decision.key, { ...decision, rows: [...decision.rows, row] });
  }
  return {
    criteria,
    rollup: [
      `Outcome: ${scope.outcome ?? (input.goal.trim() || "none set; add one with outcome: …")} · ${rows.length} PRs${rows.length ? `: ${formatTargets([...rows].sort(byNumber))}` : ""}`,
      `Validated: ${validated.join("; ") || "nothing yet"}`,
      `Still needed: ${[...[...short.values()].map((list) => `${names(list)}: ${list[0]!.next!.action} · ${list[0]!.next!.owner} · wake: ${list[0]!.next!.wake}`),
        ...shortTickets.length ? [`${names(shortTickets)}: their PRs (${formatTargets(ticketPrs)})`] : []].join("; ") || "nothing"}`,
      `Needs a decision: ${[...decisions.values()].map((item) => `${item.question} (${formatTargets(item.rows)})`).join("; ") || "none"}`,
    ],
    outcomeValidated: rows.length > 0 && rows.every((row) => row.step.phase === "prepared" || row.step.phase === "finished") && satisfied.length === criteria.length,
    completed: rows.length > 0 && rows.every((row) => row.step.phase === "finished") && users.every((item) => item.status === "satisfied"),
  };
}
