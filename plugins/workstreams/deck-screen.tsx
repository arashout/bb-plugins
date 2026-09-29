// The effort deck's screen (plan amendment A15, design-directions/
// inventory-calm): the effort strip, one compact bento card with its rows in
// sections by the move they need, the Unclassified deck, the batch bar, and
// the hint bar, plus the bodies of the deck's dialogs. Presentational only:
// data comes in as props, every click goes out through one `run` command, no
// SDK hook is called, and imports stay relative, so static-markup tests can
// render it. Color appears only where the move is yours, and muted.
import type { ReactNode, RefObject } from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import type { BatchItem, Skipped } from "./deck-batch";
import type { SeedProposal } from "./linear-seed";
import { ACTION, KEY_GROUPS, type DeckActionId } from "./deck-keys";
import type { Availability, CardScreen, Chip, DeckLine, PaletteItem, SectionScreen, Tone, UncGroup, UncScreen } from "./deck-view-model";
import { SEND_DELAY_MS } from "./deck-shared";
import { behind as cardsBehind, LAYERS, layerTransform } from "./deck-flip";
import { usePortalScopeProps } from "./lib/portal-scope";
import { cn, POINTER_CURSORS } from "./lib/utils";

/** Everything a click on the deck can ask for; the nav view decides what each does. */
export type DeckCommand =
  | { kind: "action"; id: DeckActionId; line?: DeckLine }
  | { kind: "go"; id: string } | { kind: "view"; view: "prs" | "map" | "pipeline" | "work" | "efforts" }
  | { kind: "select"; prUrl: string; shift: boolean } | { kind: "expand"; prUrl: string } | { kind: "focus"; prUrl: string }
  | { kind: "tile"; key: string } | { kind: "fold"; key: string }
  | { kind: "group"; key: string } | { kind: "undo-group"; key: string } | { kind: "undo-batch"; batchId: string }
  | { kind: "thread"; id: string } | { kind: "jump"; prUrl: string } | { kind: "resume"; id: string } | { kind: "reopen"; id: string }
  | { kind: "rule-remove"; id: string } | { kind: "pile"; pile: "hold" | "done" | null };
export type Run = (command: DeckCommand) => void;

/** The 2px accent ring every control shows on keyboard focus. */
export const RING = "outline-none focus-visible:ring-2 focus-visible:ring-sky-500";
const TONE: Record<Tone, { text: string; chip: string; edge: string; button: string; bar: string }> = {
  green: { text: "text-emerald-700 dark:text-emerald-300", chip: "bg-emerald-500/10 text-emerald-800 dark:text-emerald-200", edge: "bg-emerald-500/70",
    button: "border-emerald-500/35 bg-emerald-500/[0.07] text-emerald-800 hover:bg-emerald-500/[0.14] dark:text-emerald-200", bar: "bg-emerald-500/55" },
  violet: { text: "text-violet-700 dark:text-violet-300", chip: "bg-violet-500/10 text-violet-800 dark:text-violet-200", edge: "bg-violet-500/70",
    button: "border-violet-500/35 bg-violet-500/[0.07] text-violet-800 hover:bg-violet-500/[0.14] dark:text-violet-200", bar: "bg-violet-500/55" },
  blue: { text: "text-sky-700 dark:text-sky-300", chip: "bg-sky-500/10 text-sky-800 dark:text-sky-200", edge: "bg-sky-500/70",
    button: "border-sky-500/35 bg-sky-500/[0.07] text-sky-800 hover:bg-sky-500/[0.14] dark:text-sky-200", bar: "bg-sky-500/55" },
  amber: { text: "text-amber-700 dark:text-amber-300", chip: "bg-amber-500/10 text-amber-800 dark:text-amber-200", edge: "bg-amber-500/70",
    button: "border-amber-500/35 bg-amber-500/[0.07] text-amber-800 hover:bg-amber-500/[0.14] dark:text-amber-200", bar: "bg-amber-500/60" },
  red: { text: "text-rose-700 dark:text-rose-300", chip: "bg-rose-500/10 text-rose-800 dark:text-rose-200", edge: "bg-rose-500/70",
    button: "border-rose-500/35 bg-rose-500/[0.07] text-rose-800 hover:bg-rose-500/[0.14] dark:text-rose-200", bar: "bg-rose-500/55" },
  gray: { text: "text-muted-foreground", chip: "bg-foreground/[0.05] text-muted-foreground", edge: "bg-muted-foreground/50", button: "border-border hover:bg-foreground/[0.06]",
    bar: "bg-muted-foreground/35" },
};
const BUTTON = cn("inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-2 text-[12px] disabled:opacity-45 aria-disabled:opacity-45", RING);
const GHOST = cn("inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-[12px] text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground", RING);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-block min-w-4 rounded border border-b-2 border-border px-1 text-center font-mono text-[10.5px] leading-[14px] text-muted-foreground">{children}</kbd>;
}
/** A key's hint as kbds: "] →" reads as two keys for one action. */
export const Keys = ({ keys }: { keys: string }) => <span className="inline-flex gap-0.5">{keys.split(" ").map((key) => <Kbd key={key}>{key}</Kbd>)}</span>;
const Dot = ({ color, hollow }: { color: string; hollow?: boolean }) => <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", hollow && "border border-dashed")}
  style={hollow ? { borderColor: color } : { background: color }} />;
const Changed = ({ title }: { title: string }) => <span title={title} aria-label={title} className="inline-block size-1.5 shrink-0 rounded-full bg-sky-500" />;

/** A button that names its key: disabled ones stay focusable and say why. */
function ActionButton({ id, on, run, label, tone, primary, line }: { id: DeckActionId; on: Availability; run: Run; label?: string; tone?: Tone; primary?: boolean;
  line?: DeckLine }) {
  const available = on[id];
  const key = ACTION[id].keys[0];
  return <button type="button" data-deck-focus={`act-${id}`} aria-disabled={available.on ? undefined : true}
    title={available.on ? `${ACTION[id].title}${key ? ` (${key})` : ""}` : `${ACTION[id].title.replace("…", "")}: ${available.why}`}
    onClick={() => { if (available.on) run({ kind: "action", id, line }); }}
    className={cn(BUTTON, primary ? "border-foreground bg-foreground font-medium text-background hover:bg-foreground/90" : tone ? TONE[tone].button : "border-border hover:bg-foreground/[0.06]")}>
    {label ?? ACTION[id].title}{key ? <Keys keys={key} /> : null}
  </button>;
}

// ---------------------------------------------------------------------------
// The strip: the active pile in session order, Unclassified last, and the piles.
// ---------------------------------------------------------------------------

export type Pile = { id: string; key: string; name: string; note: string; archived?: boolean };
export function Strip({ chips, cur, deck, held, done, pile, run, chipsRef }: { chips: readonly Chip[]; cur: string | null; deck: boolean; held: readonly Pile[];
  done: readonly Pile[]; pile: "hold" | "done" | null; run: Run; chipsRef?: RefObject<HTMLDivElement | null> }) {
  return <nav aria-label="Efforts" className="flex h-11 shrink-0 items-center gap-1.5 border-b border-border/70 px-2.5">
    <button type="button" data-deck-focus="prev" title="Previous effort ([ or ←)" aria-label="Previous effort" onClick={() => run({ kind: "action", id: "prev" })}
      className={cn("size-7 shrink-0 rounded-md border border-border/70 text-[13px] text-muted-foreground hover:text-foreground", RING)}>←</button>
    <div ref={chipsRef} className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto px-0.5 py-1 [scrollbar-width:none]">
      {chips.map((chip) => <button key={chip.id} type="button" data-deck-focus={`chip-${chip.id}`} data-deck-chip={chip.id} aria-current={deck && chip.id === cur ? "true" : undefined}
        title={`${chip.name}: ${chip.count} ${chip.unc ? "to sort" : "need you"}${chip.n ? ` (${chip.n})` : ""}`} onClick={() => run({ kind: "go", id: chip.id })}
        className={cn("relative flex h-[30px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border px-2 text-[12px]", RING,
          chip.unc && "border-dashed", deck && chip.id === cur ? "border-foreground/30 bg-foreground/[0.08] text-foreground" : "border-border/70 text-muted-foreground hover:text-foreground")}>
        {chip.n ? <span className="font-mono text-[10.5px] text-muted-foreground/80">{chip.n}</span> : null}
        <Dot color={chip.color} hollow={chip.unc} />
        <span className="max-w-[150px] truncate">{chip.name}</span>
        <span className={cn("min-w-[18px] rounded-full px-1.5 text-center text-[11px] font-semibold tabular-nums", chip.count ? TONE.amber.chip : "font-normal text-muted-foreground")}>
          {chip.count || (chip.unc ? "✓" : 0)}</span>
        {chip.ping ? <span aria-label="Changed since you looked" className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-sky-500" /> : null}
      </button>)}
    </div>
    <button type="button" data-deck-focus="next" title="Next effort (] or →)" aria-label="Next effort" onClick={() => run({ kind: "action", id: "next" })}
      className={cn("size-7 shrink-0 rounded-md border border-border/70 text-[13px] text-muted-foreground hover:text-foreground", RING)}>→</button>
    <div className="flex shrink-0 items-center gap-1 border-l border-border/70 pl-1.5">
      <PilePopover pile="hold" items={held} open={pile === "hold"} run={run} />
      <PilePopover pile="done" items={done} open={pile === "done"} run={run} />
    </div>
  </nav>;
}

/** On hold or Done: a stack you open to resume or reopen an effort, which joins the end of the active pile. */
function PilePopover({ pile, items, open, run }: { pile: "hold" | "done"; items: readonly Pile[]; open: boolean; run: Run }) {
  const scope = usePortalScopeProps();
  const label = pile === "hold" ? "On hold" : "Done";
  return <PopoverPrimitive.Root open={open} onOpenChange={(next) => run({ kind: "pile", pile: next ? pile : null })}>
    <PopoverPrimitive.Trigger asChild>
      <button type="button" data-deck-focus={`pile-${pile}`} data-deck-pile={pile} title={`The ${label} pile`}
        className={cn("flex h-[30px] items-center gap-1.5 rounded-lg px-1.5 text-[12px] text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground", RING)}>
        <PileCards empty={!items.length} />
        {pile === "hold" ? "Hold" : "Done"} <b className="font-semibold text-foreground/80">{items.length}</b>
      </button>
    </PopoverPrimitive.Trigger>
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content {...scope} align="end" sideOffset={6} collisionPadding={8}
        className={cn("z-50 w-80 max-w-[calc(100vw-1rem)] rounded-lg border border-border bg-popover p-2 text-[12px] text-popover-foreground shadow-md outline-none", POINTER_CURSORS)}>
        <p className="px-1 pb-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">{label} · {items.length}</p>
        {items.length ? items.map((item) => <div key={item.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 rounded-md px-1 py-1 hover:bg-foreground/[0.04]">
          <span className="truncate">{item.name}</span>
          {pile === "hold" ? <button type="button" onClick={() => run({ kind: "resume", id: item.id })} className={cn(BUTTON, "border-border")}>Resume</button>
            : item.archived ? <span className="text-[11px] text-muted-foreground" title="Restore it from Manage efforts first">Archived</span>
            : <button type="button" onClick={() => run({ kind: "reopen", id: item.id })} className={cn(BUTTON, "border-border")}>Reopen</button>}
          <span className="col-span-2 truncate text-[11px] text-muted-foreground">{item.note}</span>
        </div>) : <p className="px-1 text-muted-foreground">Empty.</p>}
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  </PopoverPrimitive.Root>;
}

/** A pile's tiny stack, drawn like the deck's: three cards, each one behind a little lower and to the right. An empty pile is an outline. */
function PileCards({ empty }: { empty: boolean }) {
  return <span aria-hidden data-deck-pile-cards={empty ? "empty" : "stacked"} className="relative inline-block h-[17px] w-3 shrink-0">
    {empty ? <i className="absolute left-0 top-0 h-[13px] w-2.5 rounded-[2.5px] border border-dashed border-border" />
      : [2, 1, 0].map((depth) => <i key={depth} className="absolute left-0 top-0 h-[13px] w-2.5 rounded-[2.5px] border"
        style={{ transform: `translate(${depth}px, ${depth * 2}px)`, background: `color-mix(in srgb, var(--background) ${100 - 6 * depth}%, #000)`,
          borderColor: `color-mix(in srgb, var(--foreground) ${34 - 9 * depth}%, transparent)` }} />)}
  </span>;
}

// ---------------------------------------------------------------------------
// The stack: the card shown on top, and the next few in the ring peeking out below it.
// ---------------------------------------------------------------------------

/**
 * The deck as a stack of cards: the one shown on top, over the next few a flip forward reaches, each lower, to the right, smaller, and darker,
 * with the next one's name on its edge, which flips to it. A flip draws the card it takes away in the ghost, over or under the top one
 * (deck-flip.ts); the ghost is otherwise empty. It's clipped at the top card's bottom edge, so a taller card taken away never hangs over the
 * edges or rows below, while its slide and tilt still show above and to the sides.
 */
function Stack({ behind, run, children }: { behind: readonly Chip[]; run: Run; children: ReactNode }) {
  return <div className="mb-2.5" style={{ paddingBottom: LAYERS[behind.length]!.y }}>
    <div data-deck-stack className="relative isolate">
      {behind.map((chip, index) => { const depth = index + 1; return <div key={chip.id} data-deck-layer={depth} aria-hidden={depth > 1 || undefined}
        className="absolute inset-0 origin-bottom rounded-[14px] border shadow-[0_1px_2px_rgb(0_0_0/0.08),0_4px_12px_-8px_rgb(0_0_0/0.35)]"
        style={{ zIndex: 4 - depth, transform: layerTransform(depth), background: `color-mix(in srgb, var(--background) ${100 - 4 * depth}%, #000)`,
          borderColor: `color-mix(in srgb, var(--foreground) ${14 - 3 * depth}%, transparent)` }}>
        {depth === 1 ? <button type="button" tabIndex={-1} data-deck-peek={chip.id} onClick={() => run({ kind: "action", id: "next" })} title={`Next: ${chip.name} (] or →)`}
          aria-label={`Next effort: ${chip.name}`} style={{ height: LAYERS[1].y }}
          className="absolute inset-x-0 bottom-0 flex min-w-0 items-center gap-1.5 rounded-b-[14px] px-4 text-[11px] leading-none text-muted-foreground hover:text-foreground">
          <Dot color={chip.color} hollow={chip.unc} /><span className="truncate">{chip.name}</span></button> : null}
      </div>; })}
      <div data-deck-top className="relative z-[5] origin-bottom rounded-[14px] bg-background shadow-[0_1px_2px_rgb(0_0_0/0.2),0_8px_22px_-10px_rgb(0_0_0/0.6)]">{children}</div>
      <div data-deck-ghost aria-hidden className="pointer-events-none absolute inset-0" style={{ clipPath: "inset(-60px -60px 0 -60px)" }} />
    </div>
  </div>;
}

// ---------------------------------------------------------------------------
// Rows: one line each, shared by the effort cards and the Unclassified deck.
// ---------------------------------------------------------------------------

export type RowState = { selected: ReadonlySet<string>; expanded: ReadonlySet<string>; focus: string | null };
/** What a narrow pane drops from a row, as the mock does below 720 px: who approved a merge, the suggested reviewer, and "draft". */
const OPTIONAL_INFO = new Set(["merge", "request", "ready"]);

function Row({ line, state, run, first }: { line: DeckLine; state: RowState; run: Run; first: boolean }) {
  const open = state.expanded.has(line.prUrl);
  const selected = state.selected.has(line.prUrl);
  const trail = line.trail;
  return <>
    <div data-deck-row={line.prUrl} data-deck-section={line.section} data-deck-dim={line.dim || undefined} data-deck-dot={line.dot ? true : undefined} tabIndex={state.focus === line.prUrl || (state.focus === null && first) ? 0 : -1}
      aria-label={`${line.ref} ${line.title}${line.dim ? ", settled on Mark seen" : ""}`} onFocus={() => run({ kind: "focus", prUrl: line.prUrl })}
      className={cn("group relative flex h-[30px] scroll-mt-20 items-center gap-2 rounded-md pl-2 pr-1.5 text-[12.5px] hover:bg-foreground/[0.03]",
        "outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-500", selected && "bg-sky-500/[0.07]", state.focus === line.prUrl && "bg-foreground/[0.05]")}>
      {line.needs ? <span aria-hidden className={cn("absolute bottom-[7px] left-0 top-[7px] w-0.5 rounded-full", TONE[line.tone].edge)} /> : null}
      <input type="checkbox" tabIndex={-1} checked={selected} disabled={line.dim} aria-label={`Select ${line.ref}`}
        onChange={() => undefined} onClick={(event) => run({ kind: "select", prUrl: line.prUrl, shift: event.shiftKey })}
        className="size-3.5 shrink-0 accent-sky-600 opacity-50 group-hover:opacity-100 disabled:opacity-20" />
      <span className="flex w-1.5 shrink-0">{line.dot ? <Changed title={line.dot} /> : null}</span>
      <span className={cn("w-[88px] shrink-0 truncate text-right text-muted-foreground", line.dim && "opacity-50")}>
        {line.ref.replace(/ #\d+$/u, "")} <b className={cn("font-medium", line.needs ? "text-foreground" : "text-foreground/80")}>#{line.ref.split("#")[1]}</b></span>
      <span onClick={() => run({ kind: "expand", prUrl: line.prUrl })} title={line.title}
        className={cn("min-w-0 flex-1 cursor-pointer truncate", line.needs ? "text-foreground" : "text-foreground/80", line.dim && "opacity-50", line.ghost && "line-through")}>
        {line.stacked ? <span className="mr-1 text-muted-foreground" title={`Stacked on ${line.stacked}`}>↳</span> : null}{line.title}</span>
      {line.checked ? <span title={line.checked.title} className={cn("shrink-0 whitespace-nowrap text-[11px]",
        line.checked.failed ? "text-destructive" : "hidden text-muted-foreground @min-[720px]:inline")}>{line.checked.text}</span> : null}
      {line.signals.map((signal) => <span key={signal} className={cn("hidden shrink-0 rounded px-1.5 text-[11px] @min-[720px]:inline", TONE.gray.chip)}>{signal}</span>)}
      {line.info ? <span className={cn("shrink-0 whitespace-nowrap text-[11.5px]", OPTIONAL_INFO.has(line.section) && "hidden @min-[720px]:inline",
        line.info.tone ? cn("rounded px-1.5 leading-[19px]", TONE[line.dim ? "gray" : line.info.tone].chip)
        : "text-muted-foreground", line.dim && "opacity-50")}>{line.info.text}</span> : null}
      <span className={cn("w-7 shrink-0 text-right text-[11px] tabular-nums", line.hot ? TONE.amber.text : "text-muted-foreground")}>{line.age ?? ""}</span>
      <span className="flex min-w-12 shrink-0 items-center justify-end gap-1 text-[11.5px]">
        {trail?.kind === "acted" ? <>
          <span className={cn("max-w-44 truncate", trail.failed ? "text-destructive" : "text-muted-foreground")} title={trail.title ?? trail.text}>{trail.text}</span>
          {trail.undo ? <button type="button" data-deck-focus={`undo-${line.prUrl}`} onClick={() => run({ kind: "undo-batch", batchId: trail.undo! })}
            className={cn("rounded px-1 text-sky-700 hover:underline dark:text-sky-300", RING)}>Undo</button> : null}
        </> : trail?.kind === "thread" ? <button type="button" tabIndex={-1} onClick={() => run({ kind: "thread", id: trail.threadId })} title={`Open "${trail.text}" (o)`}
          aria-label={`Open ${trail.text}`} className={cn("max-w-40 truncate rounded px-1 text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground", RING)}>
          {/* A narrow pane keeps the title's room: the thread shows as ↗, named in its tooltip. */}
          <span className="hidden @min-[720px]:inline">{trail.text} </span>↗</button>
        : trail ? <span className="max-w-44 truncate text-muted-foreground" title={line.dot ?? undefined}>{trail.text}</span>
        : <button type="button" tabIndex={-1} aria-expanded={open} onClick={() => run({ kind: "expand", prUrl: line.prUrl })}
          className={cn("rounded px-1 text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100", RING)}>{open ? "Less" : "More"}</button>}
      </span>
    </div>
    {open ? <Details line={line} run={run} /> : null}
  </>;
}

/** A row's details: what it waits on, its reviewers and tickets, and every action it can take, each with its key. */
function Details({ line, run }: { line: DeckLine; run: Run }) {
  const row = line.row;
  if (!row) return <p className="mb-1.5 ml-9 text-[12px] text-muted-foreground">Left this view since you looked. Mark seen clears it.</p>;
  const move = SECTION_ACTION[line.section];
  const facts: [string, string][] = [
    ["Status", row.status], ["Next", row.waitsOn ? `${row.waitsOn.what} · waits on ${row.waitsOn.on}` : row.step ? `${row.step.text} · ${row.step.owner}` : "—"],
    ["Reviewers", row.reviewers.length ? row.reviewers.map((review) => `@${review.login} ${review.state === "requested" ? "asked" : review.state}`).join(", ") : "nobody asked"],
    ["Tickets", row.tickets.join(", ") || "none"],
    ...row.hold ? [["Held", row.hold.reason || "no reason given"] as [string, string]] : [],
    ...row.managed ? [["Roster", row.managed] as [string, string]] : [],
    ["Checked", row.failed ? "last read failed" : row.checkedAt ? new Date(row.checkedAt).toLocaleString() : "not yet"],
  ];
  return <div data-deck-details={line.prUrl} className="mb-1.5 ml-9 mr-1.5 grid gap-2 rounded-lg border border-border/60 bg-foreground/[0.02] px-3 py-2 text-[12px]">
    <dl className="grid grid-cols-[76px_minmax(0,1fr)] gap-x-3 gap-y-0.5">
      {facts.map(([label, value]) => <div key={label} className="contents"><dt className="text-[11px] text-muted-foreground">{label}</dt><dd className="min-w-0 break-words">{value}</dd></div>)}
    </dl>
    <div className="flex flex-wrap gap-1.5">
      {move && line.needs ? <button type="button" onClick={() => run({ kind: "action", id: move, line })} className={cn(BUTTON, TONE[line.tone].button)}>
        {ACTION[move].title}<Kbd>{ACTION[move].keys[0]}</Kbd></button> : null}
      {row.thread ? <button type="button" onClick={() => run({ kind: "thread", id: row.thread!.id })} className={cn(BUTTON, "border-border")}>Open “{row.thread.title}”<Kbd>o</Kbd></button> : null}
      <button type="button" onClick={() => run({ kind: "action", id: "open-pr", line })} className={GHOST}>Open on GitHub ↗</button>
      <button type="button" onClick={() => run({ kind: "action", id: "hold-pr", line })} className={GHOST}>{row.hold ? "Release hold" : "Hold PR…"}</button>
      <button type="button" onClick={() => run({ kind: "action", id: "refresh", line })} className={GHOST}>Refresh</button>
    </div>
  </div>;
}
const SECTION_ACTION: Partial<Record<string, DeckActionId>> = { merge: "merge", confirm: "confirm", nudge: "nudge", request: "request", ready: "ready" };

function Section({ section, state, run, open, stuck, held }: { section: SectionScreen; state: RowState; run: Run; open: boolean; stuck: boolean; held: boolean }) {
  const { meta } = section;
  const folded = meta.fold && !open;
  const header = <>
    <span aria-hidden className={cn("h-3.5 w-[3px] shrink-0 rounded-full", TONE[meta.tone].edge)} />
    {meta.fold ? <span aria-hidden className={cn("text-[10px] text-muted-foreground transition-transform motion-reduce:transition-none", !folded && "rotate-90")}>▶</span> : null}
    <h2 className={cn("truncate text-[12.5px]", meta.fold ? "font-medium text-muted-foreground" : "font-semibold")}>{meta.title}</h2>
    <span className={cn("min-w-[18px] rounded-full px-1.5 text-center text-[11px] tabular-nums", section.count ? cn("font-semibold", TONE[meta.tone].chip) : "text-muted-foreground")}>
      {meta.fold || meta.tone === "gray" ? section.lines.filter((line) => !line.dim).length : section.count}</span>
    <span title={meta.help} aria-label={meta.help} className="size-4 shrink-0 rounded-full border border-border text-center text-[10px] leading-[14px] text-muted-foreground">?</span>
    {section.changed ? <span className="inline-flex items-center gap-1 text-[11.5px] text-sky-700 dark:text-sky-300"><Changed title="Changed since you looked" />{section.changed} changed</span> : null}
  </>;
  return <section data-deck-sec={section.key} className="mt-0.5">
    <div className={cn("sticky z-[4] flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/50 bg-background py-1 pl-2 pr-1", stuck ? "top-[34px]" : "top-0")}>
      {meta.fold ? <button type="button" data-deck-focus={`fold-${section.key}`} aria-expanded={!folded} onClick={() => run({ kind: "fold", key: section.key })}
        className={cn("flex min-w-0 items-center gap-2 rounded", RING)}>{header}</button> : header}
      <span className="flex-1" />
      {section.action && !held ? <button type="button" data-deck-focus={`sec-${section.key}`} aria-disabled={section.action.enabled ? undefined : true}
        title={section.action.enabled ? `Acts on this section's ${plural(section.count, "PR")}; the ${section.key === "merge" ? "preview" : "confirm"} lists each one`
          : section.action.why ?? undefined}
        onClick={() => { if (section.action!.enabled) run({ kind: "action", id: section.action!.id }); }}
        className={cn(BUTTON, TONE[meta.tone].button)}>{section.action.label}<Kbd>{section.action.key}</Kbd></button> : null}
    </div>
    {folded ? null : <div className="pb-1.5 pt-0.5">{section.lines.map((line, index) => <Row key={line.prUrl} line={line} state={state} run={run} first={index === 0} />)}</div>}
  </section>;
}

// ---------------------------------------------------------------------------
// The effort card: a header and a bento of tiles, each with more on expand.
// ---------------------------------------------------------------------------

/** `more` is "narrow" when only a card under 700 px hides some of the tile. */
function Tile({ id, title, note, open, more, run, className, children }: { id: string; title: string; note?: ReactNode; open: boolean; more: boolean | "narrow"; run: Run;
  className?: string; children: ReactNode }) {
  return <div data-deck-tile={id} className={cn("min-w-0 rounded-[10px] border border-border/50 bg-foreground/[0.015] px-2.5 pb-2 pt-1.5", className)}>
    <div className="mb-1 flex min-h-5 items-center gap-2">
      <span className="shrink-0 text-[10.5px] uppercase tracking-wide text-muted-foreground">{title}</span>
      {note ? <span className="min-w-0 truncate text-[11px] text-muted-foreground">{note}</span> : null}
      <span className="flex-1" />
      {more ? <button type="button" data-deck-focus={`tile-${id}`} aria-expanded={open} onClick={() => run({ kind: "tile", key: id })} title="More or less (i toggles every tile)"
        className={cn("rounded px-1 text-[11px] text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground", RING, more === "narrow" && "@min-[700px]:hidden")}>
        {open ? "Less" : "More"}</button> : null}
    </div>
    {children}
  </div>;
}

export function Card({ screen, tiles, run, on }: { screen: CardScreen; tiles: ReadonlySet<string>; run: Run; on: Availability }) {
  const { card } = screen;
  const held = card.pile === "held";
  const open = (id: string) => tiles.has(id);
  // Three waits, or two on a card under 700 px wide.
  const blocked = open("blocked") ? screen.blocked : screen.blocked.slice(0, 3);
  const threads = open("threads") ? screen.threads : screen.threads.slice(0, 3);
  const total = screen.stats.bar.reduce((sum, item) => sum + item.count, 0) || 1;
  const { linear } = screen;
  const linearLine = linear.chips.length > 0 || linear.bar.length > 0;
  const ticketStates = `Tickets: ${linear.bar.map((state) => `${state.count} ${state.name}`).join(" · ")}`;
  return <section data-deck-card={card.id} aria-label={card.name} className="@container relative rounded-[14px] border border-border/70 bg-foreground/[0.012] p-3"
    style={{ backgroundImage: `linear-gradient(180deg, color-mix(in srgb, ${screen.color} 6%, transparent) 0, transparent 110px)` }}>
    <span aria-hidden className="absolute -top-px left-4 right-4 h-0.5 rounded-full" style={{ background: `color-mix(in srgb, ${screen.color} 50%, transparent)` }} />
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-0.5">
      <div className="min-w-0 flex-[1_1_300px]">
        <h1 tabIndex={-1} data-deck-focus="heading" className="flex min-w-0 items-center gap-2 rounded text-[17px] font-semibold leading-6 tracking-tight outline-none">
          <Dot color={screen.color} /><span className="truncate">{card.name}</span>
          <span className={cn("inline-flex shrink-0 items-center gap-1 text-[11.5px] font-medium", TONE[screen.status.tone].text)}>{screen.status.text}</span>
        </h1>
        <p className="truncate text-[12px] text-muted-foreground" title={card.goal}>{card.goal || "No goal written yet."}{held && card.reason ? ` · held: ${card.reason}` : ""}</p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {held ? <button type="button" onClick={() => run({ kind: "resume", id: card.id })} className={cn(BUTTON, "border-foreground bg-foreground text-background")}>Resume</button> : <>
          <ActionButton id="advance" on={on} run={run} primary label={`Advance${screen.advance.length ? ` · ${screen.advance.length}` : ""}`} />
          {card.oneOff ? null : <><ActionButton id="hold" on={on} run={run} label="Hold" /><ActionButton id="complete" on={on} run={run} label="Complete" /></>}
        </>}
      </div>
    </div>
    <div className="mt-2.5 grid grid-cols-6 gap-2 @min-[900px]:grid-cols-12">
      <Tile id="next" title="Next steps" open={open("next")} more={false} run={run} className="col-span-6 @min-[700px]:col-span-3 @min-[900px]:col-span-5"
        note={screen.next.criteria ? <span className="inline-flex items-center gap-1.5"><span aria-hidden className="inline-flex gap-0.5">{Array.from({ length: screen.next.criteria.needed },
          (_, index) => <i key={index} className={cn("inline-block size-2 rounded-full border", index < screen.next.criteria!.validated ? "border-transparent bg-emerald-500/60" : "border-border")} />)}</span>
          {screen.next.criteria.validated} of {screen.next.criteria.needed} done</span> : null}>
        {screen.next.items.length ? <ul className="grid gap-px">{screen.next.items.map((item, index) => <li key={`${item.text}-${index}`} className="flex min-h-[22px] items-center gap-2 text-[12px]">
          <span aria-hidden className="w-3 text-center text-muted-foreground">○</span><span className="min-w-0 flex-1 truncate" title={item.text}>{item.text}</span>
          {item.prUrl && item.ref ? <button type="button" onClick={() => run({ kind: "jump", prUrl: item.prUrl! })} title={`Show ${item.ref}`}
            className={cn("shrink-0 rounded px-1 text-[11.5px] hover:bg-foreground/[0.06]", RING)}>{item.ref} ↓</button>
            : item.owner ? <span className="shrink-0 text-[11px] text-muted-foreground">{item.owner}</span> : null}
        </li>)}</ul> : <p className="text-[12px] text-muted-foreground">{card.oneOff ? "No outcome: each one-off merges on its own." : "Nothing left to do."}</p>}
      </Tile>
      <Tile id="blocked" title="Blocked" note={screen.blocked.length ? `on others · ${screen.blocked.length}` : undefined} open={open("blocked")}
        more={screen.blocked.length > 3 || (screen.blocked.length === 3 && "narrow")} run={run}
        className="col-span-6 @min-[700px]:col-span-3 @min-[900px]:col-span-4">
        {blocked.length ? <div className="grid">{blocked.map((item, index) => <button key={item.prUrl} type="button" onClick={() => run({ kind: "jump", prUrl: item.prUrl })}
          title={`${item.ref}: ${item.what}`} className={cn("-mx-1 flex min-h-[22px] min-w-0 items-center gap-2 rounded px-1 text-left text-[12px] hover:bg-foreground/[0.04]", RING,
            index === 2 && !open("blocked") && "@max-[700px]:hidden")}>
          {item.dot ? <Changed title="Changed since you looked" /> : null}
          <span className="shrink-0 rounded-full bg-foreground/[0.07] px-1.5 text-[11px]">{item.on}</span>
          <span className="min-w-0 flex-1 truncate">{item.what}</span><span className="shrink-0 text-[11px] text-muted-foreground">{item.ref}</span>
          <span className="w-6 shrink-0 text-right text-[11px] text-muted-foreground">{item.age ?? ""}</span>
        </button>)}</div> : <p className="text-[12px] text-muted-foreground">Nothing waits on others.</p>}
      </Tile>
      <Tile id="stats" title="Stats" open={open("stats")} more run={run} className="col-span-6 @min-[900px]:col-span-3">
        <div className="grid grid-cols-4 @min-[900px]:grid-cols-2 @min-[900px]:gap-y-1">
          {[[screen.stats.open, "Open PRs"], [screen.stats.mergedWeek, "Merged 7d"], [screen.stats.median, "Median age"], [screen.stats.oldest?.text ?? "—", "Oldest wait"]]
            .map(([value, label]) => <div key={label} title={label === "Oldest wait" ? screen.stats.oldest?.title : undefined} className="min-w-0">
              <div className="text-[15px] font-semibold leading-5 tabular-nums">{value}</div><div className="truncate text-[11px] text-muted-foreground">{label}</div></div>)}
        </div>
        <div aria-hidden className="mt-1.5 flex h-1.5 gap-px overflow-hidden rounded-full bg-foreground/[0.06]">
          {screen.stats.bar.map((item) => <i key={item.key} className={cn("block h-full", TONE[item.tone].bar)} style={{ flex: item.count / total }} />)}</div>
        {open("stats") ? <p className="mt-1 text-[11px] text-muted-foreground">{screen.stats.bar.map((item) => `${item.count} ${item.label}`).join(" · ")}</p> : null}
      </Tile>
      <Tile id="threads" title="Threads" note={screen.threads.length || undefined} open={open("threads")} more={screen.threads.length > 3} run={run}
        className="col-span-6 @min-[900px]:row-span-3">
        {threads.length ? <div className="-mx-1 grid">{threads.map((thread) => <button key={thread.id} type="button" onClick={() => run({ kind: "thread", id: thread.id })}
          title={`Open "${thread.title}"`} className={cn("grid min-h-6 grid-cols-[10px_minmax(0,1fr)_auto_28px] items-center gap-2 rounded px-1 text-left text-[12px] hover:bg-foreground/[0.04]", RING)}>
          <span aria-hidden className={cn("size-2 rounded-full", thread.status === "active" ? "bg-sky-500/70 motion-safe:animate-pulse" : "bg-muted-foreground/40")} />
          <span className="truncate">{thread.dot ? <><Changed title="Changed since you looked" /> </> : null}{thread.title}<small className="ml-1.5 text-[11px] text-muted-foreground">{thread.ref}</small></span>
          <span className="text-[11px] text-muted-foreground">{thread.status}</span><span className="text-right text-[11px] text-muted-foreground">{thread.age ?? ""}</span>
        </button>)}</div> : <p className="text-[12px] text-muted-foreground">No threads yet.</p>}
      </Tile>
      {/* On a card 700 px or wider, the chips, state bar, and target sit on one line in place of the summary; opened, the fields follow. */}
      <Tile id="linear" title="Linear" note={open("linear") ? undefined : <span className={cn(linearLine && "@min-[700px]:hidden")}>{linear.summary}</span>}
        open={open("linear")} more={linear.lines.length > 0} run={run} className="col-span-2 @min-[700px]:col-span-6">
        {linearLine ? <div data-deck-linear-line className={cn("flex-wrap items-center gap-1", open("linear") ? "mb-1.5 flex" : "hidden @min-[700px]:flex")}>
          {linear.chips.map((chip) => <span key={`${chip.kind}-${chip.text}`}
            title={chip.kind === "label" ? "Linear label" : `Linear ${chip.kind}`} className={cn("inline-flex max-w-[230px] items-center gap-1 truncate rounded-md px-1.5 text-[11.5px] leading-5",
              chip.kind === "label" ? "text-muted-foreground" : "border border-border")}>
            {chip.kind === "label" ? "#" : <span aria-hidden className="text-[10.5px] text-muted-foreground">{chip.kind === "project" ? "▣" : "◇"}</span>}{chip.text}</span>)}
          {linear.bar.length ? <span role="img" aria-label={ticketStates} title={ticketStates}
            className="mx-1 inline-flex h-1.5 w-[70px] gap-px overflow-hidden rounded-full bg-foreground/[0.06]">
            {linear.bar.map((state) => <i key={state.name} className={cn("block h-full", TONE[state.tone].bar)} style={{ flex: state.count }} />)}</span> : null}
          {linear.target ? <span title="Project target date" className="text-[11px] text-muted-foreground">{linear.target}</span> : null}
        </div> : null}
        {open("linear") ? <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-2.5 gap-y-0.5 text-[12px]">{linear.lines.map(([label, value]) => <div key={label} className="contents">
          <dt className="text-[11px] text-muted-foreground">{label}</dt><dd className="break-words">{value}</dd></div>)}</dl> : null}
      </Tile>
      {([["people", "People", screen.people.summary, [
        ...screen.people.waitOnYou.map((person) => `@${person.login} waits on you: ${person.title}`), ...screen.people.youWaitOn.map((person) => `You wait on @${person.login}: ${person.title}`)]],
      ["recent", "Recent", screen.recent.summary, screen.recent.items.map((item) => `${item.text} · ${item.age}`)]] as const).map(([id, title, summary, lines]) =>
        <Tile key={id} id={id} title={title} note={open(id) ? undefined : summary} open={open(id)} more={lines.length > 0} run={run}
          className="col-span-2 @min-[700px]:col-span-3 @min-[900px]:col-span-6">
          {open(id) ? <ul className="grid gap-0.5 text-[12px]">{lines.map((line) => <li key={line} className="break-words">{line}</li>)}</ul> : null}
        </Tile>)}
    </div>
  </section>;
}

/** The one-line card header that stays once the card's own header scrolls away. */
export function CardBar({ name, color, status, advance, hollow }: { name: string; color: string; status?: { text: string; tone: Tone }; advance?: ReactNode; hollow?: boolean }) {
  return <div className="sticky top-0 z-[6] -mb-[34px] h-[34px] border-b border-border/70 bg-background">
    <div className="mx-auto flex h-full max-w-[1260px] items-center gap-2 px-4">
      <Dot color={color} hollow={hollow} /><b className="truncate text-[13px] font-semibold">{name}</b>
      {status ? <span className={cn("shrink-0 text-[11.5px]", TONE[status.tone].text)}>{status.text}</span> : null}
      <span className="flex-1" />{advance}
    </div>
  </div>;
}

export function CardSections({ screen, state, run, open, stuck }: { screen: CardScreen; state: RowState; run: Run; open: ReadonlySet<string>; stuck: boolean }) {
  return screen.sections.length ? <>{screen.sections.map((section) => <Section key={section.key} section={section} state={state} run={run} open={open.has(section.key)}
    stuck={stuck} held={screen.card.pile !== "active"} />)}</> : <p className="py-8 text-center text-[12px] text-muted-foreground">No open PRs in this effort.</p>;
}

// ---------------------------------------------------------------------------
// The Unclassified deck: coverage, standing rules, and one group per suggestion.
// ---------------------------------------------------------------------------

export type RuleItem = { id: string; text: string };
const CONFIDENCE = { low: 1, medium: 2, high: 3 } as const;
function Group({ group, state, run, stuck }: { group: UncGroup; state: RowState; run: Run; stuck: boolean }) {
  if (group.accepted) return <section data-deck-sec={group.key} className="mt-0.5">
    <div className="flex min-h-9 items-center gap-2 border-b border-border/50 py-1 pl-2 pr-1 text-[12.5px]">
      <span aria-hidden className="h-3.5 w-[3px] shrink-0 rounded-full" style={{ background: group.color }} /><span className={TONE.green.text}>✓</span>
      <span className="truncate">{group.accepted.text}</span><span className="flex-1" />
      <button type="button" data-deck-focus={`undo-group-${group.key}`} onClick={() => run({ kind: "undo-group", key: group.key })}
        className={cn("rounded px-1 text-[11.5px] text-sky-700 hover:underline dark:text-sky-300", RING)}>Undo</button>
    </div>
  </section>;
  const target = group.target;
  const live = group.button.count > 0;
  return <section data-deck-sec={group.key} className="mt-0.5">
    <div className={cn("sticky z-[4] flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/50 bg-background py-1 pl-2 pr-1", stuck ? "top-[34px]" : "top-0")}>
      <span aria-hidden className="h-3.5 w-[3px] shrink-0 rounded-full" style={{ background: group.color }} />
      {target ? <span className="text-[12px] text-muted-foreground">→{target.kind === "new" ? " new" : ""}</span> : null}
      {target ? <Dot color={group.color} /> : null}
      <h2 className={cn("truncate text-[12.5px]", target ? "font-semibold" : "font-medium text-muted-foreground")}>{group.title}</h2>
      <span className="min-w-0 flex-[1_1_200px] truncate text-[11.5px] text-muted-foreground" title={group.reason}>{group.reason}
        {group.confidence ? <span className="ml-1.5 inline-flex items-center gap-0.5 align-middle" title={`${group.confidence} confidence`}>{[1, 2, 3].map((dot) =>
          <i key={dot} className={cn("inline-block size-1 rounded-full", dot <= CONFIDENCE[group.confidence!] ? "bg-foreground/70" : "bg-border")} />)}
          <span className="ml-1 capitalize">{group.confidence}</span></span> : null}</span>
      <button type="button" data-deck-focus={`group-${group.key}`} aria-disabled={live ? undefined : true} onClick={() => { if (live) run({ kind: "group", key: group.key }); }}
        title={group.button.kind === "pick" ? "Pick an effort for each PR (e)" : "Moves nothing until you press it; Undo takes it back"}
        className={cn(BUTTON, "border-border hover:bg-foreground/[0.06]")}>{group.button.label}<Kbd>{group.button.kind === "pick" ? "e" : "p"}</Kbd></button>
    </div>
    <div className="pb-1.5 pt-0.5">{group.lines.map((line, index) => <Row key={line.prUrl} line={line} state={state} run={run} first={index === 0} />)}</div>
  </section>;
}

export function Unclassified({ screen, rules, state, run, stuck, behind }: { screen: UncScreen; rules: readonly RuleItem[]; state: RowState; run: Run; stuck: boolean;
  behind: readonly Chip[] }) {
  const { coverage } = screen;
  const bar: [number, string][] = [[coverage.efforts, "bg-emerald-500/55"], [coverage.oneOffs, "bg-muted-foreground/40"], [coverage.toSort, "bg-amber-500/55"]];
  return <>
    <Stack behind={behind} run={run}><section aria-label="Unclassified" className="relative rounded-[14px] border border-border/70 p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-0.5">
        <div className="min-w-0 flex-[1_1_300px]">
          <h1 tabIndex={-1} data-deck-focus="heading" className="flex items-center gap-2 text-[17px] font-semibold leading-6 tracking-tight outline-none">
            <Dot color="#d3a35a" hollow />Unclassified</h1>
          <p className="text-[12px] text-muted-foreground">{coverage.toSort ? "Open PRs with no effort. Each group is a suggestion; nothing moves until you press it."
            : "Every open PR is in an effort or in One-offs."}</p>
        </div>
        <div className="flex gap-1.5">
          <button type="button" data-deck-focus="seed" onClick={() => run({ kind: "action", id: "seed" })} title="Propose one effort per Linear project on your open PRs"
            className={cn(BUTTON, "border-border hover:bg-foreground/[0.06]")}>Seed from Linear…</button>
          <button type="button" data-deck-focus="rule" onClick={() => run({ kind: "action", id: "rule" })} className={cn(BUTTON, "border-border hover:bg-foreground/[0.06]")}>+ Standing rule</button>
        </div>
      </div>
      <div className="mt-2.5 grid gap-2">
        <div className="rounded-[10px] border border-border/50 px-2.5 py-1.5">
          <p className="flex flex-wrap items-baseline gap-2 text-[11.5px] text-muted-foreground"><span className="text-[10.5px] uppercase tracking-wide">Effort coverage</span>
            <b className="text-[13px] font-semibold text-foreground">{coverage.pct}%</b>of {plural(coverage.total, "open PR")} are in a real effort</p>
          <div aria-hidden className="my-1.5 flex h-2 gap-px overflow-hidden rounded-full bg-foreground/[0.06]">{bar.map(([count, tone], index) => count
            ? <i key={index} className={cn("block h-full", tone)} style={{ flex: count }} /> : null)}</div>
          <p className="flex flex-wrap gap-x-3.5 text-[11.5px] text-muted-foreground"><span><b className="text-foreground">{coverage.efforts}</b> in efforts</span>
            <span><b className="text-foreground">{coverage.oneOffs}</b> one-offs</span><span><b className="text-foreground">{coverage.toSort}</b> to sort</span></p>
        </div>
        {rules.length ? <div className="flex flex-wrap items-center gap-1.5 rounded-[10px] border border-border/50 px-2.5 py-1.5 text-[12px]">
          <span className="mr-1 text-[10.5px] uppercase tracking-wide text-muted-foreground">Rules</span>
          {rules.map((rule) => <span key={rule.id} className="inline-flex items-center gap-1.5 rounded-md border border-border bg-foreground/[0.03] px-2">{rule.text}
            <button type="button" aria-label={`Remove the rule ${rule.text}`} title="Remove this rule; the PRs it placed stay" onClick={() => run({ kind: "rule-remove", id: rule.id })}
              className={cn("rounded text-muted-foreground hover:text-foreground", RING)}>×</button></span>)}
        </div> : null}
      </div>
    </section></Stack>
    <div data-deck-rows>
      {screen.groups.map((group) => <Group key={group.key} group={group} state={state} run={run} stuck={stuck} />)}
      {screen.groups.length ? null : <p className="py-8 text-center text-[12px] text-muted-foreground">Nothing to sort. New PRs land here only when no rule or signal places them.</p>}
    </div>
  </>;
}

// ---------------------------------------------------------------------------
// Chrome: the top bar, the batch bar docked under the rows, and the hint bar.
// ---------------------------------------------------------------------------

export const OTHER_VIEWS = [{ id: "map", title: "Map" }, { id: "pipeline", title: "Pipeline" }, { id: "work", title: "Work" }, { id: "efforts", title: "Manage efforts" }] as const;

export function TopBar({ view, read, seen, run, onPalette, onHelp }: { view: "deck" | "prs"; read: { text: string; error: string | null };
  seen: { changed: number; available: boolean; note: string | null }; run: Run; onPalette(): void; onHelp(): void }) {
  const scope = usePortalScopeProps();
  return <header className="@container flex h-10 shrink-0 items-center gap-2 border-b border-border/70 px-3">
    <nav aria-label="Workstreams views" className="inline-flex shrink-0 overflow-hidden rounded-md border border-border">
      <button type="button" data-deck-focus="view-deck" aria-pressed={view === "deck"} title="One effort per card (v)" onClick={() => { if (view !== "deck") run({ kind: "action", id: "view" }); }}
        className={cn("h-6 px-2.5 text-[12px]", RING, view === "deck" ? "bg-foreground/[0.08] text-foreground" : "text-muted-foreground hover:text-foreground")}>Efforts</button>
      <button type="button" data-deck-focus="view-prs" aria-pressed={view === "prs"} title="Every open PR in one list (v)" onClick={() => { if (view !== "prs") run({ kind: "action", id: "view" }); }}
        className={cn("h-6 px-2.5 text-[12px]", RING, view === "prs" ? "bg-foreground/[0.08] text-foreground" : "text-muted-foreground hover:text-foreground")}>All PRs</button>
    </nav>
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger asChild><button type="button" className={GHOST}>More ▾</button></PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content {...scope} align="start" sideOffset={4} className={cn("z-50 grid w-44 rounded-lg border border-border bg-popover p-1 text-[12px] shadow-md outline-none", POINTER_CURSORS)}>
          {OTHER_VIEWS.map((item) => <button key={item.id} type="button" onClick={() => run({ kind: "view", view: item.id })}
            className={cn("rounded px-2 py-1 text-left hover:bg-foreground/[0.06]", RING)}>{item.title}</button>)}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
    <span className="flex-1" />
    <span role={read.error ? "alert" : "status"} className={cn("truncate text-[11.5px]", read.error ? "text-destructive" : "text-muted-foreground")}>{read.error ?? read.text}</span>
    {seen.note ? <span role="status" className="shrink-0 text-[11.5px] text-muted-foreground"><span className={TONE.green.text}>✓</span> {seen.note}</span>
      : seen.available ? <button type="button" data-deck-focus="seen" onClick={() => run({ kind: "action", id: "seen" })}
        title="Settles this view only: rows a read changed, rows that left, and rows you acted on"
        className={cn("inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full bg-sky-500/10 px-2 text-[11.5px] text-sky-800 hover:bg-sky-500/20 dark:text-sky-200", RING)}>
        {seen.changed ? <><Changed title="Changed here" /><b>{seen.changed}</b> changed here ·</> : null} Mark seen <Kbd>s</Kbd></button> : null}
    <button type="button" data-deck-focus="palette" onClick={onPalette} title="Every action and its key (⌘K)" className={cn(BUTTON, "border-border text-muted-foreground hover:text-foreground")}>
      <Kbd>⌘K</Kbd><span className="hidden @min-[720px]:inline">all actions</span></button>
    <button type="button" data-deck-focus="help" onClick={onHelp} title="Keys and colors (?)" aria-label="Keys and colors (?)"
      className={cn(BUTTON, "w-6 justify-center border-border px-0 text-muted-foreground hover:text-foreground")}>?</button>
  </header>;
}

/** The selection's moves, docked under the rows so it never covers one. */
export function BatchBar({ selected, kinds, unc, run }: { selected: number; kinds: readonly { id: DeckActionId; count: number; tone: Tone }[]; unc: boolean; run: Run }) {
  if (!selected) return null;
  const safe = kinds.filter((kind) => kind.id !== "merge").reduce((sum, kind) => sum + kind.count, 0);
  return <div aria-label="Selection" className="shrink-0 border-t border-border bg-background">
    <div className="mx-auto flex max-w-[1260px] flex-wrap items-center gap-1.5 px-4 py-1.5 text-[12px]">
      <b className="mr-1 font-semibold">{selected} selected</b>
      {!unc && safe ? <button type="button" onClick={() => run({ kind: "action", id: "advance" })} className={cn(BUTTON, "border-foreground bg-foreground font-medium text-background")}>
        Advance · {safe}<Kbd>a</Kbd></button> : null}
      {kinds.map((kind) => <button key={kind.id} type="button" onClick={() => run({ kind: "action", id: kind.id })} className={cn(BUTTON, TONE[kind.tone].button)}>
        {ACTION[kind.id].title.replace("…", "")} {kind.count}<Kbd>{ACTION[kind.id].keys[0]}</Kbd></button>)}
      {unc ? <>
        <button type="button" onClick={() => run({ kind: "action", id: "accept" })} className={cn(BUTTON, "border-border")}>Accept suggestions<Kbd>p</Kbd></button>
        <button type="button" onClick={() => run({ kind: "action", id: "move" })} className={cn(BUTTON, "border-border")}>Move…<Kbd>e</Kbd></button>
        <button type="button" onClick={() => run({ kind: "action", id: "new-effort" })} className={cn(BUTTON, "border-border")}>New effort from these…</button>
        <button type="button" onClick={() => run({ kind: "action", id: "one-off" })} className={cn(BUTTON, "border-border")}>Mark one-offs</button>
      </> : null}
      <span className="flex-1" />
      <button type="button" onClick={() => run({ kind: "action", id: "clear" })} className={GHOST}>Clear<Kbd>esc</Kbd></button>
    </div>
  </div>;
}

/** The few keys that matter now, or one status line, which never covers a row; ⌘K and ? stay on the right. */
export function HintBar({ hints, flash, onPalette, onHelp, onUndo }: { hints: readonly [string, string][]; flash: { text: string; undo: boolean } | null;
  onPalette(): void; onHelp(): void; onUndo(): void }) {
  return <footer aria-label="Keys for what you're doing" className="@container flex h-7 shrink-0 items-center gap-3.5 overflow-hidden whitespace-nowrap border-t border-border/70 bg-foreground/[0.02] px-3 text-[11.5px] text-muted-foreground">
    <span role="status" className="flex min-w-0 items-center gap-3.5 overflow-hidden">
      {flash ? <span className="flex min-w-0 items-center gap-2.5 text-foreground"><span className="truncate">{flash.text}</span>
        {flash.undo ? <button type="button" tabIndex={-1} onClick={onUndo} className="inline-flex shrink-0 items-center gap-1 font-medium text-sky-700 hover:underline dark:text-sky-300">Undo <Kbd>z</Kbd></button> : null}</span>
        : hints.map(([keys, label], index) => <span key={keys} className={cn("inline-flex items-center gap-1.5", index >= 4 && "hidden @min-[720px]:inline-flex")}><Keys keys={keys} />{label}</span>)}
    </span>
    <span className="ml-auto flex shrink-0 gap-3">
      <button type="button" tabIndex={-1} onClick={onPalette} className="inline-flex items-center gap-1.5 hover:text-foreground"><Kbd>⌘K</Kbd>all actions</button>
      <button type="button" tabIndex={-1} onClick={onHelp} className="inline-flex items-center gap-1.5 hover:text-foreground"><Kbd>?</Kbd>keys</button>
    </span>
  </footer>;
}

// ---------------------------------------------------------------------------
// Dialog bodies. The nav view puts each in a dialog that returns focus where it came from.
// ---------------------------------------------------------------------------

/** What a confirm lists: each PR's one write, every PR it leaves out and why, and what Advance never does. */
export type ConfirmPlan = { title: string; sub: string; verb: string; items: readonly Pick<BatchItem, "prUrl" | "ref" | "title" | "kind" | "what" | "notes">[];
  skipped: readonly Pick<Skipped, "prUrl" | "ref" | "reason">[]; excluded: string | null; request: boolean };
const KIND_TONE: Record<BatchItem["kind"], Tone> = { confirm: "violet", nudge: "blue", request: "blue", ready: "blue" };

/**
 * The listing confirm: nothing is written until you press its button (or ⌘↵), and then only after SEND_DELAY_MS, which Undo cancels.
 * A request can ask someone else instead of each PR's suggestion; that plans again.
 */
export function ConfirmBody({ plan, busy, error, reviewer, dirty, onReviewer, onReplan, onConfirm, onCancel }: { plan: ConfirmPlan; busy: boolean; error: string | null;
  /** The reviewer you typed differs from the one this listing asks: nothing sends until it plans again. */
  reviewer: string; dirty: boolean; onReviewer(value: string): void; onReplan(): void; onConfirm(): void; onCancel(): void }) {
  const seconds = Math.round(SEND_DELAY_MS / 1_000);
  return <div className="grid gap-3 text-[12.5px]">
    <ul data-deck-plan className="grid max-h-[50vh] gap-2 overflow-y-auto">
      {plan.items.map((item) => <li key={`${item.kind}-${item.prUrl}`} className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2.5">
        <span className={cn("mt-px rounded px-1.5 text-[11px] leading-[18px]", TONE[KIND_TONE[item.kind]].chip)}>{item.what}</span>
        <span className="min-w-0"><b className="font-medium">{item.ref}</b> <span className="text-muted-foreground">{item.title}</span></span>
      </li>)}
    </ul>
    {plan.skipped.length ? <div className="grid gap-1 border-t border-border/60 pt-2 text-[12px]"><p className="text-muted-foreground">Left out:</p>
      <ul className="grid gap-0.5">{plan.skipped.map((item) => <li key={item.prUrl}><b className="font-medium">{item.ref}</b> <span className="text-muted-foreground">{item.reason}</span></li>)}</ul></div> : null}
    {plan.excluded ? <p className="border-t border-border/60 pt-2 text-[12px] text-muted-foreground">{plan.excluded}</p> : null}
    {plan.request ? <label className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">Ask instead
      <input value={reviewer} onChange={(event) => onReviewer(event.target.value)} placeholder="login" autoComplete="off" spellCheck={false}
        onKeyDown={(event) => { if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) { event.preventDefault(); onReplan(); } }}
        className="h-7 w-40 rounded-md border border-input bg-background px-2 font-mono text-[12px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-sky-500" />
      <button type="button" onClick={onReplan} disabled={!dirty || busy} className={cn(BUTTON, "border-border")}>Plan again</button></label> : null}
    {error ? <p role="alert" className="text-[12px] text-destructive">{error}</p> : null}
    <div className="flex items-center justify-end gap-2 border-t border-border/60 pt-2.5">
      <span className="mr-auto text-[11.5px] text-muted-foreground">{dirty ? "Plan again first" : `Sends after ${seconds} s · Undo until then`}</span>
      <button type="button" onClick={onCancel} className={cn(BUTTON, "h-7 border-border")}>Cancel<Kbd>esc</Kbd></button>
      <button type="button" data-deck-confirm disabled={busy || dirty || plan.items.length === 0} onClick={onConfirm}
        className={cn(BUTTON, "h-7 border-foreground bg-foreground font-medium text-background hover:bg-foreground/90")}>{busy ? "Starting…" : `${plan.verb} ${plan.items.length}`}<Kbd>⌘↵</Kbd></button>
    </div>
  </div>;
}

/** Hold: the effort leaves the active pile with an optional reason; its PRs stop counting until you resume it. */
export function HoldBody({ reason, onReason, busy, error, onHold, onCancel }: { reason: string; onReason(value: string): void; busy: boolean; error: string | null;
  onHold(): void; onCancel(): void }) {
  return <div className="grid gap-3 text-[12.5px]">
    <label className="grid gap-1 text-[12px] text-muted-foreground">Reason (optional)
      <input value={reason} maxLength={500} onChange={(event) => onReason(event.target.value)} placeholder="Waiting on the design review"
        className="h-8 rounded-md border border-input bg-background px-2.5 text-[12.5px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-sky-500" /></label>
    {error ? <p role="alert" className="text-[12px] text-destructive">{error}</p> : null}
    <DialogButtons busy={busy} label="Hold" onOk={onHold} onCancel={onCancel} />
  </div>;
}
function DialogButtons({ busy, label, onOk, onCancel, disabled }: { busy: boolean; label: string; onOk(): void; onCancel(): void; disabled?: boolean }) {
  return <div className="flex items-center justify-end gap-2 border-t border-border/60 pt-2.5">
    <button type="button" onClick={onCancel} className={cn(BUTTON, "h-7 border-border")}>Cancel<Kbd>esc</Kbd></button>
    <button type="button" data-deck-confirm disabled={busy || disabled} onClick={onOk}
      className={cn(BUTTON, "h-7 border-foreground bg-foreground font-medium text-background hover:bg-foreground/90")}>{busy ? "Working…" : label}<Kbd>⌘↵</Kbd></button>
  </div>;
}

/** Complete: what is still open first. Its PRs and threads stay with it on the Done pile. */
export function CompleteBody({ screen, busy, error, onComplete, onCancel }: { screen: CardScreen; busy: boolean; error: string | null; onComplete(): void; onCancel(): void }) {
  const active = screen.threads.filter((thread) => thread.status === "active");
  const criteria = screen.next.criteria;
  return <div className="grid gap-3 text-[12.5px]">
    <ul className="grid gap-1.5">
      <li><b className="font-medium">{plural(screen.card.stats.open, "open PR")}</b> <span className="text-muted-foreground">{screen.needsYou} need you</span></li>
      {active.length ? <li><b className="font-medium">{plural(active.length, "active thread")}</b> <span className="text-muted-foreground">{active.map((thread) => thread.title).join(", ")}</span></li> : null}
      {criteria && criteria.validated < criteria.needed ? <li><b className="font-medium">{criteria.needed - criteria.validated} “done when” not met</b></li> : null}
    </ul>
    <p className="text-[12px] text-muted-foreground">Its PRs and threads stay with it on the Done pile, and stop counting. Reopen puts it back.</p>
    {error ? <p role="alert" className="text-[12px] text-destructive">{error}</p> : null}
    <DialogButtons busy={busy} label="Complete" onOk={onComplete} onCancel={onCancel} />
  </div>;
}

export type RuleDraft = { kind: "ticket-prefix" | "branch" | "repo" | "stack" | "linear-project"; value: string; effortId: string; now: boolean };
export const RULE_WORDS: Record<RuleDraft["kind"], string> = { "ticket-prefix": "Ticket prefix", branch: "Branch", repo: "Repo", stack: "Stacked on a PR in an effort",
  "linear-project": "Linear project" };
/** A standing rule places new PRs on every read; `now` also moves the open PRs it matches today, which the preview counts. */
export function RuleBody({ draft, efforts, matches, busy, error, onDraft, onAdd, onCancel }: { draft: RuleDraft; efforts: readonly { id: string; name: string }[];
  matches: number | null; busy: boolean; error: string | null; onDraft(draft: RuleDraft): void; onAdd(): void; onCancel(): void }) {
  const field = "h-8 rounded-md border border-input bg-background px-2 text-[12.5px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-sky-500";
  return <div className="grid gap-3 text-[12.5px]">
    <div className="flex flex-wrap items-center gap-2">Always put
      <select aria-label="Rule kind" value={draft.kind} onChange={(event) => onDraft({ ...draft, kind: event.target.value as RuleDraft["kind"] })} className={field}>
        {Object.entries(RULE_WORDS).map(([kind, word]) => <option key={kind} value={kind}>{word}</option>)}</select>
      {draft.kind === "stack" ? null : <input aria-label="Rule value" value={draft.value} onChange={(event) => onDraft({ ...draft, value: event.target.value })}
        placeholder={draft.kind === "branch" ? "billing/*" : draft.kind === "repo" ? "inkwell/folio" : draft.kind === "linear-project" ? "Reading lists" : "ABC"}
        className={cn(field, "w-36", draft.kind !== "linear-project" && "font-mono")} />}
      {draft.kind === "stack" ? "with its base" : <>in <select aria-label="Effort" value={draft.effortId} onChange={(event) => onDraft({ ...draft, effortId: event.target.value })} className={field}>
        {efforts.map((effort) => <option key={effort.id} value={effort.id}>{effort.name}</option>)}</select></>}
    </div>
    <label className="flex items-center gap-2 text-[12px]"><input type="checkbox" checked={draft.now} onChange={(event) => onDraft({ ...draft, now: event.target.checked })} />
      Also move the {matches === null ? "open PRs" : plural(matches, "open PR")} it matches now</label>
    {error ? <p role="alert" className="text-[12px] text-destructive">{error}</p> : null}
    <DialogButtons busy={busy} label="Add rule" onOk={onAdd} onCancel={onCancel} disabled={draft.kind !== "stack" && !draft.value.trim()} />
  </div>;
}

/** A new effort from chosen PRs: its name and goal, and the PRs it takes. */
export function NewEffortBody({ name, goal, refs, busy, error, onName, onGoal, onCreate, onCancel }: { name: string; goal: string; refs: readonly string[]; busy: boolean;
  error: string | null; onName(value: string): void; onGoal(value: string): void; onCreate(): void; onCancel(): void }) {
  const field = "h-8 rounded-md border border-input bg-background px-2.5 text-[12.5px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-sky-500";
  return <div className="grid gap-3 text-[12.5px]">
    <label className="grid gap-1 text-[12px] text-muted-foreground">Name<input value={name} maxLength={120} onChange={(event) => onName(event.target.value)} className={field} /></label>
    <label className="grid gap-1 text-[12px] text-muted-foreground">Goal (optional)<input value={goal} maxLength={500} onChange={(event) => onGoal(event.target.value)}
      placeholder="What's true when it's done" className={field} /></label>
    <p className="text-[12px] text-muted-foreground">Takes {refs.join(", ")}. The card joins the end of the pile; Undo takes it back.</p>
    {error ? <p role="alert" className="text-[12px] text-destructive">{error}</p> : null}
    <DialogButtons busy={busy} label="Create effort" onOk={onCreate} onCancel={onCancel} disabled={!name.trim()} />
  </div>;
}

/**
 * Seed from Linear: one proposed effort per Linear project on your open PRs. Nothing is picked until you check it, each shows how many of
 * its PRs it would take and which effort it may duplicate, and Create makes only the ones you checked.
 */
export function SeedBody({ proposals, keyed, picked, busy, error, onPick, onCreate, onCancel }: { proposals: readonly SeedProposal[] | null; keyed: boolean;
  picked: ReadonlySet<string>; busy: boolean; error: string | null; onPick(projectId: string): void; onCreate(): void; onCancel(): void }) {
  const free = (proposal: SeedProposal) => proposal.prs.filter((pr) => !pr.effort).length;
  const MATCH = { name: "has its name", members: "owns", seed: "was seeded from it" } as const;
  return <div className="grid gap-3 text-[12.5px]">
    {proposals === null ? <p role="status" className="text-muted-foreground">Reading Linear projects…</p>
      : !proposals.length ? <p className="text-muted-foreground">{keyed ? "No Linear project has tickets on your open PRs yet. Projects show after the next scan reads Linear."
        : "No Linear API key is set. Add one under Linear API keys in the Workstreams settings."}</p>
      : <ul data-deck-seed className="grid max-h-[50vh] gap-1 overflow-y-auto">{proposals.map((proposal) => {
        const count = free(proposal);
        // Create skips a project an effort has the name of or was seeded from, so it can't be checked.
        const exists = proposal.matches.some((match) => match.by !== "members");
        return <li key={proposal.projectId}><label className={cn("grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2.5 rounded-md px-1.5 py-1",
          count && !exists ? "hover:bg-foreground/[0.04]" : "opacity-60")}>
          <input type="checkbox" checked={picked.has(proposal.projectId)} disabled={!count || exists} onChange={() => onPick(proposal.projectId)} className="mt-[3px]" />
          <span className="min-w-0"><b className="font-medium">{proposal.name}</b>{proposal.goal ? <span className="block truncate text-[12px] text-muted-foreground"
            title={proposal.goal}>{proposal.goal}</span> : null}
            {proposal.matches.map((match) => <span key={`${match.by}-${match.id}`} className={cn("block text-[11.5px]", TONE.amber.text)}>
              {match.name} {MATCH[match.by]}{match.by === "members" ? ` ${match.prs} of its PRs` : ""}</span>)}</span>
          <span className="whitespace-nowrap text-[11.5px] text-muted-foreground" title={proposal.prs.map((pr) => `${pr.repo.split("/").at(-1)} #${pr.number}`).join(", ")}>
            {exists ? "already exists" : count ? `takes ${count} of ${plural(proposal.prs.length, "PR")}` : "all in efforts"}</span>
        </label></li>;
      })}</ul>}
    <p className="text-[12px] text-muted-foreground">Each takes only PRs no effort owns. It never syncs with Linear after; Undo takes it back.</p>
    {error ? <p role="alert" className="text-[12px] text-destructive">{error}</p> : null}
    <DialogButtons busy={busy} label={picked.size ? `Create ${plural(picked.size, "effort")}` : "Create"} onOk={onCreate} onCancel={onCancel} disabled={!picked.size} />
  </div>;
}

/** Move: the efforts a PR can join, One-offs, or a new effort from these. */
export function MoveBody({ refs, efforts, busy, error, onMove, onNew }: { refs: readonly string[]; efforts: readonly { id: string; name: string; color: string; open: number }[];
  busy: boolean; error: string | null; onMove(effortId: string): void; onNew(): void }) {
  return <div className="grid gap-1 text-[12.5px]">
    <p className="mb-1 text-[12px] text-muted-foreground">{refs.join(", ")}</p>
    {efforts.map((effort) => <button key={effort.id} type="button" disabled={busy} onClick={() => onMove(effort.id)}
      className={cn("flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-foreground/[0.06]", RING)}>
      <Dot color={effort.color} />{effort.name}<span className="ml-auto text-[11px] text-muted-foreground">{effort.open} open</span></button>)}
    <button type="button" disabled={busy} onClick={onNew} className={cn("mt-1 flex items-center gap-2 border-t border-border/60 px-2 pb-1 pt-2 text-left hover:bg-foreground/[0.04]", RING)}>
      <span className="text-muted-foreground">+</span>New effort from {refs.length > 1 ? "these" : "this"}…</button>
    {error ? <p role="alert" className="text-[12px] text-destructive">{error}</p> : null}
  </div>;
}

/** ⌘K: every action with its key, grayed with why where it can't run; ↑ ↓ choose, ↵ runs. */
export function PaletteBody({ query, items, highlight, onQuery, onRun, onHighlight }: { query: string; items: readonly PaletteItem[]; highlight: number;
  onQuery(value: string): void; onRun(item: PaletteItem): void; onHighlight(index: number): void }) {
  const live = items.filter((item) => item.on);
  let group: string | null = null;
  return <div className="grid text-[12.5px]">
    <input autoFocus value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Type an action or a key…" aria-label="Filter actions" autoComplete="off" spellCheck={false}
      className="h-10 border-b border-border bg-transparent px-3.5 text-[14px] outline-none" />
    <div role="listbox" aria-label="Actions" className="max-h-[min(460px,60vh)] overflow-y-auto px-1.5 pb-1.5 pt-1">
      {items.length ? items.map((item) => {
        const head = item.group !== group ? (group = item.group) : null;
        const index = live.indexOf(item);
        return <div key={item.key}>
          {head ? <p className="px-2 pb-0.5 pt-2 text-[10.5px] uppercase tracking-wide text-muted-foreground">{head}</p> : null}
          <button type="button" role="option" tabIndex={-1} aria-selected={item.on && index === highlight} aria-disabled={item.on ? undefined : true}
            onMouseMove={() => { if (item.on) onHighlight(index); }} onClick={() => { if (item.on) onRun(item); }}
            className={cn("flex min-h-7 w-full items-center gap-2.5 rounded-md px-2 text-left", item.on ? "text-foreground/90" : "cursor-default text-muted-foreground/70",
              item.on && index === highlight && "bg-foreground/[0.07] text-foreground shadow-[inset_2px_0_0_theme(colors.sky.500)]")}>
            <span>{item.title}</span>{item.on ? null : <span className="text-[11px] text-muted-foreground/80">· {item.why}</span>}
            <span className="flex-1" />{item.keys.length ? <Keys keys={item.keys.join(" ")} /> : null}
          </button>
        </div>;
      }) : <p className="py-6 text-center text-muted-foreground">No matching action.</p>}
    </div>
    <p className="flex items-center gap-3 border-t border-border px-3 py-1.5 text-[11.5px] text-muted-foreground"><span><Keys keys="↑ ↓" /> choose</span><span><Kbd>↵</Kbd> run</span>
      <span><Kbd>esc</Kbd> close</span><span className="ml-auto">{live.length} of {items.length} available here</span></p>
  </div>;
}

/** ?: every key by group, grayed where it doesn't apply here, then what the colors mean and how writes stay safe. */
export function HelpBody({ items }: { items: readonly PaletteItem[] }) {
  const keyed = items.filter((item) => item.action && item.keys.length);
  return <div className="grid gap-4 text-[12px]">
    <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-x-6 gap-y-3.5">
      {KEY_GROUPS.map((group) => { const list = keyed.filter((item) => item.group === group); return list.length ? <div key={group}>
        <h3 className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">{group}</h3>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2.5 gap-y-1">{list.map((item) => <div key={item.key} className="contents">
          <dt><Keys keys={item.keys.join(" ")} /></dt><dd className={item.on ? "" : "text-muted-foreground/70"}>{item.title}</dd></div>)}</dl>
      </div> : null; })}
    </div>
    <div className="grid gap-1.5 border-t border-border/60 pt-3">
      <div className="flex flex-wrap gap-1.5">{([["green", "Ready to merge"], ["violet", "Confirm notes"], ["blue", "Nudge, request, ready"], ["amber", "Conflict or changes"],
        ["red", "CI failing"], ["gray", "Waiting or in flight"]] as const).map(([tone, label]) => <span key={tone} className={cn("rounded px-1.5 text-[11px] leading-[19px]", TONE[tone].chip)}>{label}</span>)}</div>
      <p className="text-muted-foreground">Color means your move; gray waits on others, runs itself, is on hold, or is to sort. A blue dot marks a change since you looked, which stays put until Mark seen.</p>
      <p className="text-muted-foreground">Needs you: an open PR in an active effort or One-offs whose next move is yours. Dimmed rows don't count, and Unclassified PRs are to sort.</p>
      <p className="text-muted-foreground">Every GitHub write opens one confirm that lists each PR, then waits {Math.round(SEND_DELAY_MS / 1_000)} s with Undo. Merges run only from the fresh preview, on a click or ⌘↵.</p>
    </div>
  </div>;
}

// ---------------------------------------------------------------------------
// The whole deck.
// ---------------------------------------------------------------------------

export type DeckPaneProps = {
  chips: readonly Chip[]; cur: string | null;
  /** The card shown, or the Unclassified deck; null before the first read. */
  card: CardScreen | null; unc: UncScreen | null; rules: readonly RuleItem[];
  held: readonly Pile[]; done: readonly Pile[];
  read: { text: string; error: string | null };
  seen: { changed: number; available: boolean; note: string | null };
  state: RowState; tiles: ReadonlySet<string>; open: ReadonlySet<string>; pile: "hold" | "done" | null;
  /** The card's own header has scrolled away, so its one-line bar shows and section headers stick below it. */
  stuck: boolean;
  /** The card a flip landed on, said once to screen readers; empty otherwise. */
  announce?: string;
  on: Availability; hints: readonly [string, string][]; flash: { text: string; undo: boolean } | null;
  batch: { kinds: readonly { id: DeckActionId; count: number; tone: Tone }[] };
  run: Run; onPalette(): void; onHelp(): void; onUndo(): void;
  rootRef?: RefObject<HTMLDivElement | null>; scrollerRef?: RefObject<HTMLDivElement | null>; slackRef?: RefObject<HTMLDivElement | null>;
  chipsRef?: RefObject<HTMLDivElement | null>; viewRef?: RefObject<HTMLDivElement | null>;
};

export function DeckPane(props: DeckPaneProps) {
  const { card, unc, stuck } = props;
  const name = card ? card.card.name : "Unclassified";
  const behind = cardsBehind(props.chips, props.cur);
  return <div ref={props.rootRef} role="region" aria-label="Effort deck" className={cn("flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground", POINTER_CURSORS)}>
    <TopBar view="deck" read={props.read} seen={props.seen} run={props.run} onPalette={props.onPalette} onHelp={props.onHelp} />
    <Strip chips={props.chips} cur={props.cur} deck held={props.held} done={props.done} pile={props.pile} run={props.run} chipsRef={props.chipsRef} />
    <div ref={props.scrollerRef} data-deck-scroller className="@container relative min-h-0 flex-1 overflow-y-auto overscroll-contain [overflow-anchor:none]">
      {stuck && (card || unc) ? <CardBar name={name} color={card ? card.color : "#d3a35a"} hollow={!card} status={card?.status}
        advance={card && card.card.pile === "active" ? <ActionButton id="advance" on={props.on} run={props.run} primary label={`Advance${card.advance.length ? ` · ${card.advance.length}` : ""}`} /> : null} /> : null}
      <div ref={props.slackRef} aria-hidden data-deck-slack />
      <div ref={props.viewRef} className="mx-auto max-w-[1260px] px-2 pb-10 pt-3 @min-[720px]:px-4">
        {card ? <><Stack behind={behind} run={props.run}><Card screen={card} tiles={props.tiles} run={props.run} on={props.on} /></Stack>
          <div data-deck-rows><CardSections screen={card} state={props.state} run={props.run} open={props.open} stuck={stuck} /></div></>
          : unc ? <Unclassified screen={unc} rules={props.rules} state={props.state} run={props.run} stuck={stuck} behind={behind} />
          : <p role="status" className="py-8 text-center text-[12px] text-muted-foreground">{props.read.error ? "Couldn't read the deck." : "Reading your efforts…"}</p>}
      </div>
    </div>
    <BatchBar selected={props.state.selected.size} kinds={props.batch.kinds} unc={!card && !!unc} run={props.run} />
    <HintBar hints={props.hints} flash={props.flash} onPalette={props.onPalette} onHelp={props.onHelp} onUndo={props.onUndo} />
    <p role="status" data-deck-announce className="sr-only">{props.announce}</p>
  </div>;
}
