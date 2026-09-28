// The roster's command box and what a command said back (V2-UI-SPEC §4.6).
// The command is the authorization boundary: the box takes the same grammar
// as the effort parent thread, and every click elsewhere in the pane either
// runs a command whose text it showed or writes one here for you to finish.
// Presentational only: data and callbacks come in as props, no SDK hook is
// called, and imports stay relative, so static-markup tests can render it.
import type { RefObject } from "react";
import { Icon } from "./components/ui/icon";
import { cn } from "./lib/utils";
import { HATCH } from "./roster-rows";
import type { AckChip, AckView } from "./roster-view-model";

/** A note that isn't a command's acknowledgment: a refresh's read, a hint, or an Undo's answer. */
export type RosterNote = { command: string; lines: string[]; tone: "info" | "error" };
export type CommandBoxProps = {
  value: string;
  onValue(value: string): void;
  onSubmit(): void;
  inputRef?: RefObject<HTMLInputElement | null>;
  /** The latest command: this visit's, or the newest the roster journaled. */
  ack: AckView | null;
  /** Whether its details show. */
  open: boolean;
  onToggle(): void;
  note: RosterNote | null;
  /** Esc leaves the box for the roster, where single keys work again. */
  onLeave(): void;
};

export const COMMAND_PLACEHOLDER = "Command, same grammar as the thread: hold 8 because…, D2 all but 14 · ? for keys";

const CHIP_CLASS: Record<AckChip["kind"], string> = {
  added: "border-foreground/30 text-foreground", kept: "border-transparent bg-foreground/[0.07]", change: "border-transparent bg-foreground/[0.07]",
  alone: "border-dashed border-muted-foreground/60 text-muted-foreground", held: "border-border", no: "border-border text-muted-foreground",
};

export function AckChips({ chips }: { chips: readonly AckChip[] }) {
  return <div className="mt-1 flex flex-wrap gap-1">
    {chips.map((chip) => <span key={chip.label} data-ack-chip={chip.kind} style={chip.kind === "held" ? HATCH : undefined}
      className={cn("inline-flex h-5 items-center gap-1 rounded-full border px-1.5 text-[11px] leading-none tabular-nums", CHIP_CLASS[chip.kind])}>
      {chip.kind === "held" ? <Icon name="Pin" className="size-3" aria-hidden /> : null}{chip.label}
    </span>)}
  </div>;
}

export function AckDetails({ ack }: { ack: AckView }) {
  return <dl className="mt-1.5 grid max-h-40 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 overflow-y-auto overscroll-contain text-[12px]">
    {ack.details.map((detail, index) => <div key={`${detail.label}-${index}`} className="contents">
      <dt className="text-muted-foreground">{detail.label}</dt>
      <dd className="min-w-0">{detail.numbers ? <span className="font-medium tabular-nums">{detail.numbers} · </span> : null}{detail.text}</dd>
    </div>)}
  </dl>;
}

/** A clarification or refusal: nothing ran. It offers the command as the server read it, into the box, for you to fix and send. */
export function ClarifyNote({ ack, onUse }: { ack: AckView; onUse(text: string): void }) {
  return <p className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
    <span className="font-medium">Nothing ran.</span>
    <span className={cn("whitespace-pre-wrap", ack.kind === "error" && "text-destructive")}>{ack.message}</span>
    {ack.normalized ? <button type="button" onClick={() => onUse(ack.normalized!)} title="Put this reading in the command box; nothing runs until you send it"
      className="rounded-full border border-border px-1.5 font-mono text-[11px] leading-5 outline-none hover:bg-foreground/[0.05] focus-visible:ring-2 focus-visible:ring-ring">
      Use this: {ack.normalized}</button> : null}
  </p>;
}

/** The last command's line, its chip row, and its details when open. */
export function Acknowledgment({ ack, open, onToggle, onUse }: { ack: AckView; open: boolean; onToggle(): void; onUse(text: string): void }) {
  const refused = ack.kind === "clarify" || ack.kind === "error";
  return <div role="status" aria-live="polite">
    <p className="flex min-w-0 items-baseline gap-2">
      <span className="min-w-0 shrink truncate font-mono text-[11px]" title={ack.command}>› {ack.command}</span>
      <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" title={ack.meta}>{ack.meta}</span>
      {!refused && ack.details.length ? <button type="button" aria-expanded={open} onClick={onToggle}
        className="shrink-0 text-[11px] text-muted-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">{open ? "Hide details" : "Details"}</button> : null}
    </p>
    {refused ? <ClarifyNote ack={ack} onUse={onUse} /> : ack.message ? <p className="mt-1 text-muted-foreground">{ack.message}</p> : <AckChips chips={ack.chips} />}
    {open && !refused ? <AckDetails ack={ack} /> : null}
  </div>;
}

/** The pinned bottom of the pane: the last command and what it did, any note, then the box. */
export function CommandBox(props: CommandBoxProps) {
  const { ack, note } = props;
  return <div className="shrink-0 border-t border-border/70 px-3 py-1.5 text-[12px]">
    {ack ? <Acknowledgment ack={ack} open={props.open} onToggle={props.onToggle} onUse={(text) => { props.onValue(text); props.inputRef?.current?.focus(); }} /> : null}
    {note ? <p role="status" className="mt-1 flex min-w-0 items-baseline gap-2">
      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">› {note.command}</span>
      <span className={cn("min-w-0 flex-1 whitespace-pre-wrap", note.tone === "error" && "text-destructive")}>{note.lines.join("\n")}</span>
    </p> : null}
    <form onSubmit={(event) => { event.preventDefault(); if (props.value.trim()) props.onSubmit(); }}
      className="mt-1.5 flex items-center gap-2 rounded-md border border-input bg-background px-2 focus-within:ring-2 focus-within:ring-ring">
      <span aria-hidden className="font-mono text-muted-foreground">›</span>
      <input ref={props.inputRef} value={props.value} onChange={(event) => props.onValue(event.target.value)} aria-label="Command" placeholder={COMMAND_PLACEHOLDER}
        spellCheck={false} autoComplete="off" maxLength={4_000} onKeyDown={(event) => { if (event.key === "Escape") props.onLeave(); }}
        className="h-7 min-w-0 flex-1 bg-transparent font-mono text-[12px] outline-none placeholder:text-muted-foreground" />
      <kbd className="shrink-0 rounded border border-border px-1 font-mono text-[11px] leading-4 text-muted-foreground">/</kbd>
    </form>
  </div>;
}
