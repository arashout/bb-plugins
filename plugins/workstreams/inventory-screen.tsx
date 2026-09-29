// The PR inventory, Workstreams' front door (plan amendment A13): every open
// PR you author, and every PR an effort names, by effort, answering three
// questions: what's forgotten in draft, what's missing a reviewer, and what
// needs a nudge. It renders server state only: inventory-view-model.ts shapes
// inventory_get's output, and every write is one click on one row, through
// the inventory action RPCs or the existing fresh merge preview. InventoryPane
// and its parts take data and callbacks as props and call no SDK hook, with
// relative imports, so static-markup tests can render them.
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { InventoryQuestion, InventoryRow, InventoryView } from "./inventory-view";
import type { rpcContract } from "./server";
import { Icon } from "./components/ui/icon";
import { cn, POINTER_CURSORS } from "./lib/utils";
import { InventoryList, InventoryTable, TABLE_MIN_WIDTH, type RowCallbacks } from "./inventory-rows";
import { actionCall, INVENTORY_CHANGED, inventoryScreen, withOutcome, type ActionId, type InventoryLine, type InventoryScreen, type LineAction,
  type Outcome } from "./inventory-view-model";
import { MergePreviewDialog } from "./roster-merge-dialog";

/** The views beside the inventory, in the order the tabs and `V` walk them. */
export const OTHER_VIEWS = [{ id: "map", title: "Map" }, { id: "pipeline", title: "Pipeline" }, { id: "work", title: "Work" }, { id: "efforts", title: "Efforts" }] as const;
export type OtherView = (typeof OTHER_VIEWS)[number]["id"];

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
      <button type="button" role="tab" aria-selected className="rounded px-1 py-1 font-semibold">Inventory</button>
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
    onOpenPr: props.onOpenPr, onOpenThread: props.onOpenThread, onOpenRoster: props.onOpenRoster };
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

  if (!screen) return <InventoryPending error={error} onRetry={load} onView={onView} onHow={onHow} />;
  const openRoster = (effortId: string, n: number | null) =>
    navigate.toPluginPanel("board", { subPath: `roster/${encodeURIComponent(effortId)}${n === null ? "" : `/${n}`}` });
  return <>
    <InventoryPane screen={screen} wide={wide} error={error} picker={picker} rootRef={rootRef} onFilter={setFilter} onView={onView} onHow={onHow}
      onAction={(line, action) => void run(line, action)} onPicker={setPicker}
      onRequest={(line, logins) => { setPicker(null); const action = line.actions.find((item) => item.id === "request-review"); if (action) void run(line, action, logins); }}
      onOpenPr={(url) => navigate.openUrl(url)} onOpenThread={(id) => navigate.toThread(id)} onOpenRoster={openRoster} />
    <MergePreviewDialog targets={merging} onClose={() => setMerging(null)} onMerged={load} onOpenUrl={(url) => navigate.openUrl(url)}
      rows={(merging ?? []).flatMap(({ target }) => { const row = rows.get(target); return row ? [{ target, repo: row.repo, number: row.number, title: row.title }] : []; })} />
  </>;
}
