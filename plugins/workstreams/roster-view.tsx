// The effort roster pane (V2-UI-SPEC §3–§6), mounted beside the effort parent
// thread as a side-panel tab and full width at board/roster/<effortId>. It
// renders server state only: roster-view-model.ts shapes effort_roster_get's
// output, and every write goes through effort_reconcile or effort_command.
// RosterPane and its parts take data and callbacks as props and call no SDK
// hook, with relative imports, so static-markup tests can render them.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  experimental_useSidebarThreads,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  type JsonValue,
} from "@get-bb/plugin-sdk/app";
import type { EffortRoster } from "./effort-roster";
import type { rpcContract } from "./server";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog";
import { Button } from "./components/ui/button";
import { Icon } from "./components/ui/icon";
import { EASE_CSS } from "./layout";
import { usePortalScopeProps } from "./lib/portal-scope";
import { cn, POINTER_CURSORS } from "./lib/utils";
import { AsksBlock, type AsksProps } from "./roster-asks";
import { CommandBox, type CommandBoxProps, type RosterNote } from "./roster-command";
import { MergePreviewDialog } from "./roster-merge-dialog";
import type { RosterListEntry } from "./roster-parents";
import { HATCH, RosterList, RosterTable, TONE_CLASS, type RowActions } from "./roster-rows";
import { ROSTER_CHANGED } from "./roster-shared";
import { ackRows, ackView, afterAnswer, answerCommand, answerInput, answerKey, askCards, commandInput, composeNumber, fieldAnswerInput, firstAsk, holdCommand, latestUndo, liveGroup,
  paneKey, recoveryIntent, ROSTER_KEYS, rosterView, rowCommandInput, rowIntent, settle, shownCommand, type AnswerReply, type CommandRecord, type DecisionAsk, type GroupKey, type MenuItem,
  type Ask, type PaneEffect, type ResetConfirm, type PaneFocus, type PaneState, type RosterLine, type RosterOrder, type RosterView as View, type Seen, type SincePart } from "./roster-view-model";

export type RosterPaneProps = RowActions & {
  view: View;
  wide: boolean;
  mount: "nav" | "tab";
  /** The realtime connection is up, so the roster refreshes itself. */
  live: boolean;
  order: RosterOrder;
  focusN: number | null;
  menuN: number | null;
  liveThreads: ReadonlySet<string>;
  /** The command box, pinned to the bottom, with the last command and any note. */
  command: CommandBoxProps;
  /** Decisions and the answers waiting for Undo, above the rows. */
  asks: AsksProps;
  history: EffortRoster["history"];
  hasParent: boolean;
  onOrder(order: RosterOrder): void;
  onMarkSeen(): void;
  onHeader(action: "keys" | "full" | "parent" | "all"): void;
  onKeyDown?(event: KeyboardEvent<HTMLDivElement>): void;
  rootRef?: RefObject<HTMLDivElement | null>;
};

const RIBBON_CELL: Record<GroupKey, string> = {
  decision: TONE_CLASS.decision, issue: TONE_CLASS.issue, doing: "border-transparent bg-foreground/[0.12]", waiting: "border-transparent bg-foreground/[0.05]",
  ready: "border-foreground/45", "not-in-instruction": "border-transparent text-muted-foreground", done: "border-transparent text-muted-foreground/70",
};

function RosterHeader(props: Pick<RosterPaneProps, "view" | "wide" | "mount" | "live" | "order" | "history" | "hasParent" | "onOrder" | "onHeader">) {
  const { header } = props.view;
  const portalScope = usePortalScopeProps();
  const item = "cursor-pointer rounded px-2 py-1.5 text-[12px] outline-none focus:bg-foreground/[0.06]";
  return <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/70 px-3 py-2">
    <div className={cn("flex min-w-0 flex-1 items-baseline gap-x-2", !props.wide && "flex-wrap")}>
      <h2 className="max-w-full truncate text-[14px] font-semibold tracking-tight">{header.name}</h2>
      <span role="status" title={props.live ? "Live: the roster refreshes itself" : "Reconnecting; the roster may be behind"}
        className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
        <span aria-hidden className={cn("size-1.5 rounded-full", props.live ? "bg-emerald-500" : "bg-muted-foreground/50")} />{props.live ? "live" : "reconnecting"}
      </span>
      <span className={cn("min-w-0 truncate text-[11px] text-muted-foreground", !props.wide && "order-last basis-full")} title={[header.instruction, header.snapshot].filter(Boolean).join(" · ")}>
        {[header.instruction ?? "no instruction", header.snapshot].filter(Boolean).join(" · ")}
      </span>
      {header.execution ? <span className="shrink-0 rounded-full border border-border px-1.5 text-[11px] text-muted-foreground">{header.execution}</span> : null}
      {header.note ? <span className="shrink-0 text-[11px] text-muted-foreground">{header.note}</span> : null}
    </div>
    <div className="flex shrink-0 items-center gap-1.5">
      <div role="group" aria-label="Order" className="flex rounded-md border border-border p-0.5 text-[11px]">
        {(["number", "state"] as const).map((order) => <button key={order} type="button" aria-pressed={props.order === order} onClick={() => props.onOrder(order)}
          title={`By ${order} (s)`} className={cn("rounded px-2 py-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring",
            props.order === order ? "bg-foreground/[0.1] text-foreground" : "text-muted-foreground hover:text-foreground")}>By {order}</button>)}
      </div>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button type="button" aria-label="Roster options" title="Roster options"
            className="flex size-7 items-center justify-center rounded text-muted-foreground outline-none hover:bg-foreground/[0.07] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
            <Icon name="MoreHorizontal" className="size-4" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content {...portalScope} side="bottom" align="end" sideOffset={4} collisionPadding={8}
            className="z-50 min-w-56 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md">
            <DropdownMenu.Item className={item} onSelect={() => props.onHeader("keys")}>Keys <span className="float-right font-mono text-[11px] text-muted-foreground">?</span></DropdownMenu.Item>
            {props.mount === "tab" ? <DropdownMenu.Item className={item} onSelect={() => props.onHeader("full")}>Open full view</DropdownMenu.Item>
              : <DropdownMenu.Item className={item} onSelect={() => props.onHeader("all")}>All rosters</DropdownMenu.Item>}
            {props.mount === "tab" && props.hasParent ? <DropdownMenu.Item className={item} onSelect={() => props.onHeader("parent")}>Open parent thread</DropdownMenu.Item> : null}
            {props.history.legacyJobs ? <DropdownMenu.Label className="px-2 py-1.5 text-[11px] text-muted-foreground">
              History: {props.history.legacyJobs} legacy {props.history.legacyJobs === 1 ? "job" : "jobs"} over {props.history.legacyPrs} {props.history.legacyPrs === 1 ? "PR" : "PRs"}
            </DropdownMenu.Label> : null}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {props.mount === "nav" && props.hasParent ? <button type="button" onClick={() => props.onHeader("parent")} title="Open the effort parent thread"
        className="rounded-md border border-border px-2 py-0.5 text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">Thread</button> : null}
    </div>
  </header>;
}

/** One cell per stable number, filled by state at low saturation: hatched when held, dashed when left alone, dotted when stale. */
function NumberRibbon({ view, onFocus }: Pick<RosterPaneProps, "view" | "onFocus">) {
  const { legend } = view;
  const swatch = "inline-block size-2.5 rounded-[2px] border align-[-1px]";
  return <div className="px-3 pt-2">
    <div role="group" aria-label="Rows by number" className="flex flex-wrap gap-1">
      {view.ribbon.map((cell) => <button key={cell.n} type="button" data-roster-cell={cell.n} data-tone={cell.group === "decision" || cell.group === "issue" ? cell.group : undefined}
        onClick={() => onFocus(cell.n)} title={`${cell.n}${cell.held ? " · held" : ""}${cell.leftAlone ? " · left alone" : ""}${cell.stale ? " · stale" : ""}`}
        className={cn("relative h-5 min-w-5 rounded-[3px] border px-1 text-[11px] leading-none tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring",
          RIBBON_CELL[cell.group], cell.leftAlone && "border-dashed border-muted-foreground/60")} style={cell.held ? HATCH : undefined}>
        {cell.n}
        {cell.stale ? <span aria-hidden data-tone="stale" className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-amber-500" /> : null}
      </button>)}
    </div>
    <p className="mt-1 flex flex-wrap gap-x-2.5 gap-y-0.5 text-[11px] text-muted-foreground">
      <span><span aria-hidden data-tone="decision" className={cn(swatch, TONE_CLASS.decision)} /> {legend.decide} decide</span>
      <span><span aria-hidden data-tone="issue" className={cn(swatch, TONE_CLASS.issue)} /> {legend.system} system</span>
      <span><span aria-hidden className={cn(swatch, "border-transparent bg-foreground/[0.12]")} /> doing</span>
      <span><span aria-hidden className={cn(swatch, "border-foreground/45")} /> {legend.ready} ready</span>
      <span><span aria-hidden className={cn(swatch, "border-border")} style={HATCH} /> held</span>
      <span><span aria-hidden className={cn(swatch, "border-dashed border-muted-foreground/60")} /> left alone</span>
      <span><span aria-hidden data-tone="stale" className="inline-block size-1.5 rounded-full bg-amber-500 align-[1px]" /> stale</span>
    </p>
  </div>;
}

/** Outcome, Validated, Still needed, and Needs a decision: the server's four lines, each one line until you open it when narrow. */
function RollupBlock({ view, wide }: Pick<RosterPaneProps, "view" | "wide">) {
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  if (view.rollup.length === 0) return null;
  return <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 px-3 pt-2 text-[12px]">
    {view.rollup.map((line, index) => <div key={line.label} className="contents">
      <dt data-tone={line.tone ?? undefined} className={cn("whitespace-nowrap", line.tone === "decision" ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground")}>{line.label}</dt>
      <dd className="min-w-0">{wide || open.has(index) ? line.text : <button type="button" title={line.text}
        onClick={() => setOpen((current) => new Set([...current, index]))}
        className="block w-full truncate text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">{line.text}</button>}</dd>
    </div>)}
  </dl>;
}

function SinceChips({ part }: { part: SincePart }) {
  return <span className="inline-flex flex-wrap items-center gap-1">
    {part.chips.map((chip) => <span key={chip.label} data-tone={chip.tone ?? undefined}
      className={cn("rounded-[3px] border px-1 text-[11px] leading-4 tabular-nums", chip.tone ? TONE_CLASS[chip.tone] : "border-transparent bg-foreground/[0.07]")}>{chip.label}</span>)}
    <span>{part.text}</span>
  </span>;
}

/** What changed since you last pressed Mark seen, and how many steps v2 took on its own. */
function SinceLine({ view, onMarkSeen }: Pick<RosterPaneProps, "view" | "onMarkSeen">) {
  const { since } = view;
  return <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 pt-2 text-[12px]">
    {since.at === null ? <span className="text-muted-foreground">Mark seen to follow what changes from here</span> : <>
      <span className="font-medium">Since you looked · {since.at}</span>
      {since.parts.map((part) => <SinceChips key={part.text} part={part} />)}
      {since.parts.length === 0 && !since.handled ? <span className="text-muted-foreground">no changes</span> : null}
      {since.handled ? <span className="text-muted-foreground">{since.handled} {since.handled === 1 ? "step" : "steps"} handled without you</span> : null}
    </>}
    {since.settling ? <span className="text-muted-foreground">{since.settling} {since.settling === 1 ? "row changed state in place; it settles" : "rows changed state in place; they settle"} on Mark seen</span> : null}
    <button type="button" onClick={onMarkSeen} title="Mark seen (space): settle rows into their groups and restart the since-line"
      className="ml-auto rounded-md border border-border px-2 py-0.5 text-[11px] outline-none hover:bg-foreground/[0.05] focus-visible:ring-2 focus-visible:ring-ring">Mark seen</button>
  </div>;
}

function EmptyAsks({ text }: { text: string }) {
  return <p role="status" className="mx-3 mt-2 flex items-center gap-2 rounded-md border border-border bg-foreground/[0.03] px-3 py-2 text-[12px]">
    <Icon name="CircleCheck" className="size-4 shrink-0 text-muted-foreground" aria-hidden />{text}
  </p>;
}

/** The whole pane for one roster read. */
export function RosterPane(props: RosterPaneProps) {
  const { view, wide } = props;
  const rows = { groups: view.groups, focusN: props.focusN, menuN: props.menuN, liveThreads: props.liveThreads, onFocus: props.onFocus, onCompose: props.onCompose,
    onMenu: props.onMenu, onAction: props.onAction, onToggleGroup: props.onToggleGroup, onOpenUrl: props.onOpenUrl };
  return <div ref={props.rootRef} role="region" aria-label={`${view.header.name} roster`} tabIndex={-1} onKeyDown={props.onKeyDown}
    className={cn("flex h-full min-h-0 flex-col bg-background text-foreground outline-none", POINTER_CURSORS)}>
    <RosterHeader {...props} />
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-3">
      <NumberRibbon view={view} onFocus={props.onFocus} />
      <RollupBlock view={view} wide={wide} />
      <SinceLine view={view} onMarkSeen={props.onMarkSeen} />
      <AsksBlock {...props.asks} />
      {view.empty ? <EmptyAsks text={view.empty} /> : null}
      <div data-roster-rows className="mt-2">{wide ? <RosterTable {...rows} /> : <RosterList {...rows} />}</div>
    </div>
    <CommandBox {...props.command} />
  </div>;
}

/** The effort picker: rosters that run on v2 first, then the ones legacy launchers still run. */
export function RosterPicker({ efforts, onPick }: { efforts: readonly RosterListEntry[]; onPick(id: string): void }) {
  const shown = efforts.filter((effort) => !effort.archived)
    .sort((a, b) => Number(b.mode === "v2") - Number(a.mode === "v2") || a.name.localeCompare(b.name));
  return <div className={cn("h-full overflow-y-auto px-3 py-3 text-foreground", POINTER_CURSORS)}>
    <h2 className="text-[14px] font-semibold tracking-tight">Rosters</h2>
    <p className="mt-0.5 text-[11px] text-muted-foreground">Pick an effort to see its numbered PRs.</p>
    {shown.length === 0 ? <p className="mt-4 text-[12px] text-muted-foreground">No saved efforts yet. Create one in the Efforts view.</p> :
      <ul className="mt-3 border-t border-border/60">{shown.map((effort) => <li key={effort.id} className="border-b border-border/60">
        <button type="button" onClick={() => onPick(effort.id)}
          className="flex w-full items-baseline gap-2 px-1 py-2 text-left outline-none hover:bg-foreground/[0.03] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
          <span className="min-w-0 flex-1 truncate text-[13px]">{effort.name}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground">{effort.mode === "v2" ? "runs on its roster" : "legacy launchers · read only"}</span>
        </button>
      </li>)}</ul>}
  </div>;
}

// ---------------------------------------------------------------------------
// Data, state, and the SDK: everything below talks to BB.
// ---------------------------------------------------------------------------

const ORDER_KEY = "bb-workstreams:roster-order";
const seenKey = (effortId: string) => `bb-workstreams:roster-seen:${effortId}`;
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
function readStored<T>(key: string, parse: (value: unknown) => T | null): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? null : parse(JSON.parse(raw));
  } catch { return null; }
}
function store(key: string, value: unknown): void {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* The pane still works for this visit without storage. */ }
}
const parseSeen = (value: unknown): Seen | null => typeof value === "object" && value !== null && typeof (value as Seen).seq === "number" && typeof (value as Seen).at === "number"
  ? { seq: (value as Seen).seq, at: (value as Seen).at } : null;

/** Typing in a field, a dialog, or a menu is never a roster key. */
export function typing(target: EventTarget | null): boolean {
  const element = target as Partial<HTMLElement> | null;
  return typeof element?.closest === "function" && (element.isContentEditable === true
    || element.closest("input, textarea, select, [contenteditable], [role=dialog], [role=menu], [role=alertdialog]") !== null);
}

/** What a key acts on: the ask or row holding keyboard focus, such as a row's ⋯ once its menu closes, else the remembered focus. */
export function keyFocus(target: EventTarget | null, focus: PaneFocus): PaneFocus {
  const element = (target as Partial<HTMLElement> | null)?.closest?.("[data-roster-ask], [data-roster-row]");
  const ask = element?.getAttribute("data-roster-ask");
  const row = element?.getAttribute("data-roster-row");
  return ask ? { ask } : row ? { row: Number(row) } : focus;
}

function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(timer);
  }, [ms]);
  return now;
}

/**
 * One effort's roster (its pane is keyed by effort, so the effort never changes under it): read on mount, on effort-roster-changed for this effort, on board-changed at most every 3 seconds while visible
 * (holds, legacy jobs, and thread activity still change rows that way), when the page shows again, and when a row's staleAt passes.
 * A signal during a read reads once more after it; a read for an earlier seen sequence is dropped.
 */
function useEffortRoster(effortId: string, since: number | undefined) {
  const rpc = useRpc<typeof rpcContract>();
  const [roster, setRoster] = useState<EffortRoster | null>(null);
  const [error, setError] = useState<string | null>(null);
  const args = useRef({ effortId, since });
  args.current = { effortId, since };
  const reading = useRef(false);
  const again = useRef(false);
  const load = useCallback(function read(): void {
    if (reading.current) { again.current = true; return; }
    reading.current = true;
    const asked = args.current;
    rpc.call("effort_roster_get", asked.since === undefined ? { effortId: asked.effortId } : { effortId: asked.effortId, since: asked.since }).then(
      (next) => {
        if (args.current.since !== asked.since) { again.current = true; return; }
        setRoster(next);
        setError(null);
      },
      (cause: unknown) => setError(message(cause)),
    ).finally(() => {
      reading.current = false;
      if (again.current) { again.current = false; read(); }
    });
  }, [rpc]);
  useEffect(load, [effortId, since, load]);
  useRealtime(ROSTER_CHANGED, (payload) => {
    if (typeof payload === "object" && payload !== null && (payload as { effortId?: unknown }).effortId === args.current.effortId) load();
  });
  const lastBoard = useRef(0);
  const trailing = useRef<number | null>(null);
  useRealtime("board-changed", () => {
    if (document.visibilityState !== "visible" || trailing.current !== null) return;
    const wait = Math.max(0, lastBoard.current + 3_000 - Date.now());
    trailing.current = window.setTimeout(() => { trailing.current = null; lastBoard.current = Date.now(); load(); }, wait);
  });
  useEffect(() => () => { if (trailing.current !== null) window.clearTimeout(trailing.current); }, []);
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load]);
  // A read that finds nothing new signals no one, so read again once the soonest row goes stale.
  useEffect(() => {
    const now = Date.now();
    const next = Math.min(...(roster?.rows ?? []).flatMap((row) => row.staleAt !== null && row.staleAt > now ? [row.staleAt] : []));
    if (!Number.isFinite(next)) return;
    const timer = window.setTimeout(load, Math.min(next - now + 1_000, 30 * 60_000));
    return () => window.clearTimeout(timer);
  }, [roster, load]);
  const patchRow = useCallback((row: EffortRoster["rows"][number]) =>
    setRoster((current) => current && { ...current, rows: current.rows.map((item) => item.n === row.n ? row : item) }), []);
  return { roster, error, load, patchRow };
}

/** Owner chips cross-fade and rise 2px in place when they change, and the row's ribbon cell pulses once; reduced motion turns it off. */
function useRosterMotion(rootRef: RefObject<HTMLElement | null>, view: View | null, settleCount: number) {
  const previous = useRef<{ chips: Map<number, string>; settle: number } | null>(null);
  useLayoutEffect(() => {
    if (view === null) return;
    const chips = new Map(view.groups.flatMap((group) => group.lines.map((line) => [line.n, `${line.chip.kind}:${line.chip.label}`] as const)));
    const prior = previous.current;
    previous.current = { chips, settle: settleCount };
    const root = rootRef.current;
    if (prior === null || root === null || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    for (const [n, chip] of chips) {
      if (prior.chips.get(n) === undefined || prior.chips.get(n) === chip) continue;
      root.querySelector(`[data-roster-chip="${n}"]`)?.animate([{ opacity: 0, transform: "translateY(2px)" }, { opacity: 1, transform: "none" }], { duration: 180, easing: EASE_CSS });
      root.querySelector(`[data-roster-cell="${n}"]`)?.animate([{ transform: "scale(1)" }, { transform: "scale(1.15)" }, { transform: "scale(1)" }], { duration: 360, easing: EASE_CSS });
    }
    if (prior.settle !== settleCount) root.querySelector("[data-roster-rows]")?.animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: 160, easing: EASE_CSS });
  }, [rootRef, view, settleCount]);
}

/** The roster for one effort, in the thread's side panel or the full-width nav view. Callers key it by effort. */
export function RosterView({ effortId, mount, focus = null }: { effortId: string; mount: "nav" | "tab"; focus?: number | null }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const connection = useRealtimeConnectionState();
  const sidebar = experimental_useSidebarThreads();
  const [seen, setSeen] = useState<Seen | null>(() => readStored(seenKey(effortId), parseSeen));
  const { roster, error, load, patchRow } = useEffortRoster(effortId, seen?.seq);
  // An answer's Undo counts down by the second; otherwise ages move every 30 seconds.
  const now = useNow(roster?.pending.length ? 1_000 : 30_000);
  const [order, setOrder] = useState<RosterOrder>(() => readStored(ORDER_KEY, (value) => value === "state" ? "state" : "number") ?? "number");
  const [settled, setSettled] = useState<Map<number, GroupKey> | null>(null);
  const [settleCount, setSettleCount] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [pane, setPane] = useState<PaneState>(() => ({ focus: focus === null ? null : { row: focus }, open: null, picks: new Map(), subsets: new Map(), hint: null }));
  const focusN = pane.focus && "row" in pane.focus ? pane.focus.row : null;
  const [menuN, setMenuN] = useState<number | null>(null);
  const [note, setNote] = useState<RosterNote | null>(null);
  const [commandText, setCommandText] = useState("");
  /** This visit's latest command and its result; the roster's own last command shows until there is one. */
  const [record, setRecord] = useState<CommandRecord | null>(null);
  /** Whether the acknowledgment's details show; null follows the default, open for this visit's own command in a wide pane. */
  const [ackOpen, setAckOpen] = useState<boolean | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [holding, setHolding] = useState<RosterLine | null>(null);
  const [resetting, setResetConfirm] = useState<ResetConfirm | null>(null);
  const [keysOpen, setKeysOpen] = useState(false);
  /** The PRs whose fresh merge preview is open: a command such as `merge 9 16` names them, and grants nothing. */
  const [merging, setMerging] = useState<{ target: string; n: number | null }[] | null>(null);
  const [wide, setWide] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  /** Rows this pane's own command changed settle at once: you caused the move, so it isn't news. */
  const ownChanges = useRef(new Set<number>());

  // The first read settles every row; after that only Mark seen and this pane's own commands do.
  useEffect(() => {
    if (roster === null) return;
    if (settled === null) { setSettled(settle(roster)); return; }
    if (ownChanges.current.size === 0) return;
    const mine = roster.rows.filter((row) => ownChanges.current.has(row.n));
    ownChanges.current.clear();
    setSettled((current) => new Map([...current ?? [], ...mine.map((row) => [row.n, liveGroup(row, roster)] as const)]));
  }, [roster, settled]);
  const threads = sidebar.threads;
  const titles = useMemo(() => new Map(threads.map((thread) => [thread.id, thread.displayTitle])), [threads]);
  const liveThreads = useMemo(() => new Set(threads.filter((thread) => thread.indicator === "runtime").map((thread) => thread.id)), [threads]);
  const view = useMemo(() => roster && settled ? rosterView(roster, { order, now, settled, seen, expanded, titles }) : null,
    [roster, settled, order, now, seen, expanded, titles]);
  useRosterMotion(rootRef, view, settleCount);
  // The pane's own width picks the layout, so a narrow side panel gets two-line rows even on a wide screen.
  const shown = view !== null;
  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setWide((entry?.contentRect.width ?? node.clientWidth) >= 900));
    observer.observe(node);
    setWide(node.clientWidth >= 900);
    return () => observer.disconnect();
  }, [shown]);

  const lineOf = useCallback((n: number | null) => view?.groups.flatMap((group) => group.lines).find((line) => line.n === n) ?? null, [view]);
  // Focusing a row in a collapsed group, from the ribbon or a deep link, opens the group first.
  const focusRow = useCallback((n: number) => {
    setPane((current) => ({ ...current, focus: { row: n }, hint: null }));
    const collapsed = view?.groups.find((group) => group.collapsed && group.lines.some((line) => line.n === n));
    if (collapsed) setExpanded((current) => new Set([...current, collapsed.key]));
    window.requestAnimationFrame(() => {
      const node = rootRef.current?.querySelector<HTMLElement>(`[data-roster-row="${n}"]`);
      node?.focus({ preventScroll: true });
      node?.scrollIntoView({ block: "nearest" });
    });
  }, [view]);
  // A deep link to row n focuses it once the roster is on screen.
  // Otherwise focus starts on the first ask, without taking DOM focus from wherever you are.
  const focused = useRef(false);
  const { asks, receipts } = useMemo(() => roster ? askCards(roster) : { asks: [], receipts: [] }, [roster]);
  useEffect(() => {
    if (focused.current || view === null) return;
    focused.current = true;
    if (focus !== null) focusRow(focus);
    else setPane((current) => ({ ...current, focus: firstAsk(asks) }));
  }, [focus, view, focusRow, asks]);
  /** Put DOM focus where the pane's focus is, so the next key acts there; with nowhere to go, the pane root keeps the keys. */
  const domFocus = useCallback((target: PaneFocus) => {
    if (target && "row" in target) { focusRow(target.row); return; }
    window.requestAnimationFrame(() => {
      const node = target ? rootRef.current?.querySelector<HTMLElement>(`[data-roster-ask="${target.ask}"]`) : null;
      (node ?? rootRef.current)?.focus({ preventScroll: true });
      node?.scrollIntoView({ block: "nearest" });
    });
  }, [focusRow]);

  const markSeen = useCallback(() => {
    if (!roster) return;
    const next = { seq: roster.through, at: Date.now() };
    store(seenKey(effortId), next);
    setSeen(next);
    setSettled(settle(roster));
    setSettleCount((count) => count + 1);
  }, [roster, effortId]);
  const toggleOrder = useCallback((next?: RosterOrder) => setOrder((current) => {
    const order = next ?? (current === "number" ? "state" : "number");
    store(ORDER_KEY, order);
    return order;
  }), []);

  /** A send that failed before any answer: sending the same text again reuses its request id, so a lost reply can't run it twice. */
  const unanswered = useRef<{ text: string; requestId: string } | null>(null);
  /** Send one command. A row command shows no decisions, so no `Dn` in it can answer one; the command box shows them all. */
  const send = useCallback(async (text: string, from: "row" | "box", rows: readonly number[] = []): Promise<CommandRecord["result"] | null> => {
    if (!roster) return null;
    const requestId = unanswered.current?.text === text ? unanswered.current.requestId : crypto.randomUUID();
    unanswered.current = { text, requestId };
    setNote({ command: text, lines: ["Sending…"], tone: "info" });
    let result: CommandRecord["result"];
    try {
      result = await rpc.call("effort_command", from === "row" ? rowCommandInput(roster, text, requestId) : commandInput(roster, text, requestId));
      unanswered.current = null;
    } catch (cause) {
      result = { kind: "error", message: message(cause) };
    }
    if (result.kind === "admit") for (const n of [...rows, ...result.parts ? ackRows(result.parts) : []]) ownChanges.current.add(n);
    if (result.kind === "admit" && result.mergePreviews.length) setMerging(result.mergePreviews);
    setNote(null);
    keep(text, requestId, result);
    return result;
  }, [roster, rpc, load]);
  /** Show what a command from this pane got back, and read the roster again. */
  const keep = useCallback((text: string, requestId: string, result: CommandRecord["result"]) => {
    if (!roster) return;
    setRecord({ requestId, text, origin: "panel", at: Date.now(), revision: result.kind === "admit" ? result.revision : roster.instruction?.revision ?? null,
      snapshotId: roster.snapshotId, result, fresh: true });
    setAckOpen(null);
    load();
  }, [roster, load]);
  /** Answer a decision from its card: held ten seconds for Undo, from a button, a key, or the lifecycle card's number field. */
  const answer = useCallback(async (ask: DecisionAsk, reply: AnswerReply | { field: string }) => {
    if (!roster) return;
    const requestId = crypto.randomUUID();
    const text = "field" in reply ? `${ask.id} ${reply.field.trim()}` : answerCommand(ask, reply);
    let result: CommandRecord["result"];
    try {
      result = "field" in reply ? await rpc.call("effort_command", fieldAnswerInput(roster, ask, reply.field, requestId))
        : await rpc.call("effort_decision_answer", answerInput(ask, reply, requestId));
    } catch (cause) {
      result = { kind: "error", message: message(cause) };
    }
    keep(text, requestId, result);
  }, [roster, rpc, keep]);
  /** A click answers, like Enter does: focus moves to the next ask you can answer, never onto a merge. */
  const answered = useCallback((ask: Ask) => {
    const next = afterAnswer(asks, pane, ask.id, wide);
    setPane(next);
    domFocus(next.focus);
  }, [asks, pane, wide, domFocus]);
  const undo = useCallback(async (receipt: { id: string; requestId: string } | null) => {
    if (!roster) return;
    if (!receipt) { setNote({ command: "undo", lines: ["Nothing is waiting to send"], tone: "info" }); return; }
    try {
      const result = await rpc.call("effort_command_undo", { effortId: roster.effort.id, requestId: receipt.requestId });
      setNote({ command: `undo ${receipt.id}`, lines: [result.message], tone: result.undone ? "info" : "error" });
      // A taken-back answer never runs, so the last-command line goes back to the last command that did.
      if (result.undone) setRecord((current) => current?.requestId === receipt.requestId ? null : current);
    } catch (cause) {
      setNote({ command: `undo ${receipt.id}`, lines: [message(cause)], tone: "error" });
    }
    load();
  }, [roster, rpc, load]);
  const submit = useCallback(async () => {
    const text = commandText.trim();
    const result = await send(text, "box");
    // A clarified or refused command stays in the box to fix; one the server took leaves it.
    if (result?.kind === "admit" || result?.kind === "pending") setCommandText((current) => current.trim() === text ? "" : current);
  }, [commandText, send]);
  const ack = useMemo(() => {
    const latest = shownCommand(record, roster?.lastCommand ?? null);
    return latest && ackView(latest, now);
  }, [roster, record, now]);

  const act = useCallback((line: RosterLine, id: MenuItem["id"]) => {
    const intent = rowIntent(line, id);
    if (!intent || !roster) return;
    if (intent.kind === "refuse") setNote({ command: intent.command, lines: [intent.why], tone: "error" });
    else if (intent.kind === "open-pr") navigate.openUrl(intent.url);
    else if (intent.kind === "open-thread") navigate.toThread(intent.threadId);
    else if (intent.kind === "hold") setHolding(line);
    else if (intent.kind === "confirm-reset") setResetConfirm({ command: `reset ${line.n} release`, label: String(line.n), numbers: [line.n], threadId: line.threadId });
    else if (intent.kind === "send") void send(intent.command, "row", [line.n]);
    else if (intent.kind === "refresh") {
      const { command } = intent;
      setNote({ command, lines: ["Reading GitHub…"], tone: "info" });
      rpc.call("effort_reconcile", { effortId: roster.effort.id, prUrl: line.target }).then((result) => {
        patchRow(result.row);
        setNote({ command, lines: [result.status === "checked" ? `${line.n} read from GitHub just now` : `GitHub read failed: ${result.error ?? "unknown error"}`],
          tone: result.status === "checked" ? "info" : "error" });
      }, (cause: unknown) => setNote({ command, lines: [message(cause)], tone: "error" }));
    }
  }, [roster, rpc, navigate, patchRow, send]);

  const run = useCallback((effect: PaneEffect) => {
    const line = "n" in effect ? lineOf(effect.n) : null;
    if (effect.kind === "answer") void answer(effect.ask, effect.reply);
    else if (effect.kind === "recover") void send(effect.command, "row", effect.ask.numbers);
    else if (effect.kind === "preview") void send(effect.command, "row");
    else if (effect.kind === "row" && line) act(line, effect.id);
    else if (effect.kind === "menu") setMenuN(effect.n);
    else if (effect.kind === "order") toggleOrder();
    else if (effect.kind === "seen") markSeen();
    else if (effect.kind === "keys") setKeysOpen(true);
    else if (effect.kind === "command") inputRef.current?.focus();
    else if (effect.kind === "undo") void undo(latestUndo(receipts, Date.now()));
  }, [lineOf, answer, send, act, toggleOrder, markSeen, undo, receipts]);
  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (typing(event.target) || !view) return;
    const control = event.target instanceof Element && event.target.closest("button, a") !== null;
    const step = paneKey(view, asks, pane, event, { control, wide, focus: keyFocus(event.target, pane.focus) });
    if (!step) return;
    event.preventDefault();
    const moved = JSON.stringify(step.state.focus) !== JSON.stringify(keyFocus(event.target, pane.focus));
    setPane(step.state);
    if (moved) domFocus(step.state.focus);
    if (step.effect) run(step.effect);
  }, [view, asks, pane, wide, domFocus, run]);

  if (error && !roster) return <div className="p-4 text-[12px] text-destructive" role="alert">Could not read the roster: {error}
    <button type="button" onClick={load} className="ml-2 underline">Retry</button></div>;
  if (!roster || !view) return <div className="p-4 text-[12px] text-muted-foreground" role="status">Reading the roster…</div>;
  const parent = roster.effort.coordinatorThreadId;
  return <>
    <RosterPane view={view} wide={wide} mount={mount} live={connection === "connected"} order={order} focusN={focusN} menuN={menuN} liveThreads={liveThreads}
      command={{ value: commandText, onValue: setCommandText, onSubmit: () => void submit(), inputRef, ack, open: ackOpen ?? Boolean(ack?.fresh && wide),
        onToggle: () => setAckOpen((current) => !(current ?? Boolean(ack?.fresh && wide))), onLeave: () => rootRef.current?.focus(),
        note: error ? { command: "read", lines: [`The roster may be behind: ${error}`], tone: "error" } : note }}
      history={roster.history} hasParent={parent !== null}
      rootRef={rootRef} onKeyDown={onKeyDown} onOrder={toggleOrder} onMarkSeen={markSeen} onFocus={focusRow} onMenu={setMenuN} onAction={act}
      onCompose={(n, shift) => { setCommandText((text) => composeNumber(text, n, shift)); inputRef.current?.focus(); }}
      asks={{ asks, receipts, state: pane, wide, now,
        onFocusAsk: (id) => { setPane((current) => ({ ...current, focus: { ask: id }, open: id, hint: null })); domFocus({ ask: id }); }, onFocus: focusRow,
        onAnswer: (ask, reply) => { answered(ask); void answer(ask, reply); }, onField: (ask, field) => { answered(ask); void answer(ask, { field }); },
        onSubset: (ask, numbers) => setPane((current) => ({ ...current, subsets: new Map([...current.subsets, [answerKey(ask), numbers]]) })),
        onCompose: (text) => { setCommandText(text); inputRef.current?.focus(); }, onUndo: (receipt) => void undo(receipt),
        onPreview: (ask) => void send(ask.command, "row"),
        onRecover: (ask, recovery) => {
          const intent = recoveryIntent(ask, recovery);
          if (intent.kind === "confirm") setResetConfirm(intent.reset);
          else { answered(ask); void send(intent.command, "row", ask.numbers); }
        },
        onOpenThread: (id) => navigate.toThread(id), onOpenUrl: (url) => navigate.openUrl(url) }}
      onOpenUrl={(url) => navigate.openUrl(url)}
      onToggleGroup={(key) => setExpanded((current) => { const next = new Set(current); if (!next.delete(key)) next.add(key); return next; })}
      onHeader={(action) => {
        if (action === "keys") setKeysOpen(true);
        else if (action === "parent" && parent) navigate.toThread(parent);
        else if (action === "full") navigate.toPluginPanel("board", { subPath: `roster/${encodeURIComponent(roster.effort.id)}` });
        else if (action === "all") navigate.toPluginPanel("board", { subPath: "roster" });
      }} />
    <HoldDialog line={holding} onClose={() => setHolding(null)} onHold={(line, command) => { setHolding(null); void send(command, "row", [line.n]); }} />
    <ResetDialog reset={resetting} thread={resetting?.threadId ? titles.get(resetting.threadId) ?? null : null} onClose={() => setResetConfirm(null)}
      onOpenThread={(id) => navigate.toThread(id)} onReset={(reset) => { setResetConfirm(null); void send(reset.command, "row", reset.numbers); }} />
    <MergePreviewDialog targets={merging} rows={roster.rows} onClose={() => setMerging(null)} onMerged={load} onOpenUrl={(url) => navigate.openUrl(url)} />
    <Dialog open={keysOpen} onOpenChange={setKeysOpen}>
      <DialogContent className={cn("max-w-sm", POINTER_CURSORS)}>
        <DialogHeader><DialogTitle>Roster keys</DialogTitle><DialogDescription>They work while the roster has focus, never while you type.</DialogDescription></DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
          {ROSTER_KEYS.map(([key, what]) => <div key={key} className="contents"><dt className="font-mono text-[11px]">{key}</dt><dd className="text-muted-foreground">{what}</dd></div>)}
        </dl>
      </DialogContent>
    </Dialog>
  </>;
}

/** Hold a row, with an optional reason. A hold outlasts every instruction, unlike leaving a row alone. It sends the command it shows. */
function HoldDialog({ line, onClose, onHold }: { line: RosterLine | null; onClose(): void; onHold(line: RosterLine, command: string): void }) {
  const [reason, setReason] = useState("");
  useEffect(() => setReason(""), [line]);
  const command = line ? holdCommand(line.n, reason) : "";
  return <Dialog open={line !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className={cn("max-w-md", POINTER_CURSORS)}>
      <DialogHeader><DialogTitle>Hold {line?.n} · {line?.repo} #{line?.number}</DialogTitle>
        <DialogDescription>Nothing runs on it until you release it. A hold outlasts every instruction.</DialogDescription></DialogHeader>
      <form onSubmit={(event) => { event.preventDefault(); if (line) onHold(line, command); }} className="space-y-3">
        <label className="grid gap-1.5 text-[12px]">Reason (optional)
          <input autoFocus value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500}
            className="h-9 rounded-md border border-input bg-background px-3 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring" />
        </label>
        <p className="font-mono text-[11px] text-muted-foreground">{command}</p>
        <DialogFooter><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit">Hold {line?.n}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

/** Dropping an uncertain launch's claim could leave two writers, so it names the likely thread and asks you to confirm none is writing. */
function ResetDialog({ reset, thread, onClose, onOpenThread, onReset }: { reset: ResetConfirm | null; thread: string | null; onClose(): void; onOpenThread(id: string): void;
  onReset(reset: ResetConfirm): void }) {
  const numbers = reset?.label;
  return <Dialog open={reset !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className={cn("max-w-md", POINTER_CURSORS)}>
      <DialogHeader><DialogTitle>Reset {numbers} and release its launch?</DialogTitle>
        <DialogDescription>Its launch outcome is uncertain. Check {thread ? `"${thread}"` : "its likely worker thread"} first: if a worker is writing there, a reset could start a second one.</DialogDescription></DialogHeader>
      <p className="font-mono text-[11px] text-muted-foreground">{reset?.command}</p>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        {reset?.threadId ? <Button type="button" variant="outline" onClick={() => onOpenThread(reset.threadId!)}>Open likely thread</Button> : null}
        <Button type="button" onClick={() => { if (reset) onReset(reset); }}>No worker is writing · reset {numbers}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

function useRosterList() {
  const rpc = useRpc<typeof rpcContract>();
  const [efforts, setEfforts] = useState<RosterListEntry[] | null>(null);
  useEffect(() => {
    let live = true;
    rpc.call("effort_roster_list", null).then((list) => { if (live) setEfforts(list); }, () => { if (live) setEfforts([]); });
    return () => { live = false; };
  }, [rpc]);
  return efforts;
}

/** The full-width roster at board/roster/<effortId>[/<n>], or the picker at board/roster. */
export function RosterNavView({ route }: { route: { effortId: string | null; n: number | null } }) {
  const navigate = useBbNavigate();
  if (route.effortId) return <RosterView key={route.effortId} effortId={route.effortId} mount="nav" focus={route.n} />;
  return <RosterNavPicker onPick={(id) => navigate.toPluginPanel("board", { subPath: `roster/${encodeURIComponent(id)}` })} />;
}

function RosterNavPicker({ onPick }: { onPick(id: string): void }) {
  const efforts = useRosterList();
  return efforts === null ? <div className="p-4 text-[12px] text-muted-foreground" role="status">Reading efforts…</div> : <RosterPicker efforts={efforts} onPick={onPick} />;
}

const effortParam = (params: JsonValue | null) =>
  typeof params === "object" && params !== null && !Array.isArray(params) && typeof params.effortId === "string" ? params.effortId : null;

/** The Roster tab beside a thread: the effort it opened for, else the effort this thread is the parent of, else a picker. */
export function RosterPanelTab({ threadId, params }: { threadId: string; params: JsonValue | null }) {
  const chosen = effortParam(params);
  return chosen ? <RosterView key={chosen} effortId={chosen} mount="tab" /> : <RosterTabResolve threadId={threadId} />;
}

function RosterTabResolve({ threadId }: { threadId: string }) {
  const efforts = useRosterList();
  const [picked, setPicked] = useState<string | null>(null);
  const effortId = picked ?? efforts?.find((effort) => effort.parentThreadId === threadId)?.id ?? null;
  if (effortId) return <RosterView key={effortId} effortId={effortId} mount="tab" />;
  return efforts === null ? <div className="p-4 text-[12px] text-muted-foreground" role="status">Reading efforts…</div> : <RosterPicker efforts={efforts} onPick={setPicked} />;
}
