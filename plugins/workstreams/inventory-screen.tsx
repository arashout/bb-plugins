// The PR inventory, Workstreams' front door (plan amendment A13): every open
// PR you author, and every PR an effort names, by effort, answering three
// questions: what's forgotten in draft, what's missing a reviewer, and what
// needs a nudge. It renders server state only: inventory-view-model.ts shapes
// inventory_get's output. InventoryPane and its parts take data and callbacks
// as props and call no SDK hook, with relative imports, so static-markup
// tests can render them.
import type { RefObject } from "react";
import type { InventoryQuestion } from "./inventory-view";
import { Icon } from "./components/ui/icon";
import { cn, POINTER_CURSORS } from "./lib/utils";
import { InventoryList, InventoryTable, type RowCallbacks } from "./inventory-rows";
import type { InventoryScreen } from "./inventory-view-model";

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

export function InventoryPane(props: InventoryPaneProps) {
  const { screen, wide } = props;
  const rows = { groups: screen.groups, picker: props.picker, onAction: props.onAction, onRequest: props.onRequest, onPicker: props.onPicker,
    onOpenPr: props.onOpenPr, onOpenThread: props.onOpenThread, onOpenRoster: props.onOpenRoster };
  return <div ref={props.rootRef} role="region" aria-label="PR inventory" className={cn("flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground", POINTER_CURSORS)}>
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border/70 px-4 py-2.5">
      <div role="tablist" aria-label="Workstreams views" className="flex items-center gap-3 text-[12px]">
        <button type="button" role="tab" aria-selected className="rounded px-1 py-1 font-semibold">Inventory</button>
        {OTHER_VIEWS.map((view) => <button key={view.id} type="button" role="tab" aria-selected={false} onClick={() => props.onView(view.id)}
          className={cn("rounded px-1 py-1 text-muted-foreground hover:text-foreground", FOCUS)}>{view.title}</button>)}
      </div>
      <button type="button" onClick={props.onHow} className={cn("rounded px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground", FOCUS)}>How it works</button>
    </header>
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
