// All PRs: Your turn, your PRs where a person's feedback waits on you (onYourTurn), by effort, above every other open PR you author or an
// effort names. Its direct writes are Nudge, one click on a row where the server says it's due (a Your turn row offers none for a reviewer
// who hasn't answered yet, and any row reads Re-request @login where you've answered), and Dismiss, which hides a Your turn row until its
// head moves or someone says something new. Your turn rows select (x, a click, Shift for a range; ⇧X or the list's box for all), and
// Address, or b, starts one batch thread for them at once, with 8 s to Undo. A sent PR links its thread with BB's status for it while the
// PR is open, on Other open PRs once it leaves Your turn; why one wasn't sent shows on its row. f on a row opens the deck's listing confirm for the PR's own thread. It
// shares the deck's key registry, hint bar, palette, and ? sheet: j and k move between rows, and n opens the deck's listing confirm for the
// focused row's Nudge, never a write itself. ↻ on a row, g, or Refresh on the selection reads those PRs from GitHub again, four at a time;
// a click on Last read reads every open PR again.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { InventoryRow, InventoryView } from "./inventory-view";
import type { rpcContract } from "./server";
import { cn, POINTER_CURSORS } from "./lib/utils";
import { SimpleInventoryList, type SimpleGroup } from "./inventory-rows";
import { actionCall, askKind, INVENTORY_CHANGED, inventoryScreen, onYourTurn, pickRows, sendable, type InventoryLine, type InventoryScreen, type LineAction,
  type Outcome } from "./inventory-view-model";
import { ACTION, type DeckActionId } from "./deck-keys";
import { readSeen, SEEN_KEY } from "./deck-place";
import { availability, hintKeys, paletteItems, paletteMatch, type KeyContext, type PaletteItem } from "./deck-view-model";
import { HelpBody, HintBar, Kbd, PaletteBody, RefreshSelected, Spin, WorkstreamsHeader, type HeaderProps, type HeaderTarget } from "./deck-screen";
import { DeckDialog, useBatchConfirm, useRefresh, useRegistryKeys, workingLabel, type LiveItems, type Undo, type Working } from "./deck-flow";

const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-ring";
const REGION = cn("flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground", POINTER_CURSORS);

/** Your turn, the rows you dismissed from it, and every other open PR, each by effort; a PR shows in only one. */
export function splitInventory(screen: InventoryScreen): { turn: SimpleGroup[]; dismissed: SimpleGroup[]; other: SimpleGroup[] } {
  const split = { turn: [] as SimpleGroup[], dismissed: [] as SimpleGroup[], other: [] as SimpleGroup[] };
  for (const group of screen.groups) {
    const identity = { key: group.key, label: group.label, effortId: group.effort?.id ?? null };
    const of = (line: InventoryLine) => onYourTurn(line) ? split.turn : line.dismissed ? split.dismissed : split.other;
    for (const list of [split.turn, split.dismissed, split.other]) {
      const lines = group.lines.filter((line) => of(line) === list);
      if (lines.length) list.push({ ...identity, lines });
    }
  }
  return split;
}
/** The rows Address can take, in drawn order. */
const addressable = (split: ReturnType<typeof splitInventory>) => split.turn.flatMap((group) => group.lines).filter(sendable);

/** The shared header, with this read's freshness; ⌘K and ? open the deck's palette and key sheet. */
function Header({ read, onView, onPalette, onHelp }: { read: HeaderProps["read"]; onView(target: HeaderTarget): void; onPalette(): void; onHelp(): void }) {
  return <WorkstreamsHeader view="inventory" read={read} palette="all actions" help="Keys and colors" onView={onView} onPalette={onPalette} onHelp={onHelp} />;
}

export function InventoryPending({ error, onRetry, onView, onPalette, onHelp }: { error: string | null; onRetry(): void; onView(target: HeaderTarget): void;
  onPalette(): void; onHelp(): void }) {
  return <div role="region" aria-label="PR inventory" className={REGION}>
    <Header read={{ text: error ? "Read failed" : "Reading…", error: null }} onView={onView} onPalette={onPalette} onHelp={onHelp} />
    <div className="p-4 text-[12px]" role={error ? "alert" : "status"}>
      {error ? <>Couldn't read the inventory: {error} <button type="button" onClick={onRetry} className={cn("ml-1 rounded-sm underline", FOCUS)}>Retry</button></>
        : <span className="text-muted-foreground">Reading your open PRs…</span>}
    </div>
  </div>;
}

function Notice({ notice }: { notice: InventoryScreen["notices"][number] }) {
  return <p role={notice.tone === "error" ? "alert" : "status"}
    className={cn("text-[12px]", notice.tone === "error" ? "text-destructive" : "text-muted-foreground")}>{notice.text}</p>;
}

/** The Your turn rows you selected, docked under the lists so it never covers one: Address them together, or clear; and why nothing started. */
function SelectionBar({ count, refusal, working, refresh, onAddress, onRefresh, onClear }: { count: number; refusal?: string | null; working?: Working | null;
  refresh?: { busy: boolean; progress: string | null }; onAddress(): void; onRefresh(): void; onClear(): void }) {
  if (!count) return null;
  return <div aria-label="Selection" className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-border bg-background px-4 py-1.5 text-[12px]">
    <b className="mr-1 font-semibold">{count} selected</b>
    <button type="button" data-inventory-action="address" disabled={!!working} aria-busy={working?.kind === "address" || undefined} onClick={onAddress}
      title="Starts one thread for them now, with 8 s to Undo. Nothing merges."
      className={cn("inline-flex h-6 items-center gap-1.5 rounded-md border border-foreground bg-foreground px-2 font-medium text-background", FOCUS)}>
      {working?.kind === "address" ? <><Spin />{workingLabel(working)}</> : <>Address {count}<Kbd inverted>{ACTION.address.keys[0]}</Kbd></>}</button>
    <RefreshSelected count={count} busy={!!refresh?.busy} progress={refresh?.progress ?? null} onClick={onRefresh} />
    {refusal ? <span role="alert" data-inventory-refusal className="min-w-0 truncate text-destructive" title={refusal}>{refusal}</span> : null}
    <span className="flex-1" />
    <button type="button" onClick={onClear} className={cn("inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-muted-foreground hover:bg-foreground/[0.06]", FOCUS)}>
      Clear<Kbd>esc</Kbd></button>
  </div>;
}

export function InventoryPane(props: { screen: InventoryScreen; busyKey: string | null; error: string | null;
  onView(target: HeaderTarget): void; onPalette(): void; onHelp(): void; onOpenPr(url: string): void; onOpenThread(id: string): void; onOpenRoster(effortId: string): void;
  onNudge(line: InventoryLine, action: LineAction): void; rootRef?: RefObject<HTMLDivElement | null>;
  /** Your turn rows selected for Address, by PR; a row's checkbox, Your turn's box for all or none, Address, and Clear. */
  selected?: ReadonlySet<string>; onSelect?(line: InventoryLine, shift: boolean): void; onSelectAll?(all: boolean): void; onAddress?(): void; onClear?(): void;
  /** Why the last Address started nothing, and why it didn't send each PR, by PR; a batch's Undo from its row; and Dismiss and back. */
  refusal?: string | null; notes?: ReadonlyMap<string, string>; onUndo?(batchId: string): void; onDismiss?(line: InventoryLine, dismiss: boolean): void;
  /** A batch call out now, whose rows show pending; and each item of a batch sending now, by PR. */
  working?: Working | null; live?: LiveItems;
  /** The deck's shared hint bar, under the lists. */
  footer?: ReactNode;
  /** ↻ on a row, Refresh on the selection, and a click on Last read; the rows reading now, and the selection's progress. */
  onRefresh?(line: InventoryLine): void; onRefreshSelected?(): void; onRefreshAll?(): void; reading?: ReadonlySet<string>; refresh?: { busy: boolean; progress: string | null } }) {
  const split = splitInventory(props.screen);
  const { turn, dismissed, other } = split;
  const [primaryNotice, ...otherNotices] = props.screen.notices;
  const callbacks = { busyKey: props.busyKey, onOpenPr: props.onOpenPr, onOpenThread: props.onOpenThread,
    onOpenRoster: props.onOpenRoster, onNudge: props.onNudge, onRefresh: props.onRefresh, reading: props.reading, onDismiss: props.onDismiss };
  // Address takes only rows nothing it sent is still working on; Your turn's box takes only Your turn's.
  const turnLines = turn.flatMap((group) => group.lines).filter(sendable);
  const turnPicked = turnLines.filter((line) => props.selected?.has(line.prUrl)).length;
  const listed = turn.reduce((sum, group) => sum + group.lines.length, 0);
  const hidden = dismissed.reduce((sum, group) => sum + group.lines.length, 0);
  const rows = { ...callbacks, selected: props.selected, onSelect: props.onSelect, notes: props.notes, onUndo: props.onUndo, working: props.working?.prUrls, live: props.live };
  return <div ref={props.rootRef} role="region" aria-label="PR inventory" className={REGION}>
    <Header read={{ text: props.screen.read.text, title: props.screen.read.title, busy: props.screen.read.refreshing, error: null, onRefresh: props.onRefreshAll }} onView={props.onView}
      onPalette={props.onPalette} onHelp={props.onHelp} />
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-8">
      <h1 className="px-4 pt-4 text-[18px] font-semibold tracking-tight">All PRs</h1>
      {props.error || props.screen.notices.length ? <div className="grid gap-1 px-4 pt-3">
        {props.error ? <p role="alert" className="text-[12px] text-destructive">Couldn't read the inventory: {props.error}</p> : null}
        {primaryNotice ? <Notice notice={primaryNotice} /> : null}
        {otherNotices.length ? <details className="text-[11px] text-muted-foreground">
          <summary className={cn("w-fit rounded-sm hover:text-foreground", FOCUS)}>{otherNotices.length} more inventory {otherNotices.length === 1 ? "notice" : "notices"}</summary>
          <div className="grid gap-1 pt-2">{otherNotices.map((notice) => <Notice key={notice.text} notice={notice} />)}</div>
        </details> : null}
      </div> : null}
      <section className="mt-5" aria-label="Your turn">
        <h2 className="mb-2 flex items-center gap-2 px-4 text-[14px] font-semibold">
          {turnLines.length && props.onSelectAll ? <input type="checkbox" data-inventory-select-all checked={turnPicked === turnLines.length}
            ref={(element) => { if (element) element.indeterminate = turnPicked > 0 && turnPicked < turnLines.length; }}
            aria-label={turnPicked === turnLines.length ? "Clear the selection" : "Select every Your turn PR"} onChange={() => props.onSelectAll!(turnPicked < turnLines.length)}
            className="size-3.5 shrink-0 accent-sky-600" /> : null}
          Your turn <span className="font-normal tabular-nums text-muted-foreground">{listed}</span></h2>
        {turn.length ? <SimpleInventoryList groups={turn} kind="turn" {...rows} />
          : <p className="px-4 text-[12px] text-muted-foreground">Nothing waits on you.</p>}
        {hidden ? <details className="mt-2" data-inventory-dismissed>
          <summary className={cn("mx-4 w-fit rounded-sm text-[11px] text-muted-foreground hover:text-foreground", FOCUS)}>{hidden} dismissed · show</summary>
          <div className="pt-2"><SimpleInventoryList groups={dismissed} kind="dismissed" {...callbacks} /></div>
        </details> : null}
      </section>
      <section className="mt-7" aria-label="Other open PRs">
        <h2 className="mb-2 px-4 text-[14px] font-semibold">Other open PRs <span className="font-normal tabular-nums text-muted-foreground">{other.reduce((sum, group) => sum + group.lines.length, 0)}</span></h2>
        {other.length ? <SimpleInventoryList groups={other} kind="other" {...callbacks} />
          : <p className="px-4 text-[12px] text-muted-foreground">{props.screen.empty ?? "No other open PRs."}</p>}
      </section>
    </div>
    <SelectionBar count={turnPicked} refusal={props.refusal} working={props.working} refresh={props.refresh} onAddress={() => props.onAddress?.()}
      onRefresh={() => props.onRefreshSelected?.()} onClear={() => props.onClear?.()} />
    {props.footer}
  </div>;
}

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
/** inventory_get, read again on each inventory change, a board change you can see, and when the page shows again: never on a timer. */
export function useInventory() {
  const rpc = useRpc<typeof rpcContract>();
  const [view, setView] = useState<InventoryView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reading = useRef(false);
  const again = useRef(false);
  const load = useCallback(function read(): void {
    if (reading.current) { again.current = true; return; }
    reading.current = true;
    rpc.call("inventory_get", {}).then((next) => { setView(next); setError(null); }, (cause: unknown) => setError(message(cause))).finally(() => {
      reading.current = false;
      if (again.current) { again.current = false; read(); }
    });
  }, [rpc]);
  useEffect(load, [load]);
  useRealtime(INVENTORY_CHANGED, () => load());
  useRealtime("board-changed", () => { if (document.visibilityState === "visible") load(); });
  useEffect(() => {
    const visible = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, [load]);
  return { view, error, load };
}

export function InventoryNavView({ onView }: { onView(target: HeaderTarget): void }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const { view, error, load } = useInventory();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, Outcome>>(new Map());
  const now = Date.now();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const rows = useMemo(() => new Map<string, InventoryRow>(view?.groups.flatMap((group) => group.rows.map((row) => [row.prUrl, row] as const)) ?? []), [view]);
  const nudge = async (line: InventoryLine, action: LineAction) => {
    if (busyKey || !action.enabled) return;
    const row = rows.get(line.prUrl);
    if (!row) return;
    const call = actionCall(row, action);
    if (call.kind !== "rpc" || call.method !== "inventory_nudge") return;
    setBusyKey(line.prUrl);
    try {
      const result = await rpc.call("inventory_nudge", call.input);
      setOutcomes((current) => new Map([...current, [line.prUrl, { at: Date.now(), action: "nudge", ok: result.ok,
        text: result.ok ? result.detail : result.error }]]));
      load();
    } catch (cause) {
      setOutcomes((current) => new Map([...current, [line.prUrl, { at: Date.now(), action: "nudge", ok: false, text: message(cause) }]]));
    } finally { setBusyKey(null); }
  };

  // ---- the deck's shared keys, hint bar, palette, and ? sheet ----------------
  const [dialog, setDialog] = useState<{ kind: "palette"; query: string; highlight: number } | { kind: "help" } | null>(null);
  const [undo, setUndo] = useState<Undo | null>(null);
  const [flash, setFlash] = useState<{ text: string; undo: boolean } | null>(null);
  const [activeRow, setActiveRow] = useState<string | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const anchor = useRef<string | null>(null);
  // A selected row Address can't take now (a batch took it, or you answered it) stays unselected if it comes back.
  useEffect(() => {
    if (!view) return;
    const live = new Set(addressable(splitInventory(inventoryScreen(view, { now: Date.now(), filter: null }))).map((line) => line.prUrl));
    setPicked((current) => [...current].every((prUrl) => live.has(prUrl)) ? current : new Set([...current].filter((prUrl) => live.has(prUrl))));
  }, [view]);
  const opener = useRef<HTMLElement | null>(null);
  const flashTimer = useRef<number | null>(null);
  const say = useCallback((text: string, withUndo = false, ms?: number) => {
    setFlash({ text, undo: withUndo });
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), ms ?? (withUndo ? 9_000 : 5_000));
  }, []);
  const refresh = useRefresh({ say, reads: () => load() });
  // A row's newer outcome wins: a read after a Nudge, or a Nudge after a read.
  const screen = useMemo(() => view && inventoryScreen(view, { now, filter: null, pending: new Map([...refresh.reading].map((prUrl) => [prUrl, "refresh" as const])),
    outcomes: new Map([...outcomes, ...[...refresh.outcomes].filter(([prUrl, outcome]) => (outcomes.get(prUrl)?.at ?? 0) <= outcome.at)]) }),
  [view, now, outcomes, refresh.reading, refresh.outcomes]);
  const remember = () => { opener.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : opener.current; };
  /** Back to the control that opened a dialog, or its row, never the page body. */
  const returnFocus = () => window.requestAnimationFrame(() => {
    const element = opener.current;
    const row = activeRow ? rootRef.current?.querySelector<HTMLElement>(`[data-inventory-row="${CSS.escape(activeRow)}"]`) : null;
    (element?.isConnected ? element : row ?? rootRef.current?.querySelector<HTMLElement>("[data-inventory-row]"))?.focus({ preventScroll: true });
  });
  const batch = useBatchConfirm({ seenAt: () => { try { return readSeen(window.localStorage.getItem(SEEN_KEY), Date.now()).at; } catch { return {}; } },
    scopeName: () => null, say, setUndo, load, onOpen: remember, onReturn: returnFocus, reread: view });
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onIn = (event: FocusEvent) => setActiveRow((event.target as Element).closest<HTMLElement>("[data-inventory-row]")?.dataset.inventoryRow ?? null);
    root.addEventListener("focusin", onIn);
    return () => root.removeEventListener("focusin", onIn);
  });
  // The focused row, in either list: a PR shows in only one.
  const focused = activeRow ? screen?.groups.flatMap((group) => group.lines).find((line) => `${line.slug}#${line.number}` === activeRow) ?? null : null;
  // Nudge is due exactly where its row shows the button; so is Refresh.
  const due = focused?.actions.find((action) => action.id === "nudge" && action.enabled) ?? null;
  const readable = !!focused?.actions.some((action) => action.id === "refresh" && action.enabled);
  const thread = focused?.actions.find((action) => action.id === "thread" && action.enabled)?.threadId ?? null;
  const fix = focused && askKind(focused) === "fix";
  // Your turn in drawn order, which a Shift-click's range follows, less rows a batch still works on; a selected row that leaves it is no
  // longer selected.
  const split = screen ? splitInventory(screen) : null;
  const turnLines = split ? split.turn.flatMap((group) => group.lines).filter(sendable) : [];
  const selectable = split ? addressable(split) : [];
  const selected = selectable.filter((line) => picked.has(line.prUrl));
  const toggle = (line: InventoryLine, shift: boolean) => {
    setPicked(pickRows(selectable.map((item) => item.prUrl), picked, line.prUrl, shift, anchor.current));
    anchor.current = line.prUrl;
  };
  const context: KeyContext = { view: "prs", cur: null, focused: null, selected: [], seenAvailable: false, undo: !!undo?.live(), held: 0, done: 0,
    prs: { row: !!focused, thread: !!thread, moves: new Set<DeckActionId>([...due ? ["nudge" as const] : [], ...fix ? ["fix" as const] : [], ...readable ? ["refresh" as const] : []]),
      selectable: !!focused && selectable.includes(focused), turn: turnLines.length, picked: selected.length } };
  /** Address the selected Your turn rows: one batch thread, started now, with 8 s to Undo. */
  const address = () => { if (selected.length) void batch.address(null, selected.map((line) => line.prUrl)); };
  /** Dismiss a row on the head it shows, or bring it back. */
  const dismiss = (line: InventoryLine, on: boolean) => {
    void rpc.call("inventory_dismiss", { prUrl: line.prUrl, head: on ? rows.get(line.prUrl)?.head ?? null : null }).then(load, (cause: unknown) => say(message(cause)));
  };
  const undoBatch = async (batchId: string) => {
    const undone = await rpc.call("deck_batch_undo", { batchId }).catch((cause: unknown) => ({ ok: false as const, error: message(cause) }));
    say(undone.ok ? "Undone. Nothing was sent." : undone.error);
    load();
  };
  /** Refresh the selection, else the focused row: four at a time, each row saying what its read got. */
  const reread = () => { void refresh.read(selected.length ? selected.map((line) => line.prUrl) : focused && readable ? [focused.prUrl] : []); };
  /** Ask a Your turn row's thread to address its feedback: the deck's listing confirm, with the PR's own thread named, then its Undo window. */
  const ask = (line: InventoryLine) => { const kind = askKind(line); if (kind) void batch.plan(kind, null, [line.prUrl]); };
  const on = availability(context);
  const contextRef = useRef(context);
  contextRef.current = context;
  function runKey(id: DeckActionId) {
    switch (id) {
      case "view": onView("deck"); return;
      case "palette": remember(); setDialog({ kind: "palette", query: "", highlight: 0 }); return;
      case "help": remember(); setDialog({ kind: "help" }); return;
      case "row-next": case "row-prev": {
        const all = Array.from(rootRef.current?.querySelectorAll<HTMLElement>("[data-inventory-row]") ?? []);
        const at = activeRow ? all.findIndex((element) => element.dataset.inventoryRow === activeRow) : -1;
        const next = all[at < 0 ? 0 : Math.max(0, Math.min(all.length - 1, at + (id === "row-next" ? 1 : -1)))];
        next?.focus({ preventScroll: true });
        next?.scrollIntoView({ block: "nearest" });
        return;
      }
      // The key opens the deck's listing confirm, which waits out its Undo window; only the row's own Nudge button is one click.
      case "nudge": if (focused && due) void batch.plan("nudge", null, [focused.prUrl]); return;
      case "fix": if (focused && fix) ask(focused); return;
      // The key starts it, as the bar's button does; nothing starts before its Undo window ends.
      case "address": address(); return;
      case "refresh": reread(); return;
      case "select": if (focused && selectable.includes(focused)) toggle(focused, false); return;
      case "select-section": setPicked(new Set(turnLines.map((line) => line.prUrl))); say(`Selected ${turnLines.length} on Your turn.`); return;
      case "clear": setPicked(new Set()); return;
      case "undo": if (undo?.live()) { const last = undo; setUndo(null); setFlash(null); void last.run(); } return;
      case "open-thread": if (thread) navigate.toThread(thread); return;
      case "open-pr": if (focused) navigate.openUrl(focused.prUrl); return;
      default: return;
    }
  }
  const runRef = useRef(runKey);
  runRef.current = runKey;
  useRegistryKeys(rootRef, { on: () => availability(contextRef.current), run: (id) => runRef.current(id), say, isRow: () => false });
  const palette = paletteItems(on, [], { held: [], done: [] }, null, false);
  const matches = dialog?.kind === "palette" ? paletteMatch(palette, dialog.query) : [];
  const runPalette = (entry: PaletteItem) => { setDialog(null); window.setTimeout(() => { if (entry.action) runKey(entry.action.id); }, 0); };

  return <>
    {screen ? <InventoryPane screen={screen} busyKey={busyKey} error={error} rootRef={rootRef}
      onView={onView} onPalette={() => runKey("palette")} onHelp={() => runKey("help")} onOpenPr={(url) => navigate.openUrl(url)} onOpenThread={(id) => navigate.toThread(id)}
      onOpenRoster={(effortId) => navigate.toPluginPanel("board", { subPath: `roster/${encodeURIComponent(effortId)}` })}
      onNudge={(line, action) => { void nudge(line, action); }}
      selected={picked} onSelect={toggle} onSelectAll={(all) => setPicked(new Set(all ? [...picked, ...turnLines.map((line) => line.prUrl)] : []))} onAddress={address}
      onClear={() => setPicked(new Set())} refusal={batch.refusal} notes={batch.details} onUndo={(batchId) => void undoBatch(batchId)} onDismiss={dismiss} working={batch.working} live={batch.live}
      onRefresh={(line) => void refresh.read([line.prUrl])} onRefreshSelected={reread} onRefreshAll={refresh.all} reading={refresh.reading}
      refresh={{ busy: refresh.reading.size > 0, progress: refresh.progress }}
      footer={<HintBar hints={hintKeys(context, on)} flash={flash ?? (refresh.progress ? { text: refresh.progress, undo: false, busy: true } : batch.sending ? { text: batch.sending, undo: false, busy: true } : null)} onPalette={() => runKey("palette")} onHelp={() => runKey("help")} onUndo={() => runKey("undo")} />} />
      : <InventoryPending error={error} onRetry={load} onView={onView} onPalette={() => runKey("palette")} onHelp={() => runKey("help")} />}
    {batch.element}
    <DeckDialog open={dialog?.kind === "palette"} title="All actions" bare onClose={() => setDialog(null)} onReturn={returnFocus}>
      {dialog?.kind === "palette" ? <div onKeyDown={(event) => {
        const live = matches.filter((entry) => entry.on);
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          setDialog({ ...dialog, highlight: Math.max(0, Math.min(live.length - 1, dialog.highlight + (event.key === "ArrowDown" ? 1 : -1))) });
        } else if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) { event.preventDefault(); const entry = live[dialog.highlight]; if (entry) runPalette(entry); }
        else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setDialog(null); }
      }}><PaletteBody query={dialog.query} items={matches} highlight={dialog.highlight} onQuery={(query) => setDialog({ ...dialog, query, highlight: 0 })}
        onRun={runPalette} onHighlight={(highlight) => setDialog({ ...dialog, highlight })} /></div> : null}
    </DeckDialog>
    <DeckDialog open={dialog?.kind === "help"} wide closeKey="?" title="Keys and colors" sub="The same keys do the same thing in Efforts and All PRs. Grayed keys don't apply here."
      onClose={() => setDialog(null)} onReturn={returnFocus}>
      {dialog?.kind === "help" ? <HelpBody items={palette} /> : null}
    </DeckDialog>
  </>;
}
