// The PR inventory, Workstreams' front door (plan amendment A13): every open
// PR you author, and every PR an effort names, by effort, answering three
// questions: what's forgotten in draft, what's missing a reviewer, and what
// needs a nudge. It renders server state only: inventory-view-model.ts shapes
// inventory_get's output, and every write is one click on one row, through
// the inventory action RPCs or the existing fresh merge preview. InventoryPane
// and its parts take data and callbacks as props and call no SDK hook, with
// relative imports, so static-markup tests can render them. As All PRs beside
// the effort deck (A15), it shares the deck's key registry: a key that writes
// opens the deck's listing confirm for the focused row, never a write itself.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { InventoryQuestion, InventoryRow, InventoryView } from "./inventory-view";
import type { rpcContract } from "./server";
import { Icon } from "./components/ui/icon";
import { cn, POINTER_CURSORS } from "./lib/utils";
import { InventoryList, InventoryTable, TABLE_MIN_WIDTH, type RowCallbacks } from "./inventory-rows";
import { actionCall, INVENTORY_CHANGED, inventoryScreen, withOutcome, type ActionId, type InventoryLine, type InventoryScreen, type LineAction,
  type Outcome } from "./inventory-view-model";
import { MergePreviewDialog } from "./roster-merge-dialog";
import type { DeckActionId } from "./deck-keys";
import { readSeen, SEEN_KEY } from "./deck-place";
import { availability, hintKeys, KIND_OF, paletteItems, paletteMatch, type KeyContext, type PaletteItem } from "./deck-view-model";
import { HelpBody, HintBar, HoldBody, PaletteBody } from "./deck-screen";
import { DeckDialog, useBatchConfirm, useRegistryKeys, type Undo } from "./deck-flow";

/** The views after All PRs, in tab order; the effort deck comes before it. */
export const OTHER_VIEWS = [{ id: "map", title: "Map" }, { id: "pipeline", title: "Pipeline" }, { id: "work", title: "Work" }, { id: "efforts", title: "Manage efforts" }] as const;
export type OtherView = "deck" | (typeof OTHER_VIEWS)[number]["id"];

export type InventoryPaneProps = RowCallbacks & {
  screen: InventoryScreen;
  /** The PR whose reviewer picker is open. */
  picker: string | null;
  /** The pane is 1100px or wider, where the dense table's Title and Next columns fit: the table, else two-line rows. */
  wide: boolean;
  /** The read failed before any view arrived, or a later read failed. */
  error: string | null;
  onFilter(question: InventoryQuestion | null): void;
  onView(view: OtherView): void;
  onHow(): void;
  rootRef?: RefObject<HTMLDivElement | null>;
  /** The shared hint bar, under the rows. */
  footer?: ReactNode;
};

const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** The three questions as counts; each shows only its rows, and pressing it again shows every row. */
function Counts({ screen, onFilter }: Pick<InventoryPaneProps, "screen" | "onFilter">) {
  return <div role="group" aria-label="Filter by question" className="flex flex-wrap gap-2 px-4 pt-3">
    {screen.counts.map((count) => <button key={count.key} type="button" aria-pressed={count.active} onClick={() => onFilter(count.active ? null : count.key)}
      aria-label={`${count.label}: ${count.count}. ${count.active ? "Showing only these; press to show every PR" : "Show only these"}`}
      className={cn("flex min-w-36 items-baseline gap-2 rounded-lg border px-3 py-1.5 text-left", FOCUS,
        count.active ? "border-foreground/50 bg-foreground/[0.08]" : "border-border hover:bg-foreground/[0.04]")}>
      <span className={cn("text-[18px] font-semibold tabular-nums", count.count === 0 && "text-muted-foreground")}>{count.count}</span>
      <span className="text-[12px]">{count.label}</span>
    </button>)}
  </div>;
}

/** The view tabs and How it works, which every state of the inventory keeps, so the other views never hang on its read. */
function Header({ onView, onHow }: Pick<InventoryPaneProps, "onView" | "onHow">) {
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

const REGION = cn("flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground", POINTER_CURSORS);

/** Before the first read arrives, or when it failed: the tabs stay, and a failed read offers Retry. */
export function InventoryPending({ error, onRetry, onView, onHow }: { error: string | null; onRetry(): void } & Pick<InventoryPaneProps, "onView" | "onHow">) {
  return <div role="region" aria-label="PR inventory" className={REGION}>
    <Header onView={onView} onHow={onHow} />
    <div className="p-4 text-[12px]" role={error ? "alert" : "status"}>
      {error ? <span className="text-destructive">Couldn't read the inventory: {error} <button type="button" onClick={onRetry}
        className={cn("ml-1 rounded-sm underline", FOCUS)}>Retry</button></span>
        : <span className="text-muted-foreground">Reading your open PRs…</span>}
    </div>
  </div>;
}

export function InventoryPane(props: InventoryPaneProps) {
  const { screen, wide } = props;
  const rows = { groups: screen.groups, picker: props.picker, onAction: props.onAction, onRequest: props.onRequest, onPicker: props.onPicker,
    onOpenPr: props.onOpenPr, onOpenThread: props.onOpenThread, onOpenRoster: props.onOpenRoster, onHold: props.onHold };
  return <div ref={props.rootRef} role="region" aria-label="PR inventory" className={REGION}>
    <Header onView={props.onView} onHow={props.onHow} />
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-8">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 pt-4">
        <h1 className="text-[18px] font-semibold tracking-tight">PR inventory</h1>
        <p role="status" title={screen.read.title} className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
          {screen.read.refreshing ? <Icon name="Loading" className="size-3 motion-safe:animate-spin" aria-hidden /> : null}{screen.read.text}
        </p>
      </div>
      <Counts screen={screen} onFilter={props.onFilter} />
      {props.error || screen.notices.length ? <div className="grid gap-1 px-4 pt-3">
        {props.error ? <p role="alert" className="text-[12px] text-destructive">Couldn't read the inventory: {props.error}</p> : null}
        {screen.notices.map((notice) => <p key={notice.text} role={notice.tone === "error" ? "alert" : "status"}
          className={cn("flex items-start gap-1.5 text-[12px]", notice.tone === "error" ? "text-destructive" : "text-muted-foreground")}>
          <Icon name={notice.tone === "error" ? "AlertTriangle" : "Info"} className="mt-0.5 size-3.5 shrink-0" aria-hidden />{notice.text}
        </p>)}
      </div> : null}
      {screen.empty ? <p role="status" className="mx-4 mt-4 flex items-center gap-2 rounded-md border border-border bg-foreground/[0.03] px-3 py-2 text-[12px]">
        <Icon name="CircleCheck" className="size-4 shrink-0 text-muted-foreground" aria-hidden />{screen.empty}
      </p> : <div className="mt-2">{wide ? <InventoryTable {...rows} /> : <InventoryList {...rows} />}</div>}
    </div>
    {props.footer}
  </div>;
}

// ---------------------------------------------------------------------------
// Data, state, and the SDK: everything below talks to BB.
// ---------------------------------------------------------------------------

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(timer);
  }, [ms]);
  return now;
}

/**
 * inventory_get, read on mount, on inventory-changed, on board-changed at most every 3 seconds while visible (effort membership and
 * names move that way), and when the page shows again. A signal during a read reads once more after it.
 */
function useInventory() {
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
  return { view, error, load };
}

/** The inventory in the Workstreams panel: live from the server, one click per action, and the fresh merge preview behind Merge…. */
/** The deck batch each row action is, for the shared keys. */
const KEY_OF: Partial<Record<ActionId, DeckActionId>> = { merge: "merge", "confirm-handled": "confirm", nudge: "nudge", "request-review": "request", "mark-ready": "ready" };

export function InventoryNavView({ onView, onHow }: { onView(view: OtherView): void; onHow(): void }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const { view, error, load } = useInventory();
  // "checked 25s ago" moves while you watch.
  const now = useNow(5_000);
  const [filter, setFilter] = useState<InventoryQuestion | null>(null);
  const [pending, setPending] = useState<ReadonlyMap<string, ActionId>>(new Map());
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, Outcome>>(new Map());
  const [picker, setPicker] = useState<string | null>(null);
  const [merging, setMerging] = useState<{ target: string; n: null }[] | null>(null);
  const [wide, setWide] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const shown = view !== null;
  // The pane's own width picks the layout, so a narrow panel gets two-line rows even on a wide screen.
  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setWide((entry?.contentRect.width ?? node.clientWidth) >= TABLE_MIN_WIDTH));
    observer.observe(node);
    setWide(node.clientWidth >= TABLE_MIN_WIDTH);
    return () => observer.disconnect();
  }, [shown]);
  const rows = useMemo(() => new Map<string, InventoryRow>(view?.groups.flatMap((group) => group.rows.map((row) => [row.prUrl, row] as const)) ?? []), [view]);
  const screen = useMemo(() => view && inventoryScreen(view, { now, filter, pending, outcomes }), [view, now, filter, pending, outcomes]);

  /** One click, one call: the row's facts go with it, and what comes back, a refusal included, shows on the row. */
  const run = useCallback(async (line: InventoryLine, action: LineAction, logins: string[] = []) => {
    const row = rows.get(line.prUrl);
    if (!row) return;
    const call = actionCall(row, action, logins);
    // A disabled action names why in its label and tooltip; clicking it does nothing.
    if (call.kind === "refuse") return;
    if (call.kind === "thread") { navigate.toThread(call.threadId); return; }
    // Merge… only opens the fresh merge preview; only a click or ⌘↵ there merges.
    if (call.kind === "preview") { setMerging([{ target: call.target, n: null }]); return; }
    if (pending.has(line.prUrl)) return;
    setPending((current) => new Map([...current, [line.prUrl, action.id]]));
    let result: { ok: boolean; text: string } | null;
    try {
      if (call.kind === "refresh") {
        const read = await rpc.call("pr_refresh", { prUrl: call.prUrl });
        // A good read shows as the row's new age, and clears this visit's failed one; only a failed read needs saying.
        result = read.status === "checked" ? null : { ok: false, text: read.error };
      } else {
        const written = call.method === "inventory_mark_ready" ? await rpc.call("inventory_mark_ready", call.input)
          : call.method === "inventory_request_review" ? await rpc.call("inventory_request_review", call.input)
          : call.method === "inventory_confirm_handled" ? await rpc.call("inventory_confirm_handled", call.input) : await rpc.call("inventory_nudge", call.input);
        result = written.ok ? { ok: true, text: written.detail } : { ok: false, text: written.error };
      }
    } catch (cause) {
      result = { ok: false, text: message(cause) };
    }
    setOutcomes((current) => withOutcome(current, line.prUrl, result && { at: Date.now(), action: action.id, ...result }));
    setPending((current) => { const next = new Map(current); next.delete(line.prUrl); return next; });
    load();
  }, [rows, pending, rpc, navigate, load]);

  // ---- the deck's shared keys, hint bar, palette, and ? sheet ----------------
  const [dialog, setDialog] = useState<{ kind: "hold"; line: InventoryLine; reason: string } | { kind: "palette"; query: string; highlight: number } | { kind: "help" } | null>(null);
  const [holdError, setHoldError] = useState<string | null>(null);
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
  const focused = activeRow ? screen?.groups.flatMap((group) => group.lines).find((line) => `${line.slug}#${line.number}` === activeRow) ?? null : null;
  const context: KeyContext = { view: "prs", cur: null, focused: null, selected: [], seenAvailable: false, undo: !!undo?.live(), held: 0, done: 0,
    prs: { row: !!focused, thread: !!focused?.actions.find((action) => action.id === "thread")?.enabled,
      moves: new Set([...(focused?.actions ?? []).flatMap((action) => action.enabled && KEY_OF[action.id] ? [KEY_OF[action.id]!] : []),
        ...focused?.hold ? ["release" as const] : []]) } };
  const on = availability(context);
  const contextRef = useRef(context);
  contextRef.current = context;
  /** Hold asks for a reason first; a release lists the PR and waits out its Undo window, as it does in the deck. */
  const hold = (line: InventoryLine) => {
    if (!line.hold) { remember(); setHoldError(null); setDialog({ kind: "hold", line, reason: "" }); return; }
    void batch.plan("release", null, [line.prUrl]);
  };
  const saveHold = () => {
    if (dialog?.kind !== "hold") return;
    const { line, reason } = dialog;
    void rpc.call("pr_hold_set", { prUrl: line.prUrl, held: true, reason: reason.trim() || undefined }).then(() => { setDialog(null); say(`Held ${line.repo} #${line.number}.`); load(); },
      (cause: unknown) => setHoldError(message(cause)));
  };
  function runKey(id: DeckActionId) {
    const action = (actionId: ActionId) => focused?.actions.find((item) => item.id === actionId);
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
      case "merge": { const merge = action("merge"); if (focused && merge) { remember(); void run(focused, merge); } return; }
      // Review notes are never a batch: c is the row's own Confirm handled, which refuses without evidence of handling.
      case "confirm": { const confirm = action("confirm-handled"); if (focused && confirm) void run(focused, confirm); return; }
      case "nudge": case "request": case "ready": if (focused) void batch.plan(KIND_OF[id]!, null, [focused.prUrl]); return;
      case "undo": if (undo?.live()) { const last = undo; setUndo(null); setFlash(null); void last.run(); } return;
      case "hold-pr": if (focused) hold(focused); return;
      case "release": if (focused?.hold) hold(focused); return;
      case "refresh": { const refresh = action("refresh"); if (focused && refresh) void run(focused, refresh); return; }
      case "open-thread": { const thread = action("thread")?.threadId; if (thread) navigate.toThread(thread); return; }
      case "open-pr": if (focused) navigate.openUrl(focused.prUrl); return;
      default: return;
    }
  }
  const runRef = useRef(runKey);
  runRef.current = runKey;
  useRegistryKeys(rootRef, { on: () => availability(contextRef.current), run: (id) => runRef.current(id), say, isRow: () => false });
  const palette = paletteItems(on, [], { held: [], done: [] }, null, false);
  const matches = dialog?.kind === "palette" ? paletteMatch(palette, dialog.query) : [];
  const runPalette = (item: PaletteItem) => { setDialog(null); window.setTimeout(() => { if (item.action) runKey(item.action.id); }, 0); };

  if (!screen) return <InventoryPending error={error} onRetry={load} onView={onView} onHow={onHow} />;
  const openRoster = (effortId: string, n: number | null) =>
    navigate.toPluginPanel("board", { subPath: `roster/${encodeURIComponent(effortId)}${n === null ? "" : `/${n}`}` });
  return <>
    <InventoryPane screen={screen} wide={wide} error={error} picker={picker} rootRef={rootRef} onFilter={setFilter} onView={onView} onHow={onHow}
      onAction={(line, action) => { if (action.id === "merge") remember(); void run(line, action); }} onPicker={setPicker} onHold={hold}
      onRequest={(line, logins) => { setPicker(null); const action = line.actions.find((item) => item.id === "request-review"); if (action) void run(line, action, logins); }}
      onOpenPr={(url) => navigate.openUrl(url)} onOpenThread={(id) => navigate.toThread(id)} onOpenRoster={openRoster}
      footer={<HintBar hints={hintKeys(context, on)} flash={flash} onPalette={() => runKey("palette")} onHelp={() => runKey("help")} onUndo={() => runKey("undo")} />} />
    <MergePreviewDialog targets={merging} onClose={() => setMerging(null)} onMerged={load} onOpenUrl={(url) => navigate.openUrl(url)} onClosed={returnFocus}
      rows={(merging ?? []).flatMap(({ target }) => { const row = rows.get(target); return row ? [{ target, repo: row.repo, number: row.number, title: row.title }] : []; })} />
    {batch.element}
    <DeckDialog open={dialog?.kind === "hold"} title={dialog?.kind === "hold" ? `Hold ${dialog.line.repo} #${dialog.line.number}` : ""}
      sub="Nothing acts on this PR, and no batch writes to it, until you release it." onClose={() => setDialog(null)} onReturn={returnFocus} onConfirmKey={saveHold}>
      {dialog?.kind === "hold" ? <HoldBody reason={dialog.reason} onReason={(reason) => setDialog({ ...dialog, reason })} busy={false} error={holdError} onHold={saveHold}
        onCancel={() => setDialog(null)} /> : null}
    </DeckDialog>
    <DeckDialog open={dialog?.kind === "palette"} title="All actions" bare onClose={() => setDialog(null)} onReturn={returnFocus}>
      {dialog?.kind === "palette" ? <div onKeyDown={(event) => {
        const live = matches.filter((item) => item.on);
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          setDialog({ ...dialog, highlight: Math.max(0, Math.min(live.length - 1, dialog.highlight + (event.key === "ArrowDown" ? 1 : -1))) });
        } else if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) { event.preventDefault(); const item = live[dialog.highlight]; if (item) runPalette(item); }
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
