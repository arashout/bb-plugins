// The effort deck's view model (plan amendment A15): pure functions from
// deck_get's output, what each view last marked seen, and the view's own
// state to what the deck draws. The server placed each row in its section and
// counted Needs you with deck-shared.ts's one rule; this settles rows in
// place until Mark seen (deck-place.ts), words them for one line, and says
// which actions the keys, hint bar, ? sheet, and ⌘K offer right now. It
// imports types, zero-import modules, and the roster's time format only, so
// no server module reaches the browser (A12.1).
import type { DeckCard, DeckRow, DeckView } from "./deck";
import { cardTier, counted, DECK_SECTIONS, LOOSE_ID, needsYou, SERVICE_PREFIX, serviceGoal, serviceName, type BatchKind, type DeckPile, type DeckSection }
  from "./deck-shared";
import { settleRows, type SettledRow, type Shown } from "./deck-place";
import { ACTION, DECK_ACTIONS, type DeckAction, type DeckActionId } from "./deck-keys";
import type { SuggestionGroup } from "./effort-classify";
import { age, clock } from "./roster-view-model";

const DAY = 86_400_000;
/** A Linear date or time as its calendar day, "Oct 17": a target or due date is a day, not a moment. */
const calendarDay = (value: string) => new Date(Date.parse(value)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
/** Color only where the move is yours; gray waits on others or runs itself. */
export type Tone = "green" | "violet" | "blue" | "amber" | "red" | "gray";
export type SectionMeta = { title: string; tone: Tone; action: DeckActionId | null; button: string | null; help: string; fold?: boolean };
export const SECTIONS: Record<DeckSection, SectionMeta> = {
  merge: { title: "Merge", tone: "green", action: "merge", button: "Preview merge", help: "Approved, checks green, no conflicts. The preview reads each PR again, and nothing merges until you press Merge or ⌘↵." },
  confirm: { title: "Confirm review notes", tone: "violet", action: "confirm", button: "Confirm…", help: "Approved with written notes. The confirm lists each PR before it records the notes handled." },
  nudge: { title: "Nudge reviewers", tone: "blue", action: "nudge", button: "Nudge…", help: "Asked over a business day ago with no answer, or changes addressed and not asked again." },
  request: { title: "Request a reviewer", tone: "blue", action: "request", button: "Request…", help: "Open, not a draft, and nobody is asked." },
  ready: { title: "Mark ready", tone: "blue", action: "ready", button: "Mark ready…", help: "Drafts with green checks and no conflict." },
  work: { title: "Work in threads", tone: "amber", action: null, button: null, help: "Conflicts, failing checks, and requested changes. Each is fixed in its PR's thread; o opens it." },
  flight: { title: "In flight", tone: "gray", action: null, button: null, fold: true, help: "In review under a business day, checks running, or a thread working on it. Nothing for you yet." },
  blocked: { title: "Blocked", tone: "gray", action: null, button: null, help: "Waits on a parent PR, an open decision, or a hold." },
};
/** The batch each act key plans. */
export const KIND_OF: Partial<Record<DeckActionId, BatchKind>> = { confirm: "confirm", nudge: "nudge", request: "request", ready: "ready" };
const SECTION_OF: Partial<Record<DeckActionId, DeckSection>> = { merge: "merge", confirm: "confirm", nudge: "nudge", request: "request", ready: "ready" };
const ACTED: Record<BatchKind, [string, string]> = { confirm: ["Confirming…", "Confirmed handled"], nudge: ["Nudging…", "Nudged"],
  request: ["Requesting…", "Review requested"], ready: ["Marking ready…", "Marked ready"] };
/** Muted effort colors, picked by the effort's id so a card keeps its color across reads and sessions. */
const EFFORT_COLORS = ["#5fb3b3", "#d3a35a", "#8c8fd9", "#d98ca8", "#9cb86a", "#6fa8d6", "#d9905f", "#b48ad6"];
export const ONE_OFF_COLOR = "#8f8e8a";
/** A service card's color, drawn as a hollow dot: it stands in for an effort no one made yet. */
export const SERVICE_COLOR = "#d3a35a";
export function effortColor(id: string, oneOff = false): string {
  if (oneOff || id === LOOSE_ID) return ONE_OFF_COLOR;
  if (cardTier(id) > 0) return SERVICE_COLOR;
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return EFFORT_COLORS[hash % EFFORT_COLORS.length]!;
}

const short = (repo: string) => repo.split("/").at(-1) ?? repo;
export const refOf = (row: Pick<DeckRow, "repo" | "number">) => `${short(row.repo)} #${row.number}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const mentions = (logins: readonly string[]) => logins.map((login) => `@${login}`).join(" ");

/** One row as the deck draws it on one line. */
export type DeckLine = {
  prUrl: string; ref: string; title: string;
  /** The PR it's stacked on, when it has one. */
  stacked: string | null;
  section: string; tone: Tone;
  /** Counts toward Needs you now: your move, not dimmed. */
  needs: boolean;
  /** You acted on it, a read changed it, or it left: it stays put and stops counting until Mark seen. */
  dim: boolean; ghost: boolean;
  /** Why it carries a change dot. */
  dot: string | null;
  info: { text: string; tone: Tone | null } | null;
  signals: string[];
  age: string | null; hot: boolean;
  /** Its read, only when it isn't current: the last one failed, or the last full read didn't list it. */
  checked: { text: string; title: string; failed: boolean } | null;
  trail: { kind: "acted"; text: string; undo: string | null; failed: boolean; title: string | null } | { kind: "change" | "ghost"; text: string }
    | { kind: "thread"; text: string; threadId: string } | null;
  row: DeckRow | null;
};
/** What a view knows beyond deck_get: when each row was last marked seen, and what a refused or cut-off write said. */
export type LineContext = { now: number; seenAt: Readonly<Record<string, number>>; details?: ReadonlyMap<string, string>;
  /** PRs a read saw merge, so a row that left says so. */
  merged?: ReadonlySet<string>;
  /** PRs you moved to an effort from here, by the effort's name, until Mark seen: a row that left that way says where to, as news it isn't. */
  moved?: ReadonlyMap<string, string> };

function info(row: DeckRow, section: string): DeckLine["info"] {
  switch (section) {
    case "merge": { const approved = row.reviewers.filter((review) => review.state === "approved").map((review) => review.login);
      return approved.length ? { text: `✓ ${mentions(approved)}`, tone: null } : null; }
    case "confirm": return { text: plural(Math.max(1, row.notes), "note"), tone: "violet" };
    case "nudge": return row.nudge.length ? { text: mentions(row.nudge), tone: null } : null;
    case "request": return row.suggested.length ? { text: `suggest @${row.suggested[0]}`, tone: null } : null;
    case "ready": return { text: "draft", tone: null };
    case "work": return { text: row.status, tone: /CI|check/iu.test(row.status) ? "red" : "amber" };
    case "blocked": return { text: row.waitsOn?.what ?? row.status, tone: "gray" };
    default: return { text: row.status, tone: "gray" };
  }
}

function checked(row: DeckRow, now: number): DeckLine["checked"] {
  const good = row.checkedAt ? `; its last good read was ${age(Date.parse(row.checkedAt), now)} ago` : "";
  if (row.failed) return { text: "read failed", failed: true, title: `GitHub didn't answer its last read${good}. Refresh reads it again.` };
  return row.stale ? { text: `stale${row.checkedAt ? ` ${age(Date.parse(row.checkedAt), now)}` : ""}`, failed: false,
    title: `The last full read didn't list it${good}.` } : null;
}

/** One settled row as a line: a ghost keeps what you last saw; a changed row stays in its old section with what it is now. */
export function deckLine(item: Shown<DeckRow>, pile: DeckPile, context: LineContext, signals: string[] = []): DeckLine {
  const row = item.row;
  const settled = item.settled;
  const section = item.section;
  const seenAt = context.seenAt[item.prUrl];
  const moved = item.ghost ? context.moved?.get(item.prUrl) ?? null : null;
  const acted = row?.acted ?? null;
  const dim = item.ghost || item.change !== null || (row !== null && !counted(row, seenAt));
  const needs = !dim && row !== null && needsYou(row, pile, seenAt);
  const since = row?.waitsOn?.since ?? row?.step?.since ?? null;
  const shownAge = row && since !== null && section !== "merge" && section !== "flight" ? age(since, context.now) : null;
  const tone: Tone = section === "work" && row ? info(row, section)!.tone! : SECTIONS[section as DeckSection]?.tone ?? "gray";
  let trail: DeckLine["trail"] = null;
  if (acted) {
    const failed = acted.state === "refused" || acted.state === "unknown";
    trail = { kind: "acted", failed, undo: acted.state === "queued" ? acted.batchId : null, title: context.details?.get(item.prUrl) ?? null,
      text: acted.state === "refused" ? "Not sent" : acted.state === "unknown" ? "May not have sent" : ACTED[acted.kind][acted.state === "sent" ? 1 : 0] };
  } else if (item.ghost) trail = { kind: "ghost", text: moved ? `→ ${moved}` : context.merged?.has(item.prUrl) ? "Merged" : "Left" };
  else if (item.change) trail = { kind: "change", text: `→ ${item.change.now}` };
  else if (row?.thread && section === "work") trail = { kind: "thread", text: row.thread.title, threadId: row.thread.id };
  return {
    prUrl: item.prUrl, ref: row ? refOf(row) : settled!.ref, title: row?.title ?? settled!.title,
    stacked: row?.stackedOn != null ? `${short(row.repo)} #${row.stackedOn}` : null, section, tone, needs, dim, ghost: item.ghost,
    dot: moved ? null : item.ghost ? `${context.merged?.has(item.prUrl) ? "Merged" : "Left"} since you looked. Clears on Mark seen.` : item.change ? `Was ${item.change.was}; now ${item.change.now}. Settles on Mark seen.`
      : item.arrived ? "New since you looked" : null,
    info: row ? info(row, section) : null, signals, age: shownAge, checked: row ? checked(row, context.now) : null,
    hot: needs && since !== null && context.now - since >= 4 * DAY, trail, row,
  };
}

const settledOf = (row: DeckRow, section: string = row.section): SettledRow => ({ prUrl: row.prUrl, ref: refOf(row), title: row.title, section, status: row.status });
/** What Mark seen keeps for a card: its rows in their sections now. */
export const cardSnapshot = (card: DeckCard): SettledRow[] => card.sections.flatMap((section) => section.rows.map((row) => settledOf(row)));
const threadRow = (thread: DeckCard["threads"][number]) => ({ prUrl: thread.id, ref: thread.role, title: thread.title, section: "threads", status: thread.status });
/** What Mark seen keeps of a card's threads, whose order holds until then. */
export const threadSnapshot = (card: DeckCard): SettledRow[] => card.threads.map(threadRow);
export const threadsKey = (cardId: string) => `threads:${cardId}`;

/**
 * The service cards in the session's `order` that a read no longer draws, because their last PR left, as empty stand-ins while Mark seen
 * has something there to settle: a row you last saw there, now a ghost saying Left or → its effort, or a suggestion you accepted there,
 * with its Undo. So a service card stays put like an effort's card rather than going out from under you; Mark seen lets it go.
 */
export function keptServiceCards(order: readonly string[], active: readonly DeckCard[], seen: Readonly<Record<string, readonly SettledRow[]>>,
  accepted: Accepted): DeckCard[] {
  const here = new Set(active.map((card) => card.id));
  return order.filter((id) => id.startsWith(SERVICE_PREFIX) && !here.has(id)
    && (!!seen[id]?.length || [...accepted.keys()].some((key) => key.startsWith(`${id} `)))).map((id) => {
    const repo = id.slice(SERVICE_PREFIX.length);
    return { id, key: id, name: serviceName(repo), goal: serviceGoal(repo), kind: "service", repo, oneOff: false, pile: "active", reason: "", since: 0,
      status: { tone: "quiet", text: "No open PRs" }, needsYou: 0, stats: { open: 0, ready: 0, mergedWeek: 0, medianAgeMs: null, oldestWait: null },
      progress: { merged: 0, open: 0, criteria: null }, next: [], blocked: [],
      linear: { tickets: 0, known: 0, projects: [], initiatives: [], parents: [], states: [], labels: [], cycles: [], assignees: [] },
      people: { youWaitOn: [], waitOnYou: [] }, threads: [], activity: [], sections: [], suggestions: [] };
  });
}

export type SectionScreen = { key: DeckSection; meta: SectionMeta; count: number; changed: number; lines: DeckLine[];
  action: { id: DeckActionId; label: string; key: string; enabled: boolean; why: string | null } | null };
/** How strongly a suggestion's signals point at its target, as its group says it. */
export type Strength = "strong" | "moderate" | "weak";
/** One of a service card's suggestions, with the card's rows it covers. */
export type SuggestGroup = {
  /** The card's id and the classifier's group key: a group that spans repositories shows on each of their cards. */
  key: string; title: string; target: SuggestionGroup["target"]; color: string; reason: string; strength: Strength | null;
  /** The specific signals behind its target, strongest first, shown before you accept it. */
  signals: readonly string[];
  /**
   * What its one button does to its rows still here, and how many. `confirm`: a weak suggestion that would move PRs at once asks first,
   * listing each PR with its signals.
   */
  button: { kind: "assign" | "new" | "one-off" | "pick"; label: string; count: number; confirm: boolean };
  /** Its rows on the card, each with its own signals. */
  lines: DeckLine[];
  /** You accepted all of it that was here: one line with Undo until Mark seen. */
  accepted: { text: string; actionId: string } | null;
};
/** A suggestion you accepted, by its group key, with the PRs it moved and where its line was, until Mark seen. */
export type Accepted = ReadonlyMap<string, { actionId: string; text: string; prUrls: readonly string[]; index?: number }>;
export type CardScreen = {
  card: DeckCard; color: string;
  status: { text: string; tone: Tone };
  /** Needs you now, the PRs Advance plans (the safe moves drawn as needing you), and what Mark seen would settle. */
  needsYou: number; advance: string[]; changed: number; settleable: boolean;
  next: { criteria: { validated: number; needed: number } | null; items: { text: string; owner: string | null; prUrl: string | null; ref: string | null }[] };
  blocked: { prUrl: string; ref: string; on: string; what: string; age: string | null; dot: boolean }[];
  stats: { open: number; mergedWeek: number; median: string; oldest: { text: string; title: string } | null; bar: { key: string; label: string; count: number; tone: Tone }[] };
  threads: { id: string; title: string; ref: string; status: string; age: string | null; dot: boolean }[];
  /**
   * Chips for its projects (▣), initiatives (◇), and labels (#), a bar of its tickets' states, and its top project's target, all on one line
   * on a wide card; then one [label, value] line per field Linear gave.
   */
  linear: { summary: string; chips: { kind: "project" | "initiative" | "label"; text: string }[]; bar: { name: string; count: number; tone: Tone }[];
    target: string | null; lines: [string, string][] };
  people: { summary: string; waitOnYou: { login: string; count: number; title: string }[]; youWaitOn: { login: string; count: number; title: string }[] };
  recent: { summary: string; items: { text: string; age: string }[] };
  sections: SectionScreen[];
  /** A service card's suggestions, in the classifier's order; empty on an effort's card. */
  suggest: SuggestGroup[];
};

const BAR: { key: string; label: string; tone: Tone; of: readonly DeckSection[] }[] = [
  { key: "ready", label: "ready to merge", tone: "green", of: ["merge"] }, { key: "yours", label: "your other moves", tone: "blue", of: ["confirm", "nudge", "request", "ready"] },
  { key: "fix", label: "to fix", tone: "amber", of: ["work"] }, { key: "flight", label: "in flight", tone: "gray", of: ["flight"] },
  { key: "blocked", label: "blocked", tone: "gray", of: ["blocked"] }];
const ACTIVITY: Record<DeckCard["activity"][number]["kind"], string> = { merged: "Merged", approved: "Approved", changes: "Changes asked on", pushed: "Pushed" };

/** Where a suggestion points, as a row's chip says it. */
const pointer = (target: SuggestionGroup["target"]) => target?.kind === "effort" ? `→ ${target.name}` : target?.kind === "new" ? `→ new ${target.name}`
  : target?.kind === "one-off" ? "→ One-offs" : null;

/**
 * A card as the deck draws it, with its rows settled against what you last marked seen. On a service card, each row names where its
 * suggestion points, and `accepted` collapses the suggestions you took.
 */
export function cardScreen(card: DeckCard, seen: { rows: Readonly<Record<string, readonly SettledRow[]>>; at: Readonly<Record<string, number>> },
  context: Omit<LineContext, "seenAt"> & { accepted?: Accepted }): CardScreen {
  const { now } = context;
  const lineContext = { ...context, seenAt: seen.at, merged: new Set(card.activity.filter((item) => item.kind === "merged").map((item) => item.prUrl)) };
  const current = card.sections.flatMap((section) => section.rows);
  const groupOf = new Map(card.suggestions.flatMap((group) => group.prs.map((pr) => [pr.prUrl, group] as const)));
  const shown = settleRows(seen.rows[card.id], current, DECK_SECTIONS).map((item) => {
    const chip = pointer(groupOf.get(item.prUrl)?.target ?? null);
    return deckLine(item, card.pile, lineContext, chip && !item.ghost ? [chip] : []);
  });
  const byPr = new Map(shown.map((line) => [line.prUrl, line]));
  const sections = DECK_SECTIONS.flatMap((key): SectionScreen[] => {
    const lines = shown.filter((line) => line.section === key);
    if (!lines.length) return [];
    const meta = SECTIONS[key];
    const count = lines.filter((line) => line.needs).length;
    const action = meta.action && meta.button ? { id: meta.action, label: meta.button, key: ACTION[meta.action].keys[0]!, enabled: count > 0 && card.pile === "active",
      why: count ? null : "Nothing left here; dimmed rows settle on Mark seen" } : null;
    return [{ key, meta, count, changed: lines.filter((line) => line.dot !== null).length, lines, action }];
  });
  const counts = (of: readonly DeckSection[]) => current.filter((row) => of.includes(row.section)).length;
  const threads = settleRows(seen.rows[threadsKey(card.id)], card.threads.map(threadRow)).filter((item) => !item.ghost).map((item) => {
    const thread = card.threads.find((candidate) => candidate.id === item.prUrl)!;
    const pr = thread.prUrl ? current.find((row) => row.prUrl === thread.prUrl) : undefined;
    return { id: thread.id, title: thread.title, ref: thread.role === "parent" ? "parent" : pr ? refOf(pr) : "", status: thread.status,
      age: thread.lastActivityAt === null ? null : age(thread.lastActivityAt, now), dot: item.change !== null || item.arrived };
  });
  const people = (list: DeckCard["people"]["youWaitOn"]) => list.map((person) => ({ login: person.login, count: person.prs.length,
    title: person.prs.map((pr) => `${pr.ref}${pr.since === null ? "" : `, ${age(pr.since, now)}`}`).join("; ") }));
  const { linear } = card;
  const tallies = (list: readonly { name: string; count: number }[]) => list.map((item) => `${item.name}${item.count > 1 ? ` ${item.count}` : ""}`).join(" · ");
  const top = linear.projects[0];
  const target = top?.targetDate ? `target ${calendarDay(top.targetDate)}` : null;
  const linearLines = ([["States", linear.states.map((state) => `${state.count} ${state.name.toLowerCase()}`).join(" · ")],
    ["Cycle", linear.cycles.map((cycle) => `${cycle.name ?? `Cycle ${cycle.number}`}${cycle.endsAt ? ` → ${calendarDay(cycle.endsAt)}` : ""}`).join(" · ")],
    ["Assignees", linear.assignees.map((person) => person.name).join(", ")],
    ["Target", linear.projects.flatMap((project) => project.targetDate ? [`${calendarDay(project.targetDate)} ${project.name}`] : []).join(" · ")],
    ["Parent", tallies(linear.parents)], ["Read", `${linear.known} of ${plural(linear.tickets, "ticket")}`]] as [string, string][]).filter(([, value]) => value);
  const waitOnYou = people(card.people.waitOnYou), youWaitOn = people(card.people.youWaitOn);
  const first = card.activity[0];
  const needsYou = shown.filter((line) => line.needs).length;
  const suggest = suggestGroups(card, shown, context.accepted ?? new Map());
  // Worded from the rows as drawn, so the header, the strip, and the sections agree while rows wait for Mark seen.
  const parts = [needsYou && `${needsYou} need you`, card.blocked.length && `${card.blocked.length} blocked`,
    counts(["flight"]) && `${counts(["flight"])} in flight`].filter(Boolean);
  return {
    card, color: effortColor(card.id, card.oneOff),
    status: card.pile === "held" ? { text: card.status.text, tone: "gray" }
      : { text: parts.join(" · ") || "No open PRs", tone: needsYou ? "amber" : card.blocked.length ? "blue" : current.length ? "green" : "gray" },
    needsYou,
    advance: shown.filter((line) => line.needs && ["confirm", "nudge", "request", "ready"].includes(line.section)).map((line) => line.prUrl),
    changed: shown.filter((line) => line.dot !== null).length + threads.filter((thread) => thread.dot).length,
    // Only a landed write's dim is Mark seen's to settle: a waiting write isn't done, and a refused one never dimmed. So are rows and
    // suggestions you moved from here.
    settleable: shown.some((line) => line.row?.acted?.state === "sent" && !counted(line.row, seen.at[line.prUrl]))
      || shown.some((line) => line.ghost && !line.dot) || suggest.some((group) => group.accepted),
    next: { criteria: card.progress.criteria, items: card.next.map((item) => {
      const row = item.prUrl ? current.find((candidate) => candidate.prUrl === item.prUrl) : undefined;
      return { text: item.text, owner: item.owner, prUrl: row ? item.prUrl : null, ref: row ? refOf(row) : null };
    }) },
    blocked: card.blocked.map((item) => ({ prUrl: item.prUrl, ref: item.ref, on: item.on, what: item.what, age: item.since === null ? null : age(item.since, now),
      dot: byPr.get(item.prUrl)?.dot != null })),
    stats: { open: card.stats.open, mergedWeek: card.stats.mergedWeek, median: card.stats.medianAgeMs === null ? "—" : age(now - card.stats.medianAgeMs, now),
      oldest: card.stats.oldestWait && { text: age(card.stats.oldestWait.since, now), title: `${card.stats.oldestWait.ref}: ${card.stats.oldestWait.text}` },
      bar: BAR.map((segment) => ({ key: segment.key, label: segment.label, tone: segment.tone, count: counts(segment.of) })).filter((segment) => segment.count) },
    threads,
    linear: { summary: linear.known === 0 ? "no Linear data" : [top?.name, target].filter(Boolean).join(" · ") || `${linear.known} of ${linear.tickets} tickets`,
      chips: linear.known ? [...linear.projects.map((project) => ({ kind: "project" as const, text: project.name })),
        ...linear.initiatives.map((initiative) => ({ kind: "initiative" as const, text: initiative.name })),
        ...linear.labels.map((label) => ({ kind: "label" as const, text: label.name }))] : [],
      bar: linear.states.map((state) => ({ name: state.name, count: state.count,
        tone: state.type === "completed" ? "green" as const : state.type === "started" ? "blue" as const : "gray" as const })),
      target, lines: linear.known ? linearLines : [] },
    people: { waitOnYou, youWaitOn, summary: waitOnYou.length ? `@${waitOnYou[0]!.login} waits on you` : youWaitOn.length ? `you wait on ${youWaitOn.length}` : "nobody" },
    recent: { summary: first ? `${ACTIVITY[first.kind]} ${first.ref} ${age(first.at, now)} ago` : "quiet",
      items: card.activity.map((item) => ({ text: `${ACTIVITY[item.kind]} ${item.ref}${item.who ? ` · @${item.who}` : ""}`, age: age(item.at, now) })) },
    sections, suggest,
  };
}

const STRENGTH: Record<NonNullable<SuggestionGroup["confidence"]>, Strength> = { high: "strong", medium: "moderate", low: "weak" };

/** What accepting a group does to `n` of its PRs, as its button and a weak group's confirm say it. */
export function acceptLabel(target: SuggestionGroup["target"], n: number): string {
  return target?.kind === "effort" ? `Put ${n} in ${target.name}` : target?.kind === "new" ? `New effort from ${n}`
    : target?.kind === "one-off" ? `Mark ${n} one-off${n === 1 ? "" : "s"}` : "Pick per PR";
}

/**
 * What Accept takes from a selection across the groups `keys`. A weak group asks on its own, so across two or more groups Accept takes
 * the rest and leaves each weak one, and `left` says so; a lone weak group is taken, and its Accept opens its confirm.
 */
export function acceptPlan(groups: readonly Pick<SuggestGroup, "key" | "button">[], keys: readonly string[]): { take: string[]; left: string | null } {
  const weak = keys.length > 1 ? keys.filter((key) => groups.some((group) => group.key === key && group.button.confirm)) : [];
  const n = weak.length;
  return { take: keys.filter((key) => !weak.includes(key)), left: n ? `${n} weak group${n === 1 ? "" : "s"} left: accept ${n === 1 ? "it" : "each"} alone.` : null };
}

/**
 * A service card's suggestions: each group with its reason once and one button, over the card's rows it covers, in the classifier's order.
 * A group you accepted all of collapses to one line with Undo where it was, even after its PRs leave the card, until Mark seen.
 */
function suggestGroups(card: DeckCard, shown: readonly DeckLine[], accepted: Accepted): SuggestGroup[] {
  if (card.kind !== "service") return [];
  const keyOf = (key: string) => `${card.id} ${key}`;
  const make = (key: string, group: SuggestionGroup | null, lines: DeckLine[], done: { text: string; actionId: string } | null): SuggestGroup => {
    const target = group?.target ?? null;
    const count = lines.filter((line) => !line.dim).length;
    const title = !group ? "Moved" : target?.kind === "effort" || target?.kind === "new" ? target.name : target?.kind === "one-off" ? "One-offs" : "No clear signal";
    const strength = group?.confidence ? STRENGTH[group.confidence] : null;
    const confirm = strength === "weak" && (target?.kind === "effort" || target?.kind === "one-off");
    const button: SuggestGroup["button"] = { kind: target?.kind === "effort" ? "assign" : target?.kind ?? "pick",
      label: `${acceptLabel(target, count)}${confirm || target?.kind === "new" ? "…" : ""}`, count, confirm };
    return { key, title, target, color: target?.kind === "effort" ? effortColor(target.effortId) : target?.kind === "one-off" ? ONE_OFF_COLOR : SERVICE_COLOR,
      reason: (group?.reason ?? "").replace(/^No clear signal\.\s*/u, ""), strength, signals: group?.signals ?? [], button, lines, accepted: done };
  };
  const groups = card.suggestions.map((group) => {
    const key = keyOf(group.key);
    const taken = accepted.get(key);
    const lines = shown.filter((line) => !line.ghost && line.row && group.prs.some((pr) => pr.prUrl === line.prUrl))
      .map((line) => ({ ...line, signals: group.prs.find((pr) => pr.prUrl === line.prUrl)!.signals.map((signal) => signal.text) }));
    // It collapses only while nothing here is outside what you accepted, so the rest of a partial accept, or a PR that arrives, shows.
    return make(key, group, lines, taken && lines.every((line) => line.dim || taken.prUrls.includes(line.prUrl)) ? taken : null);
  });
  for (const [key, taken] of accepted) if (key.startsWith(keyOf("")) && !groups.some((group) => group.key === key))
    groups.splice(Math.min(taken.index ?? groups.length, groups.length), 0, make(key, null, [], taken));
  return groups.filter((group) => group.lines.length || group.accepted);
}

/** The top bar's read status: when the deck last read GitHub, and GitHub's rate limit while it holds reads. */
export function readText(view: Pick<DeckView, "checkedAt" | "refreshing" | "limitedUntil">, now: number): string {
  const limited = view.limitedUntil !== null && view.limitedUntil > now ? `Rate-limited until ${clock(view.limitedUntil, now)} · ` : "";
  return `${limited}${view.refreshing ? "Reading now · " : ""}Read ${view.checkedAt ? `${age(Date.parse(view.checkedAt), now)} ago` : "never"}`;
}

/** One strip chip: the active pile in session order, service cards after the efforts. `service`: no stored effort backs it. */
export type Chip = { id: string; n: number | null; name: string; color: string; count: number; ping: boolean; service: boolean };
export function stripChips(order: readonly string[], cards: ReadonlyMap<string, CardScreen>, cur: string | null): Chip[] {
  return order.filter((id) => cards.has(id)).map((id, index) => {
    const card = cards.get(id)!;
    return { id, n: index < 9 ? index + 1 : null, name: card.card.name, color: card.color, count: card.needsYou, ping: id !== cur && card.changed > 0,
      service: card.card.kind !== "effort" };
  });
}

/** What the keys can act on: the view, the card or deck shown, the focused row, and the selection. */
export type KeyContext = {
  view: "deck" | "prs";
  /** The card shown on the deck. */
  cur: CardScreen | null;
  /** The first service card, which u goes to; none when nothing open is outside an effort. */
  service?: string | null;
  focused: DeckLine | null;
  selected: readonly DeckLine[];
  seenAvailable: boolean; undo: boolean; held: number; done: number;
  /** In All PRs: whether a row is focused, whether it has a thread, and the moves its inventory row offers. */
  prs?: { row: boolean; thread: boolean; moves: ReadonlySet<DeckActionId> };
};
export type Availability = Record<DeckActionId, { on: boolean; why: string }>;

/**
 * Which rows an act key would take: the selected rows with that move, else the focused row when it has it, else every row in the card
 * with it. Only rows that need you count; a dimmed row waits for Mark seen.
 */
export function targets(id: DeckActionId, context: Pick<KeyContext, "cur" | "focused" | "selected">): DeckLine[] {
  const section = SECTION_OF[id];
  if (!section) return [];
  const take = (lines: readonly DeckLine[]) => lines.filter((line) => line.needs && line.section === section);
  if (context.selected.length) return take(context.selected);
  if (context.focused && take([context.focused]).length) return [context.focused];
  return context.cur ? take(context.cur.sections.flatMap((item) => item.lines)) : [];
}

const NO_CARD = "open an effort card";
const NOTHING = { merge: "nothing is ready to merge", confirm: "no notes are waiting", nudge: "no nudge is due", request: "every PR has a reviewer",
  ready: "no draft is ready" } as const;
/** Every action's availability now, with why one can't run, for the keys, the hint bar, the ? sheet, and ⌘K. */
export function availability(context: KeyContext): Availability {
  const { focused, selected } = context;
  const deck = context.view === "deck";
  const card = deck ? context.cur : null;
  const live = !!card && card.card.pile === "active";
  const service = !!card && card.card.kind === "service";
  const sorting = service && (selected.length ? selected.some((line) => !line.dim) : !!focused?.row && !focused.dim);
  const prs = context.prs;
  const out = {} as Availability;
  const set = (id: DeckActionId, on: boolean, why = "") => { out[id] = { on, why: on ? "" : why }; };
  set("next", deck, "Efforts only"); set("prev", deck, "Efforts only"); set("jump", deck, "Efforts only");
  set("services", deck && !!context.service, deck ? "every PR is in an effort" : "Efforts only");
  set("view", true); set("seen", deck && context.seenAvailable, deck ? "nothing changed here" : "Efforts only");
  set("hold-pile", deck && context.held > 0, deck ? "no effort is on hold" : "Efforts only");
  set("done-pile", deck && context.done > 0, deck ? "no effort is done" : "Efforts only");
  set("advance", live && card!.advance.length > 0, card ? "nothing safe to run" : deck ? NO_CARD : "Efforts only");
  const effort = card?.card.kind === "effort";
  const stays = card?.card.oneOff ? "One-offs stays active" : !effort ? "this card stays active" : "it's on hold";
  set("hold", live && !card!.card.oneOff && effort, card ? stays : deck ? NO_CARD : "Efforts only");
  set("complete", live && !card!.card.oneOff && effort, card ? stays : deck ? NO_CARD : "Efforts only");
  set("promote", service && card!.card.stats.open > 0, service ? "no open PRs here" : card ? "only a service card promotes" : deck ? NO_CARD : "Efforts only");
  set("tiles", !!card, deck ? NO_CARD : "Efforts only");
  for (const id of ["merge", "confirm", "nudge", "request", "ready"] as const) {
    if (!deck) { set(id, !!prs?.moves.has(id), prs?.row ? "the row has no such move" : "focus a row first"); continue; }
    set(id, live && targets(id, context).length > 0, !card ? NO_CARD : NOTHING[id]);
  }
  set("undo", context.undo, "nothing to undo");
  const row = deck ? !!focused?.row && !focused.ghost : !!prs?.row;
  set("hold-pr", row, "focus a row first");
  set("refresh", row, "focus a row first");
  set("row-next", true); set("row-prev", true);
  set("select", deck && !!focused && !focused.dim, deck ? "focus a live row first" : "Efforts only");
  set("select-section", deck && !!focused, deck ? "focus a row first" : "Efforts only");
  set("expand", deck && !!focused, deck ? "focus a row first" : "Efforts only");
  set("clear", selected.length > 0, "nothing selected");
  set("open-thread", deck ? !!focused?.row?.thread : !!prs?.thread, row ? "the row has no thread" : "focus a row first");
  set("open-pr", row, "focus a row first");
  set("accept", sorting, service ? "focus a row first" : "only a service card's rows move from here");
  set("move", sorting, service ? "focus or select a row" : "only a service card's rows move from here");
  set("one-off", sorting, service ? "focus or select a row" : "only a service card's rows move from here");
  set("new-effort", service && selected.length > 0, service ? "select rows first" : "only a service card's rows move from here");
  set("rule", deck, "Efforts only");
  set("seed", deck, "Efforts only");
  set("palette", true); set("help", true);
  return out;
}

/** The few keys that matter now, for the hint bar: [kbd, what it does]. */
export function hintKeys(context: KeyContext, on: Availability): [string, string][] {
  const { focused } = context;
  const pick = (...items: ([DeckActionId, string] | false)[]) => items.flatMap((item) => item && on[item[0]].on ? [[ACTION[item[0]].keys.join(" "), item[1]] as [string, string]] : []);
  const move = (["merge", "confirm", "nudge", "request", "ready"] as const).find((id) => on[id].on && (context.view === "prs" || (focused?.needs && focused.section === SECTION_OF[id])));
  const moveHint = move ? [move, move === "merge" ? "preview merge" : ACTION[move].title.replace("…", "").toLowerCase()] as [DeckActionId, string] : false;
  if (context.view === "prs") return pick(["row-next", "rows"], moveHint, ["open-thread", "open thread"], ["view", "Efforts"]);
  if (context.selected.length) return [["x", "toggle"], ...pick(["advance", "advance"], ["accept", "accept"], ["move", "move…"], ["clear", "clear"])];
  if (focused?.dim) return pick(["row-next", "rows"], ["undo", "undo"], ["expand", "details"], ["seen", "mark seen"]);
  if (focused && context.cur?.card.kind === "service") return pick(["row-next", "rows"], moveHint, ["accept", "accept"], ["move", "move…"], ["expand", "details"]);
  if (focused) return pick(["row-next", "rows"], moveHint, ["select", "select"], ["expand", "details"], ["open-thread", "open thread"]);
  return pick(["next", "flip"], ["row-next", "rows"], ["advance", "advance"], ["seen", "mark seen"], ["merge", "merge"]);
}

/** One palette entry: a registry action, or a go-to, resume, or reopen for one effort. */
export type PaletteItem = { key: string; group: string; title: string; keys: readonly string[]; on: boolean; why: string; action: DeckAction | null;
  target?: { kind: "go" | "resume" | "reopen"; id: string } };
/** Every action with its key, then each effort to go to, resume, or reopen; grayed with why when it can't run here. */
export function paletteItems(on: Availability, chips: readonly Chip[], piles: { held: readonly { id: string; name: string }[];
  done: readonly { id: string; name: string; archived: boolean }[] }, cur: string | null, deck: boolean): PaletteItem[] {
  const items: PaletteItem[] = DECK_ACTIONS.filter((action) => action.id !== "jump").map((action) => ({ key: action.id, group: action.group, title: action.title,
    keys: action.keys, on: on[action.id].on, why: on[action.id].why, action }));
  items.push(...chips.map((chip) => ({ key: `go:${chip.id}`, group: "Deck", title: `Go to ${chip.name}`, keys: chip.n ? [String(chip.n)] : [],
    on: !deck || chip.id !== cur, why: "you're here", action: null, target: { kind: "go" as const, id: chip.id } })));
  items.push(...piles.held.map((item) => ({ key: `resume:${item.id}`, group: "Card", title: `Resume ${item.name}`, keys: [], on: true, why: "", action: null,
    target: { kind: "resume" as const, id: item.id } })));
  items.push(...piles.done.map((item) => ({ key: `reopen:${item.id}`, group: "Card", title: `Reopen ${item.name}`, keys: [], on: !item.archived,
    why: "archived: restore it first", action: null, target: { kind: "reopen" as const, id: item.id } })));
  return items;
}
/** The palette's matches for what you typed: a word of the title or group, or a key. */
export function paletteMatch(items: readonly PaletteItem[], query: string): PaletteItem[] {
  const q = query.trim().toLowerCase();
  return q ? items.filter((item) => `${item.group} ${item.title}`.toLowerCase().includes(q) || item.keys.some((key) => key.toLowerCase() === q)) : [...items];
}
