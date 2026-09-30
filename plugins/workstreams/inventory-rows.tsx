import { askKind, type InventoryLine, type LineAction } from "./inventory-view-model";
import { cn } from "./lib/utils";

export type SimpleGroup = { key: string; label: string; effortId: string | null; lines: InventoryLine[] };
export type SimpleRowsProps = {
  groups: SimpleGroup[];
  kind: "turn" | "other";
  busyKey: string | null;
  onOpenPr(url: string): void;
  onOpenThread(id: string): void;
  onOpenRoster(effortId: string): void;
  onNudge(line: InventoryLine, action: LineAction): void;
  /** Open the deck's listing confirm asking the PR's thread to address its feedback; nothing sends before you confirm it. */
  onAsk(line: InventoryLine): void;
};
const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-500";

export function SimpleInventoryList(props: SimpleRowsProps) {
  return <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
    {props.groups.map((group) => <section key={group.key} data-inventory-group={group.label} className="min-w-0">
      <h3 className="mb-1 px-4 text-[11px] font-medium text-muted-foreground">
        {group.effortId ? <button type="button" onClick={() => props.onOpenRoster(group.effortId!)} className={cn("rounded-sm hover:text-foreground hover:underline", FOCUS)}>{group.label}</button> : group.label}
      </h3>
      <ul className="min-w-0 divide-y divide-border/50 border-y border-border/50">
        {group.lines.map((line) => {
          const nudge = line.actions.find((action) => action.id === "nudge" && action.enabled);
          const thread = line.actions.find((action) => action.id === "thread" && action.enabled)?.threadId;
          const next = line.steps[0];
          const turn = props.kind === "turn" ? line.yourTurn : null;
          const ask = turn ? askKind(line) : null;
          const info = turn ? `${turn.text}${turn.age ? ` · ${turn.age}` : ""}` : `${line.status}${next ? ` · ${next.text}${next.age ? ` · ${next.age}` : ""}` : ""}`;
          return <li key={line.prUrl} data-inventory-row={`${line.slug}#${line.number}`} tabIndex={-1}
            className={cn("flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-[12px] hover:bg-foreground/[0.025]", FOCUS)}>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                {/* The PR number never truncates: a long repository name gives way first, as on the deck's rows. */}
                <button type="button" onClick={() => props.onOpenPr(line.prUrl)} title={`${line.slug}#${line.number}`}
                  className={cn("flex min-w-0 max-w-full rounded-sm font-mono text-[11px] text-muted-foreground hover:underline", FOCUS)}>
                  <span className="min-w-0 truncate">{line.slug}</span><span className="shrink-0">#{line.number}</span></button>
                <span className="min-w-0 truncate font-medium" title={line.title}>{line.title}</span>
              </div>
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground" title={info}>{info}</p>
              {line.last ? <p role="status" className={cn("text-[11px]", line.last.ok ? "text-muted-foreground" : "text-destructive")}>{line.last.text}</p> : null}
            </div>
            {turn && thread ? <button type="button" onClick={() => props.onOpenThread(thread)} className={cn("shrink-0 rounded-sm text-[11px] text-muted-foreground hover:underline", FOCUS)}>Open thread</button> : null}
            {ask ? <button type="button" data-inventory-action="ask" onClick={() => props.onAsk(line)}
              title={ask === "ask" ? "Ask its thread to address the approval's notes. You confirm the listing first, then Undo for 8 s."
                : "Ask its thread to address it. You confirm the listing first, then Undo for 8 s."}
              className={cn("shrink-0 rounded-md border border-border px-2 py-1 text-[11px] hover:bg-foreground/[0.06]", FOCUS)}>Ask its thread</button> : null}
            {nudge ? <button type="button" data-inventory-action="nudge" disabled={props.busyKey === line.prUrl} onClick={() => props.onNudge(line, nudge)}
              title={nudge.title} className={cn("shrink-0 rounded-md border border-border px-2 py-1 text-[11px] hover:bg-foreground/[0.06] disabled:opacity-50", FOCUS)}>Nudge</button> : null}
          </li>;
        })}
      </ul>
    </section>)}
  </div>;
}
