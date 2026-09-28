// The roster's rows: a column table at 900px and wider, two-line rows below.
// Presentational only: data and callbacks come in as props, no SDK hook is
// called, and imports stay relative, so static-markup tests can render it.
import type { CSSProperties, ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Icon } from "./components/ui/icon";
import { Tip } from "./components/ui/tooltip";
import { usePortalScopeProps } from "./lib/portal-scope";
import { cn } from "./lib/utils";
import type { Chip, MenuItem, RosterGroup, RosterLine, Tone } from "./roster-view-model";

/** A held row's diagonal hatch, drawn in the text color so it reads in either theme. */
export const HATCH: CSSProperties = { backgroundImage: "repeating-linear-gradient(135deg, transparent 0 3px, color-mix(in srgb, currentColor 22%, transparent) 3px 4px)" };
/** Amber for decisions and rose for system issues; every other tone is neutral. */
export const TONE_CLASS: Record<NonNullable<Tone>, string> = {
  decision: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  issue: "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300",
};

export type RowActions = {
  onFocus(n: number): void;
  /** A number cell writes its number into the command box, or with Shift a range to it, without running anything. */
  onCompose(n: number, shift: boolean): void;
  onMenu(n: number | null): void;
  onAction(line: RosterLine, id: MenuItem["id"]): void;
  onToggleGroup(key: RosterGroup["key"]): void;
  onOpenUrl(url: string): void;
};
export type RowsProps = RowActions & {
  groups: RosterGroup[];
  focusN: number | null;
  menuN: number | null;
  /** Worker threads running now, whose chips animate. */
  liveThreads: ReadonlySet<string>;
};

function StateDot({ tone }: { tone: Tone }) {
  return <span aria-hidden data-tone={tone ?? undefined} className={cn("size-1.5 shrink-0 rounded-full", tone === "decision" ? "bg-amber-500" : tone === "issue" ? "bg-rose-500" : "bg-muted-foreground/60")} />;
}

export function OwnerChip({ line, live, onAction, onFocus }: { line: RosterLine; live: boolean } & Pick<RowActions, "onAction" | "onFocus">) {
  const chip: Chip = line.chip;
  const worker = chip.kind === "thread" || chip.kind === "new-worker";
  const parentN = chip.rowN;
  const click = worker && chip.threadId ? () => onAction(line, "thread") : parentN !== null ? () => onFocus(parentN) : null;
  const body: ReactNode = <>
    {chip.kind === "held" ? <Icon name="Pin" className="size-3" aria-hidden /> : null}
    <span>{chip.label}</span>
    {chip.progress ? <span aria-hidden className="h-1 w-6 overflow-hidden rounded-full bg-foreground/15">
      <span className="block h-full rounded-full bg-foreground/60" style={{ width: `${chip.progress.total ? Math.round((chip.progress.done / chip.progress.total) * 100) : 0}%` }} />
    </span> : null}
    {worker ? <span aria-hidden className="flex gap-px">{[0, 1, 2].map((dot) =>
      <span key={dot} className={cn("size-[3px] rounded-full bg-current opacity-60", live && "motion-safe:animate-pulse")} style={live ? { animationDelay: `${dot * 160}ms` } : undefined} />)}</span> : null}
  </>;
  const className = cn("inline-flex h-5 max-w-full shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-1.5 text-[11px] leading-none",
    chip.tone ? TONE_CLASS[chip.tone] : chip.kind === "left-alone" ? "border-dashed border-muted-foreground/60 text-muted-foreground"
      : chip.kind === "merge" ? "border-foreground/30 text-foreground" : "border-border text-muted-foreground");
  return <Tip label={chip.title}>
    {click ? <button type="button" data-roster-chip={line.n} data-tone={chip.tone ?? undefined} onClick={(event) => { event.stopPropagation(); click(); }}
      className={cn(className, "outline-none hover:border-foreground/40 focus-visible:ring-2 focus-visible:ring-ring")} style={chip.kind === "held" ? HATCH : undefined}>{body}</button>
      : <span data-roster-chip={line.n} data-tone={chip.tone ?? undefined} className={className}
        style={chip.kind === "held" ? HATCH : undefined}>{body}</span>}
  </Tip>;
}

function RowMenu({ line, open, onMenu, onAction }: { line: RosterLine; open: boolean } & Pick<RowActions, "onMenu" | "onAction">) {
  const portalScope = usePortalScopeProps();
  const label = `Actions for ${line.n} · ${line.repo} #${line.number}`;
  return <DropdownMenu.Root open={open} onOpenChange={(next) => onMenu(next ? line.n : null)}>
    <DropdownMenu.Trigger asChild>
      <button type="button" aria-label={label} title={label} onClick={(event) => event.stopPropagation()}
        className="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:bg-foreground/[0.07] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        <Icon name="MoreHorizontal" className="size-4" />
      </button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content {...portalScope} side="bottom" align="end" sideOffset={4} collisionPadding={8}
        className="z-50 w-80 max-w-[calc(100vw-1rem)] rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md">
        <DropdownMenu.Label className="px-2 py-1.5 text-[11px] text-muted-foreground">{line.n} · {line.repo} #{line.number} · {line.state.label}</DropdownMenu.Label>
        {line.menu.map((item) => <DropdownMenu.Item key={item.id} disabled={!item.enabled} onSelect={() => onAction(line, item.id)}
          className="flex cursor-pointer items-start gap-3 rounded px-2 py-1.5 text-[12px] outline-none focus:bg-foreground/[0.06] data-[disabled]:cursor-default">
          <span className="min-w-0 flex-1">
            <span className={cn("block", !item.enabled && "text-muted-foreground")}>{item.label}</span>
            {item.why ? <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{item.why}</span> : null}
          </span>
          {item.command ? <span className="shrink-0 pt-px font-mono text-[11px] text-muted-foreground">{item.command}</span> : null}
          <kbd className="shrink-0 rounded border border-border px-1 font-mono text-[11px] leading-4 text-muted-foreground">{item.key}</kbd>
        </DropdownMenu.Item>)}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}

/** The row number: dashed when left alone, hatched when held, with a dot while it changed since you looked. A click composes it into the command box. */
function RowNumber({ line, onCompose }: { line: RosterLine } & Pick<RowActions, "onCompose">) {
  return <span className="relative inline-flex items-center">
    {line.changed ? <span aria-label="Changed since you looked" className="absolute -left-2 size-1 rounded-full bg-foreground/70" /> : null}
    <button type="button" data-compose={line.n} onClick={(event) => { event.stopPropagation(); onCompose(line.n, event.shiftKey); }}
      title={`Add ${line.n} to the command; Shift-click for a range`}
      className={cn("inline-flex h-5 min-w-5 items-center justify-center rounded-[3px] px-0.5 tabular-nums outline-none hover:bg-foreground/[0.08] focus-visible:ring-2 focus-visible:ring-ring",
        line.leftAlone && "border border-dashed border-muted-foreground/60")} style={line.held ? HATCH : undefined}>{line.n}</button>
  </span>;
}

function Pr({ line, onAction }: { line: RosterLine } & Pick<RowActions, "onAction">) {
  return <button type="button" onClick={(event) => { event.stopPropagation(); onAction(line, "pr"); }} title={`Open ${line.repo} #${line.number} on GitHub`}
    className="min-w-0 truncate rounded-sm text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
    {line.branch ? <span aria-hidden className="text-muted-foreground" style={{ paddingLeft: `${(line.depth - 1) * 12}px` }}>{line.branch} </span> : null}
    <span className="text-muted-foreground">{line.repo}</span> <span className="tabular-nums">#{line.number}</span>
  </button>;
}

function Reviewer({ line }: { line: RosterLine }) {
  if (!line.reviewer) return <span className="text-muted-foreground">—</span>;
  const { login, more } = line.reviewer;
  return <span className="truncate" title={[login, ...more].map((name) => `@${name}`).join(", ")}>@{login}{more.length ? <span className="text-muted-foreground"> +{more.length}</span> : null}</span>;
}

function Seen({ line }: { line: RosterLine }) {
  const title = line.seen.failed ? "The last GitHub read failed; this is the newest good one" : `Last observed on GitHub ${line.seen.age} ago${line.seen.stale ? "; older than its poll, so it may be out of date" : ""}`;
  return <span title={title} className="inline-flex items-center gap-1 tabular-nums text-muted-foreground">
    {line.seen.stale ? <span aria-label="Stale" data-tone="stale" className="size-1.5 rounded-full bg-amber-500" /> : null}
    {line.seen.failed ? "read failed" : line.seen.age}
  </span>;
}

function Next({ line, clamp }: { line: RosterLine; clamp: "line-clamp-1" | "line-clamp-2" }) {
  const full = [line.next.lead, line.next.detail].filter(Boolean).join(" · ");
  return <span title={full} className={clamp}>{line.next.lead}{line.next.detail ? <span className="text-muted-foreground"> · {line.next.detail}</span> : null}</span>;
}

/** The state with its modifiers, which give way before the owner chip does. */
function StateCell({ line, live, actions }: { line: RosterLine; live: boolean; actions: Pick<RowActions, "onAction" | "onFocus"> }) {
  return <span className="flex min-w-0 items-center gap-1.5">
    <StateDot tone={line.state.tone} />
    <span title={line.state.label} data-tone={line.state.tone ?? undefined}
      className={cn("min-w-0 truncate", line.state.tone === "decision" ? "text-amber-700 dark:text-amber-300" : line.state.tone === "issue" ? "text-rose-700 dark:text-rose-300" : "text-muted-foreground")}>
      {line.state.short}
    </span>
    <OwnerChip line={line} live={live} {...actions} />
  </span>;
}

function groupTitle(group: RosterGroup) {
  const count = group.key === "tickets" ? group.tickets.length : group.lines.length;
  return `${group.label} ${count}${group.collapsed && group.summary ? ` · ${group.summary}` : ""}`;
}

function GroupHeader({ group, onToggle }: { group: RosterGroup; onToggle(): void }) {
  const collapsible = group.key === "done" || group.key === "tickets" || group.key === "not-in-instruction";
  if (!collapsible) return <span className="text-[11px] font-medium text-muted-foreground">{group.label} · {group.lines.length}</span>;
  return <button type="button" aria-expanded={!group.collapsed} onClick={onToggle}
    className="flex min-w-0 items-center gap-1 text-[11px] font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
    <Icon name={group.collapsed ? "ChevronRight" : "ChevronDown"} className="size-3 shrink-0" aria-hidden />
    <span className="truncate">{groupTitle(group)}</span>
  </button>;
}

function Tickets({ group, onOpenUrl }: { group: RosterGroup } & Pick<RowActions, "onOpenUrl">) {
  return <>{group.tickets.map((ticket) => <span key={ticket.id} className="text-[12px]">
    {ticket.url ? <button type="button" onClick={() => onOpenUrl(ticket.url!)} className="rounded-sm font-mono text-[11px] text-muted-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">{ticket.id}</button>
      : <span className="font-mono text-[11px] text-muted-foreground">{ticket.id}</span>} {ticket.title ?? ""}
  </span>)}</>;
}

const rowProps = (line: RosterLine, props: RowsProps) => ({
  "data-roster-row": line.n, tabIndex: -1, "aria-selected": props.focusN === line.n, onClick: () => props.onFocus(line.n),
});

/** The column table: #, PR, Reviewer, Summary, State, Owner · wake · next, Seen, and the always-visible menu. */
export function RosterTable(props: RowsProps) {
  const { groups, focusN, menuN, liveThreads } = props;
  return <table className="w-full table-fixed border-collapse text-[12px]">
    <colgroup>
      <col style={{ width: 40 }} /><col style={{ width: 120 }} /><col style={{ width: 100 }} /><col /><col style={{ width: 200 }} /><col /><col style={{ width: 60 }} /><col style={{ width: 36 }} />
    </colgroup>
    <thead>
      <tr className="border-b border-border text-left text-[11px] text-muted-foreground">
        <th className="px-2 py-1.5 font-normal">#</th><th className="px-2 py-1.5 font-normal">PR</th><th className="px-2 py-1.5 font-normal">Reviewer</th>
        <th className="px-2 py-1.5 font-normal">Summary</th><th className="px-2 py-1.5 font-normal">State</th><th className="px-2 py-1.5 font-normal">Owner · wake · next</th>
        <th className="px-2 py-1.5 font-normal" title="When Workstreams last observed the PR on GitHub">Seen</th><th className="px-2 py-1.5 font-normal"><span className="sr-only">Actions</span></th>
      </tr>
    </thead>
    {groups.map((group) => <tbody key={group.key} data-roster-group={group.key}>
      {group.label ? <tr><th colSpan={8} className="border-b border-border/60 px-2 pb-1 pt-3 text-left font-normal"><GroupHeader group={group} onToggle={() => props.onToggleGroup(group.key)} /></th></tr> : null}
      {group.collapsed ? null : group.key === "tickets" ? <tr><td colSpan={8} className="px-2 py-1.5"><div className="flex flex-wrap gap-x-4 gap-y-1"><Tickets group={group} onOpenUrl={props.onOpenUrl} /></div></td></tr>
        : group.lines.map((line) => <tr key={line.n} {...rowProps(line, props)}
          className={cn("border-b border-border/50 align-middle outline-none hover:bg-foreground/[0.03] focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
            focusN === line.n && "bg-foreground/[0.05]")}>
          <td className="px-2 py-1.5"><RowNumber line={line} onCompose={props.onCompose} /></td>
          <td className="px-2 py-1.5"><Pr line={line} onAction={props.onAction} /></td>
          <td className="truncate px-2 py-1.5"><Reviewer line={line} /></td>
          <td className="truncate px-2 py-1.5" title={line.title}>{line.title}{line.draft ? <span className="ml-1.5 text-[11px] text-muted-foreground">draft</span> : null}</td>
          <td className="px-2 py-1.5"><StateCell line={line} live={line.threadId !== null && liveThreads.has(line.threadId)} actions={props} /></td>
          <td className="px-2 py-1.5"><Next line={line} clamp="line-clamp-2" /></td>
          <td className="px-2 py-1.5 text-[11px]"><Seen line={line} /></td>
          <td className="px-1 py-1"><RowMenu line={line} open={menuN === line.n} onMenu={props.onMenu} onAction={props.onAction} /></td>
        </tr>)}
    </tbody>)}
  </table>;
}

/** Two-line rows for a narrow pane: number, PR, and summary, then state, owner chip, and the next step. */
export function RosterList(props: RowsProps) {
  const { groups, focusN, menuN, liveThreads } = props;
  return <div role="list" aria-label="Roster rows" className="text-[12px]">
    {groups.map((group) => <div key={group.key} role="presentation" data-roster-group={group.key}>
      {group.label ? <div role="presentation" className="border-b border-border/60 px-3 pb-1 pt-3"><GroupHeader group={group} onToggle={() => props.onToggleGroup(group.key)} /></div> : null}
      {group.collapsed ? null : group.key === "tickets" ? <div className="flex flex-col gap-1 px-3 py-1.5"><Tickets group={group} onOpenUrl={props.onOpenUrl} /></div>
        : group.lines.map((line) => <div key={line.n} role="listitem" {...rowProps(line, props)}
          className={cn("border-b border-border/50 px-3 py-1.5 outline-none hover:bg-foreground/[0.03] focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
            focusN === line.n && "bg-foreground/[0.05]")}>
          <div className="flex min-w-0 items-center gap-2">
            <span className="w-7 shrink-0"><RowNumber line={line} onCompose={props.onCompose} /></span>
            <span className="shrink-0"><Pr line={line} onAction={props.onAction} /></span>
            <span className="min-w-0 flex-1 truncate" title={line.title}>{line.title}{line.draft ? <span className="ml-1.5 text-[11px] text-muted-foreground">draft</span> : null}</span>
            <span className="max-w-24 shrink-0 truncate text-muted-foreground"><Reviewer line={line} /></span>
            <span className="shrink-0 text-[11px]"><Seen line={line} /></span>
            <RowMenu line={line} open={menuN === line.n} onMenu={props.onMenu} onAction={props.onAction} />
          </div>
          <div className="flex min-w-0 items-center gap-1.5 pl-9">
            <StateCell line={line} live={line.threadId !== null && liveThreads.has(line.threadId)} actions={props} />
            <span className="min-w-0 flex-1"><Next line={line} clamp="line-clamp-1" /></span>
          </div>
        </div>)}
    </div>)}
  </div>;
}
