// The effort deck's screen (plan amendments A15 and A17.1, design-directions/
// inventory-calm): the effort strip, one compact bento card with its rows in
// sections by the move they need, a service card's suggestions, the batch
// bar, and the hint bar, plus the bodies of the deck's dialogs. Presentational only:
// data comes in as props, every click goes out through one `run` command, no
// SDK hook is called, and imports stay relative, so static-markup tests can
// render it. Color appears only where the move is yours, and muted.
import { Fragment, type ReactNode, type RefObject } from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import type { BatchItem, Skipped } from "./deck-batch";
import type { SeedProposal } from "./linear-seed";
import { ACTION, KEY_GROUPS, type DeckActionId } from "./deck-keys";
import type { Availability, CardScreen, Chip, DeckLine, NotesScreen, OverviewScreen, PaletteItem, SectionScreen, Strength, SuggestGroup, Tone } from "./deck-view-model";
import { SEND_DELAY_MS } from "./deck-shared";
import { NOTES_MAX } from "./effort-notes";
import { behind as cardsBehind, LAYERS, layerTransform } from "./deck-flip";
import { Icon } from "./components/ui/icon";
import { usePortalScopeProps } from "./lib/portal-scope";
import { cn, POINTER_CURSORS } from "./lib/utils";

/** Everything a click on the deck can ask for; the nav view decides what each does. */
export type DeckCommand =
  | { kind: "action"; id: DeckActionId; line?: DeckLine }
  | { kind: "go"; id: string } | { kind: "view"; view: HeaderTarget }
  | { kind: "select"; prUrl: string; shift: boolean } | { kind: "expand"; prUrl: string } | { kind: "focus"; prUrl: string }
  | { kind: "tile"; key: string } | { kind: "fold"; key: string }
  | { kind: "group"; key: string } | { kind: "undo-group"; key: string } | { kind: "undo-batch"; batchId: string }
  | { kind: "thread"; id: string } | { kind: "jump"; prUrl: string } | { kind: "section"; key: string; prUrl?: string }
  | { kind: "resume"; id: string } | { kind: "reopen"; id: string }
  | { kind: "rule-remove"; id: string } | { kind: "pile"; pile: "hold" | "done" | null }
  /** Take back your confirmation of a PR's review notes. */
  | { kind: "revoke"; prUrl: string }
  /** Show only the rows a header count names, or all again. */
  | { kind: "filter"; filter: "needs" | "blocked" }
  /** The Notes tile's editor: what you typed, save (⌘↵), or cancel (esc). */
  | { kind: "notes-draft"; text: string } | { kind: "notes-save" } | { kind: "notes-cancel" };
export type Run = (command: DeckCommand) => void;

/** The 2px accent ring every control shows on keyboard focus. */
export const RING = "outline-none focus-visible:ring-2 focus-visible:ring-sky-500";
export const TONE: Record<Tone, { text: string; chip: string; edge: string; button: string; bar: string }> = {
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
export const BUTTON = cn("inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-2 text-[12px] disabled:opacity-45 aria-disabled:opacity-45", RING);
export const GHOST = cn("inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-[12px] text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground", RING);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** The spinner a control shows while it works; still under reduced motion. */
export const Spin = () => <span aria-hidden data-spin className="inline-block leading-none motion-safe:animate-spin">↻</span>;
/** A row a batch is planning: it pulses, or dims under reduced motion. */
export const WORKING_ROW = "motion-safe:animate-pulse motion-reduce:opacity-60";

// The list vocabulary the deck shares with All PRs, so the two views read as one.
/** The centered column a view's content and its docked selection bar sit in. */
export const COLUMN = "mx-auto max-w-3xl";
/** That column's scrolling content: its gutters, which widen in a wide pane, and its top and bottom spacing. */
export const CONTENT = cn(COLUMN, "px-2 pb-10 pt-3 @min-[720px]:px-4");
/** A section's heading line, which its colored bar, title, and count sit in. */
export const SECTION_HEAD = "flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/50 bg-background py-1 pl-2 pr-1";
/** A section's count badge; the caller adds its tone. */
export const COUNT = "min-w-[18px] rounded-full px-1.5 text-center text-[11px] tabular-nums";
/** One PR's row: a single line, its height, padding, and type. */
export const ROW = "flex h-[30px] items-center gap-2 pl-2 pr-1.5 text-[12.5px]";
/** A row's checkbox: faint until you point at the row. */
export const CHECKBOX = "size-3.5 shrink-0 accent-sky-600 opacity-50 group-hover:opacity-100 disabled:opacity-20";

/**
 * A PR's repository, muted, and its number, bold, in a fixed column so rows line up. A long repository name truncates first, so the
 * number never does. `strong`: the move is yours. With `onClick`, it's a button.
 */
export function PrRef({ repo, number, strong, className, onClick }: { repo: string; number: string | number; strong?: boolean; className?: string | false;
  onClick?(): void }) {
  const title = `${repo} #${number}`;
  const parts = <><span className="min-w-0 truncate">{repo}</span><b className={cn("shrink-0 font-medium", strong ? "text-foreground" : "text-foreground/80")}>#{number}</b></>;
  const column = cn("flex w-[124px] shrink-0 justify-start gap-1 whitespace-nowrap text-muted-foreground @min-[720px]:w-[156px]", className);
  return onClick ? <button type="button" title={title} onClick={onClick} className={cn(column, "rounded-sm hover:underline", RING)}>{parts}</button>
    : <span title={title} className={column}>{parts}</span>;
}

/**
 * A key badge. On a primary button (`inverted`, which fills with the foreground color) it's a translucent wash of the button's own text
 * color with text in that color, so it never reads as an empty box; elsewhere it's a hairline with muted text. No key draws no badge.
 */
export function Kbd({ children, inverted }: { children?: string | null; inverted?: boolean }) {
  if (!children?.trim()) return null;
  return <kbd className={cn("inline-block min-w-4 rounded border px-1 text-center font-mono text-[10.5px] leading-[14px]",
    inverted ? "border-transparent bg-background/20 text-background" : "border-border text-muted-foreground")}>{children}</kbd>;
}
/** A key's hint as kbds: "] →" reads as two keys for one action. */
export function Keys({ keys, inverted }: { keys: string; inverted?: boolean }) {
  const list = keys.split(" ").filter(Boolean);
  return list.length ? <span className="inline-flex gap-0.5">{list.map((key) => <Kbd key={key} inverted={inverted}>{key}</Kbd>)}</span> : null;
}
const Dot = ({ color, hollow }: { color: string; hollow?: boolean }) => <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", hollow && "border border-dashed")}
  style={hollow ? { borderColor: color } : { background: color }} />;
const Changed = ({ title }: { title: string }) => <span title={title} aria-label={title} className="inline-block size-1.5 shrink-0 rounded-full bg-sky-500" />;

/** A button that names its key: disabled ones stay focusable and say why. */
/** `keyless` drops its badge while its key acts through another control, as a does on a focused row or a selection. */
function ActionButton({ id, on, run, label, tone, primary, line, keyless }: { id: DeckActionId; on: Availability; run: Run; label?: string; tone?: Tone;
  primary?: boolean; line?: DeckLine; keyless?: boolean }) {
  const available = on[id];
  const key = ACTION[id].keys[0];
  return <button type="button" data-deck-focus={`act-${id}`} aria-disabled={available.on ? undefined : true}
    title={available.on ? `${ACTION[id].title}${key ? ` (${key})` : ""}` : `${ACTION[id].title.replace("…", "")}: ${available.why}`}
    onClick={() => { if (available.on) run({ kind: "action", id, line }); }}
    className={cn(BUTTON, primary ? "border-foreground bg-foreground font-medium text-background hover:bg-foreground/90" : tone ? TONE[tone].button : "border-border hover:bg-foreground/[0.06]")}>
    {label ?? ACTION[id].title}<Keys keys={keyless ? "" : key ?? ""} inverted={primary} />
  </button>;
}

// ---------------------------------------------------------------------------
// The strip: the active pile in session order, service cards last, and the piles.
// ---------------------------------------------------------------------------

export type Pile = { id: string; key: string; name: string; note: string; archived?: boolean };
export function Strip({ chips, cur, deck, held, done, pile, run, chipsRef }: { chips: readonly Chip[]; cur: string | null; deck: boolean; held: readonly Pile[];
  done: readonly Pile[]; pile: "hold" | "done" | null; run: Run; chipsRef?: RefObject<HTMLDivElement | null> }) {
  return <nav aria-label="Efforts" className="flex h-11 shrink-0 items-center gap-1.5 border-b border-border/70 px-2.5">
    <button type="button" data-deck-focus="prev" title="Previous effort ([ or ←)" aria-label="Previous effort" onClick={() => run({ kind: "action", id: "prev" })}
      className={cn("size-7 shrink-0 rounded-md border border-border/70 text-[13px] text-muted-foreground hover:text-foreground", RING)}>←</button>
    <div ref={chipsRef} className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto px-0.5 py-1 [scrollbar-width:none]">
      {chips.map((chip) => <button key={chip.id} type="button" data-deck-focus={`chip-${chip.id}`} data-deck-chip={chip.id} aria-current={deck && chip.id === cur ? "true" : undefined}
        title={chip.id === "overview" ? "Overview" : `${chip.name}: ${chip.count} need you${chip.n ? ` (${chip.n})` : ""}`} onClick={() => run({ kind: "go", id: chip.id })}
        className={cn("relative flex h-[30px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border px-2 text-[12px]", RING,
          chip.service && "border-dashed", deck && chip.id === cur ? "border-foreground/30 bg-foreground/[0.08] text-foreground" : "border-border/70 text-muted-foreground hover:text-foreground")}>
        {chip.n ? <span className="font-mono text-[10.5px] text-muted-foreground/80">{chip.n}</span> : null}
        {chip.id === "overview" ? null : <Dot color={chip.color} hollow={chip.service} />}
        <span className="max-w-[150px] truncate">{chip.name}</span>
        {chip.id === "overview" ? null : <span className={cn("min-w-[18px] rounded-full px-1.5 text-center text-[11px] font-semibold tabular-nums", chip.count ? TONE.amber.chip : "font-normal text-muted-foreground")}>
          {chip.count}</span>}
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
            : item.archived ? <span className="text-[11px] text-muted-foreground" title="Restore it from Efforts admin first">Archived</span>
            : <button type="button" onClick={() => run({ kind: "reopen", id: item.id })} className={cn(BUTTON, "border-border")}>Reopen</button>}
          <span className="col-span-2 truncate text-[11px] text-muted-foreground">{item.note}</span>
        </div>) : <p className="px-1 text-muted-foreground">Empty.</p>}
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  </PopoverPrimitive.Root>;
}

/** A pile's tiny stack, drawn like the deck's: three cards, each one behind a little further right and smaller. An empty pile is an outline. */
function PileCards({ empty }: { empty: boolean }) {
  return <span aria-hidden data-deck-pile-cards={empty ? "empty" : "stacked"} className="relative inline-block h-[13px] w-3.5 shrink-0">
    {empty ? <i className="absolute left-0 top-0 h-[13px] w-2.5 rounded-[2.5px] border border-dashed border-border" />
      : [2, 1, 0].map((depth) => <i key={depth} className="absolute left-0 top-0 h-[13px] w-2.5 origin-right rounded-[2.5px] border"
        style={{ transform: `translateX(${depth * 2}px) scale(${1 - depth * 0.1})`, background: `color-mix(in srgb, var(--background) ${100 - 6 * depth}%, #000)`,
          borderColor: `color-mix(in srgb, var(--foreground) ${34 - 9 * depth}%, transparent)` }} />)}
  </span>;
}

// ---------------------------------------------------------------------------
// The stack: the card shown on top, and the next few in the ring peeking out to its right.
// ---------------------------------------------------------------------------

/**
 * The deck as a stack of cards: the one shown on top, over the next few a flip forward reaches, each further right, smaller, and darker, as
 * → and ] move, with the next one's name up its edge, which flips to it. The deepest edge's room is a gutter on the right, inside the deck's
 * width. A flip draws the card it takes away in the ghost, over or under the top one (deck-flip.ts); the ghost is otherwise empty. It's
 * clipped at the top card's bottom edge, so a taller card taken away never hangs over the rows below, while its slide and tilt still show
 * above and to the sides.
 */
function Stack({ behind, run, children }: { behind: readonly Chip[]; run: Run; children: ReactNode }) {
  return <div className="mb-2.5" style={{ paddingRight: LAYERS[behind.length]!.x }}>
    <div data-deck-stack className="relative isolate">
      {behind.map((chip, index) => { const depth = index + 1; return <div key={chip.id} data-deck-layer={depth} aria-hidden={depth > 1 || undefined}
        className="absolute inset-0 origin-right rounded-[14px] border shadow-[0_1px_2px_rgb(0_0_0/0.08),0_4px_12px_-8px_rgb(0_0_0/0.35)]"
        style={{ zIndex: 4 - depth, transform: layerTransform(depth), background: `color-mix(in srgb, var(--background) ${100 - 4 * depth}%, #000)`,
          borderColor: `color-mix(in srgb, var(--foreground) ${14 - 3 * depth}%, transparent)` }}>
        {depth === 1 ? <button type="button" tabIndex={-1} data-deck-peek={chip.id} onClick={() => run({ kind: "action", id: "next" })} title={`Next: ${chip.name} (] or →)`}
          aria-label={`Next effort: ${chip.name}`} style={{ width: LAYERS[1].x }}
          className="absolute inset-y-0 right-0 flex flex-col items-center gap-1.5 rounded-r-[14px] py-4 text-[11px] leading-none text-muted-foreground hover:text-foreground">
          {chip.id === "overview" ? null : <Dot color={chip.color} hollow={chip.service} />}<span className="min-h-0 truncate [writing-mode:vertical-rl]">{chip.name}</span></button> : null}
      </div>; })}
      <div data-deck-top className="relative z-[5] origin-right rounded-[14px] bg-background shadow-[0_1px_2px_rgb(0_0_0/0.2),0_8px_22px_-10px_rgb(0_0_0/0.6)]">{children}</div>
      <div data-deck-ghost aria-hidden className="pointer-events-none absolute inset-0" style={{ clipPath: "inset(-60px -60px 0 -60px)" }} />
    </div>
  </div>;
}

// ---------------------------------------------------------------------------
// Rows: one line each.
// ---------------------------------------------------------------------------

export type RowState = { selected: ReadonlySet<string>; expanded: ReadonlySet<string>; focus: string | null;
  /** Rows whose Refresh is reading GitHub now, until the read that carries it lands; and what each Refresh got: Read just now, or why it failed. */
  refreshing?: ReadonlySet<string>; reads?: ReadonlyMap<string, { text: string; ok: boolean }>;
  /** Rows a batch button is planning now, until its plan answers. */
  working?: ReadonlySet<string> };
/** What a narrow pane drops from a row, as the mock does below 720 px: who approved a merge, the suggested reviewer, and "draft". */
const OPTIONAL_INFO = new Set(["merge", "request", "ready"]);

/** Refresh on a row: ↻ on the row you point at or focus, which spins while GitHub reads it, and stays in sight until the row updates. */
function RefreshControl({ line, busy, run }: { line: DeckLine; busy: boolean; run: Run }) {
  return <button type="button" tabIndex={-1} data-deck-refresh={busy ? "busy" : "idle"} aria-busy={busy || undefined}
    aria-label={busy ? `Reading ${line.ref} from GitHub` : `Refresh ${line.ref} from GitHub`} title={busy ? "Reading GitHub now…" : "Refresh from GitHub"}
    onClick={() => { if (!busy) run({ kind: "action", id: "refresh", line }); }}
    className={cn("inline-flex size-5 shrink-0 items-center justify-center rounded text-[12px] text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground", RING,
      busy ? "text-sky-700 dark:text-sky-300" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100")}>
    <span aria-hidden className={cn("inline-block leading-none", busy && "motion-safe:animate-spin")}>↻</span></button>;
}

/** `leaves`: the row is in an effort, other than One-offs, so it can move to One-offs from its details. */
function Row({ line, state, run, first, leaves }: { line: DeckLine; state: RowState; run: Run; first: boolean; leaves?: boolean }) {
  const open = state.expanded.has(line.prUrl);
  const selected = state.selected.has(line.prUrl);
  const busy = state.refreshing?.has(line.prUrl) ?? false;
  const working = state.working?.has(line.prUrl) ?? false;
  const read = state.reads?.get(line.prUrl);
  const trail = line.trail;
  return <div className={cn("ml-7", open && "rounded-md bg-foreground/[0.035]")}>
    <div data-deck-row={line.prUrl} data-deck-section={line.section} data-deck-dim={line.dim || undefined} data-deck-dot={line.dot ? true : undefined}
      data-deck-working={working || undefined} aria-busy={working || undefined} tabIndex={state.focus === line.prUrl || (state.focus === null && first) ? 0 : -1}
      aria-label={`${line.ref} ${line.title}${line.dim ? ", settled on Mark seen" : ""}`} onFocus={() => run({ kind: "focus", prUrl: line.prUrl })}
      className={cn("group relative scroll-mt-20 rounded-md hover:bg-foreground/[0.03]", ROW, open && "rounded-b-none",
        "outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-500", selected && "bg-sky-500/[0.07]", state.focus === line.prUrl && "bg-foreground/[0.05]", working && WORKING_ROW)}>
      {line.needs ? <span aria-hidden className={cn("absolute bottom-[7px] left-0 top-[7px] w-0.5 rounded-full", TONE[line.tone].edge)} /> : null}
      <input type="checkbox" tabIndex={-1} checked={selected} disabled={line.dim} aria-label={`Select ${line.ref}`}
        onChange={() => undefined} onClick={(event) => run({ kind: "select", prUrl: line.prUrl, shift: event.shiftKey })} className={CHECKBOX} />
      <span className="flex w-1.5 shrink-0">{line.dot ? <Changed title={line.dot} /> : null}</span>
      <PrRef repo={line.ref.replace(/ #\d+$/u, "")} number={line.ref.split("#")[1]!} strong={line.needs} className={line.dim && "opacity-50"} />
      <span onClick={() => run({ kind: "expand", prUrl: line.prUrl })} title={line.title}
        className={cn("min-w-16 flex-1 cursor-pointer truncate @min-[900px]:min-w-0", line.needs ? "text-foreground" : "text-foreground/80", line.dim && "opacity-50", line.ghost && "line-through")}>
        {line.stacked ? <span className="mr-1 text-muted-foreground" title={`Stacked on ${line.stacked}`}>↳</span> : null}{line.title}</span>
      {read ? <span role="status" data-deck-read={read.ok ? "ok" : "failed"} title={read.text} className={cn("min-w-0 max-w-56 truncate whitespace-nowrap text-[11px]",
        read.ok ? "text-muted-foreground" : "text-destructive")}>{read.text}</span>
        : line.checked ? <span title={line.checked.title} className={cn("shrink-0 whitespace-nowrap text-[11px]",
        line.checked.failed ? "text-destructive" : "hidden text-muted-foreground @min-[720px]:inline")}>{line.checked.text}</span> : null}
      {line.signals.map((signal) => <span key={signal} className={cn("hidden shrink-0 rounded px-1.5 text-[11px] @min-[720px]:inline", TONE.gray.chip)}>{signal}</span>)}
      {line.info ? <span title={line.info.text} data-deck-change={line.change ? true : undefined} className={cn("min-w-0 truncate text-[11.5px]",
        OPTIONAL_INFO.has(line.section) && !line.change && "hidden @min-[720px]:inline",
        line.info.tone ? cn("rounded px-1.5 leading-[19px]", TONE[line.dim ? "gray" : line.info.tone].chip)
        // What a read changed is the one thing on a settling row that stays at full strength.
        : line.change ? "rounded px-1 leading-[19px] text-foreground/80" : "text-muted-foreground", line.dim && !line.change && "opacity-50")}>{line.info.text}</span> : null}
      <span className={cn("w-7 shrink-0 text-right text-[11px] tabular-nums", line.hot ? TONE.amber.text : "text-muted-foreground")}>{line.age ?? ""}</span>
      {/* Release stays in sight on Held's few rows; Advance and Notes… show on the row you point at or focus. Only the focused row's badge
          shows, and none while a selection takes the key: then its key acts on that row alone, which the hint bar names. */}
      {line.inline ? <button type="button" tabIndex={-1} data-deck-inline={line.inline.id} title={line.inline.title}
        onClick={() => run({ kind: "action", id: line.inline!.id, line })}
        className={cn(BUTTON, "h-5 border-border px-1.5 text-[11.5px] hover:bg-foreground/[0.06]",
          line.inline.id !== "release" && "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100")}>{line.inline.label}
        {state.selected.size ? null : <span className="hidden group-focus-within:inline-flex"><Kbd>{ACTION[line.inline.id].keys[0]}</Kbd></span>}</button>
        : null}
      {line.to ? <button type="button" tabIndex={-1} data-deck-to={line.to.key} onClick={() => run({ kind: "section", key: line.to!.key, prUrl: line.prUrl })}
        title={`It moves to ${line.to.title} on Mark seen. Show where.`}
        className={cn("shrink-0 whitespace-nowrap rounded px-1 text-[11.5px] text-sky-700 hover:underline dark:text-sky-300", RING)}>
        → moved to {line.to.title} {line.to.up ? "↑" : "↓"}</button> : null}
      {line.row ? <RefreshControl line={line} busy={busy} run={run} /> : null}
      <span className="flex min-w-12 items-center justify-end gap-1 text-[11.5px]">
        {trail?.kind === "acted" ? <>
          <span data-deck-trail={trail.busy ? "busy" : undefined} className={cn("inline-flex max-w-44 items-center gap-1 truncate", trail.failed ? "text-destructive" : "text-muted-foreground")}
            title={trail.title ?? trail.text}>{trail.busy ? <Spin /> : null}{trail.text}</span>
          {trail.undo ? <button type="button" data-deck-focus={`undo-${line.prUrl}`} onClick={() => run({ kind: "undo-batch", batchId: trail.undo! })}
            className={cn("rounded px-1 text-sky-700 hover:underline dark:text-sky-300", RING)}>Undo</button> : null}
        </> : trail?.kind === "thread" ? <button type="button" tabIndex={-1} onClick={() => run({ kind: "thread", id: trail.threadId })} title={`Open "${trail.text}" (o)`}
          aria-label={`Open ${trail.text}`} className={cn("max-w-40 truncate rounded px-1 text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground", RING)}>
          {/* A narrow pane keeps the title's room: the thread shows as ↗, named in its tooltip. */}
          <span className="hidden @min-[720px]:inline">{trail.text} </span>↗</button>
        : trail ? <span data-deck-fate className="max-w-44 truncate rounded text-muted-foreground" title={line.dot ?? undefined}>{trail.text}</span> : null}
        {open || !trail ? <button type="button" tabIndex={-1} aria-expanded={open} onClick={() => run({ kind: "expand", prUrl: line.prUrl })}
          className={cn("shrink-0 rounded px-1 text-muted-foreground hover:text-foreground", !open && "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100", RING)}>{open ? "Less" : "More"}</button> : null}
      </span>
    </div>
    {open ? <Details line={line} run={run} busy={busy} leaves={leaves} /> : null}
  </div>;
}

/** A row's details: what it waits on, its reviewers and tickets, and every action it can take, each with its key. */
function Details({ line, run, busy, leaves }: { line: DeckLine; run: Run; busy: boolean; leaves?: boolean }) {
  const row = line.row;
  if (!row) return <p className="mb-1.5 ml-9 text-[12px] text-muted-foreground">Left this view since you looked. Mark seen clears it.</p>;
  const move = SECTION_ACTION[line.section];
  const facts: [string, string][] = [
    ["Status", row.status], ["Next", row.waitsOn ? `${row.waitsOn.what} · waits on ${row.waitsOn.on}` : row.step ? `${row.step.text} · ${row.step.owner}` : "—"],
    ["Reviewers", row.reviewers.length ? row.reviewers.map((review) => `@${review.login} ${review.state === "requested" ? "asked" : review.state}`).join(", ") : "nobody asked"],
    ["Tickets", row.tickets.join(", ") || "none"],
    ...row.hold ? [["Held", row.hold.reason || "no reason given"] as [string, string]] : [],
    ["Checked", row.failed ? "last read failed" : row.checkedAt ? new Date(row.checkedAt).toLocaleString() : "not yet"],
  ];
  return <div data-deck-details={line.prUrl} className="mb-1.5 ml-9 mr-1.5 grid gap-1.5 border-t border-border/50 px-2 py-1.5 text-[12px]">
    <dl className="grid grid-cols-[76px_minmax(0,1fr)] gap-x-3 gap-y-0.5">
      {facts.map(([label, value]) => <div key={label} className="contents"><dt className="text-[11px] text-muted-foreground">{label}</dt><dd className="min-w-0 break-words">{value}</dd></div>)}
    </dl>
    <div className="flex flex-wrap gap-1.5">
      {move && line.needs ? <button type="button" onClick={() => run({ kind: "action", id: move, line })} className={cn(BUTTON, TONE[line.tone].button)}>
        {ACTION[move].title}<Kbd>{ACTION[move].keys[0]}</Kbd></button> : null}
      {row.thread ? <button type="button" onClick={() => run({ kind: "thread", id: row.thread!.id })} className={cn(BUTTON, "border-border")}>Open “{row.thread.title}”<Kbd>o</Kbd></button> : null}
      <button type="button" onClick={() => run({ kind: "action", id: "open-pr", line })} className={GHOST}>Open on GitHub ↗</button>
      <button type="button" onClick={() => run({ kind: "action", id: "hold-pr", line })} className={GHOST}>{row.hold ? "Release…" : "Hold PR…"}</button>
      {leaves && !line.dim ? <button type="button" data-deck-one-off onClick={() => run({ kind: "action", id: "one-off", line })} className={GHOST}
        title="Moves it out of this effort; Undo puts it back">Move to One-offs</button> : null}
      {row.confirmation ? <button type="button" data-deck-revoke onClick={() => run({ kind: "revoke", prUrl: line.prUrl })} className={GHOST}
        title="Its review notes need you again before it merges">Revoke confirmation</button> : null}
      <button type="button" aria-busy={busy || undefined} disabled={busy} onClick={() => run({ kind: "action", id: "refresh", line })} className={GHOST}>
        {busy ? <><Spin />Refreshing…</> : "Refresh"}</button>
    </div>
  </div>;
}
const SECTION_ACTION: Partial<Record<string, DeckActionId>> = { merge: "merge", confirm: "confirm", nudge: "nudge", request: "request", ready: "ready", work: "fix" };

function Section({ section, state, run, open, stuck, held, leaves }: { section: SectionScreen; state: RowState; run: Run; open: boolean; stuck: boolean; held: boolean;
  leaves: boolean }) {
  const { meta } = section;
  const folded = meta.fold && !open;
  const header = <>
    <span aria-hidden className={cn("h-3.5 w-[3px] shrink-0 rounded-full", TONE[meta.tone].edge)} />
    {meta.fold ? <span aria-hidden className={cn("text-[10px] text-muted-foreground transition-transform motion-reduce:transition-none", !folded && "rotate-90")}>▶</span> : null}
    <h2 className={cn("truncate text-[12.5px]", meta.fold ? "font-medium text-muted-foreground" : "font-semibold")}>{meta.title}</h2>
    <span className={cn(COUNT, section.count ? cn("font-semibold", TONE[meta.tone].chip) : "text-muted-foreground")}>
      {meta.fold || meta.tone === "gray" ? section.lines.filter((line) => !line.dim).length : section.count}</span>
    <span title={meta.help} aria-label={meta.help} className="size-4 shrink-0 rounded-full border border-border text-center text-[10px] leading-[14px] text-muted-foreground">?</span>
    {section.changed ? <span className="inline-flex items-center gap-1 text-[11.5px] text-sky-700 dark:text-sky-300"><Changed title="Changed since you looked" />{section.changed} changed</span> : null}
  </>;
  return <section data-deck-sec={section.key} className="mt-0.5 scroll-mt-10">
    <div className={cn("sticky z-[4]", SECTION_HEAD, stuck ? "top-[34px]" : "top-0")}>
      {meta.fold ? <button type="button" data-deck-focus={`fold-${section.key}`} aria-expanded={!folded} onClick={() => run({ kind: "fold", key: section.key })}
        className={cn("flex min-w-0 items-center gap-2 rounded", RING)}>{header}</button> : header}
      <span className="flex-1" />
      {section.action && (!held || section.key === "held") ? <button type="button" data-deck-focus={`sec-${section.key}`} aria-disabled={section.action.enabled ? undefined : true}
        title={section.action.enabled ? `Acts on this section's ${plural(section.action.count, "PR")}; the ${section.key === "merge" ? "preview" : "confirm"} lists each one`
          : section.action.why ?? undefined}
        onClick={() => { if (section.action!.enabled) run({ kind: "action", id: section.action!.id }); }}
        className={cn(BUTTON, TONE[meta.tone].button)}>{section.action.label}<Kbd>{section.action.key}</Kbd></button> : null}
    </div>
    {folded ? null : <div className="pb-1.5 pt-0.5">{section.lines.map((line, index) => <Row key={line.prUrl} line={line} state={state} run={run} first={index === 0}
      leaves={leaves} />)}
      {section.arriving.map((item) => <button key={item.prUrl} type="button" tabIndex={-1} data-deck-arrive={item.prUrl} onClick={() => run({ kind: "jump", prUrl: item.prUrl })}
        title={`Show ${item.ref} where it is now`} className={cn("flex h-[26px] w-full items-center gap-2 rounded-md border border-dashed border-border/70 pl-[62px] pr-2 text-left text-[11.5px] text-muted-foreground hover:text-foreground", RING)}>
        <b className="font-medium">{item.ref}</b> lands here on Mark seen</button>)}</div>}
  </section>;
}

// ---------------------------------------------------------------------------
// The effort card: a header and a bento of tiles, each with more on expand.
// ---------------------------------------------------------------------------

/** `more` is "narrow" when only a card under 700 px hides some of the tile. `action` sits before More. */
function Tile({ id, title, note, open, more, run, className, action, children }: { id: string; title: string; note?: ReactNode; open: boolean; more: boolean | "narrow";
  run: Run; className?: string; action?: ReactNode; children?: ReactNode }) {
  return <div data-deck-tile={id} className={cn("min-w-0 rounded-[10px] border border-border/50 bg-foreground/[0.015] px-3 py-2", className)}>
    <div className="mb-1.5 flex min-h-5 items-center gap-2">
      <span className="shrink-0 text-[10.5px] uppercase tracking-wide text-muted-foreground">{title}</span>
      {note ? <span className="min-w-0 truncate text-[11px] text-muted-foreground">{note}</span> : null}
      <span className="flex-1" />
      {action}
      {more ? <button type="button" data-deck-focus={`tile-${id}`} aria-expanded={open} onClick={() => run({ kind: "tile", key: id })} title="More or less (i toggles every tile)"
        className={cn("rounded px-1 text-[11px] text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground", RING, more === "narrow" && "@min-[700px]:hidden")}>
        {open ? "Less" : "More"}</button> : null}
    </div>
    {children}
  </div>;
}

/**
 * The status line. "N need you" and "N blocked" show only those rows, and again show all; `filter` is the one showing alone. `bar`: the
 * card's sticky one-line bar, whose copies take no focus id of their own.
 */
function Counts({ screen, filter, run, bar }: { screen: CardScreen; filter?: "needs" | "blocked" | null; run: Run; bar?: boolean }) {
  const tone = TONE[screen.status.tone].text;
  if (!screen.counts.length) return <span className={cn("shrink-0 text-[11.5px] font-medium", tone)}>{screen.status.text}</span>;
  return <span data-deck-counts className={cn("inline-flex shrink-0 items-center gap-1 text-[11.5px] font-medium", tone)}>
    {screen.counts.map((part, index) => <Fragment key={part.key}>{index ? <span aria-hidden>·</span> : null}
      {part.key === "needs" || part.key === "blocked" ? <button type="button" data-deck-focus={bar ? undefined : `count-${part.key}`} aria-pressed={filter === part.key}
        title={filter === part.key ? "Show all rows (esc)" : `Show only these ${part.n}`} onClick={() => run({ kind: "filter", filter: part.key as "needs" | "blocked" })}
        className={cn("rounded px-0.5 underline decoration-dotted underline-offset-2 hover:decoration-solid", RING, filter === part.key && "bg-foreground/[0.08] decoration-solid")}>
        {part.text}</button> : <span>{part.text}</span>}</Fragment>)}
  </span>;
}

/** The Notes tile's editor while it's open: what you typed, the revision it edits, and a save that's running or was refused. */
export type NotesEdit = { draft: string; busy: boolean; error: string | null };

/** Editing notes in place: Markdown in a plain field, ⌘↵ saves, esc cancels. */
function NotesEditor({ edit, run }: { edit: NotesEdit; run: Run }) {
  return <div className="grid gap-1.5">
    <textarea data-deck-notes-editor autoFocus value={edit.draft} maxLength={NOTES_MAX} rows={Math.min(14, Math.max(4, edit.draft.split("\n").length + 1))}
      aria-label="Notes, in Markdown" placeholder="Flags, experiments, anything else. Markdown works." spellCheck
      onChange={(event) => run({ kind: "notes-draft", text: event.target.value })}
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); run({ kind: "notes-save" }); }
        else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); run({ kind: "notes-cancel" }); }
      }}
      className="w-full resize-y rounded-md border border-input bg-background px-2 py-1.5 font-mono text-[12px] leading-[18px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-sky-500" />
    {edit.error ? <p role="alert" className="text-[12px] text-destructive">{edit.error}</p> : null}
    <div className="flex items-center justify-end gap-2">
      <span className="mr-auto text-[11px] text-muted-foreground">Markdown</span>
      <button type="button" onClick={() => run({ kind: "notes-cancel" })} className={cn(BUTTON, "border-border")}>Cancel<Kbd>esc</Kbd></button>
      <button type="button" data-deck-notes-save disabled={edit.busy} onClick={() => run({ kind: "notes-save" })}
        className={cn(BUTTON, "border-foreground bg-foreground font-medium text-background hover:bg-foreground/90")}>{edit.busy ? "Saving…" : "Save"}<Kbd inverted>⌘↵</Kbd></button>
    </div>
  </div>;
}

/**
 * An effort's notes: collapsed, their first line; More renders them all with `markdown` (bb's Markdown in the panel); Edit, or ⇧N, edits
 * them in place.
 */
function NotesTile({ notes, edit, open, run, markdown }: { notes: NonNullable<CardScreen["notes"]>; edit: NotesEdit | null; open: boolean; run: Run;
  markdown?: (body: string) => ReactNode }) {
  const key = ACTION.notes.keys[0];
  return <Tile id="notes" title="Notes" open={open} more={!!notes.body && !edit} run={run} className="col-span-6 @min-[900px]:col-span-12"
    note={edit || open ? undefined : <span data-deck-notes-first className={notes.first ? "text-foreground/80" : undefined}>{notes.first || "None yet."}</span>}
    action={edit ? null : <button type="button" data-deck-focus="notes-edit" onClick={() => run({ kind: "action", id: "notes" })} title={`Edit the notes (${key})`}
      className={cn("inline-flex items-center gap-1 rounded px-1 text-[11px] text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground", RING)}>
      Edit<Kbd>{key}</Kbd></button>}>
    {edit ? <NotesEditor edit={edit} run={run} />
      : open && notes.body ? <div data-deck-notes-body className="min-w-0 text-[12.5px]">{markdown ? markdown(notes.body)
        : <p className="whitespace-pre-wrap break-words">{notes.body}</p>}</div> : null}
  </Tile>;
}

/**
 * `keyless` drops its Advance's badge while a acts on a focused row or a selection. `notes` is the Notes editor while it's open on this
 * card, and `markdown` renders notes; without it they show as plain text.
 */
export function Card({ screen, tiles, run, on, keyless, notes, markdown, filter }: { screen: CardScreen; tiles: ReadonlySet<string>; run: Run; on: Availability;
  keyless?: boolean; notes?: NotesEdit | null; markdown?: (body: string) => ReactNode; filter?: "needs" | "blocked" | null }) {
  const { card } = screen;
  const held = card.pile === "held";
  const service = card.kind === "service";
  // A service card with only threads, and Loose threads, have nothing but their threads to show.
  const bare = card.kind !== "effort" && card.stats.open === 0;
  const open = (id: string) => tiles.has(id);
  // Three waits, or two on a card under 700 px wide.
  const blocked = open("blocked") ? screen.blocked : screen.blocked.slice(0, 3);
  const shown = bare ? 6 : 3;
  const threads = open("threads") ? screen.threads : screen.threads.slice(0, shown);
  const total = screen.stats.bar.reduce((sum, item) => sum + item.count, 0) || 1;
  const { linear } = screen;
  const linearLine = linear.chips.length > 0 || linear.bar.length > 0;
  const ticketStates = `Tickets: ${linear.bar.map((state) => `${state.count} ${state.name}`).join(" · ")}`;
  const threadsTile = <Tile id="threads" title="Threads" note={screen.threads.length || undefined} open={open("threads")} more={screen.threads.length > shown} run={run}
    className={bare ? "col-span-6 @min-[900px]:col-span-12" : "col-span-6 @min-[900px]:row-span-3"}>
    {threads.length ? <div className="-mx-1 grid">{threads.map((thread) => <button key={thread.id} type="button" onClick={() => run({ kind: "thread", id: thread.id })}
      title={`Open "${thread.title}"`} className={cn("grid min-h-6 grid-cols-[10px_minmax(0,1fr)_auto_28px] items-center gap-2 rounded px-1 text-left text-[12px] hover:bg-foreground/[0.04]", RING)}>
      <span aria-hidden className={cn("size-2 rounded-full", thread.status === "active" ? "bg-sky-500/70 motion-safe:animate-pulse" : "bg-muted-foreground/40")} />
      <span className="truncate">{thread.dot ? <><Changed title="Changed since you looked" /> </> : null}{thread.title}<small className="ml-1.5 text-[11px] text-muted-foreground">{thread.ref}</small></span>
      <span className="text-[11px] text-muted-foreground">{thread.status}</span><span className="text-right text-[11px] text-muted-foreground">{thread.age ?? ""}</span>
    </button>)}</div> : <p className="text-[12px] text-muted-foreground">No threads yet.</p>}
  </Tile>;
  return <section data-deck-card={card.id} aria-label={card.name} className="@container relative rounded-[14px] border border-border/70 bg-foreground/[0.012] p-3"
    style={{ backgroundImage: `linear-gradient(180deg, color-mix(in srgb, ${screen.color} 6%, transparent) 0, transparent 110px)` }}>
    <span aria-hidden className="absolute -top-px left-4 right-4 h-0.5 rounded-full" style={{ background: `color-mix(in srgb, ${screen.color} 50%, transparent)` }} />
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-0.5">
      <div className="min-w-0 flex-[1_1_300px]">
        <div className="flex min-w-0 items-center gap-2">
          <h1 tabIndex={-1} data-deck-focus="heading" className="flex min-w-0 items-center gap-2 rounded text-[17px] font-semibold leading-6 tracking-tight outline-none">
            <Dot color={screen.color} hollow={card.kind !== "effort"} /><span className="truncate">{card.name}</span>
          </h1>
          <Counts screen={screen} filter={filter} run={run} />
          {/* Held PRs are one press away on every card: the chip jumps to its Held section. */}
          {screen.held ? <button type="button" data-deck-focus="held" onClick={() => run({ kind: "action", id: "held" })} title={`Go to the held PRs (${ACTION.held.keys[0]})`}
            className={cn(BUTTON, "h-5 border-border px-1.5 text-[11.5px] text-muted-foreground hover:text-foreground")}>Held · {screen.held}<Kbd>{ACTION.held.keys[0]}</Kbd></button>
            : null}
        </div>
        <p className="truncate text-[12px] text-muted-foreground" title={card.goal}>{card.goal || "No goal written yet."}{held && card.reason ? ` · held: ${card.reason}` : ""}</p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {held ? <button type="button" onClick={() => run({ kind: "resume", id: card.id })} className={cn(BUTTON, "border-foreground bg-foreground text-background")}>Resume</button>
          : bare ? null : <>
          <ActionButton id="advance" on={on} run={run} primary label={`Advance${screen.advance.length ? ` · ${screen.advance.length}` : ""}`} keyless={keyless} />
          {service ? <ActionButton id="promote" on={on} run={run} label="Promote to effort…" />
            : card.oneOff ? null : <><ActionButton id="hold" on={on} run={run} label="Hold" /><ActionButton id="complete" on={on} run={run} label="Complete" /></>}
        </>}
      </div>
    </div>
    {bare ? <div className="mt-2.5 grid grid-cols-6 gap-3 @min-[900px]:grid-cols-12">{threadsTile}</div> : <div className="mt-2.5 grid grid-cols-6 gap-3 @min-[900px]:grid-cols-12">
      <Tile id="next" title="Next steps" open={open("next")} more={false} run={run} className="col-span-6 @min-[700px]:col-span-3 @min-[900px]:col-span-5">
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
      {screen.notes ? <NotesTile notes={screen.notes} edit={notes ?? null} open={open("notes")} run={run} markdown={markdown} /> : null}
      {threadsTile}
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
    </div>}
  </section>;
}

/** Above the rows while a header count shows them alone: what shows, how many, and Show all. */
function FilterLine({ kind, n, run }: { kind: "needs" | "blocked"; n: number; run: Run }) {
  return <div data-deck-filter={kind} className="flex min-h-8 items-center gap-2 pl-2 pr-1 text-[12px] text-muted-foreground">
    <span>Only {kind === "needs" ? "what needs you" : "what's blocked"} · {n}</span><span className="flex-1" />
    <button type="button" data-deck-focus="show-all" onClick={() => run({ kind: "filter", filter: kind })} className={GHOST}>Show all<Kbd>esc</Kbd></button>
  </div>;
}

/** The one-line card header that stays once the card's own header scrolls away; `counts` stands in for its status line. */
export function CardBar({ name, color, status, counts, advance, hollow }: { name: string; color: string; status?: { text: string; tone: Tone }; counts?: ReactNode;
  advance?: ReactNode; hollow?: boolean }) {
  return <div className="sticky top-0 z-[6] -mb-[34px] h-[34px] border-b border-border/70 bg-background">
    <div className={cn(COLUMN, "flex h-full items-center gap-2 px-4")}>
      <Dot color={color} hollow={hollow} /><b className="truncate text-[13px] font-semibold">{name}</b>
      {counts ?? (status ? <span className={cn("shrink-0 text-[11.5px]", TONE[status.tone].text)}>{status.text}</span> : null)}
      <span className="flex-1" />{advance}
    </div>
  </div>;
}

export function CardSections({ screen, state, run, open, stuck }: { screen: CardScreen; state: RowState; run: Run; open: ReadonlySet<string>; stuck: boolean }) {
  const leaves = screen.card.kind === "effort" && !screen.card.oneOff;
  return screen.sections.length ? <>{screen.sections.map((section) => <Section key={section.key} section={section} state={state} run={run} open={open.has(section.key)}
    stuck={stuck} held={screen.card.pile !== "active"} leaves={leaves} />)}</> : <p className="py-8 text-center text-[12px] text-muted-foreground">
    {screen.card.kind === "loose" ? "Set each thread's effort from the chip above its composer." : screen.card.kind === "service" ? "No open PRs here."
      : "No open PRs in this effort."}</p>;
}

// ---------------------------------------------------------------------------
// A service card's suggestions: where each group of its PRs could go, with one button each, and the standing rules.
// ---------------------------------------------------------------------------

export type RuleItem = { id: string; text: string };
const STRENGTH_DOTS: Record<Strength, number> = { weak: 1, moderate: 2, strong: 3 };
/** The refs a suggestion line names before it says how many more. */
const REFS = 4;
function Suggestion({ group, run }: { group: SuggestGroup; run: Run }) {
  const bar = <span aria-hidden className="h-3.5 w-[3px] shrink-0 rounded-full" style={{ background: group.color }} />;
  if (group.accepted) return <div data-deck-sec={group.key} className="flex min-h-8 items-center gap-2 py-0.5 pl-1 pr-1 text-[12.5px]">
    {bar}<span className={TONE.green.text}>✓</span><span className="truncate">{group.accepted.text}</span><span className="flex-1" />
    <button type="button" data-deck-focus={`undo-group-${group.key}`} onClick={() => run({ kind: "undo-group", key: group.key })}
      className={cn("rounded px-1 text-[11.5px] text-sky-700 hover:underline dark:text-sky-300", RING)}>Undo</button>
  </div>;
  const target = group.target;
  const live = group.button.count > 0;
  const detail = group.signals.length ? group.signals.join(" · ") : group.reason;
  const more = group.lines.length - REFS;
  return <div data-deck-sec={group.key} className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1 py-0.5 pl-1 pr-1">
    {bar}
    {target ? <span className="text-[12px] text-muted-foreground">→{target.kind === "new" ? " new" : ""}</span> : null}
    {target ? <Dot color={group.color} /> : null}
    <h3 className={cn("truncate text-[12.5px]", target ? "font-semibold" : "font-medium text-muted-foreground")}>{group.title}</h3>
    {group.strength ? <span data-deck-strength={group.strength} title={`${group.strength} signals`}
      className={cn("inline-flex shrink-0 items-center gap-0.5 text-[11.5px]", group.strength === "weak" ? TONE.amber.text : "text-muted-foreground")}>
      {[1, 2, 3].map((dot) => <i key={dot} aria-hidden className={cn("inline-block size-1 rounded-full", dot <= STRENGTH_DOTS[group.strength!] ? "bg-current" : "bg-border")} />)}
      <span className="ml-1 capitalize">{group.strength}</span></span> : null}
    {/* What it rests on, before you accept it: the specific signals, or why there are none. */}
    <span data-deck-signals className="min-w-0 flex-[1_1_160px] truncate text-[11.5px] text-muted-foreground" title={detail}>{detail}</span>
    <span className="flex shrink-0 gap-1">{group.lines.slice(0, REFS).map((line) => <button key={line.prUrl} type="button" tabIndex={-1} title={`Show ${line.ref}: ${line.title}`}
      onClick={() => run({ kind: "jump", prUrl: line.prUrl })} className={cn("rounded px-1 text-[11.5px] text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground", RING)}>
      {line.ref}</button>)}{more > 0 ? <span className="text-[11.5px] text-muted-foreground">+{more}</span> : null}</span>
    <button type="button" data-deck-focus={`group-${group.key}`} aria-disabled={live ? undefined : true} onClick={() => { if (live) run({ kind: "group", key: group.key }); }}
      title={group.button.kind === "pick" ? "Pick an effort for each PR (e)" : group.button.confirm ? "Weak signals: lists each PR and its signals before it moves them"
        : "Moves nothing until you press it; Undo takes it back"}
      className={cn(BUTTON, "border-border hover:bg-foreground/[0.06]")}>{group.button.label}<Kbd>{group.button.kind === "pick" ? "e" : "p"}</Kbd></button>
  </div>;
}

/** Above a service card's rows: its suggestions, Seed from Linear, and the standing rules, which place new PRs on every read. */
export function Suggestions({ screen, rules, run }: { screen: CardScreen; rules: readonly RuleItem[]; run: Run }) {
  return <section aria-label="Suggestions" data-deck-suggest className="mb-1.5 rounded-[10px] border border-border/50 px-1.5 pb-1 pt-0.5">
    <div className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1 pl-1">
      <h2 className="text-[10.5px] uppercase tracking-wide text-muted-foreground">Suggestions</h2>
      <span className="text-[11.5px] text-muted-foreground">Nothing moves until you press it.</span>
      <span className="flex-1" />
      <button type="button" data-deck-focus="seed" onClick={() => run({ kind: "action", id: "seed" })} title="Propose one effort per Linear project on your open PRs"
        className={GHOST}>Seed from Linear…</button>
      <button type="button" data-deck-focus="rule" onClick={() => run({ kind: "action", id: "rule" })} className={GHOST}>+ Standing rule</button>
    </div>
    <RuleList rules={rules} onRemove={(id) => run({ kind: "rule-remove", id })} className="pb-1 pl-1" />
    {screen.suggest.map((group) => <Suggestion key={group.key} group={group} run={run} />)}
  </section>;
}

/** The standing rules, each with × to remove it: on a service card's suggestions, and in the rules dialog, which ⌘K reaches from any card. */
function RuleList({ rules, onRemove, className }: { rules: readonly RuleItem[]; onRemove(id: string): void; className?: string }) {
  return rules.length ? <div data-deck-rules className={cn("flex flex-wrap items-center gap-1.5 text-[12px]", className)}>
    {rules.map((rule) => <span key={rule.id} className="inline-flex items-center gap-1.5 rounded-md border border-border bg-foreground/[0.03] px-2">{rule.text}
      <button type="button" aria-label={`Remove the rule ${rule.text}`} title="Remove this rule; the PRs it placed stay" onClick={() => onRemove(rule.id)}
        className={cn("rounded text-muted-foreground hover:text-foreground", RING)}>×</button></span>)}
  </div> : null;
}

// ---------------------------------------------------------------------------
// Chrome: the header every Workstreams view shares, the batch bar docked under the rows, and the hint bar.
// ---------------------------------------------------------------------------

const TABS = [{ id: "deck", title: "Efforts", tip: "One effort per card" }, { id: "inventory", title: "All PRs", tip: "Every open PR in one list" }] as const;
/** The views behind More ▾, which ends with How it works. */
export const MORE_VIEWS = [{ id: "map", title: "Map" }, { id: "efforts", title: "Efforts admin" }] as const;
export type HeaderView = (typeof TABS)[number]["id"] | (typeof MORE_VIEWS)[number]["id"];
/** Where a header click goes: a view, or the How this works tab. */
export type HeaderTarget = HeaderView | "how";
export type HeaderProps = {
  /** The view under the header. */
  view: HeaderView;
  /** How fresh this view's read is; `title` gives the exact times. `onRefresh`: a click reads every open PR again, except while one reads. */
  read: { text: string; error: string | null; title?: string; busy?: boolean; onRefresh?(): void };
  /** Mark seen, on a view that has it, with its key and what it settles there. */
  seen?: { changed: number; available: boolean; note: string | null; key: string; title?: string };
  /** What ⌘K opens here: this view's actions, or the views. */
  palette: "all actions" | "go to";
  /** What ? opens here. */
  help: string;
  /** The view's own controls, after More. */
  tools?: ReactNode;
  onView(target: HeaderTarget): void; onSeen?(): void; onPalette(): void; onHelp(): void;
};

/**
 * One header on every view: Efforts · All PRs · More ▾, then the same right side everywhere: freshness, Mark seen where it applies, ⌘K, and ?.
 * On a narrow panel the right side wraps to its own line as one group, so no control is cut off and freshness truncates only there.
 */
export function WorkstreamsHeader(props: HeaderProps) {
  const scope = usePortalScopeProps();
  const { read, seen } = props;
  const more = MORE_VIEWS.find((item) => item.id === props.view) ?? null;
  const go = (target: HeaderTarget) => { if (target !== props.view) props.onView(target); };
  return <header data-ws-header={props.view} className="@container flex min-h-10 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/70 px-3 py-1">
    <nav aria-label="Workstreams views" className="inline-flex shrink-0 overflow-hidden rounded-md border border-border">
      {TABS.map((tab) => <button key={tab.id} type="button" data-deck-focus={tab.id === "deck" ? "view-deck" : "view-prs"} aria-pressed={props.view === tab.id} title={tab.tip}
        onClick={() => go(tab.id)} className={cn("h-6 px-2.5 text-[12px]", RING, props.view === tab.id ? "bg-foreground/[0.08] text-foreground" : "text-muted-foreground hover:text-foreground")}>
        {tab.title}</button>)}
    </nav>
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger asChild><button type="button" data-ws-more aria-label={more ? `More views: ${more.title}` : "More views"}
        className={cn(GHOST, more && "bg-foreground/[0.08] text-foreground")}>{more?.title ?? "More"} ▾</button></PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content {...scope} align="start" sideOffset={4} className={cn("z-50 grid w-44 rounded-lg border border-border bg-popover p-1 text-[12px] shadow-md outline-none", POINTER_CURSORS)}>
          <MoreItems view={props.view} go={go} />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
    {props.tools}
    <div className="ml-auto flex min-w-0 items-center gap-2">
      <span role={read.error ? "alert" : "status"} title={read.title} className={cn("inline-flex min-w-0 items-center gap-1.5 text-[11.5px]", read.error ? "text-destructive" : "text-muted-foreground")}>
        {read.busy && !read.error ? <Icon name="Loading" className="size-3 shrink-0 motion-safe:animate-spin" aria-hidden /> : null}
        {read.onRefresh ? <button type="button" data-ws-read disabled={read.busy} onClick={read.onRefresh} title="Read every open PR from GitHub again"
          className={cn("inline-flex min-w-0 items-center gap-1 rounded hover:text-foreground disabled:hover:text-inherit", RING)}>
          {read.busy ? null : <span aria-hidden>↻</span>}<span className="truncate">{read.error ?? read.text}</span></button>
          : <span className="truncate">{read.error ?? read.text}</span>}</span>
      {seen?.note ? <span role="status" className="shrink-0 text-[11.5px] text-muted-foreground"><span className={TONE.green.text}>✓</span> {seen.note}</span>
        : seen?.available ? <button type="button" data-deck-focus="seen" onClick={props.onSeen}
          title={seen.title ?? "Settles this view only: rows a read changed, rows that left, and rows you acted on"}
          className={cn("inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full bg-sky-500/10 px-2 text-[11.5px] text-sky-800 hover:bg-sky-500/20 dark:text-sky-200", RING)}>
          {seen.changed ? <><Changed title="Changed here" /><b>{seen.changed}</b> changed here ·</> : null} Mark seen <Kbd>{seen.key}</Kbd></button> : null}
      <button type="button" data-deck-focus="palette" onClick={props.onPalette} title={props.palette === "all actions" ? "Every action and its key (⌘K)" : "Go to a view (⌘K)"}
        className={cn(BUTTON, "border-border text-muted-foreground hover:text-foreground")}><Kbd>⌘K</Kbd><span className="hidden @min-[720px]:inline">{props.palette}</span></button>
      <button type="button" data-deck-focus="help" onClick={props.onHelp} title={`${props.help} (?)`} aria-label={`${props.help} (?)`}
        className={cn(BUTTON, "w-6 justify-center border-border px-0 text-muted-foreground hover:text-foreground")}>?</button>
    </div>
  </header>;
}

/** More ▾'s items, each closing it: the other views, the current one marked, then How it works. */
export function MoreItems({ view, go }: { view: HeaderProps["view"]; go(target: HeaderTarget): void }) {
  return <>
    {MORE_VIEWS.map((item) => <PopoverPrimitive.Close key={item.id} asChild><button type="button" data-ws-more-item={item.id} aria-current={item.id === view ? "page" : undefined}
      onClick={() => go(item.id)} className={cn("rounded px-2 py-1 text-left hover:bg-foreground/[0.06]", item.id === view && "font-medium", RING)}>{item.title}</button>
    </PopoverPrimitive.Close>)}
    <PopoverPrimitive.Close asChild><button type="button" data-ws-more-item="how" onClick={() => go("how")}
      className={cn("mt-1 rounded border-t border-border/60 px-2 py-1 text-left hover:bg-foreground/[0.06]", RING)}>How it works</button></PopoverPrimitive.Close>
  </>;
}

/** ⌘K on a view without actions of its own: every view, then How it works. */
export function viewPaletteItems(view: HeaderProps["view"]): PaletteItem[] {
  return [...[...TABS, ...MORE_VIEWS].map((item) => ({ key: item.id, group: "Go to", title: item.title, keys: [], on: item.id !== view, why: "you're here", action: null })),
    { key: "how", group: "Help", title: "How it works", keys: [], on: true, why: "", action: null }];
}

/**
 * The selection's moves, docked under the rows so it never covers one; on a service card, the moves into efforts too, and on an effort's
 * card (`leaves`), the move to One-offs. `address` counts the selected Your turn rows, which Address selected takes.
 */
export function BatchBar({ selected, kinds, sorting, leaves, address = 0, refusal, working, refresh, run }: { selected: number; kinds: readonly { id: DeckActionId; count: number; tone: Tone }[];
  sorting: boolean; leaves?: boolean; address?: number;
  /** The selected rows Refresh reads, and its progress while it reads them. */
  refresh?: { count: number; busy: boolean; progress: string | null };
  /** Why the last Address started nothing. */
  refusal?: string | null;
  /** The batch button working now: it spins and says so, and the others wait, until its plan answers. */
  working?: { kind: string; label: string } | null; run: Run }) {
  if (!selected) return null;
  const busy = (id: string) => working?.kind === id;
  // The pressed button keeps its full color while it works; only the others fade.
  const face = (id: string, idle: ReactNode) => busy(id) ? <><Spin />{working!.label}</> : idle;
  // Advance runs the safe writes only: never a merge, and never a thread's work.
  const safe = kinds.filter((kind) => kind.id !== "merge" && kind.id !== "fix").reduce((sum, kind) => sum + kind.count, 0);
  return <div aria-label="Selection" className="shrink-0 border-t border-border bg-background">
    <div className={cn(COLUMN, "flex flex-wrap items-center gap-1.5 px-4 py-1.5 text-[12px]")}>
      <b className="mr-1 font-semibold">{selected} selected</b>
      {safe ? <button type="button" data-deck-batch="advance" disabled={!!working} aria-busy={busy("advance") || undefined} onClick={() => run({ kind: "action", id: "advance" })}
        className={cn(BUTTON, "border-foreground bg-foreground font-medium text-background", busy("advance") && "disabled:opacity-100")}>{face("advance", <>Advance · {safe}<Kbd inverted>a</Kbd></>)}</button> : null}
      {address ? <button type="button" data-deck-batch="address" data-deck-address disabled={!!working} aria-busy={busy("address") || undefined}
        onClick={() => run({ kind: "action", id: "address" })} title="Starts one thread for them now, with 8 s to Undo. Nothing merges."
        className={cn(BUTTON, TONE.amber.button, busy("address") && "disabled:opacity-100")}>{face("address", <>Address selected ({address})<Kbd>{ACTION.address.keys[0]}</Kbd></>)}</button> : null}
      {refusal ? <span role="alert" data-deck-refusal className="min-w-0 truncate text-destructive" title={refusal}>{refusal}</span> : null}
      {kinds.map((kind) => <button key={kind.id} type="button" data-deck-batch={kind.id} disabled={!!working} aria-busy={busy(kind.id) || undefined}
        onClick={() => run({ kind: "action", id: kind.id })} className={cn(BUTTON, TONE[kind.tone].button, busy(kind.id) && "disabled:opacity-100")}>
        {face(kind.id, <>{ACTION[kind.id].title.replace("…", "")} {kind.count}<Kbd>{ACTION[kind.id].keys[0]}</Kbd></>)}</button>)}
      {refresh?.count ? <RefreshSelected {...refresh} onClick={() => run({ kind: "action", id: "refresh" })} /> : null}
      {sorting ? <>
        <button type="button" onClick={() => run({ kind: "action", id: "accept" })} className={cn(BUTTON, "border-border")}>Accept suggestions<Kbd>p</Kbd></button>
        <button type="button" onClick={() => run({ kind: "action", id: "move" })} className={cn(BUTTON, "border-border")}>Move…<Kbd>e</Kbd></button>
        <button type="button" onClick={() => run({ kind: "action", id: "new-effort" })} className={cn(BUTTON, "border-border")}>New effort from these…</button>
        <button type="button" onClick={() => run({ kind: "action", id: "one-off" })} className={cn(BUTTON, "border-border")}>Mark one-offs</button>
      </> : leaves ? <button type="button" onClick={() => run({ kind: "action", id: "one-off" })} className={cn(BUTTON, "border-border")}>Move to One-offs</button> : null}
      <span className="flex-1" />
      <button type="button" onClick={() => run({ kind: "action", id: "clear" })} className={GHOST}>Clear<Kbd>esc</Kbd></button>
    </div>
  </div>;
}

/** Refresh (N) on a selection bar: reads the selected rows from GitHub, saying how far it got. */
export function RefreshSelected({ count, busy, progress, onClick }: { count: number; busy: boolean; progress: string | null; onClick(): void }) {
  return <button type="button" data-batch-refresh disabled={busy} aria-busy={busy || undefined} onClick={onClick} title="Read the selected PRs from GitHub again"
    className={cn(BUTTON, "border-border", busy && "disabled:opacity-100")}>{busy ? <><Spin />{progress ?? "Reading…"}</> : <>Refresh ({count})<Kbd>{ACTION.refresh.keys[0]}</Kbd></>}</button>;
}

/** The few keys that matter now, or one status line, which never covers a row; ⌘K and ? stay on the right. */
/** `flash.busy`: a batch sending now, which spins beside its line. */
export function HintBar({ hints, flash, onPalette, onHelp, onUndo }: { hints: readonly [string, string][]; flash: { text: string; undo: boolean; busy?: boolean } | null;
  onPalette(): void; onHelp(): void; onUndo(): void }) {
  return <footer aria-label="Keys for what you're doing" className="@container flex h-7 shrink-0 items-center gap-3.5 overflow-hidden whitespace-nowrap border-t border-border/70 bg-foreground/[0.02] px-3 text-[11.5px] text-muted-foreground">
    <span role="status" className="flex min-w-0 items-center gap-3.5 overflow-hidden">
      {flash ? <span className="flex min-w-0 items-center gap-2.5 text-foreground">{flash.busy ? <Spin /> : null}<span className="truncate">{flash.text}</span>
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
export type ConfirmPlan = { title: string; sub: string; verb: string;
  items: readonly (Pick<BatchItem, "prUrl" | "ref" | "title" | "kind" | "what" | "notes"> & Partial<Pick<BatchItem, "feedback" | "where">>)[];
  skipped: readonly Pick<Skipped, "prUrl" | "ref" | "reason">[]; excluded: string | null; request: boolean;
  /** What happens after the window, as its footer says it: "Sends", or "Releases" for a release. */
  when?: string };
const KIND_TONE: Record<BatchItem["kind"], Tone> = { confirm: "violet", nudge: "blue", request: "blue", ready: "blue", release: "gray", ask: "violet", fix: "amber",
  address: "amber" };

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
        <span className="min-w-0"><b className="font-medium">{item.ref}</b> <span className="text-muted-foreground">{item.title}</span>
          {item.feedback ? <span data-deck-feedback className="block text-[11.5px] text-muted-foreground">{[item.feedback, item.where].filter(Boolean).join(" · ")}</span> : null}</span>
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
      <span className="mr-auto text-[11.5px] text-muted-foreground">{dirty ? "Plan again first" : `${plan.when ?? "Sends"} after ${seconds} s · Undo until then`}</span>
      <button type="button" onClick={onCancel} className={cn(BUTTON, "h-7 border-border")}>Cancel<Kbd>esc</Kbd></button>
      <button type="button" data-deck-confirm disabled={busy || dirty || plan.items.length === 0} onClick={onConfirm}
        className={cn(BUTTON, "h-7 border-foreground bg-foreground font-medium text-background hover:bg-foreground/90")}>{busy ? "Starting…" : `${plan.verb} ${plan.items.length}`}<Kbd inverted>⌘↵</Kbd></button>
    </div>
  </div>;
}

/**
 * One PR's review notes and the evidence since them, from a fresh read, with any follow-ups that linked the PR. With evidence, Confirm
 * handled leads (⌘↵); without it, asking its thread leads (⌘↵), and Confirm anyway is a click only, recorded as confirmed without evidence.
 */
export function NotesBody({ screen, failed, busy, error, onConfirm, onAnyway, onAsk, onCancel }: { screen: NotesScreen | null;
  /** Why GitHub couldn't be read for the notes. */
  failed: string | null; busy: boolean; error: string | null; onConfirm(): void; onAnyway(): void; onAsk(): void; onCancel(): void }) {
  if (!screen) return <div className="grid gap-3 text-[12.5px]">
    <p role={failed ? "alert" : "status"} className={failed ? "text-destructive" : "text-muted-foreground"}>{failed ? `Couldn't read the notes: ${failed}` : "Reading GitHub…"}</p>
    <div className="flex justify-end border-t border-border/60 pt-2.5"><button type="button" onClick={onCancel} className={cn(BUTTON, "h-7 border-border")}>Close<Kbd>esc</Kbd></button></div>
  </div>;
  const lead = cn(BUTTON, "h-7 border-foreground bg-foreground font-medium text-background hover:bg-foreground/90");
  return <div className="grid gap-3 text-[12.5px]">
    <ul data-notes className="grid max-h-[45vh] gap-2.5 overflow-y-auto">
      {screen.notes.map((note) => <li key={note.id} className="grid gap-0.5">
        <span className="text-[11.5px] text-muted-foreground">{note.who} · {note.what} · {note.age}</span>
        <p className="whitespace-pre-wrap break-words rounded-md bg-foreground/[0.03] px-2.5 py-1.5">{note.body}{note.truncated ? "…" : ""}</p>
      </li>)}
    </ul>
    <p data-notes-evidence className={cn("rounded px-2 py-1 text-[12px]", screen.evidence.handled ? "text-muted-foreground" : TONE.amber.chip)}>{screen.evidence.text}</p>
    {screen.evidence.linked ? <p data-notes-linked className="px-2 text-[12px] text-muted-foreground">{screen.evidence.linked}</p> : null}
    {error ? <p role="alert" className="text-[12px] text-destructive">{error}</p> : null}
    {screen.primary !== "confirm" ? <p className="text-[11.5px] text-muted-foreground">{"to" in screen.ask
      ? `Ask ${screen.ask.to} · listed first, then sent after ${Math.round(SEND_DELAY_MS / 1_000)} s with Undo` : screen.ask.why}</p> : null}
    <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border/60 pt-2.5">
      {screen.primary !== "confirm" ? <>
        <button type="button" data-notes-anyway disabled={busy} onClick={onAnyway} title="Records that nothing showed them handled"
          className={cn(GHOST, "h-7")}>{busy ? "Confirming…" : "Confirm anyway"}</button>
        <button type="button" onClick={onCancel} className={cn(BUTTON, "h-7 border-border")}>Cancel<Kbd>esc</Kbd></button>
        {screen.primary === "ask" ? <button type="button" data-notes-ask disabled={busy} onClick={onAsk} className={lead}>Ask its thread to address it<Kbd inverted>⌘↵</Kbd></button> : null}
      </> : <>
        <button type="button" onClick={onCancel} className={cn(BUTTON, "h-7 border-border")}>Cancel<Kbd>esc</Kbd></button>
        <button type="button" data-notes-confirm disabled={busy} onClick={onConfirm} className={lead}>{busy ? "Confirming…" : "Confirm handled"}<Kbd inverted>⌘↵</Kbd></button>
      </>}
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
      className={cn(BUTTON, "h-7 border-foreground bg-foreground font-medium text-background hover:bg-foreground/90")}>{busy ? "Working…" : label}<Kbd inverted>⌘↵</Kbd></button>
  </div>;
}

/** Complete: what is still open first. Its PRs and threads stay with it on the Done pile. */
export function CompleteBody({ screen, busy, error, onComplete, onCancel }: { screen: CardScreen; busy: boolean; error: string | null; onComplete(): void; onCancel(): void }) {
  const active = screen.threads.filter((thread) => thread.status === "active");
  return <div className="grid gap-3 text-[12.5px]">
    <ul className="grid gap-1.5">
      <li><b className="font-medium">{plural(screen.card.stats.open, "open PR")}</b> <span className="text-muted-foreground">{screen.needsYou} need you</span></li>
      {active.length ? <li><b className="font-medium">{plural(active.length, "active thread")}</b> <span className="text-muted-foreground">{active.map((thread) => thread.title).join(", ")}</span></li> : null}
    </ul>
    <p className="text-[12px] text-muted-foreground">Its PRs and threads stay with it on the Done pile, and stop counting. Reopen puts it back.</p>
    {error ? <p role="alert" className="text-[12px] text-destructive">{error}</p> : null}
    <DialogButtons busy={busy} label="Complete" onOk={onComplete} onCancel={onCancel} />
  </div>;
}

export type RuleDraft = { kind: "ticket-prefix" | "branch" | "repo" | "stack" | "linear-project"; value: string; effortId: string; now: boolean };
export const RULE_WORDS: Record<RuleDraft["kind"], string> = { "ticket-prefix": "Ticket prefix", branch: "Branch", repo: "Repo", stack: "Stacked on a PR in an effort",
  "linear-project": "Linear project" };
/**
 * The standing rules, each with × to remove it, then a new one: a standing rule places new PRs on every read; `now` also moves the open
 * PRs it matches today, which the preview counts.
 */
export function RuleBody({ draft, efforts, rules, matches, busy, error, onDraft, onAdd, onRemove, onCancel }: { draft: RuleDraft;
  efforts: readonly { id: string; name: string }[]; rules: readonly RuleItem[]; matches: number | null; busy: boolean; error: string | null;
  onDraft(draft: RuleDraft): void; onAdd(): void; onRemove(id: string): void; onCancel(): void }) {
  const field = "h-8 rounded-md border border-input bg-background px-2 text-[12.5px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-sky-500";
  return <div className="grid gap-3 text-[12.5px]">
    <RuleList rules={rules} onRemove={onRemove} />
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

/** A weak suggestion asks before it moves anything: each PR with the signals behind it, then one button. */
export function WeakBody({ lines, label, busy, error, onAccept, onCancel }: { lines: readonly Pick<DeckLine, "prUrl" | "ref" | "title" | "signals">[]; label: string;
  busy: boolean; error: string | null; onAccept(): void; onCancel(): void }) {
  return <div className="grid gap-3 text-[12.5px]">
    <ul data-deck-weak className="grid max-h-[50vh] gap-1.5 overflow-y-auto">{lines.map((line) => <li key={line.prUrl} className="min-w-0">
      <b className="font-medium">{line.ref}</b> <span className="text-muted-foreground">{line.title}</span>
      <span className="block truncate text-[11.5px] text-muted-foreground">{line.signals.length ? line.signals.join(" · ") : "No signal of its own; it goes with its group"}</span>
    </li>)}</ul>
    {error ? <p role="alert" className="text-[12px] text-destructive">{error}</p> : null}
    <DialogButtons busy={busy} label={label} onOk={onAccept} onCancel={onCancel} />
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
      <p className="text-muted-foreground">Color means your move; gray waits on others, runs itself, or is on hold. A blue dot marks a change since you looked, which stays put until Mark seen.</p>
      <p className="text-muted-foreground">Needs you: an open PR on an active card whose next move is yours. A service card counts too: it holds a repository&apos;s PRs no effort has. Dimmed rows don&apos;t count.</p>
      <p className="text-muted-foreground">Every GitHub write opens one confirm that lists each PR, then waits {Math.round(SEND_DELAY_MS / 1_000)} s with Undo. Merges run only from the fresh preview, on a click or ⌘↵.</p>
    </div>
  </div>;
}

// ---------------------------------------------------------------------------
// The whole deck.
// ---------------------------------------------------------------------------

export function Overview({ screen, run }: { screen: OverviewScreen; run: Run }) {
  const panel = "min-w-0 rounded-[10px] border border-border/50 bg-foreground/[0.015] px-3 py-2.5";
  const priorities = [...screen.cards].sort((a, b) => b.needsYou - a.needsYou || b.blocked.length - a.blocked.length).slice(0, 5);
  const maxPrs = Math.max(1, ...priorities.map((item) => item.stats.bar.reduce((sum, segment) => sum + segment.count, 0)));
  return <section data-deck-overview aria-label="Overview">
    <h1 data-deck-focus="heading" tabIndex={-1} className="mb-3 text-[16px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-sky-500">Overview</h1>
    <div className="grid gap-3 @min-[680px]:grid-cols-12">
      <section className={cn(panel, "@min-[680px]:col-span-7")} aria-labelledby="overview-matrix"><div className="mb-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1"><h2 id="overview-matrix" className="text-[12px] font-semibold">Action matrix</h2>
        <span className="text-[10px] tabular-nums text-muted-foreground">{maxPrs > 1 || priorities.some((item) => item.stats.bar.some((part) => part.count)) ? `0–${maxPrs} PRs` : "No open PRs"}</span>
        <div aria-label="PR state colors" className="flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
          {([["green", "Merge"], ["blue", "Your other moves"], ["amber", "Fix"], ["gray", "Waiting"]] as const).map(([tone, label]) => <span key={tone} className="inline-flex items-center gap-1"><i aria-hidden="true" className={cn("h-1.5 w-1.5 rounded-full", TONE[tone].bar)} />{label}</span>)}
        </div></div>
        {screen.cards.length ? <div className="grid gap-0.5">{priorities.map((item) => {
          return <button key={item.card.id} type="button" data-deck-focus={`overview-matrix-${item.card.id}`} onClick={() => run({ kind: "go", id: item.card.id })}
            className={cn("grid min-w-0 grid-cols-1 items-center gap-x-2 rounded px-1 py-1 text-left hover:bg-foreground/[0.05] @min-[480px]:grid-cols-[minmax(0,1fr)_auto]", RING)}>
            <span className="flex min-w-0 items-center gap-1.5 text-[12px]"><Dot color={item.color} /><span className="truncate font-medium">{item.card.name}</span>
              {item.changed ? <Changed title="Changed since you looked" /> : null}</span>
            <span className="min-w-0 truncate text-[11px] text-muted-foreground" title={item.status.text}>{item.needsYou} need you · {item.blocked.length} blocked · {item.stats.bar.find((part) => part.key === "flight")?.count ?? 0} in flight</span>
            <span role="img" aria-label={item.stats.bar.map((part) => `${part.count} ${part.label}`).join(", ") || "No open PRs"}
              className="mt-1 flex h-1 overflow-hidden rounded-full bg-foreground/[0.06] @min-[480px]:col-span-2">
              {item.stats.bar.map((part) => <i key={part.key} className={cn("h-full shrink-0", TONE[part.tone].bar)} style={{ width: `${part.count / maxPrs * 100}%` }} />)}</span>
          </button>;
        })}{screen.cards.length > priorities.length ? <p className="px-1 pt-1 text-[11px] text-muted-foreground">
          {screen.cards.length - priorities.length} more {screen.cards.length - priorities.length === 1 ? "effort" : "efforts"} below</p> : null}</div>
          : <p className="text-[12px] text-muted-foreground">No active efforts yet.</p>}
      </section>
      <section className={cn(panel, "@min-[680px]:col-span-5")} aria-labelledby="overview-blockers"><h2 id="overview-blockers" className="mb-2 text-[12px] font-semibold">Aging blockers</h2>
        {screen.blockers.length ? <ol className="grid gap-0.5">{screen.blockers.slice(0, 5).map((item, index) => <li key={`${item.effortId}-${item.ref}-${index}`}>
          <button type="button" onClick={() => run({ kind: "go", id: item.effortId })}
            className={cn("grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-2 rounded px-1 py-1 text-left text-[12px] hover:bg-foreground/[0.05]", RING)}>
            <span className="truncate font-medium" title={`${item.effort} · ${item.ref}`}>{item.effort} · {item.ref}</span><span className="text-[11px] tabular-nums text-muted-foreground">{item.age ?? "—"}</span>
            <span className="col-span-2 truncate text-[11px] text-muted-foreground" title={`${item.on}: ${item.cause}`}>{item.on} · {item.cause}</span>
          </button></li>)}</ol> : <p className="text-[12px] text-muted-foreground">Nothing waits on others.</p>}
      </section>
      {screen.cards.map((item, index) => <button key={item.card.id} type="button" data-deck-focus={`overview-effort-${item.card.id}`} onClick={() => run({ kind: "go", id: item.card.id })}
        className={cn(panel, "grid gap-2 text-left hover:bg-foreground/[0.05]", index === 0 ? "@min-[680px]:col-span-7" : index === 1 ? "@min-[680px]:col-span-5" : "@min-[680px]:col-span-6 @min-[900px]:col-span-4", RING)}>
        <span className="flex min-w-0 items-center gap-2"><Dot color={item.color} /><strong className="min-w-0 flex-1 truncate text-[13px]">{item.card.name}</strong>
          {item.changed ? <span className="flex items-center gap-1 text-[11px] text-muted-foreground"><Changed title="Changed since you looked" />Changed</span> : null}</span>
        <span className="line-clamp-2 text-[12px]">{item.next.items[0]?.text ?? "No next action recorded."}</span>
        <span className="text-[11px] text-muted-foreground">{item.needsYou} need you · {item.blocked.length} blocked · {item.stats.open} open · {item.stats.mergedWeek} merged in 7d</span>
      </button>)}
    </div>
  </section>;
}

export type DeckPaneProps = {
  chips: readonly Chip[]; cur: string | null;
  /** The card shown; null before the first read, on Overview, or when nothing is open. */
  card: CardScreen | null; rules: readonly RuleItem[];
  /** Overview's panels while it shows; null before the first read. */
  overview?: OverviewScreen | null;
  held: readonly Pile[]; done: readonly Pile[];
  read: HeaderProps["read"];
  seen: { changed: number; available: boolean; note: string | null };
  state: RowState; tiles: ReadonlySet<string>; open: ReadonlySet<string>; pile: "hold" | "done" | null;
  /** The card's own header has scrolled away, so its one-line bar shows and section headers stick below it. */
  stuck: boolean;
  /** What a takes now; the card's Advance shows its badge only when that's the card. */
  advanceScope?: "selected" | "row" | "card" | null;
  /** The card a flip landed on, said once to screen readers; empty otherwise. */
  announce?: string;
  on: Availability; hints: readonly [string, string][]; flash: { text: string; undo: boolean; busy?: boolean } | null;
  batch: { kinds: readonly { id: DeckActionId; count: number; tone: Tone }[]; address?: number; refusal?: string | null; working?: { kind: string; label: string } | null;
    refresh?: { count: number; busy: boolean; progress: string | null } };
  run: Run; onPalette(): void; onHelp(): void; onUndo(): void;
  rootRef?: RefObject<HTMLDivElement | null>; scrollerRef?: RefObject<HTMLDivElement | null>; slackRef?: RefObject<HTMLDivElement | null>;
  chipsRef?: RefObject<HTMLDivElement | null>; viewRef?: RefObject<HTMLDivElement | null>;
  /** The Notes editor while it's open on the card shown, and what renders notes as Markdown. */
  notes?: NotesEdit | null; markdown?: (body: string) => ReactNode;
  /** The header count whose rows show alone; `card`'s sections are already cut to them. */
  filter?: "needs" | "blocked" | null;
};

export function DeckPane(props: DeckPaneProps) {
  const { card, stuck } = props;
  const behind = cardsBehind(props.chips, props.cur);
  const keyless = props.advanceScope === "row" || props.advanceScope === "selected";
  return <div ref={props.rootRef} role="region" aria-label="Effort deck" className={cn("flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground", POINTER_CURSORS)}>
    <WorkstreamsHeader view="deck" read={props.read} seen={{ ...props.seen, key: "s" }} palette="all actions" help="Keys and colors" onView={(view) => props.run({ kind: "view", view })}
      onSeen={() => props.run({ kind: "action", id: "seen" })} onPalette={props.onPalette} onHelp={props.onHelp} />
    <Strip chips={props.chips} cur={props.cur} deck held={props.held} done={props.done} pile={props.pile} run={props.run} chipsRef={props.chipsRef} />
    <div ref={props.scrollerRef} data-deck-scroller className="@container relative min-h-0 flex-1 overflow-y-auto overscroll-contain [overflow-anchor:none]">
      {stuck && card ? <CardBar name={card.card.name} color={card.color} hollow={card.card.kind !== "effort"} status={card.status}
        counts={<Counts screen={card} filter={props.filter} run={props.run} bar />}
        advance={card.card.pile === "active" ? <ActionButton id="advance" on={props.on} run={props.run} primary label={`Advance${card.advance.length ? ` · ${card.advance.length}` : ""}`}
          keyless={keyless} /> : null} /> : null}
      <div ref={props.slackRef} aria-hidden data-deck-slack />
      <div ref={props.viewRef} className={CONTENT}>
        {props.cur === "overview" && props.overview ? <Overview screen={props.overview} run={props.run} />
          : card ? <><Stack behind={behind} run={props.run}><Card screen={card} tiles={props.tiles} run={props.run} on={props.on} keyless={keyless} notes={props.notes}
          markdown={props.markdown} filter={props.filter} /></Stack>
          <div data-deck-rows>{card.suggest.length ? <Suggestions screen={card} rules={props.rules} run={props.run} /> : null}
            {props.filter ? <FilterLine kind={props.filter} n={card.sections.reduce((sum, section) => sum + section.lines.length, 0)} run={props.run} /> : null}
            {props.filter && !card.sections.length ? null : <CardSections screen={card} state={props.state} run={props.run} open={props.open} stuck={stuck} />}</div></>
          : <p role="status" className="py-8 text-center text-[12px] text-muted-foreground">{props.read.error ? "Couldn't read the deck." : "Reading your efforts…"}</p>}
      </div>
    </div>
    <BatchBar selected={props.state.selected.size} kinds={props.batch.kinds} address={props.batch.address} refusal={props.batch.refusal} working={props.batch.working}
      refresh={props.batch.refresh} sorting={card?.card.kind === "service"}
      leaves={card?.card.kind === "effort" && !card.card.oneOff} run={props.run} />
    <HintBar hints={props.hints} flash={props.flash} onPalette={props.onPalette} onHelp={props.onHelp} onUndo={props.onUndo} />
    <p role="status" data-deck-announce className="sr-only">{props.announce}</p>
  </div>;
}
