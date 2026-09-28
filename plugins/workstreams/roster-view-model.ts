// The roster pane's view model: pure functions from effort_roster_get's output
// to what the pane draws. It computes no gate, readiness, staleness, or wake;
// the server decided those, so the pane, the CLI, and the thread can't
// disagree. It imports types and roster-shared.ts only, which keeps server
// modules out of the browser bundle (plan amendment A12.1).
import type { EffortRoster, RosterRow } from "./effort-roster";
import { EFFECT_LABEL, formatTargets, ROLLUP_LABELS, STATE_LABEL } from "./roster-shared";

export type RosterOrder = "number" | "state";
/** Where a row sits by state. A row an open system issue names sits under System issues whatever its own state. */
export type GroupKey = "decision" | "issue" | "doing" | "waiting" | "ready" | "not-in-instruction" | "done";
/** Each row's group as you last saw it: rows move between groups, or fold into Done, only when you Mark seen. */
export type Settled = ReadonlyMap<number, GroupKey>;
/** What you last marked seen: the roster's journal sequence then, and when. */
export type Seen = { seq: number; at: number };
/** Amber belongs to decisions and rose to system issues; everything else is neutral. */
export type Tone = "decision" | "issue" | null;

export type Chip = {
  kind: "held" | "done" | "left-alone" | "launch" | "decision" | "issue" | "merge" | "plan" | "thread" | "new-worker" | "code" | "ci" | "reviewer" | "parent" | "owner";
  label: string;
  /** The full reason, for the chip's tooltip. */
  title: string;
  tone: Tone;
  /** The worker thread the chip stands for, whose live indicator animates it. */
  threadId: string | null;
  progress: { done: number; total: number; failed: number } | null;
  /** The roster row the chip points at: a stacked child's parent. */
  rowN: number | null;
};
export type MenuItem = {
  id: "refresh" | "recheck" | "reset" | "hold" | "release" | "retry" | "stop" | "thread" | "pr";
  label: string;
  /** The command the item sends, shown beside it; null for navigation. */
  command: string | null;
  key: string;
  enabled: boolean;
  /** Why a disabled item can't run now. */
  why: string | null;
  /** Drops a launch claim, so it asks you to confirm no worker is writing first. */
  confirm: boolean;
};
export type RosterLine = {
  n: number; target: string; repo: string; number: number; title: string; draft: boolean;
  reviewer: { login: string; more: string[] } | null;
  /** `short` is the state cell's label: the state, abbreviated, with its modifiers. */
  state: { label: string; short: string; tone: Tone };
  chip: Chip;
  /** Owner and wake first, then the server's detail. */
  next: { lead: string; detail: string | null };
  seen: { age: string; stale: boolean; failed: boolean };
  /** It changed since you last marked seen. */
  changed: boolean;
  held: boolean; leftAlone: boolean;
  /** Stack depth under its parent, and its branch glyph. */
  depth: number; branch: "├" | "└" | null;
  threadId: string | null;
  menu: MenuItem[];
};
export type RosterGroup = {
  key: GroupKey | "open" | "tickets";
  label: string | null;
  collapsed: boolean;
  lines: RosterLine[];
  /** A collapsed group's one-line summary. */
  summary: string;
  tickets: EffortRoster["ticketsWithoutPrs"];
};
export type SincePart = { chips: { label: string; tone: Tone }[]; text: string };
export type RosterView = {
  header: { name: string; instruction: string | null; snapshot: string | null; execution: string | null; note: string | null };
  ribbon: { n: number; group: GroupKey; held: boolean; leftAlone: boolean; stale: boolean; changed: boolean }[];
  legend: { decide: number; system: number; ready: number };
  rollup: { label: string; text: string; tone: Tone }[];
  since: { at: string | null; parts: SincePart[]; handled: number | null; settling: number };
  /** Nothing asks for you: the line naming the next wake; null while a decision or system issue is open. */
  empty: string | null;
  groups: RosterGroup[];
  /** Row numbers in the order j and k walk them: every line in an expanded group. */
  order: number[];
};

const GROUPS: { key: GroupKey; label: string; collapsed: boolean }[] = [
  { key: "decision", label: "Needs a decision", collapsed: false },
  { key: "issue", label: "System issues", collapsed: false },
  { key: "doing", label: STATE_LABEL.doing, collapsed: false },
  { key: "waiting", label: STATE_LABEL.waiting, collapsed: false },
  { key: "ready", label: STATE_LABEL.ready, collapsed: false },
  { key: "not-in-instruction", label: STATE_LABEL["not-in-instruction"], collapsed: true },
];
const LEGACY_WHY = "Runs on legacy launchers; move it to its roster first";
const OWNER_LABEL: Record<NonNullable<RosterRow["owner"]>, string> = { you: "you", ci: "CI", reviewer: "review", parent: "parent", github: "GitHub",
  "legacy-job": "legacy", run: "action", dispatch: "dispatch", thread: "thread", v2: "v2" };

/** An observation's or hold's age: 25s, 52m, 5h, 2d. */
export function age(at: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1_000));
  return seconds < 60 ? `${seconds}s` : seconds < 3_600 ? `${Math.floor(seconds / 60)}m` : seconds < 86_400 ? `${Math.floor(seconds / 3_600)}h` : `${Math.floor(seconds / 86_400)}d`;
}

/** A time of day today, else a date: "11:32", "Sep 26". */
export function clock(at: number, now: number): string {
  const when = new Date(at);
  return when.toDateString() === new Date(now).toDateString()
    ? when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    : when.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** The row's group by state, before settling: its decision first, then an open system issue that names it. */
export function liveGroup(row: RosterRow, roster: Pick<EffortRoster, "issues">): GroupKey {
  if (row.state === "decision" || row.state === "done") return row.state;
  return roster.issues.some((issue) => issue.numbers.includes(row.n)) ? "issue" : row.state;
}

/** The settled snapshot: every row in its live group. Taken on first load and on Mark seen. */
export function settle(roster: Pick<EffortRoster, "rows" | "issues">): Map<number, GroupKey> {
  return new Map(roster.rows.map((row) => [row.n, liveGroup(row, roster)]));
}

const threadOf = (row: RosterRow) => row.claim?.threadId ?? row.work?.resource?.threadId ?? null;
/** What releasing a held row leaves: it joins only an instruction that includes it, and one that leaves it alone keeps it out (A2). */
const afterRelease = (row: RosterRow) => row.membership === "included" ? `release ${row.n} to include`
  : row.membership === "excluded" ? "also left alone this instruction" : null;

/** The one chip that names who acts next, from server fields only (V2-UI-SPEC §4.4). A hold overrides every other. */
export function ownerChip(row: RosterRow, roster: Pick<EffortRoster, "decisions" | "issues">, now: number): Chip {
  const chip = (kind: Chip["kind"], label: string, title: string, extra: Partial<Chip> = {}): Chip =>
    ({ kind, label, title, tone: null, threadId: null, progress: null, rowN: null, ...extra });
  if (row.hold) return chip("held", `held ${age(row.hold.heldAt, now)}`,
    `Held by you${row.hold.reason ? `: ${row.hold.reason}` : ""}. ${["A hold outlasts every instruction", afterRelease(row)].filter(Boolean).join("; ")}.`);
  if (row.state === "done") return chip("done", row.cause === "closed" ? "closed" : "merged", row.label);
  if (row.membership === "excluded") return chip("left-alone", "left alone", `Left alone for this instruction only, not a hold. ${row.label}`);
  if (row.claim && row.claim.status !== "running") return chip("launch", "launch?", row.label, { threadId: row.claim.threadId });
  if (row.state === "decision") {
    const decision = roster.decisions.find((item) => item.targets.some((target) => target.target === row.target));
    return chip("decision", decision ? `D${decision.n}` : "decide", decision?.question ?? row.label, { tone: "decision" });
  }
  const issue = roster.issues.find((item) => item.numbers.includes(row.n));
  if (row.state === "issue" || issue) return chip("issue", issue?.ref ?? "system", issue?.label ?? row.label, { tone: "issue" });
  if (row.state === "ready") return chip("merge", "you · merge", "A verified merge candidate: merging is yours, through its fresh preview");
  if (row.modifiers.includes("plan only")) return chip("plan", "plan", `Dry run: planned, and nothing runs. ${row.label}`);
  const work = row.work;
  if (row.state === "doing" && work?.executor === "worker") {
    const fresh = work.resource?.kind === "spawn" || work.resource?.kind === "worktree";
    return chip(fresh ? "new-worker" : "thread", fresh ? "new worker" : "thread", work.resource?.reason ?? (fresh ? "A new worker thread" : "A worker in an existing thread"),
      { threadId: threadOf(row) });
  }
  if (row.state === "doing" && work?.executor) return chip("code", "code", "Code runs this step; no model");
  if (row.cause === "ci" && row.checkCounts) {
    const counts = row.checkCounts;
    return chip("ci", `CI ${counts.done}/${counts.total}`, `${counts.done} of ${counts.total} checks finished${counts.failed ? `, ${counts.failed} failed` : ""}`, { progress: counts });
  }
  if (row.cause === "review") return chip("reviewer", row.requested[0] ? `@${row.requested[0]}` : "review", row.label);
  if (row.cause === "parent") return chip("parent", `↱ ${row.stack?.parentN ?? "parent"}`, row.label, { rowN: row.stack?.parentN ?? null });
  return chip("owner", row.owner ? OWNER_LABEL[row.owner] : "—", row.label);
}

/** The row menu: every item stays visible, and a disabled one says why (V2-UI-SPEC §4.5). */
export function rowMenu(row: RosterRow, roster: Pick<EffortRoster, "execution">): MenuItem[] {
  const n = row.n;
  const legacy = roster.execution.mode !== "v2";
  const item = (id: MenuItem["id"], label: string, command: string | null, key: string, check: { ok: boolean; why: string | null }, confirm = false): MenuItem =>
    ({ id, label, command, key, enabled: check.ok, why: check.ok ? null : check.why, confirm });
  const command = (check: { ok: boolean; why: string | null }) => legacy ? { ok: false, why: LEGACY_WHY } : check;
  const thread = threadOf(row);
  const { recheck, reset, retry, stop } = row.actions;
  return [
    item("refresh", "Refresh", `refresh ${n}`, "r", { ok: true, why: null }),
    item("recheck", "Recheck", `recheck ${n}`, "c", command(recheck)),
    item("reset", reset.release ? "Reset…" : "Reset", reset.release ? `reset ${n} release` : `reset ${n}`, "⇧R", command(reset), reset.release),
    row.hold ? item("release", "Release", `release ${n}`, "h", command({ ok: true, why: null }))
      : item("hold", "Hold…", `hold ${n} because …`, "h", command(row.state === "done" ? { ok: false, why: "Done rows can't be held" } : { ok: true, why: null })),
    item("retry", "Retry", `retry ${n}`, "t", command(retry)),
    item("stop", "Stop", `stop ${n}`, "⇧S", command(stop)),
    item("thread", "Open thread", null, "⏎", thread ? { ok: true, why: null } : { ok: false, why: "No thread yet" }),
    item("pr", "Open PR", null, "o", { ok: true, why: null }),
  ];
}

/** What choosing a row's menu item, or pressing its key, does. Only `send` writes; a reset that drops a launch claim confirms first. */
export type RowIntent = { kind: "refuse"; command: string; why: string } | { kind: "open-pr"; url: string } | { kind: "open-thread"; threadId: string }
  | { kind: "refresh"; command: string } | { kind: "hold" } | { kind: "confirm-reset" } | { kind: "send"; command: string };
export function rowIntent(line: RosterLine, id: MenuItem["id"]): RowIntent | null {
  const item = line.menu.find((entry) => entry.id === id);
  if (!item) return null;
  if (!item.enabled) return { kind: "refuse", command: item.command ?? item.label, why: item.why ?? "Not available now" };
  if (id === "pr") return { kind: "open-pr", url: line.target };
  if (id === "thread") return line.threadId ? { kind: "open-thread", threadId: line.threadId } : null;
  if (id === "refresh") return { kind: "refresh", command: item.command! };
  if (id === "hold") return { kind: "hold" };
  if (item.confirm) return { kind: "confirm-reset" };
  return { kind: "send", command: item.command! };
}

/**
 * What Hold sends: `hold N`, or `hold N because <reason>`. A `;`, comma, newline, or sentence-ending period would end the reason
 * and let the rest read as more commands, such as `D1 A` or `move 5 forward`, so each becomes a space: the reason stays one hold's words.
 */
export function holdCommand(n: number, reason: string): string {
  const words = reason.replace(/[;,\n\r]|\.(?=\s|$)/gu, " ").replace(/\s+/gu, " ").trim();
  return words ? `hold ${n} because ${words}` : `hold ${n}`;
}

/** A row command's effort_command input. It shows no decisions, so the server refuses any `Dn` answer in it: only a decision surface answers. */
export function rowCommandInput(roster: Pick<EffortRoster, "effort" | "snapshotId" | "instruction">, text: string, requestId: string) {
  return { effortId: roster.effort.id, snapshotId: roster.snapshotId, text, requestId, source: "panel" as const,
    ...roster.instruction ? { expectedRevision: roster.instruction.revision } : {} };
}

/**
 * The command box's effort_command input: the snapshot the pane rendered, the instruction revision it showed, and each decision it shows
 * at the revision it shows, so a `Dn` answer applies only to the question you read.
 */
export function commandInput(roster: Pick<EffortRoster, "effort" | "snapshotId" | "instruction" | "decisions">, text: string, requestId: string) {
  return { ...rowCommandInput(roster, text, requestId), decisions: roster.decisions.map(({ n, revision }) => ({ n, revision })) };
}

type ServerResult = NonNullable<EffortRoster["lastCommand"]>["result"];
export type AckParts = NonNullable<Extract<ServerResult, { kind: "admit" }>["parts"]>;
/** A command and what came back: the server's result, or the error that refused it before any result. `fresh` means this visit sent it. */
export type CommandRecord = Omit<NonNullable<EffortRoster["lastCommand"]>, "result"> & {
  result: ServerResult | { kind: "error"; message: string }; fresh: boolean };
export type AckChip = { label: string; kind: "added" | "kept" | "alone" | "held" | "change" | "no" };
export type AckDetail = { label: string; numbers: string | null; text: string };
export type AckView = { command: string; meta: string; kind: CommandRecord["result"]["kind"]; chips: AckChip[]; details: AckDetail[];
  /** A clarification's, refusal's, or held answer's message; `normalized` is the reading a clarification offers to use. */
  message: string | null; normalized: string | null; fresh: boolean };

const ORIGIN_LABEL: Record<NonNullable<CommandRecord["origin"]>, string> = { panel: "roster", banner: "banner", thread: "thread", cli: "CLI" };
/** A moment today to the second, else its date: "11:26:02", "Sep 26". */
function stamp(at: number, now: number): string {
  const when = new Date(at);
  return when.toDateString() === new Date(now).toDateString() ? when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
    : clock(at, now);
}

/** The acknowledgment's chip row: what changed, what stays out, and every held target, always ending with `no merge` (A2, A8). */
export function ackChips(parts: AckParts, mergePreviews: readonly { target: string; n: number | null }[] = []): AckChip[] {
  const named = new Set(parts.holds.flatMap((hold) => hold.targets.map((item) => item.target)));
  const held = parts.held.filter((item) => !named.has(item.target));
  const chip = (kind: AckChip["kind"], label: string): AckChip => ({ kind, label });
  const some = <T,>(list: readonly T[], make: () => AckChip) => list.length ? [make()] : [];
  return [
    ...parts.answers.map((answer) => chip("change", `D${answer.n} answered`)),
    ...parts.added.map((added) => chip("added", `+${formatTargets(added.targets)} added`)),
    ...some(parts.kept, () => chip("kept", `${formatTargets(parts.kept)} kept`)),
    ...some(parts.leftAlone, () => chip("alone", `${formatTargets(parts.leftAlone)} left alone, not a hold`)),
    ...parts.holds.map((hold) => chip("held", `${formatTargets(hold.targets)} now held`)),
    ...some(held, () => chip("held", `${formatTargets(held)} held, hold wins`)),
    ...some(parts.released, () => chip("change", `${formatTargets(parts.released)} released`)),
    ...some(parts.superseded, () => chip("change", `${formatTargets(parts.superseded)} superseded`)),
    ...some(parts.dropped, () => chip("change", `${formatTargets(parts.dropped)} dropped`)),
    ...parts.interventions.map((item) => chip("change", `${item.action} ${formatTargets(item.targets)}${item.release ? " release" : ""}`)),
    ...some(mergePreviews, () => chip("change", `${formatTargets(mergePreviews)} to the merge preview`)),
    chip("no", "no merge"),
  ];
}

/** Text lines the parts already say; any other line (a recheck's finding, a readback, an outcome) still shows under Also. */
const SAID_BY_PARTS = /^(?:Added: |Still included: |Already included, |Still left alone |Superseded: |Dropped: |Left alone this instruction|Held, skipped |Effects: |Now held: |Released: |(?:Refresh|Recheck|Reset|Stop|Retry): |Reset, releasing |Merge .*: open the fresh merge preview|Next(?: \(planned[^)]*\))?: |D\d+: )/u;
const placeOf = (resource: AckParts["starting"][number]["resource"]) => !resource ? null
  : `${resource.kind === "spawn" || resource.kind === "worktree" ? "new worker" : "reused thread"}${resource.reason ? `: ${resource.reason}` : ""}`;

/**
 * The details block: Added, Kept, Excluded (this instruction only), Still held (outlasts every instruction), Effects, Not granted, and
 * Starting, each only when it has something, then any acknowledgment line the parts don't say.
 */
export function ackDetails(parts: AckParts, revision: number | null, lines: readonly string[] = []): AckDetail[] {
  const t = formatTargets;
  const named = new Set(parts.holds.flatMap((hold) => hold.targets.map((item) => item.target)));
  const held = parts.held.filter((item) => !named.has(item.target));
  const detail = (label: string, numbers: string | null, text: string): AckDetail => ({ label, numbers, text });
  const some = <T,>(list: readonly T[], make: () => AckDetail) => list.length ? [make()] : [];
  const also = lines.filter((line) => !SAID_BY_PARTS.test(line));
  // Releasing a held row includes it only where the instruction does; one this command leaves alone stays out (A2).
  const within = (list: readonly { target: string }[]) => held.filter((item) => list.some((other) => other.target === item.target));
  const rejoin = within([...parts.added.flatMap((added) => added.targets), ...parts.kept, ...parts.stillIncluded]);
  const alone = within(parts.leftAlone);
  return [
    ...parts.answers.map((answer) => detail(`D${answer.n}`, null, answer.answer)),
    ...parts.added.map((added) => detail("Added", t(added.targets), `${added.verb}${revision === null ? "" : ` · rev ${revision}`}`)),
    ...some(parts.kept, () => detail("Kept", t(parts.kept), "already included; effects unchanged")),
    ...some(parts.stillIncluded, () => detail("Still included", t(parts.stillIncluded), "not named here; unchanged")),
    ...some(parts.leftAlone, () => detail("Excluded", t(parts.leftAlone), "this instruction only, not a hold")),
    ...parts.holds.map((hold) => detail("Now held", t(hold.targets), `${hold.reason ? `because ${hold.reason} · ` : ""}outlasts every instruction`)),
    ...some(held, () => detail("Still held", t(held), ["outlasts every instruction", rejoin.length ? `release ${t(rejoin)} to include` : null,
      alone.length ? `${t(alone)} also left alone this instruction` : null].filter(Boolean).join(" · "))),
    ...some(parts.released, () => detail("Released", t(parts.released), "rejoins the instruction wherever it includes them")),
    ...some(parts.superseded, () => detail("Superseded", t(parts.superseded), "left the instruction; a running turn finishes first")),
    ...some(parts.dropped, () => detail("Dropped", t(parts.dropped), "removed from the instruction")),
    ...some(parts.effects, () => detail("Effects", null, parts.effects.map((group) => `${t(group.targets)} ${group.effects.map((effect) => EFFECT_LABEL[effect]).join(", ")}`).join("; "))),
    ...parts.added.length || parts.notGranted.length ? [detail("Not granted", null, [...parts.notGranted.map((effect) => EFFECT_LABEL[effect]), "merge"].join(", "))] : [],
    ...some(parts.starting, () => detail("Starting", null, parts.starting.map((item) =>
      [`${t(item.targets)} ${item.step.replaceAll("_", " ")}`, placeOf(item.resource)].filter(Boolean).join(" · ")).join(" · "))),
    ...some(also, () => detail("Also", null, also.join(" · "))),
  ];
}

/** What the pane shows for a command: the text you sent, where and when, the chip row, and the details block. */
export function ackView(record: CommandRecord, now: number): AckView {
  const { result } = record;
  const meta = [record.origin ? ORIGIN_LABEL[record.origin] : null, stamp(record.at, now), record.revision === null ? null : `rev ${record.revision}`, record.snapshotId,
    record.origin === "thread" ? null : "0 model turns"].filter(Boolean).join(" · ");
  const base = { command: record.text, meta, kind: result.kind, chips: [], details: [], message: null, normalized: null, fresh: record.fresh };
  if (result.kind === "error") return { ...base, message: result.message };
  if (result.kind === "clarify") return { ...base, message: result.message, normalized: result.normalized };
  if (result.kind === "pending") return { ...base, message: `Waits for Undo until ${stamp(result.until, now)}; nothing changes before then` };
  if (!result.parts) return { ...base, chips: [{ kind: "no", label: "no merge" }], details: result.acknowledgment.map((line) => ({ label: "Said", numbers: null, text: line })) };
  return { ...base, chips: ackChips(result.parts, result.mergePreviews), details: ackDetails(result.parts, result.revision, result.acknowledgment) };
}

/**
 * The command the last-command line shows: this visit's, until the journal has a newer one. A held answer reads as waiting for Undo only
 * until the server journals what became of it under the same request, admitted or refused.
 */
export function shownCommand(record: CommandRecord | null, journaled: EffortRoster["lastCommand"]): CommandRecord | null {
  const last = journaled && { ...journaled, fresh: false };
  if (!record || !last) return record ?? last;
  if (record.requestId === last.requestId) return record.result.kind === "pending" ? { ...last, fresh: record.fresh } : record;
  return record.at >= last.at ? record : last;
}

/** The rows an admitted command named, which settle into their new groups at once: you caused the move, so it isn't news. */
export function ackRows(parts: AckParts): number[] {
  const lists = [...parts.added.map((added) => added.targets), parts.kept, parts.leftAlone, ...parts.holds.map((hold) => hold.targets), parts.released, parts.superseded,
    parts.dropped, ...parts.interventions.map((item) => item.targets), ...parts.starting.map((item) => item.targets)];
  return [...new Set(lists.flat().flatMap((item) => item.n === null ? [] : [item.n]))];
}

/** effort_parent_context: what the parent thread's composer banner shows, and the snapshot and decisions a command typed there reads. */
export type ParentContext = { effort: { id: string; name: string; archived: boolean }; snapshotId: string | null; revision: number | null;
  decisions: readonly { n: number; revision: number }[]; counts: Readonly<Record<"doing" | "waiting" | "decision" | "ready" | "issue" | "done", number>>;
  /** Open system issues as the roster lists them, paused launches included, which hold no row in an issue. */
  issues: number };

/** The banner's one-line summary: the instruction's revision, then what needs you, counted by decision and system issue rather than by the rows that wait on them. */
export function parentSummary(context: ParentContext): string {
  const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const { decisions, issues, counts } = context;
  return ["Effort parent", context.revision === null ? "no instruction" : `rev ${context.revision}`,
    decisions.length ? plural(decisions.length, "decision", "decisions") : null, issues ? plural(issues, "system issue", "system issues") : null,
    !decisions.length && !issues ? "no asks" : null, `${counts.ready} ready`, context.effort.archived ? "archived" : null].filter(Boolean).join(" · ");
}

/** A command typed in the parent's banner: its source is the banner, and it answers only decisions the banner's context showed. It never waits for Undo. */
export function bannerCommandInput(context: ParentContext, text: string, requestId: string) {
  return { effortId: context.effort.id, snapshotId: context.snapshotId, text, requestId, source: "banner" as const,
    ...context.revision === null ? {} : { expectedRevision: context.revision }, decisions: context.decisions.map(({ n, revision }) => ({ n, revision })) };
}

/** A number cell's click composes into the command box: it appends the number, and with Shift turns the last number or range into a range to it. */
export function composeNumber(text: string, n: number, shift: boolean): string {
  const last = shift ? /(\d+)(?:-\d+)?\s*$/u.exec(text) : null;
  if (last && Number(last[1]) !== n) return `${text.slice(0, last.index)}${Math.min(Number(last[1]), n)}-${Math.max(Number(last[1]), n)}`;
  return text && !/\s$/u.test(text) ? `${text} ${n}` : `${text}${n}`;
}

/** What the next-owner cell leads with: who acts and what wakes the row, then the server's detail. */
function nextOf(row: RosterRow, roster: EffortRoster, now: number, titles: ReadonlyMap<string, string>): RosterLine["next"] {
  const detail = row.label || null;
  const named = (id: string | null) => id && titles.get(id) ? `"${titles.get(id)}"` : null;
  if (row.hold) return { lead: [`held by you ${age(row.hold.heldAt, now)}${row.hold.reason ? `: "${row.hold.reason}"` : ""}`, afterRelease(row)].filter(Boolean).join(" · "), detail: null };
  if (row.membership === "excluded") return { lead: `${row.membershipReason ?? "this instruction only"}, not a hold`, detail };
  if (row.claim && row.claim.status !== "running")
    return { lead: row.claim.threadId ? `likely thread ${named(row.claim.threadId) ?? ""}`.trim() : "no worker thread found yet", detail };
  if (row.state === "decision") {
    const decision = roster.decisions.find((item) => item.targets.some((target) => target.target === row.target));
    return { lead: `you${decision?.createdAt ? ` · asked ${clock(decision.createdAt, now)}${decision.source ? ` by the ${decision.source.label}` : ""}` : ""}`, detail };
  }
  if (row.state === "ready") {
    const children = roster.rows.filter((other) => other.stack?.parentN === row.n && other.state !== "done");
    return { lead: children.length ? `yours to merge · merging wakes ${formatTargets(children)}` : "yours to merge", detail };
  }
  const work = row.work;
  if (row.state === "doing" && work?.executor === "worker") {
    const fresh = work.resource?.kind === "spawn" || work.resource?.kind === "worktree";
    return { lead: fresh ? work.resource?.reason ?? "new worker" : `reused thread${named(threadOf(row)) ? ` ${named(threadOf(row))}` : ""}`, detail };
  }
  if (row.state === "doing" && work?.executor) return { lead: "code only, no model", detail };
  if (row.wake && row.state !== "done") return { lead: `wakes when ${row.wake.event} · looks again ${clock(row.wake.dueAt, now)}`, detail };
  return { lead: row.label, detail: null };
}

/** Rows the server says changed since the seen sequence: a new phase or cause, or a new head. */
const changedSince = (roster: Pick<EffortRoster, "since">) => new Set([...roster.since?.rows.map((item) => item.n) ?? [], ...roster.since?.newHeads ?? []]);

/** One row as the pane draws it. */
export function rosterLine(row: RosterRow, roster: EffortRoster, options: { now: number; settled: Settled; titles?: ReadonlyMap<string, string>;
  changed?: ReadonlySet<number> }): RosterLine {
  const { now } = options;
  const reviewers = [...row.requested, ...row.reviewers.map((review) => review.login).filter((login) => !row.requested.includes(login))];
  const since = options.changed ?? changedSince(roster);
  const settled = options.settled.get(row.n);
  // The plan chip carries "plan only"; recovering and draining stay in the label you read without hovering.
  const modifiers = row.modifiers.filter((modifier) => modifier !== "plan only");
  return {
    n: row.n, target: row.target, repo: row.repo.split("/").at(-1) ?? row.repo, number: row.number, title: row.title, draft: row.gates?.["not-draft"] === false,
    reviewer: reviewers[0] ? { login: reviewers[0], more: reviewers.slice(1) } : null,
    state: { label: [STATE_LABEL[row.state], ...modifiers].join(", "),
      short: [row.state === "not-in-instruction" ? "Not in instr." : STATE_LABEL[row.state], ...modifiers].join(", "),
      tone: row.state === "decision" ? "decision" : row.state === "issue" ? "issue" : null },
    chip: ownerChip(row, roster, now),
    next: nextOf(row, roster, now, options.titles ?? new Map()),
    seen: { age: row.observedAt === null ? "never" : age(row.observedAt, now), stale: row.stale,
      failed: row.failedAt !== null && (row.observedAt === null || row.failedAt > row.observedAt) },
    changed: since.has(row.n) || (settled !== undefined && settled !== liveGroup(row, roster)),
    held: row.hold !== null, leftAlone: row.membership === "excluded", depth: 0, branch: null, threadId: threadOf(row),
    menu: rowMenu(row, roster),
  };
}

/** Rows in number order, each stack parent followed by the children stacked on it in the same group, at any depth. */
function stacked(rows: readonly RosterRow[], make: (row: RosterRow) => RosterLine): RosterLine[] {
  const here = new Set(rows.map((row) => row.n));
  const children = new Map<number, RosterRow[]>();
  const roots: RosterRow[] = [];
  for (const row of [...rows].sort((a, b) => a.n - b.n)) {
    const parent = row.stack?.parentN ?? null;
    if (parent !== null && parent !== row.n && here.has(parent)) children.set(parent, [...children.get(parent) ?? [], row]);
    else roots.push(row);
  }
  const lines: RosterLine[] = [];
  const placed = new Set<number>();
  const visit = (row: RosterRow, depth: number, branch: RosterLine["branch"]) => {
    if (placed.has(row.n)) return;
    placed.add(row.n);
    lines.push({ ...make(row), depth, branch });
    const kids = children.get(row.n) ?? [];
    kids.forEach((kid, index) => visit(kid, depth + 1, index === kids.length - 1 ? "└" : "├"));
  };
  for (const row of roots) visit(row, 0, null);
  // A stack that loops back on itself has no root; its rows still show.
  for (const row of rows) visit(row, 0, null);
  return lines;
}

/** The two waits that wake first, by the reconciler's own due time; never a guessed duration. */
export function nextWake(roster: EffortRoster, now: number): string {
  const ready = roster.rows.filter((row) => row.state === "ready").length;
  const head = ready ? `No asks · ${ready} ready to merge` : "Nothing needs you";
  const waits = roster.rows.filter((row) => row.state === "waiting" && !row.hold && row.wake).sort((a, b) => a.wake!.dueAt - b.wake!.dueAt).slice(0, 2);
  const name = (row: RosterRow) => row.cause === "ci" ? "CI" : row.cause === "review" ? (row.requested[0] ? `review from @${row.requested[0]}` : "a review")
    : row.cause === "parent" ? `${row.stack?.parentN ?? "its parent"} merging` : row.wake!.event;
  const [first, second] = waits;
  if (!first) return head;
  return `${head} · next wake: ${name(first)} on ${first.n} · looks again ${clock(first.wake!.dueAt, now)}${second ? ` · then ${name(second)} on ${second.n}` : ""}`;
}

/** The pane's whole picture of one roster read. */
export function rosterView(roster: EffortRoster, options: { order: RosterOrder; now: number; settled: Settled; seen: Seen | null;
  expanded?: ReadonlySet<string>; titles?: ReadonlyMap<string, string> }): RosterView {
  const { now, settled } = options;
  const changed = changedSince(roster);
  const lines = new Map(roster.rows.map((row) => [row.n, rosterLine(row, roster, { ...options, changed })]));
  const make = (row: RosterRow) => lines.get(row.n)!;
  const groupOf = (row: RosterRow) => settled.get(row.n) ?? liveGroup(row, roster);
  const byN = new Map(roster.rows.map((row) => [row.n, row]));
  // A stack moves as a unit with its top open parent; a finished row folds into Done on its own.
  const anchor = (row: RosterRow): RosterRow => {
    const seen = new Set<number>();
    let current = row;
    while (current.stack?.parentN != null && !seen.has(current.n)) {
      seen.add(current.n);
      const parent = byN.get(current.stack.parentN);
      if (!parent || groupOf(parent) === "done") break;
      current = parent;
    }
    return current;
  };
  const sectionOf = (row: RosterRow): GroupKey => groupOf(row) === "done" ? "done" : groupOf(anchor(row));
  const done = roster.rows.filter((row) => sectionOf(row) === "done");
  const doneSummary = (rows: readonly RosterRow[]) => {
    const merged = rows.filter((row) => row.cause !== "closed");
    const closed = rows.filter((row) => row.cause === "closed");
    return [merged.length ? `${merged.map((row) => row.n).join(" ")} merged` : "", closed.length ? `${closed.map((row) => row.n).join(" ")} closed` : ""].filter(Boolean).join(" · ");
  };
  const expanded = options.expanded ?? new Set<string>();
  const group = (key: RosterGroup["key"], label: string | null, collapsed: boolean, rows: readonly RosterRow[], summary = ""): RosterGroup =>
    ({ key, label, collapsed: collapsed && !expanded.has(key), lines: stacked(rows, make), summary, tickets: [] });
  const tickets: RosterGroup = { key: "tickets", label: "Tickets without PRs", collapsed: !expanded.has("tickets"), lines: [],
    summary: roster.ticketsWithoutPrs.map((ticket) => ticket.title ? `${ticket.id} ${ticket.title}` : ticket.id).join(" · "), tickets: roster.ticketsWithoutPrs };
  const groups = [
    ...options.order === "number" ? [group("open", null, false, roster.rows.filter((row) => sectionOf(row) !== "done"))]
      : GROUPS.map((entry) => {
        const rows = roster.rows.filter((row) => sectionOf(row) === entry.key);
        return group(entry.key, entry.label, entry.collapsed, rows, entry.collapsed ? rows.map((row) => row.n).join(" ") : "");
      }),
    group("done", STATE_LABEL.done, true, done, doneSummary(done)),
    tickets,
  ].filter((entry) => entry.lines.length > 0 || entry.tickets.length > 0);

  const held = roster.rows.filter((row) => row.hold);
  const instruction = roster.instruction;
  const since = roster.since;
  const changedRows = since ? since.rows.filter((item) => {
    const row = byN.get(item.n);
    return row && row.state !== "decision" && !roster.issues.some((issue) => issue.numbers.includes(item.n));
  }) : [];
  const by = new Map<string, number[]>();
  for (const item of changedRows) {
    const row = byN.get(item.n)!;
    const text = row.state === "done" ? row.cause === "closed" ? "closed" : "merged" : `→ ${STATE_LABEL[row.state]}`;
    by.set(text, [...by.get(text) ?? [], item.n]);
  }
  const chips = (list: readonly number[]) => list.map((n) => ({ label: String(n), tone: null }));
  const asks = [...since?.decisionsOpened.map((n) => ({ label: `D${n}`, tone: "decision" as const })) ?? [],
    ...since?.issuesOpened.map((ref) => ({ label: ref, tone: "issue" as const })) ?? []];
  const parts: SincePart[] = since ? [
    ...[...by].map(([text, list]) => ({ chips: chips(list), text })),
    ...asks.length ? [{ chips: asks, text: "new" }] : [],
    ...since.newHeads.length ? [{ chips: chips(since.newHeads), text: "new head" }] : [],
  ] : [];
  const execution = roster.execution.mode !== "v2" ? "legacy launchers · read only" : roster.v2Execution === "dry-run" ? "dry run · plans only" : null;
  const excluded = instruction?.excluded.flatMap((item) => item.n === null ? [] : [{ target: item.target, n: item.n }]) ?? [];
  const groupsInOrder = groups.filter((entry) => !entry.collapsed);
  return {
    header: {
      name: roster.effort.name,
      instruction: [instruction ? `rev ${instruction.revision}` : null,
        instruction ? `includes ${formatTargets(instruction.included.map((n) => ({ target: "", n }))) || "nothing"}` : null,
        excluded.length ? `not ${formatTargets(excluded)}` : null,
        held.length ? `${formatTargets(held)} held` : null,
        instruction?.reportMode === "decisions-only" ? "decisions only" : null].filter(Boolean).join(" · ") || null,
      snapshot: roster.snapshotId, execution,
      note: roster.effort.archivedAt ? "archived" : roster.effort.redirectedFrom ? `merged from ${roster.effort.redirectedFrom}` : null,
    },
    ribbon: [...lines.values()].map((line) => ({ n: line.n, group: liveGroup(byN.get(line.n)!, roster), held: line.held, leftAlone: line.leftAlone, stale: line.seen.stale, changed: line.changed })),
    legend: { decide: roster.rows.filter((row) => row.state === "decision").length, system: roster.issues.length,
      ready: roster.rows.filter((row) => row.state === "ready").length },
    rollup: (roster.rollup ?? []).map((text, index) => {
      const cut = text.indexOf(": ");
      const label = cut > 0 ? text.slice(0, cut) : ROLLUP_LABELS[index] ?? "";
      const body = cut > 0 ? text.slice(cut + 2) : text;
      return { label, text: body, tone: label === ROLLUP_LABELS[3] && body !== "none" ? "decision" : null };
    }),
    since: { at: options.seen ? clock(options.seen.at, now) : null, parts, handled: since?.handled ?? null,
      settling: roster.rows.filter((row) => settled.has(row.n) && settled.get(row.n) !== liveGroup(row, roster)).length },
    empty: roster.decisions.length === 0 && roster.issues.length === 0 ? nextWake(roster, now) : null,
    groups,
    order: groupsInOrder.flatMap((entry) => entry.lines.map((line) => line.n)),
  };
}

/**
 * A roster key: move, toggle the order, Mark seen, list the keys, type a command, take back the latest answer, open the row's menu, or
 * run one of its items; on an ask, pick one of its options or accept it.
 */
export type KeyAction = { kind: "move"; step: 1 | -1 } | { kind: "order" | "seen" | "keys" | "menu" | "command" | "undo" | "accept" } | { kind: "row"; id: MenuItem["id"] }
  | { kind: "option"; index: number };
export type KeyEvent = { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean };
/**
 * What a key does on the roster, or null for a key it leaves alone. Shift, never a letter's case, picks ⇧R and ⇧S, so Caps Lock can't
 * turn Refresh into Reset or the order toggle into Stop. Space and Enter on a button or link stay that control's own. On an ask, a, b,
 * and c pick an option and Enter accepts; row keys do nothing there.
 */
export function rosterKey(event: KeyEvent, on: { control: boolean; held: boolean; ask?: boolean }): KeyAction | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  const key = /^[a-z]$/iu.test(event.key) ? event.shiftKey ? event.key.toUpperCase() : event.key.toLowerCase() : event.key;
  if (on.ask && ["a", "b", "c"].includes(key)) return { kind: "option", index: key.charCodeAt(0) - 97 };
  if (on.ask && key === "Enter") return on.control ? null : { kind: "accept" };
  if (on.ask && ["o", "r", "c", "h", "R", "t", "S", "."].includes(key)) return null;
  switch (key) {
    case "j": case "ArrowDown": return { kind: "move", step: 1 };
    case "k": case "ArrowUp": return { kind: "move", step: -1 };
    case "s": return { kind: "order" };
    case " ": return on.control ? null : { kind: "seen" };
    case "?": return { kind: "keys" };
    case "/": return { kind: "command" };
    case "u": return { kind: "undo" };
    case ".": return { kind: "menu" };
    case "Enter": return on.control ? null : { kind: "row", id: "thread" };
    case "o": return { kind: "row", id: "pr" };
    case "r": return { kind: "row", id: "refresh" };
    case "c": return { kind: "row", id: "recheck" };
    case "h": return { kind: "row", id: on.held ? "release" : "hold" };
    case "R": return { kind: "row", id: "reset" };
    case "t": return { kind: "row", id: "retry" };
    case "S": return { kind: "row", id: "stop" };
    default: return null;
  }
}

/** The keys the pane answers while focus is on it, never while you type in a field or the thread's composer. */
export const ROSTER_KEYS: [string, string][] = [
  ["j / k", "Next / previous ask, then row"],
  ["a / b / c", "Pick an option on a product decision; Enter sends it"],
  ["Enter", "Accept a lifecycle ask's subset, or open the row's thread; a product decision needs an option first"],
  ["u", "Undo the latest answer within its 10 seconds"],
  [".", "Open the row's menu"],
  ["r", "Refresh the row from GitHub"],
  ["c", "Recheck it"],
  ["h", "Hold or release it"],
  ["⇧R", "Reset it"],
  ["t", "Retry it"],
  ["⇧S", "Stop its worker"],
  ["o", "Open the PR"],
  ["s", "By number or by state"],
  ["Space", "Mark seen"],
  ["/", "Type a command; Esc leaves the box"],
  ["?", "These keys"],
];

// ---------------------------------------------------------------------------
// Asks: the decisions, system issues, and merge candidates that need you.
// ---------------------------------------------------------------------------

/** How long a roster answer waits for Undo before the server admits it; the server's own window, which a test holds them to. */
export const UNDO_WINDOW = 10_000 as const;
type Decision = EffortRoster["decisions"][number];
export type PendingAnswer = EffortRoster["pending"][number];
/** A drafted PR a lifecycle decision asks about, with the row that shows it. */
export type AskTarget = { n: number | null; target: string; repo: string; number: number | null; title: string; note: string | null; recommended: boolean };
export type DecisionAsk = {
  kind: "decision"; id: string; decision: Decision;
  /**
   * How it's answered: product, authority, and worker questions take an explicit option (A9 call 3); a lifecycle question takes a subset
   * of its PRs; a worker's own interaction is answered in the worker's thread.
   */
  answer: "option" | "subset" | "thread";
  /** Options you can pick, keyed a, b, c; the "in your own words" placeholder a worker question carries is the words field instead. */
  options: { id: string; key: string; label: string; consequence: string | null; recommended: boolean }[];
  targets: AskTarget[];
  /** The rows the question holds up. */
  numbers: number[];
  /** A lifecycle question's preselected subset. */
  recommended: number[];
};
export type Ask = DecisionAsk;
/** An answer the server holds for Undo, in place of its card. */
export type Receipt = PendingAnswer & { id: string; numbers: number[] };
export type AnswerReply = { optionId: string } | { numbers: number[] } | { text: string };

const numbersOf = (targets: readonly { n: number | null }[]) => targets.flatMap((item) => item.n === null ? [] : [item.n]);
function decisionAsk(decision: Decision, rows: readonly RosterRow[]): DecisionAsk {
  const options = decision.options.filter((option) => option.id !== "text").map((option, index) => ({ id: option.id, key: String.fromCharCode(97 + index),
    label: option.label, consequence: option.consequence, recommended: decision.recommendation?.optionId === option.id }));
  const targets = decision.targets.map((item) => {
    const row = rows.find((other) => other.target === item.target);
    return { n: item.n, target: item.target, repo: row?.repo.split("/").at(-1) ?? "", number: row?.number ?? null, title: row?.title ?? item.target, note: item.note,
      recommended: item.recommended ?? false };
  });
  const numbers = numbersOf(decision.targets);
  return { kind: "decision", id: `D${decision.n}`, decision, options, targets, numbers,
    answer: decision.answer === "open-thread" ? "thread" : decision.subkind ? "subset" : "option",
    recommended: decision.subkind ? (decision.recommendation?.numbers ?? numbersOf(decision.targets.filter((item) => item.recommended))).filter((n) => numbers.includes(n)) : [] };
}

/** The asks in the order you clear them: decisions by number. A decision whose answer waits for Undo shows as its receipt instead. */
export function askCards(roster: EffortRoster, pending: readonly PendingAnswer[] = roster.pending): { asks: Ask[]; receipts: Receipt[] } {
  const waiting = new Set(pending.flatMap((item) => item.decisions));
  const decisions = [...roster.decisions].sort((a, b) => a.n - b.n);
  return {
    asks: decisions.filter((decision) => !waiting.has(decision.n)).map((decision) => decisionAsk(decision, roster.rows)),
    receipts: pending.map((item) => ({ ...item, id: item.decisions.map((n) => `D${n}`).join(" "),
      numbers: numbersOf(decisions.filter((decision) => item.decisions.includes(decision.n)).flatMap((decision) => decision.targets)) })),
  };
}

/** The same answer as thread text: `D1 A`, `D2 13 15`, `D2 none`, or `D1` and your words. */
export function answerCommand(ask: DecisionAsk, reply: AnswerReply): string {
  return `${ask.id} ${"optionId" in reply ? reply.optionId : "numbers" in reply ? reply.numbers.join(" ") || "none" : reply.text}`;
}

/** Which question a decision card asks: a product decision, an authority grant, a worker's question, or a lifecycle subset. */
export const askKind = (ask: DecisionAsk): "product" | "authority" | "worker" | "lifecycle" => ask.answer === "subset" ? "lifecycle"
  : ask.decision.kind === "authority" ? "authority" : ask.decision.kind.startsWith("worker") ? "worker" : "product";
/** What a pick or a subset is kept under: the decision at the revision you read, so neither carries over to a question that changed. */
export const answerKey = (ask: DecisionAsk) => `${ask.decision.id}@${ask.decision.revision}`;

/** effort_decision_answer for a card's answer, at the revision the card showed, held for Undo. */
export function answerInput(ask: DecisionAsk, reply: AnswerReply, requestId: string) {
  return { decisionId: ask.decision.id, ...reply, expectedRevision: ask.decision.revision, requestId, delayMs: UNDO_WINDOW };
}

/** A lifecycle card's number field (`all but 14`) parses on the server, as `D2 all but 14` against only this decision, held for Undo. */
export function fieldAnswerInput(roster: Pick<EffortRoster, "effort" | "snapshotId" | "instruction">, ask: DecisionAsk, field: string, requestId: string) {
  return { ...rowCommandInput(roster, `${ask.id} ${field.trim()}`, requestId), decisions: [{ n: ask.decision.n, revision: ask.decision.revision }], delayMs: UNDO_WINDOW };
}

/** The answer `u` takes back: the newest still inside its window. */
export function latestUndo(receipts: readonly Receipt[], now: number): Receipt | null {
  return receipts.filter((item) => item.until > now).sort((a, b) => b.until - a.until)[0] ?? null;
}

/** Where keyboard focus is: an ask by id, a row by number, or nowhere. */
export type PaneFocus = { ask: string } | { row: number } | null;
/** The asks' client state: focus, the one ask open in a narrow pane, each product decision's picked option and each lifecycle subset by answerKey, and a hint. */
export type PaneState = { focus: PaneFocus; open: string | null; picks: ReadonlyMap<string, string>; subsets: ReadonlyMap<string, readonly number[]>;
  hint: { id: string; text: string } | null };
/** What a key asks the container to do. Only `answer` and `subset` send, and nothing here merges. */
export type PaneEffect = { kind: "answer"; ask: DecisionAsk; reply: AnswerReply } | { kind: "hint"; text: string }
  | { kind: "row"; n: number; id: MenuItem["id"] } | { kind: "menu"; n: number } | { kind: "order" | "seen" | "keys" | "command" | "undo" };

/** Asks an answer moves focus to: decisions and system issues, never merge candidates, so a run of Enter can't reach a merge. */
const answerable = (ask: Ask) => ask.kind === "decision";
/** The first ask focus rests on: the first one you can answer, or nothing. */
export function firstAsk(asks: readonly Ask[]): PaneFocus {
  const first = asks.find(answerable);
  return first ? { ask: first.id } : null;
}
/**
 * After an answer, focus moves on to the next ask you can answer and rests on nothing after the last, so a run of Enter never comes back
 * to one it just answered while the server holds that answer; a narrow pane opens the next one.
 */
export function afterAnswer(asks: readonly Ask[], state: PaneState, id: string, wide: boolean): PaneState {
  const next = asks.slice(asks.findIndex((ask) => ask.id === id) + 1).find(answerable);
  return { ...state, focus: next ? { ask: next.id } : null, open: wide ? state.open : next?.id ?? null, hint: null };
}

/** What Enter does on an ask: a one-line ask opens first; then only a lifecycle subset accepts without an explicit choice. */
function accept(asks: readonly Ask[], ask: Ask, state: PaneState, wide: boolean): { state: PaneState; effect: PaneEffect | null } {
  if (!wide && state.open !== ask.id) return { state: { ...state, open: ask.id, hint: null }, effect: null };
  const hint = (text: string) => ({ state: { ...state, hint: { id: ask.id, text } }, effect: { kind: "hint" as const, text } });
  if (ask.answer === "thread") return hint(`${ask.id} is answered in its worker's thread: open it from the card`);
  if (ask.answer === "option") {
    const picked = state.picks.get(answerKey(ask));
    const ids = ask.options.map((option) => option.id);
    // A question asked without options takes only your words, in its card's field.
    if (!ids.length) return hint(`${ask.id} has no options to pick: type your answer in its field, then Enter`);
    const kind = askKind(ask) === "authority" ? "authority decisions" : askKind(ask) === "worker" ? "worker questions" : "product decisions";
    if (!picked) return hint(`Pick ${ids.length > 2 ? `${ids.slice(0, -1).join(", ")}, or ${ids.at(-1)}` : ids.join(" or ")}: ${kind} need an explicit choice`);
    return { state: afterAnswer(asks, state, ask.id, wide), effect: { kind: "answer", ask, reply: { optionId: picked } } };
  }
  if (ask.decision.subkind === "request-review")
    return hint(`Name the reviewers: request review ${formatTargets(ask.targets)} from @login, or choose Don't request review`);
  return { state: afterAnswer(asks, state, ask.id, wide), effect: { kind: "answer", ask, reply: { numbers: [...state.subsets.get(answerKey(ask)) ?? ask.recommended] } } };
}

/**
 * The pane's keys as one pure step: from the asks, the rows, the client state, and a key, the next state and at most one effect. The
 * container runs the effect and nothing else, so the rules here (a product decision needs an option; Enter never merges) hold for it too.
 * `on.focus` is where DOM focus is, which wins over the remembered focus. Null leaves the key to the browser.
 */
export function paneKey(view: RosterView, asks: readonly Ask[], state: PaneState, event: KeyEvent, on: { control: boolean; wide: boolean; focus?: PaneFocus })
  : { state: PaneState; effect: PaneEffect | null } | null {
  const focus = on.focus === undefined ? state.focus : on.focus;
  const ask = focus && "ask" in focus ? asks.find((item) => item.id === focus.ask) ?? null : null;
  const line = focus && "row" in focus ? view.groups.flatMap((group) => group.lines).find((item) => item.n === focus.row) ?? null : null;
  const action = rosterKey(event, { control: on.control, held: line?.held ?? false, ask: ask !== null });
  if (!action) return null;
  const here: PaneState = { ...state, focus, hint: null };
  const done = (next: PaneState, effect: PaneEffect | null = null) => ({ state: next, effect });
  switch (action.kind) {
    case "move": {
      const order: NonNullable<PaneFocus>[] = [...asks.map((item) => ({ ask: item.id })), ...view.order.map((n) => ({ row: n }))];
      const index = order.findIndex((item) => JSON.stringify(item) === JSON.stringify(focus));
      const next = order[Math.min(order.length - 1, Math.max(0, index + action.step))] ?? null;
      return done({ ...here, focus: next, open: !on.wide && next && "ask" in next ? next.ask : here.open });
    }
    case "option": {
      const decision = ask?.kind === "decision" && ask.answer === "option" ? ask : null;
      const option = decision?.options[action.index];
      return decision && option ? done({ ...here, picks: new Map([...here.picks, [answerKey(decision), option.id]]), open: decision.id }) : done(here);
    }
    case "accept": return ask ? accept(asks, ask, here, on.wide) : done(here);
    case "row": return done(here, line ? { kind: "row", n: line.n, id: action.id } : null);
    case "menu": return done(here, line ? { kind: "menu", n: line.n } : null);
    default: return done(here, { kind: action.kind });
  }
}
