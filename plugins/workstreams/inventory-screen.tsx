// All PRs: Your turn, your PRs where a reviewer's feedback waits on you (onYourTurn), by effort, above every other open PR
// you author or an effort names. Its only write is Nudge, one click on a row where the server says it's due. It shares the deck's key
// registry, hint bar, palette, and ? sheet: j and k move between rows, and n opens the deck's listing confirm for the focused row's Nudge,
// never a write itself.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { InventoryRow, InventoryView } from "./inventory-view";
import type { rpcContract } from "./server";
import { Icon } from "./components/ui/icon";
import { cn, POINTER_CURSORS } from "./lib/utils";
import { SimpleInventoryList, type SimpleGroup } from "./inventory-rows";
import { actionCall, INVENTORY_CHANGED, inventoryScreen, onYourTurn, type InventoryLine, type InventoryScreen, type LineAction } from "./inventory-view-model";
import type { DeckActionId } from "./deck-keys";
import { readSeen, SEEN_KEY } from "./deck-place";
import { availability, hintKeys, paletteItems, paletteMatch, type KeyContext, type PaletteItem } from "./deck-view-model";
import { HelpBody, HintBar, PaletteBody } from "./deck-screen";
import { DeckDialog, useBatchConfirm, useRegistryKeys, type Undo } from "./deck-flow";

export const OTHER_VIEWS = [{ id: "map", title: "Map" }, { id: "pipeline", title: "Pipeline" }, { id: "work", title: "Work" }, { id: "efforts", title: "Manage efforts" }] as const;
export type OtherView = "deck" | (typeof OTHER_VIEWS)[number]["id"];
const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-ring";
const REGION = cn("flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground", POINTER_CURSORS);

/** Your turn above every other open PR, each by effort; a PR shows in only one. */
export function splitInventory(screen: InventoryScreen): { turn: SimpleGroup[]; other: SimpleGroup[] } {
  const turn: SimpleGroup[] = [];
  const other: SimpleGroup[] = [];
  for (const group of screen.groups) {
    const identity = { key: group.key, label: group.label, effortId: group.effort?.id ?? null };
    const mine = group.lines.filter(onYourTurn);
    const rest = group.lines.filter((line) => !onYourTurn(line));
    if (mine.length) turn.push({ ...identity, lines: mine });
    if (rest.length) other.push({ ...identity, lines: rest });
  }
  return { turn, other };
}

function Header({ onView, onHow }: { onView(view: OtherView): void; onHow(): void }) {
  return <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border/70 px-4 py-2.5">
    <div role="tablist" aria-label="Workstreams views" className="flex items-center gap-3 text-[12px]">
      <button type="button" role="tab" aria-selected={false} onClick={() => onView("deck")} className={cn("rounded px-1 py-1 text-muted-foreground hover:text-foreground", FOCUS)}>Efforts</button>
      <button type="button" role="tab" aria-selected className="rounded px-1 py-1 font-semibold">All PRs</button>
      {OTHER_VIEWS.map((view) => <button key={view.id} type="button" role="tab" aria-selected={false} onClick={() => onView(view.id)}
        className={cn("rounded px-1 py-1 text-muted-foreground hover:text-foreground", FOCUS)}>{view.title}</button>)}
    </div>
    <button type="button" onClick={onHow} className={cn("rounded px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground", FOCUS)}>How it works</button>
  </header>;
}

export function InventoryPending({ error, onRetry, onView, onHow }: { error: string | null; onRetry(): void; onView(view: OtherView): void; onHow(): void }) {
  return <div role="region" aria-label="PR inventory" className={REGION}>
    <Header onView={onView} onHow={onHow} />
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

export function InventoryPane(props: { screen: InventoryScreen; busyKey: string | null; error: string | null;
  onView(view: OtherView): void; onHow(): void; onOpenPr(url: string): void; onOpenThread(id: string): void; onOpenRoster(effortId: string): void;
  onNudge(line: InventoryLine, action: LineAction): void; rootRef?: RefObject<HTMLDivElement | null>;
  /** The deck's shared hint bar, under the lists. */
  footer?: ReactNode }) {
  const { turn, other } = splitInventory(props.screen);
  const [primaryNotice, ...otherNotices] = props.screen.notices;
  const callbacks = { busyKey: props.busyKey, onOpenPr: props.onOpenPr, onOpenThread: props.onOpenThread,
    onOpenRoster: props.onOpenRoster, onNudge: props.onNudge };
  return <div ref={props.rootRef} role="region" aria-label="PR inventory" className={REGION}>
    <Header onView={props.onView} onHow={props.onHow} />
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-8">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 pt-4">
        <h1 className="text-[18px] font-semibold tracking-tight">All PRs</h1>
        <p role="status" title={props.screen.read.title} className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
          {props.screen.read.refreshing ? <Icon name="Loading" className="size-3 motion-safe:animate-spin" aria-hidden /> : null}{props.screen.read.text}
        </p>
      </div>
      {props.error || props.screen.notices.length ? <div className="grid gap-1 px-4 pt-3">
        {props.error ? <p role="alert" className="text-[12px] text-destructive">Couldn't read the inventory: {props.error}</p> : null}
        {primaryNotice ? <Notice notice={primaryNotice} /> : null}
        {otherNotices.length ? <details className="text-[11px] text-muted-foreground">
          <summary className={cn("w-fit rounded-sm hover:text-foreground", FOCUS)}>{otherNotices.length} more inventory {otherNotices.length === 1 ? "notice" : "notices"}</summary>
          <div className="grid gap-1 pt-2">{otherNotices.map((notice) => <Notice key={notice.text} notice={notice} />)}</div>
        </details> : null}
      </div> : null}
      <section className="mt-5" aria-label="Your turn">
        <h2 className="mb-2 px-4 text-[14px] font-semibold">Your turn <span className="font-normal tabular-nums text-muted-foreground">{turn.reduce((sum, group) => sum + group.lines.length, 0)}</span></h2>
        {turn.length ? <SimpleInventoryList groups={turn} kind="turn" {...callbacks} />
          : <p className="px-4 text-[12px] text-muted-foreground">No feedback waits on you.</p>}
      </section>
      <section className="mt-7" aria-label="Other open PRs">
        <h2 className="mb-2 px-4 text-[14px] font-semibold">Other open PRs <span className="font-normal tabular-nums text-muted-foreground">{other.reduce((sum, group) => sum + group.lines.length, 0)}</span></h2>
        {other.length ? <SimpleInventoryList groups={other} kind="other" {...callbacks} />
          : <p className="px-4 text-[12px] text-muted-foreground">{props.screen.empty ?? "No other open PRs."}</p>}
      </section>
    </div>
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

export function InventoryNavView({ onView, onHow }: { onView(view: OtherView): void; onHow(): void }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const { view, error, load } = useInventory();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, { at: number; action: "nudge"; ok: boolean; text: string }>>(new Map());
  const now = Date.now();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const screen = useMemo(() => view && inventoryScreen(view, { now, filter: null, outcomes }), [view, now, outcomes]);
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
  const opener = useRef<HTMLElement | null>(null);
  const flashTimer = useRef<number | null>(null);
  const say = useCallback((text: string, withUndo = false, ms?: number) => {
    setFlash({ text, undo: withUndo });
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), ms ?? (withUndo ? 9_000 : 5_000));
  }, []);
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
  // Nudge is due exactly where its row shows the button.
  const due = focused?.actions.find((action) => action.id === "nudge" && action.enabled) ?? null;
  const thread = focused?.actions.find((action) => action.id === "thread" && action.enabled)?.threadId ?? null;
  const context: KeyContext = { view: "prs", cur: null, focused: null, selected: [], seenAvailable: false, undo: !!undo?.live(), held: 0, done: 0,
    prs: { row: !!focused, thread: !!thread, moves: new Set<DeckActionId>(due ? ["nudge"] : []) } };
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

  if (!screen) return <InventoryPending error={error} onRetry={load} onView={onView} onHow={onHow} />;
  return <>
    <InventoryPane screen={screen} busyKey={busyKey} error={error} rootRef={rootRef}
      onView={onView} onHow={onHow} onOpenPr={(url) => navigate.openUrl(url)} onOpenThread={(id) => navigate.toThread(id)}
      onOpenRoster={(effortId) => navigate.toPluginPanel("board", { subPath: `roster/${encodeURIComponent(effortId)}` })}
      onNudge={(line, action) => { void nudge(line, action); }}
      footer={<HintBar hints={hintKeys(context, on)} flash={flash} onPalette={() => runKey("palette")} onHelp={() => runKey("help")} onUndo={() => runKey("undo")} />} />
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
