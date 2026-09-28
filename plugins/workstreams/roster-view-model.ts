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

/** The rows an admitted command named, which settle into their new groups at once: you caused the move, so it isn't news. */
export function ackRows(parts: AckParts): number[] {
  const lists = [...parts.added.map((added) => added.targets), parts.kept, parts.leftAlone, ...parts.holds.map((hold) => hold.targets), parts.released, parts.superseded,
    parts.dropped, ...parts.interventions.map((item) => item.targets), ...parts.starting.map((item) => item.targets)];
  return [...new Set(lists.flat().flatMap((item) => item.n === null ? [] : [item.n]))];
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

/** A roster key: move, toggle the order, Mark seen, list the keys, type a command, open the row's menu, or run one of its items. */
export type KeyAction = { kind: "move"; step: 1 | -1 } | { kind: "order" | "seen" | "keys" | "menu" | "command" } | { kind: "row"; id: MenuItem["id"] };
/**
 * What a key does on the roster, or null for a key it leaves alone. Shift, never a letter's case, picks ⇧R and ⇧S, so Caps Lock can't
 * turn Refresh into Reset or the order toggle into Stop. Space and Enter on a button or link stay that control's own.
 */
export function rosterKey(event: { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean },
  on: { control: boolean; held: boolean }): KeyAction | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  const key = /^[a-z]$/iu.test(event.key) ? event.shiftKey ? event.key.toUpperCase() : event.key.toLowerCase() : event.key;
  switch (key) {
    case "j": case "ArrowDown": return { kind: "move", step: 1 };
    case "k": case "ArrowUp": return { kind: "move", step: -1 };
    case "s": return { kind: "order" };
    case " ": return on.control ? null : { kind: "seen" };
    case "?": return { kind: "keys" };
    case "/": return { kind: "command" };
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
  ["j / k", "Next / previous row"],
  ["Enter", "Open the row's thread"],
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
