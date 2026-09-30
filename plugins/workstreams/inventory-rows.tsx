import type { InventoryLine, LineAction } from "./inventory-view-model";
import type { FeedbackItem } from "./review-feedback-queue";
import { cn } from "./lib/utils";

export type SimpleGroup = { key: string; label: string; effortId: string | null; rows: { line?: InventoryLine; item?: FeedbackItem }[] };
export type SimpleRowsProps = {
  groups: SimpleGroup[];
  kind: "feedback" | "other";
  busyKey: string | null;
  onOpenPr(url: string): void;
  onOpenThread(id: string): void;
  onOpenRoster(effortId: string): void;
  onStart(item: FeedbackItem): void;
  onNudge(line: InventoryLine, action: LineAction): void;
};
const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-500";

function age(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}

export function SimpleInventoryList(props: SimpleRowsProps) {
  return <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
    {props.groups.map((group) => <section key={group.key} data-inventory-group={group.label} className="min-w-0">
      <h3 className="mb-1 px-4 text-[11px] font-medium text-muted-foreground">
        {group.effortId ? <button type="button" onClick={() => props.onOpenRoster(group.effortId!)} className={cn("rounded-sm hover:text-foreground hover:underline", FOCUS)}>{group.label}</button> : group.label}
      </h3>
      <ul className="min-w-0 divide-y divide-border/50 border-y border-border/50">
        {group.rows.map(({ line, item }) => {
          const url = item?.url ?? line!.prUrl;
          const repo = item?.repo ?? line!.slug;
          const number = item?.number ?? line!.number;
          const title = item?.title ?? line!.title;
          const nudge = line?.actions.find((action) => action.id === "nudge" && action.enabled);
          const thread = item ? item.threadId : line?.actions.find((action) => action.id === "thread" && action.enabled)?.threadId;
          const next = line?.steps[0];
          return <li key={url} data-inventory-row={`${repo}#${number}`} tabIndex={-1}
            className={cn("flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-[12px] hover:bg-foreground/[0.025]", FOCUS)}>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                {/* The PR number never truncates: a long repository name gives way first, as on the deck's rows. */}
                <button type="button" onClick={() => props.onOpenPr(url)} title={`${repo}#${number}`}
                  className={cn("flex min-w-0 max-w-full rounded-sm font-mono text-[11px] text-muted-foreground hover:underline", FOCUS)}>
                  <span className="min-w-0 truncate">{repo}</span><span className="shrink-0">#{number}</span></button>
                <span className="min-w-0 truncate font-medium" title={title}>{title}</span>
              </div>
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground" title={item?.reason ?? next?.text ?? line?.status}>
                {item ? `${item.reason} · ${age(item.updatedAt)}` : `${line!.status}${next ? ` · ${next.text}${next.age ? ` · ${next.age}` : ""}` : ""}`}
              </p>
              {line?.last ? <p role="status" className={cn("text-[11px]", line.last.ok ? "text-muted-foreground" : "text-destructive")}>{line.last.text}</p> : null}
            </div>
            {props.kind === "feedback" && item ? (thread ? <button type="button" onClick={() => props.onOpenThread(thread)} className={cn("shrink-0 rounded-sm text-[11px] text-muted-foreground hover:underline", FOCUS)}>Open thread</button>
              : <button type="button" onClick={() => props.onStart(item)} disabled={props.busyKey === item.key} className={cn("shrink-0 rounded-md border border-border px-2 py-1 text-[11px] hover:bg-foreground/[0.06] disabled:opacity-50", FOCUS)}>Start</button>) : null}
            {props.kind === "other" && nudge && line ? <button type="button" data-inventory-action="nudge" disabled={props.busyKey === line.prUrl} onClick={() => props.onNudge(line, nudge)}
              title={nudge.title} className={cn("shrink-0 rounded-md border border-border px-2 py-1 text-[11px] hover:bg-foreground/[0.06] disabled:opacity-50", FOCUS)}>Nudge</button> : null}
          </li>;
        })}
      </ul>
    </section>)}
  </div>;
}
