import { sendable, type InventoryLine, type LineAction } from "./inventory-view-model";
import { BUTTON, CHECKBOX, PrRef, RING, ROW, Spin, TONE, WORKING_ROW } from "./deck-screen";
import type { LiveItems } from "./deck-flow";
import { sentText, type Sent } from "./your-turn";
import { cn } from "./lib/utils";

export type SimpleGroup = { key: string; label: string; effortId: string | null; lines: InventoryLine[] };
export type SimpleRowsProps = {
  groups: SimpleGroup[];
  /** Your turn rows show why, select, and dismiss; dismissed ones show why and come back; other rows their state. Any row links its sent thread. */
  kind: "turn" | "dismissed" | "other";
  busyKey: string | null;
  onOpenPr(url: string): void;
  onOpenThread(id: string): void;
  onOpenEffort(effortId: string): void;
  onNudge(line: InventoryLine, action: LineAction): void;
  /** Your turn rows you selected for Address, by PR, and a click on one's checkbox; Shift takes the range from the last one you clicked. */
  selected?: ReadonlySet<string>;
  onSelect?(line: InventoryLine, shift: boolean): void;
  /** Why the last Address didn't send a PR, by PR. */
  notes?: ReadonlyMap<string, string>;
  /** Dismiss a Your turn row, or bring a dismissed one back. */
  onDismiss?(line: InventoryLine, dismiss: boolean): void;
  /** Take back a batch still in its Undo window. */
  onUndo?(batchId: string): void;
  /** Rows a batch call is planning now; and each item of a batch sending now, by PR. */
  working?: ReadonlySet<string>; live?: LiveItems;
  /** ↻ on a row reads it from GitHub again; the rows reading now spin. */
  onRefresh?(line: InventoryLine): void; reading?: ReadonlySet<string>;
};
const CHIP = "inline-flex h-5 min-w-0 max-w-72 items-center gap-1 rounded px-1.5 text-[11px]";

const SENT_TONE: Record<Sent["state"], keyof typeof TONE> = { sending: "gray", refused: "red", working: "blue", "needs-you": "amber", failed: "red", idle: "gray" };
/** A sent PR's link to its thread with BB's status for it, grey off Your turn; Sending's is Undo instead, and a refusal says why. */
function SentChip({ sent, quiet, onOpenThread, onUndo }: { sent: Sent; quiet: boolean; onOpenThread(id: string): void; onUndo?(batchId: string): void }) {
  const text = sentText(sent);
  const tone = TONE[quiet ? "gray" : SENT_TONE[sent.state]].chip;
  if (sent.state === "sending") return <span data-inventory-sent="sending" className={cn(CHIP, tone)}>Sending
    {sent.batchId && onUndo ? <> · <button type="button" onClick={() => onUndo(sent.batchId!)} className={cn("rounded-sm font-medium underline", RING)}>Undo</button></> : null}</span>;
  return sent.threadId ? <button type="button" data-inventory-sent={sent.state} onClick={() => onOpenThread(sent.threadId!)} title={`${text} · open “${sent.title ?? "its batch thread"}”`}
    className={cn(CHIP, tone, "hover:underline", RING)}><span className="truncate">{text}</span><span aria-hidden>↗</span></button>
    : <span role={sent.state === "refused" ? "alert" : undefined} data-inventory-sent={sent.state} title={text} className={cn(CHIP, tone)}><span className="truncate">{text}</span></span>;
}
/** A sending batch's item on its row: queued, sending, then what it came to. */
const LIVE: Record<NonNullable<ReturnType<LiveItems["get"]>>["state"], { text: string; tone: keyof typeof TONE }> = { pending: { text: "Queued", tone: "gray" },
  sending: { text: "Sending…", tone: "blue" }, sent: { text: "Sent", tone: "green" }, refused: { text: "Not sent", tone: "red" }, unknown: { text: "May not have sent", tone: "red" } };

export function SimpleInventoryList(props: SimpleRowsProps) {
  // The deck's rows: one line each, indented under their section's heading, with no rules between them.
  return <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 pb-1.5 pt-0.5">
    {props.groups.map((group) => <section key={group.key} data-inventory-group={group.label} className="min-w-0">
      <h3 className="ml-9 pb-0.5 pt-1.5 text-[11px] font-medium text-muted-foreground">
        {group.effortId ? <button type="button" onClick={() => props.onOpenEffort(group.effortId!)} className={cn("rounded-sm hover:text-foreground hover:underline", RING)}>{group.label}</button> : group.label}
      </h3>
      <ul className="min-w-0 list-none">
        {group.lines.map((line) => {
          const nudge = line.actions.find((action) => action.id === "nudge" && action.enabled);
          const next = line.steps[0];
          const turn = props.kind !== "other" ? line.yourTurn : null;
          const mine = props.kind === "turn";
          const info = turn ? `${turn.why}${turn.age ? ` · ${turn.age}` : ""}` : `${line.status}${next ? ` · ${next.text}${next.age ? ` · ${next.age}` : ""}` : ""}`;
          const picked = mine && !!props.selected?.has(line.prUrl);
          // One thing beside it: a batch sending it now, why the last Address didn't send it, its sent thread, or, off Your turn, its Nudge.
          const note = mine ? props.notes?.get(line.prUrl) ?? null : null;
          const sent = note ? { state: "refused" as const, threadId: null, title: null, detail: note, batchId: null } : mine || line.sent?.threadId ? line.sent : null;
          const live = mine ? props.live?.get(line.prUrl) ?? null : null;
          const working = mine && !!props.working?.has(line.prUrl);
          const refresh = props.onRefresh ? line.actions.find((action) => action.id === "refresh") : undefined;
          const reading = !!props.reading?.has(line.prUrl);
          const box = mine && !!props.onSelect;
          return <li key={line.prUrl} data-inventory-row={`${line.slug}#${line.number}`} data-inventory-selected={picked || undefined} tabIndex={-1}
            data-inventory-working={working || undefined} aria-busy={working || undefined}
            className={cn("group ml-7 min-w-0 rounded-md hover:bg-foreground/[0.03] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-500",
              picked && "bg-sky-500/[0.07]", working && WORKING_ROW)}>
            <div className={ROW}>
              {box ? sendable(line) ? <input type="checkbox" tabIndex={-1} checked={picked} aria-label={`Select ${line.slug}#${line.number}`}
                onChange={() => undefined} onClick={(event) => props.onSelect!(line, event.shiftKey)} className={CHECKBOX} />
                : <span aria-hidden className="size-3.5 shrink-0" /> : null}
              <PrRef repo={line.slug} number={line.number} strong={mine || !!nudge} onClick={() => props.onOpenPr(line.prUrl)} />
              <span className={cn("min-w-16 flex-1 truncate @min-[900px]:min-w-0", mine || nudge ? "text-foreground" : "text-foreground/80")} title={line.title}>{line.title}</span>
              <span className="min-w-0 truncate text-[11.5px] text-muted-foreground" title={info}>{info}</span>
              {refresh ? <button type="button" tabIndex={-1} data-inventory-action="refresh" disabled={reading || !refresh.enabled} aria-busy={reading || undefined}
                aria-label={reading ? `Reading ${line.slug}#${line.number} from GitHub` : refresh.title} title={reading ? "Reading GitHub now…" : refresh.why ?? `${refresh.title} (g)`}
                onClick={() => props.onRefresh!(line)} className={cn("inline-flex size-5 shrink-0 items-center justify-center rounded text-[12px] text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground disabled:hover:bg-transparent",
                  RING, reading ? "text-sky-700 dark:text-sky-300" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100")}>
                <span aria-hidden className={cn("inline-block leading-none", reading && "motion-safe:animate-spin")}>↻</span></button> : null}
              {turn && props.onDismiss ? <button type="button" tabIndex={-1} data-inventory-action={mine ? "dismiss" : "undismiss"} onClick={() => props.onDismiss!(line, mine)}
                title={mine ? "Hide until the head moves or someone says something new" : "Back on Your turn"}
                className={cn("shrink-0 rounded px-1 text-[11.5px] text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground", RING,
                  mine && "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100")}>{mine ? "Dismiss" : "Undismiss"}</button> : null}
              {live ? <span data-inventory-live={live.state} className={cn(CHIP, TONE[LIVE[live.state].tone].chip)}>{live.state === "sending" ? <Spin /> : null}{LIVE[live.state].text}</span>
                : sent ? <SentChip sent={sent} quiet={!mine} onOpenThread={props.onOpenThread} onUndo={props.onUndo} />
                : nudge ? <button type="button" data-inventory-action="nudge" disabled={props.busyKey === line.prUrl} onClick={() => props.onNudge(line, nudge)}
                title={nudge.title} className={cn(BUTTON, "h-5 border-border px-1.5 text-[11.5px] hover:bg-foreground/[0.06]")}>{nudge.label}</button> : null}
            </div>
            {/* The last action's outcome, word for word, under the line rather than truncated in it. */}
            {line.last ? <p role="status" className={cn("pb-1.5 pr-1.5 text-[11px]", box ? "pl-[30px]" : "pl-2", line.last.ok ? "text-muted-foreground" : "text-destructive")}>{line.last.text}</p> : null}
          </li>;
        })}
      </ul>
    </section>)}
  </div>;
}
