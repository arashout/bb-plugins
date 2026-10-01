import { sendable, type InventoryLine, type LineAction } from "./inventory-view-model";
import { Spin, TONE, WORKING_ROW } from "./deck-screen";
import type { LiveItems } from "./deck-flow";
import { sentChip, type Sent } from "./your-turn";
import { cn } from "./lib/utils";

export type SimpleGroup = { key: string; label: string; effortId: string | null; lines: InventoryLine[] };
export type SimpleRowsProps = {
  groups: SimpleGroup[];
  /** Your turn and Comments only rows show their feedback, select, and carry Address's chips; other rows their state. */
  kind: "turn" | "comments" | "other";
  busyKey: string | null;
  onOpenPr(url: string): void;
  onOpenThread(id: string): void;
  onOpenRoster(effortId: string): void;
  onNudge(line: InventoryLine, action: LineAction): void;
  /** Your turn and Comments only rows you selected for Address, by PR, and a click on one's checkbox; Shift takes the range from the last one you clicked. */
  selected?: ReadonlySet<string>;
  onSelect?(line: InventoryLine, shift: boolean): void;
  /** Why the last Address left a PR out, or dispatch refused it, by PR. */
  notes?: ReadonlyMap<string, string>;
  /** Take back a batch still in its Undo window. */
  onUndo?(batchId: string): void;
  /** Rows a batch call is planning now; and each item of a batch sending now, by PR. */
  working?: ReadonlySet<string>; live?: LiveItems;
  /** ↻ on a row reads it from GitHub again; the rows reading now spin. */
  onRefresh?(line: InventoryLine): void; reading?: ReadonlySet<string>;
};
const CHIP = "inline-flex h-5 min-w-0 max-w-72 shrink-0 items-center gap-1 rounded px-1.5 text-[11px]";

/** A sent PR's one state chip, which opens its thread however it ended; Sending's is Undo instead. */
function SentChip({ sent, onOpenThread, onUndo }: { sent: Sent; onOpenThread(id: string): void; onUndo?(batchId: string): void }) {
  const chip = sentChip(sent);
  const tone = TONE[chip.tone].chip;
  if (sent.state === "sending") return <span data-inventory-sent="sending" className={cn(CHIP, tone)}>Sending
    {sent.batchId && onUndo ? <button type="button" onClick={() => onUndo(sent.batchId!)} className={cn("rounded-sm font-medium underline", FOCUS)}>Undo</button> : null}</span>;
  return sent.threadId ? <button type="button" data-inventory-sent={sent.state} onClick={() => onOpenThread(sent.threadId!)} title={`${chip.text} · open “${sent.title ?? "its batch thread"}”`}
    className={cn(CHIP, tone, "hover:underline", FOCUS)}><span className="truncate">{chip.text}</span><span aria-hidden>↗</span></button>
    : <span data-inventory-sent={sent.state} title={chip.text} className={cn(CHIP, tone)}><span className="truncate">{chip.text}</span></span>;
}
const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-500";
/** A sending batch's item on its row: queued, sending, then what it came to. */
const LIVE: Record<NonNullable<ReturnType<LiveItems["get"]>>["state"], { text: string; tone: keyof typeof TONE }> = { pending: { text: "Queued", tone: "gray" },
  sending: { text: "Sending…", tone: "blue" }, sent: { text: "Sent", tone: "green" }, refused: { text: "Not sent", tone: "red" }, unknown: { text: "May not have sent", tone: "red" } };

export function SimpleInventoryList(props: SimpleRowsProps) {
  return <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
    {props.groups.map((group) => <section key={group.key} data-inventory-group={group.label} className="min-w-0">
      <h3 className="mb-1 px-4 text-[11px] font-medium text-muted-foreground">
        {group.effortId ? <button type="button" onClick={() => props.onOpenRoster(group.effortId!)} className={cn("rounded-sm hover:text-foreground hover:underline", FOCUS)}>{group.label}</button> : group.label}
      </h3>
      <ul className="min-w-0 divide-y divide-border/50 border-y border-border/50">
        {group.lines.map((line) => {
          const nudge = line.actions.find((action) => action.id === "nudge" && action.enabled);
          const next = line.steps[0];
          const turn = props.kind !== "other" ? line.yourTurn : null;
          const age = turn?.age ? ` · ${turn.age}` : "";
          const info = turn ? `${turn.text}${age}` : `${line.status}${next ? ` · ${next.text}${next.age ? ` · ${next.age}` : ""}` : ""}`;
          const picked = !!turn && !!props.selected?.has(line.prUrl);
          // A Your turn or Comments only row: its feedback, and one thing beside it: why the last Address left it out, what Address made of it, or its re-request.
          const note = turn ? props.notes?.get(line.prUrl) ?? null : null;
          const sent = turn && !note ? line.sent : null;
          const live = turn ? props.live?.get(line.prUrl) ?? null : null;
          const working = !!turn && !!props.working?.has(line.prUrl);
          const refresh = props.onRefresh ? line.actions.find((action) => action.id === "refresh") : undefined;
          const reading = !!props.reading?.has(line.prUrl);
          return <li key={line.prUrl} data-inventory-row={`${line.slug}#${line.number}`} data-inventory-selected={picked || undefined} tabIndex={-1}
            data-inventory-working={working || undefined} aria-busy={working || undefined}
            className={cn("group flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-[12px] hover:bg-foreground/[0.025]", picked && "bg-sky-500/[0.07]", working && WORKING_ROW, FOCUS)}>
            {turn && props.onSelect ? sendable(line) ? <input type="checkbox" tabIndex={-1} checked={picked} aria-label={`Select ${line.slug}#${line.number}`}
              onChange={() => undefined} onClick={(event) => props.onSelect!(line, event.shiftKey)} className="size-3.5 shrink-0 accent-sky-600" />
              : <span aria-hidden className="size-3.5 shrink-0" /> : null}
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                {/* The PR number never truncates: a long repository name gives way first, as on the deck's rows. */}
                <button type="button" onClick={() => props.onOpenPr(line.prUrl)} title={`${line.slug}#${line.number}`}
                  className={cn("flex min-w-0 max-w-full rounded-sm font-mono text-[11px] text-muted-foreground hover:underline", FOCUS)}>
                  <span className="min-w-0 truncate">{line.slug}</span><span className="shrink-0">#{line.number}</span></button>
                <span className="min-w-0 truncate font-medium" title={line.title}>{line.title}</span>
              </div>
              {/* The follow-up leads; the comments and bot notes beside it stay quiet. */}
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground" title={info}>{turn ? <>{turn.tag}
                {turn.rest ? <span data-inventory-rest className="text-muted-foreground/60"> · {turn.rest}</span> : null}{age}</> : info}</p>
              {line.last ? <p role="status" className={cn("text-[11px]", line.last.ok ? "text-muted-foreground" : "text-destructive")}>{line.last.text}</p> : null}
            </div>
            {refresh ? <button type="button" tabIndex={-1} data-inventory-action="refresh" disabled={reading || !refresh.enabled} aria-busy={reading || undefined}
              aria-label={reading ? `Reading ${line.slug}#${line.number} from GitHub` : refresh.title} title={reading ? "Reading GitHub now…" : refresh.why ?? `${refresh.title} (g)`}
              onClick={() => props.onRefresh!(line)} className={cn("inline-flex size-5 shrink-0 items-center justify-center rounded text-[12px] text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground disabled:hover:bg-transparent",
                FOCUS, reading ? "text-sky-700 dark:text-sky-300" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100")}>
              <span aria-hidden className={cn("inline-block leading-none", reading && "motion-safe:animate-spin")}>↻</span></button> : null}
            {live ? <span data-inventory-live={live.state} className={cn(CHIP, TONE[LIVE[live.state].tone].chip)}>{live.state === "sending" ? <Spin /> : null}{LIVE[live.state].text}</span>
              : note ? <span role="alert" data-inventory-left title={note} className={cn(CHIP, TONE.red.chip)}><span className="truncate">Left out: {note}</span></span>
              : sent ? <SentChip sent={sent} onOpenThread={props.onOpenThread} onUndo={props.onUndo} />
              : nudge ? <button type="button" data-inventory-action="nudge" disabled={props.busyKey === line.prUrl} onClick={() => props.onNudge(line, nudge)}
              title={nudge.title} className={cn("shrink-0 rounded-md border border-border px-2 py-1 text-[11px] hover:bg-foreground/[0.06] disabled:opacity-50", FOCUS)}>{nudge.label}</button> : null}
          </li>;
        })}
      </ul>
    </section>)}
  </div>;
}
