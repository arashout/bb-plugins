// The effort deck's read model (plan amendment A15): the active pile of effort
// cards, the On hold and Done piles, and the Unclassified deck. Pure: the
// server gathers the inventory's rows and what the board keeps about each
// effort. This places every row in one section by the move it needs, words it
// as the inventory does, counts Needs you with deck-shared.ts's one rule, and
// sums each card from its rows, merges, Linear details, and threads.
import { z } from "zod";
import type { Pr } from "./contract.js";
import { ACTED_MS, DECK_SECTIONS, needsYou, type DeckSection, type RowActed } from "./deck-shared.js";
import { suggestionGroupSchema, type SuggestionGroup } from "./effort-classify.js";
import { EFFORT_PILES, type EffortPileState } from "./effort-piles.js";
import type { InventoryRow } from "./inventory-view.js";
import { inventoryLine, type ActionId } from "./inventory-view-model.js";
import type { LinearDetail } from "./linear.js";
import type { Criterion } from "./outcome-evidence.js";

/** Merged this week, and how far back recent activity reaches. */
const WEEK_MS = 7 * 86_400_000;

const waitSchema = z.object({
  kind: z.enum(["parent", "decision", "hold"]),
  /** Who or what it waits on: the PR it's stacked on, the decision, or you, for a hold. */
  on: z.string(),
  /** What, in a few words: the parent merging first, the decision's question, or the hold's reason. */
  what: z.string(),
  since: z.number().nullable(),
}).strict();
export const deckRowSchema = z.object({
  prUrl: z.string(), repo: z.string(), number: z.number(), title: z.string(), draft: z.boolean().nullable(),
  section: z.enum(DECK_SECTIONS),
  /** The inventory's state word. */
  status: z.string(),
  /** The next step, who takes it (you, reviewers, or #N), and since when, as the inventory row states it. */
  step: z.object({ text: z.string(), owner: z.string(), since: z.number().nullable() }).strict().nullable(),
  waitsOn: waitSchema.nullable(),
  reviewers: z.array(z.object({ login: z.string(), state: z.string() }).strict()),
  /** Whom Request review asks first, and whom Nudge asks again. */
  suggested: z.array(z.string()), nudge: z.array(z.string()),
  /** Approval comments waiting for your confirmation. */
  notes: z.number(),
  tickets: z.array(z.string()),
  stackedOn: z.number().nullable(),
  thread: z.object({ id: z.string(), title: z.string(), active: z.boolean() }).strict().nullable(),
  hold: z.object({ reason: z.string(), since: z.number() }).strict().nullable(),
  /** The v2 roster that manages it. */
  managed: z.string().nullable(),
  /** When GitHub last answered for it; `failed` when its last read didn't. */
  checkedAt: z.string().nullable(), failed: z.boolean(),
  acted: z.object({ kind: z.string(), state: z.enum(["queued", "sending", "sent", "refused", "unknown"]), at: z.number() }).strict().nullable(),
}).strict();
export type DeckRow = z.infer<typeof deckRowSchema>;

const nextSchema = z.object({ text: z.string(), owner: z.string().nullable(), prUrl: z.string().nullable() }).strict();
const tally = z.array(z.object({ name: z.string(), count: z.number() }).strict());
const personSchema = z.object({ login: z.string(), prs: z.array(z.object({ prUrl: z.string(), ref: z.string(), since: z.number().nullable() }).strict()) }).strict();
export const deckCardSchema = z.object({
  id: z.string(), key: z.string(), name: z.string(), goal: z.string(),
  /** The one effort for standalone PRs. */
  oneOff: z.boolean(),
  pile: z.enum(EFFORT_PILES), reason: z.string(), since: z.number(),
  status: z.object({ tone: z.enum(["you", "waiting", "moving", "quiet", "held"]), text: z.string() }).strict(),
  needsYou: z.number(),
  stats: z.object({ open: z.number(), ready: z.number(), mergedWeek: z.number(), medianAgeMs: z.number().nullable(),
    oldestWait: z.object({ prUrl: z.string(), ref: z.string(), text: z.string(), since: z.number() }).strict().nullable() }).strict(),
  /** Merged PRs a read saw against open ones, and how many of the active instruction's "done when" criteria hold. */
  progress: z.object({ merged: z.number(), open: z.number(), criteria: z.object({ validated: z.number(), needed: z.number() }).strict().nullable() }).strict(),
  /** Up to three: the instruction's unmet "done when" criteria when it has some, else the oldest moves of yours, then the oldest waits. */
  next: z.array(nextSchema),
  /** Every row waiting on someone or something else, oldest first. */
  blocked: z.array(waitSchema.extend({ prUrl: z.string(), ref: z.string() }).strict()),
  /** What the stored Linear details say about its tickets; `known` 0 means no Linear data. */
  linear: z.object({ tickets: z.number(), known: z.number(), projects: tally, parents: tally,
    states: z.array(z.object({ name: z.string(), type: z.string().nullable(), count: z.number() }).strict()), labels: tally }).strict(),
  /** Reviewers you wait on, and reviewers whose requested changes wait on you. */
  people: z.object({ youWaitOn: z.array(personSchema), waitOnYou: z.array(personSchema) }).strict(),
  /** Its parent thread, then each PR's threads, most recent first. Read-only. */
  threads: z.array(z.object({ id: z.string(), title: z.string(), role: z.enum(["parent", "pr"]), prUrl: z.string().nullable(), status: z.string(),
    lastActivityAt: z.number().nullable() }).strict()),
  /** Merges, reviews, and pushes in the last 7 days, newest first. */
  activity: z.array(z.object({ kind: z.enum(["merged", "approved", "changes", "pushed"]), prUrl: z.string(), ref: z.string(), who: z.string().nullable(),
    at: z.number() }).strict()),
  sections: z.array(z.object({ key: z.enum(DECK_SECTIONS), needsYou: z.number(), rows: z.array(deckRowSchema) }).strict()),
}).strict();
export type DeckCard = z.infer<typeof deckCardSchema>;
export const deckViewSchema = z.object({
  /** Active efforts, most Needs you first and One-offs after them. The Unclassified deck follows the last. */
  active: z.array(deckCardSchema),
  /** Held efforts, in the order they were held. */
  held: z.array(deckCardSchema),
  /** Done efforts, newest first, and archived efforts that still own open PRs. */
  done: z.array(z.object({ id: z.string(), key: z.string(), name: z.string(), archived: z.boolean(), since: z.number(), merged: z.number(), open: z.number() })
    .strict()),
  unclassified: z.object({ rows: z.array(deckRowSchema), groups: z.array(suggestionGroupSchema), oneOffsId: z.string().nullable() }).strict(),
  counts: z.object({ needsYou: z.number(), toSort: z.number(), held: z.number(), done: z.number() }).strict(),
  checkedAt: z.string().nullable(), refreshing: z.boolean(),
}).strict();
export type DeckView = z.infer<typeof deckViewSchema>;
/** When you last marked each PR's row seen, by PR URL, as the view keeps it. */
export const deckSeenSchema = z.record(z.string().max(500), z.number()).refine((seen) => Object.keys(seen).length <= 1_000, "Too many PRs.");

/** One inventory row with the facts the deck adds. */
export type DeckRowInput = InventoryRow & {
  effort: { id: string; name: string } | null;
  /** What GitHub last said of it, for the dates its waits start; null for a teammate's PR the board doesn't read. */
  pr: Pick<Pr, "createdAt" | "headCommittedAt" | "reviewRequestedAt" | "approvalFeedback"> | null;
  tickets: readonly string[];
  /** The open v2 decision it waits on, and when it was asked. */
  decision: { n: number; question: string; since: number | null } | null;
  acted: RowActed | null;
};
export type DeckEffortInput = {
  id: string; key: string; name: string; goal: string; oneOff: boolean; pile: EffortPileState;
  /** Archived: it keeps its PRs, which pause on the Done pile until you restore it. */
  archived: boolean;
  parentThreadId: string | null;
  /** Tickets it owns by name. */
  tickets: readonly string[];
  /** Its active instruction's criteria; null without one. */
  criteria: readonly Criterion[] | null;
};
export type DeckInput = {
  now: number;
  efforts: readonly DeckEffortInput[];
  rows: readonly DeckRowInput[];
  /** Merges a read saw, with the effort that owns each. */
  merges: readonly { url: string; at: number; effortId: string }[];
  linear: ReadonlyMap<string, LinearDetail>;
  threads: ReadonlyMap<string, { title: string; status: string; updatedAt: number }>;
  unclassified: { groups: SuggestionGroup[]; oneOffsId: string | null };
  read: { checkedAt: string | null; refreshing: boolean };
  /** When you last marked each PR's row seen; see counted(). */
  seen: ReadonlyMap<string, number>;
};

/** The inventory action a row leads with, as the section it files under. */
const MOVES: Partial<Record<ActionId, DeckSection>> = { merge: "merge", "confirm-handled": "confirm", nudge: "nudge", "request-review": "request",
  "mark-ready": "ready", thread: "work" };
const time = (value: string | null | undefined): number | null => {
  const at = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(at) ? null : at;
};
const short = (repo: string) => repo.split("/").at(-1) ?? repo;
const refOf = (row: Pick<InventoryRow, "repo" | "number">) => `${short(row.repo)} #${row.number}`;
const urlRef = (url: string) => { const match = /\/([^/]+)\/pull\/(\d+)\/?$/u.exec(url); return match ? `${match[1]} #${match[2]}` : url; };
const oldest = (a: number | null, b: number | null) => (a ?? Number.POSITIVE_INFINITY) - (b ?? Number.POSITIVE_INFINITY);

/**
 * The section a row files under, and what it waits on when that isn't you. A hold outranks everything, as it does every write. Only a
 * parent, a decision, or a hold blocks: a review not yet due a nudge, running checks, and code work a thread is doing are in flight.
 */
function place(row: DeckRowInput, primary: ActionId | null, owner: string | null): { section: DeckSection; waitsOn: DeckRow["waitsOn"] } {
  const blocked = (waitsOn: NonNullable<DeckRow["waitsOn"]>) => ({ section: "blocked" as const, waitsOn });
  if (row.hold) return blocked({ kind: "hold", on: "you", what: row.hold.reason ? `On hold: ${row.hold.reason}` : "On hold", since: row.hold.heldAt });
  if (row.decision) return blocked({ kind: "decision", on: `D${row.decision.n}`, what: row.decision.question, since: row.decision.since });
  const move = primary && MOVES[primary];
  if (move && !(move === "work" && row.threads.executor?.active)) return { section: move, waitsOn: null };
  if (owner === "parent" && row.stackedOn !== null) {
    const parent = `${short(row.repo)} #${row.stackedOn}`;
    return blocked({ kind: "parent", on: parent, what: `Merges after ${parent}`, since: time(row.pr?.headCommittedAt) });
  }
  return { section: "flight", waitsOn: null };
}

/** One row as the deck draws it, worded by the inventory's own view model. */
export function deckRow(row: DeckRowInput, parents: ReadonlyMap<string, InventoryRow>, now: number): DeckRow {
  const line = inventoryLine(row, parents, { now, limitedUntil: null });
  const first = line.steps[0];
  const { section, waitsOn } = place(row, line.primary, first?.owner.kind ?? null);
  const thread = row.threads.executor ?? row.threads.origin;
  const feedback = row.pr?.approvalFeedback;
  return {
    prUrl: row.prUrl, repo: row.repo, number: row.number, title: row.title, draft: row.draft, section, status: line.status,
    step: first ? { text: first.text, owner: first.owner.label, since: row.attention.length ? row.attention[0]!.since : null } : null,
    waitsOn, reviewers: line.reviewers, suggested: line.suggested, nudge: line.actions.find((action) => action.id === "nudge")?.reviewers ?? [],
    notes: feedback?.status === "present" ? feedback.sourceIds.length : 0, tickets: [...row.tickets], stackedOn: row.stackedOn,
    thread: thread && { id: thread.id, title: thread.title, active: thread.active }, hold: row.hold && { reason: row.hold.reason, since: row.hold.heldAt },
    managed: row.managed?.label ?? null, checkedAt: row.checkedAt, failed: row.failure !== null, acted: row.acted && now - row.acted.at < ACTED_MS ? row.acted : null,
  };
}

type Placed = { row: DeckRow; input: DeckRowInput };
const tallies = (values: readonly string[]) => [...values.reduce((map, value) => map.set(value, (map.get(value) ?? 0) + 1), new Map<string, number>())]
  .map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

function people(rows: readonly Placed[]): DeckCard["people"] {
  const add = (map: Map<string, DeckCard["people"]["youWaitOn"][number]["prs"]>, login: string, row: DeckRow, since: number | null) =>
    map.set(login, [...map.get(login) ?? [], { prUrl: row.prUrl, ref: refOf(row), since }]);
  const youWaitOn = new Map<string, DeckCard["people"]["youWaitOn"][number]["prs"]>(), waitOnYou = new Map<string, DeckCard["people"]["youWaitOn"][number]["prs"]>();
  for (const { row, input } of rows) {
    if (!input.authored || input.hold) continue;
    for (const login of input.reviewers.requested) add(youWaitOn, login, row, time(input.pr?.reviewRequestedAt?.find((wait) => wait.reviewer === login)?.at));
    // Changes a reviewer asked for wait on you until you answer them.
    if (row.section === "work") for (const review of input.reviewers.reviewed.filter((item) => item.state === "CHANGES_REQUESTED"))
      add(waitOnYou, review.login, row, time(review.submittedAt));
  }
  const first = (prs: readonly { since: number | null }[]) => Math.min(...prs.map((pr) => pr.since ?? Number.POSITIVE_INFINITY));
  // Longest wait first; NaN between two undated waits falls through to the next key.
  const sorted = (map: typeof youWaitOn) => [...map].map(([login, prs]) => ({ login, prs }))
    .sort((a, b) => first(a.prs) - first(b.prs) || b.prs.length - a.prs.length || a.login.localeCompare(b.login));
  return { youWaitOn: sorted(youWaitOn), waitOnYou: sorted(waitOnYou) };
}

function card(effort: DeckEffortInput, rows: readonly Placed[], input: DeckInput): DeckCard {
  const { now } = input;
  const pile = effort.pile.pile;
  const all = rows.map(({ row }) => row);
  const inSection = (section: DeckSection) => all.filter((row) => row.section === section);
  const counts = (row: DeckRow) => needsYou(row, pile, input.seen.get(row.prUrl));
  const needs = all.filter(counts).length;
  const blocked = inSection("blocked").map((row) => ({ ...row.waitsOn!, prUrl: row.prUrl, ref: refOf(row) })).sort((a, b) => oldest(a.since, b.since));
  const flight = inSection("flight").length;
  const merges = input.merges.filter((merge) => merge.effortId === effort.id);
  const ages = rows.flatMap(({ input: row }) => time(row.pr?.createdAt) ?? []).map((at) => now - at).sort((a, b) => a - b);
  const waits = all.filter((row) => row.section !== "flight").flatMap((row) => {
    const since = row.waitsOn?.since ?? row.step?.since ?? null;
    return since === null ? [] : [{ prUrl: row.prUrl, ref: refOf(row), text: row.waitsOn?.what ?? row.step!.text, since }];
  }).sort((a, b) => a.since - b.since);
  // "Done when" is what you wrote. The gates and tickets the roster also checks are the rows' own facts, which the sections already show.
  const criteria = effort.criteria?.filter((item) => item.source === "user") ?? [];
  const next = criteria.length
    ? criteria.filter((item) => item.status !== "satisfied").slice(0, 3).map((item) => ({ text: item.label, owner: item.next?.owner ?? null,
      prUrl: item.affected[0]?.target ?? null }))
    : all.filter((row) => row.section !== "flight").sort((a, b) => DECK_SECTIONS.indexOf(a.section) - DECK_SECTIONS.indexOf(b.section) ||
      oldest(a.waitsOn?.since ?? a.step?.since ?? null, b.waitsOn?.since ?? b.step?.since ?? null)).slice(0, 3)
      .map((row) => ({ text: row.waitsOn?.what ?? row.step?.text ?? row.status, owner: row.waitsOn?.on ?? row.step?.owner ?? null, prUrl: row.prUrl }));
  const tickets = [...new Set([...effort.tickets, ...rows.flatMap(({ input: row }) => row.tickets)])].sort();
  const details = tickets.flatMap((ticket) => input.linear.get(ticket) ?? []);
  const threads = new Map<string, DeckCard["threads"][number]>();
  const parent = effort.parentThreadId ? input.threads.get(effort.parentThreadId) : undefined;
  if (parent) threads.set(effort.parentThreadId!, { id: effort.parentThreadId!, title: parent.title, role: "parent", prUrl: null, status: parent.status,
    lastActivityAt: parent.updatedAt });
  for (const { input: row } of rows) for (const thread of [row.threads.executor, row.threads.origin]) if (thread && !threads.has(thread.id)) {
    const facts = input.threads.get(thread.id);
    threads.set(thread.id, { id: thread.id, title: thread.title, role: "pr", prUrl: row.prUrl, status: facts?.status ?? (thread.active ? "active" : "idle"),
      lastActivityAt: facts?.updatedAt ?? null });
  }
  const recent = (at: number | null) => at !== null && now - at <= WEEK_MS;
  const activity: DeckCard["activity"] = [
    ...merges.filter((merge) => recent(merge.at)).map((merge) => ({ kind: "merged" as const, prUrl: merge.url, ref: urlRef(merge.url), who: null, at: merge.at })),
    ...rows.flatMap(({ input: row }) => [
      ...row.reviewers.reviewed.flatMap((review) => {
        const at = time(review.submittedAt);
        const kind = review.state === "APPROVED" ? "approved" as const : review.state === "CHANGES_REQUESTED" ? "changes" as const : null;
        return kind && recent(at) ? [{ kind, prUrl: row.prUrl, ref: refOf(row), who: review.login, at: at! }] : [];
      }),
      ...recent(time(row.pr?.headCommittedAt)) ? [{ kind: "pushed" as const, prUrl: row.prUrl, ref: refOf(row), who: null, at: time(row.pr?.headCommittedAt)! }] : []]),
  ].sort((a, b) => b.at - a.at).slice(0, 12);
  const parts = [needs && `${needs} need you`, blocked.length && `${blocked.length} blocked`, flight && `${flight} in flight`].filter(Boolean);
  return {
    id: effort.id, key: effort.key, name: effort.name, goal: effort.goal, oneOff: effort.oneOff, pile, reason: effort.pile.reason, since: effort.pile.since,
    status: pile === "held" ? { tone: "held", text: effort.pile.reason ? `On hold: ${effort.pile.reason}` : "On hold" }
      : { tone: needs ? "you" : blocked.length ? "waiting" : rows.length ? "moving" : "quiet", text: parts.join(" · ") || "No open PRs" },
    needsYou: needs,
    stats: { open: rows.length, ready: inSection("merge").length, mergedWeek: merges.filter((merge) => recent(merge.at)).length,
      medianAgeMs: ages.length ? ages[Math.floor(ages.length / 2)]! : null, oldestWait: waits[0] ?? null },
    progress: { merged: merges.length, open: rows.length,
      criteria: criteria.length ? { validated: criteria.filter((item) => item.status === "satisfied").length, needed: criteria.length } : null },
    next, blocked,
    linear: { tickets: tickets.length, known: details.length, projects: tallies(details.flatMap((detail) => detail.project ? [detail.project.name] : [])),
      parents: tallies(details.flatMap((detail) => detail.parent?.identifier ? [`${detail.parent.identifier}${detail.parent.title ? ` ${detail.parent.title}` : ""}`] : [])),
      states: tallies(details.flatMap((detail) => detail.state ? [detail.state.name] : []))
        .map(({ name, count }) => ({ name, type: details.find((detail) => detail.state?.name === name)!.state!.type, count })),
      labels: tallies(details.flatMap((detail) => detail.labels)) },
    people: people(rows),
    threads: [...threads.values()].sort((a, b) => Number(b.role === "parent") - Number(a.role === "parent") || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)),
    activity,
    sections: DECK_SECTIONS.flatMap((key) => {
      const list = inSection(key);
      return list.length ? [{ key, needsYou: list.filter(counts).length, rows: list }] : [];
    }),
  };
}

/** The whole deck from one read. */
export function deckView(input: DeckInput): DeckView {
  const parents = new Map(input.rows.map((row) => [`${row.repo.toLowerCase()}#${row.number}`, row]));
  const placed = input.rows.map((row) => ({ row: deckRow(row, parents, input.now), input: row }));
  const of = (effortId: string | null) => placed.filter(({ input: row }) => (row.effort?.id ?? null) === effortId);
  const cards = input.efforts.filter((effort) => effort.pile.pile !== "done").map((effort) => card(effort, of(effort.id), input));
  const active = cards.filter((item) => item.pile === "active")
    .sort((a, b) => Number(a.oneOff) - Number(b.oneOff) || b.needsYou - a.needsYou || a.since - b.since || a.name.localeCompare(b.name));
  const held = cards.filter((item) => item.pile === "held").sort((a, b) => a.since - b.since || a.name.localeCompare(b.name));
  const done = input.efforts.filter((effort) => effort.pile.pile === "done" && (!effort.archived || of(effort.id).length))
    .map((effort) => ({ id: effort.id, key: effort.key, name: effort.name, archived: effort.archived, since: effort.pile.since,
      merged: input.merges.filter((merge) => merge.effortId === effort.id).length, open: of(effort.id).length }))
    .sort((a, b) => b.since - a.since || a.name.localeCompare(b.name));
  const unsorted = of(null).map(({ row }) => row);
  return { active, held, done, unclassified: { rows: unsorted, groups: input.unclassified.groups, oneOffsId: input.unclassified.oneOffsId },
    counts: { needsYou: active.reduce((sum, item) => sum + item.needsYou, 0), toSort: unsorted.length, held: held.length, done: done.length },
    checkedAt: input.read.checkedAt, refreshing: input.read.refreshing };
}
