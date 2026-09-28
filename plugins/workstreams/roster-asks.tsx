// The asks above the roster (V2-UI-SPEC §4.2): decision cards, the receipts
// that replace them while an answer waits ten seconds for Undo, system
// issues with their recovery commands, and M, the merge candidates, whose
// only action opens their fresh preview.
// Each action control shows the command it sends before you use it, and each
// card's footer carries the thread's text for the same answer, which a click
// writes into the command box. Product decisions take an explicit option;
// only a lifecycle subset or a system issue's recovery accepts with Enter
// (plan amendment A9, call 3), and a recovery that drops a claim confirms.
// Presentational only: data and callbacks come in as props, no SDK hook is
// called, and imports stay relative, so static-markup tests can render it.
import { useState, type ReactNode } from "react";
import { Checkbox } from "./components/ui/checkbox";
import { cn } from "./lib/utils";
import { formatTargets } from "./roster-shared";
import { TONE_CLASS } from "./roster-rows";
import { answerCommand, answerKey, askKind, clock, UNDO_WINDOW, type AnswerReply, type Ask, type DecisionAsk, type IssueAsk, type MergeAsk, type PaneState, type Receipt,
  type Recovery } from "./roster-view-model";

export type AskActions = {
  /** Keyboard focus moves to this ask; a narrow pane opens its line. */
  onFocusAsk(id: string): void;
  onFocus(n: number): void;
  /** Send an answer, held for Undo. */
  onAnswer(ask: DecisionAsk, reply: AnswerReply): void;
  /** A lifecycle card's number field, sent as `Dn <field>` for the server to parse. */
  onField(ask: DecisionAsk, field: string): void;
  onSubset(ask: DecisionAsk, numbers: number[]): void;
  /** Write a command into the command box without sending it. */
  onCompose(text: string): void;
  onUndo(receipt: Receipt): void;
  /** Run a system issue's recovery; one marked confirm opens its confirmation instead. */
  onRecover(ask: IssueAsk, recovery: Recovery): void;
  /** Send M's `merge N` and open the fresh merge preview; it merges nothing. */
  onPreview(ask: MergeAsk): void;
  onOpenThread(threadId: string): void;
  onOpenUrl(url: string): void;
};
export type AsksProps = AskActions & { asks: readonly Ask[]; receipts: readonly Receipt[]; state: PaneState; wide: boolean; now: number };

const button = "inline-flex h-7 items-center rounded-md border px-2 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
const quiet = "border-border hover:bg-foreground/[0.05]";

function Numbers({ numbers, onFocus }: { numbers: readonly number[]; onFocus(n: number): void }) {
  return <span className="inline-flex flex-wrap gap-1">{numbers.map((n) => <button key={n} type="button" onClick={(event) => { event.stopPropagation(); onFocus(n); }}
    title={`Go to row ${n}`} className="rounded-[3px] bg-foreground/[0.07] px-1 text-[11px] leading-4 tabular-nums outline-none hover:bg-foreground/[0.12] focus-visible:ring-2 focus-visible:ring-ring">{n}</button>)}</span>;
}

/** Thread text you can paste or compose: a click writes it into the command box without sending it. */
function ThreadText({ commands, onCompose }: { commands: readonly string[]; onCompose(text: string): void }) {
  return <span className="inline-flex flex-wrap items-baseline gap-1">Thread {commands.map((command, index) => <span key={command}>
    <button type="button" onClick={() => onCompose(command)} title="Write this into the command box"
      className="rounded-[3px] border border-border px-1 font-mono text-[11px] leading-4 outline-none hover:bg-foreground/[0.05] focus-visible:ring-2 focus-visible:ring-ring">{command}</button>
    {index < commands.length - 1 ? " ·" : null}
  </span>)}</span>;
}

function AskKey({ id, tone }: { id: string; tone: "decision" | "issue" | null }) {
  return <span data-tone={tone ?? undefined} className={cn("inline-flex h-5 shrink-0 items-center rounded-[3px] border px-1 text-[11px] font-medium tabular-nums",
    tone ? TONE_CLASS[tone] : "border-foreground/30")}>{id}</span>;
}

const toneOf = (ask: Ask) => ask.kind === "issue" ? "issue" as const : ask.kind === "decision" ? "decision" as const : null;
const BORDER = { issue: "border-rose-500/30", decision: "border-amber-500/30" } as const;
/** The card frame: amber for decisions, rose for system issues, and neutral for merges; focused, it gets a ring. */
function Card({ ask, focused, children, onFocusAsk }: { ask: Ask; focused: boolean; children: ReactNode; onFocusAsk(id: string): void }) {
  const tone = toneOf(ask);
  return <article data-roster-ask={ask.id} tabIndex={-1} aria-label={`${ask.id} ask`} onClick={() => onFocusAsk(ask.id)} data-tone={tone ?? undefined}
    className={cn("min-w-0 rounded-md border bg-foreground/[0.03] px-3 py-2 text-[12px] outline-none", tone ? BORDER[tone] : "border-border", focused && "ring-2 ring-ring")}>
    {children}
  </article>;
}

function askedBy(ask: DecisionAsk, now: number) {
  const { createdAt, source } = ask.decision;
  return [createdAt ? `asked ${clock(createdAt, now)}` : null, source ? `by the ${source.label}` : null].filter(Boolean).join(" ");
}

/**
 * A product, authority, or worker question: evidence, each option with what it means for the work, and the recommendation with its reason,
 * never preselected. A question asked without options takes only your words, so its field is open from the start.
 */
export function ProductDecisionCard({ ask, state, focused, now, ...actions }: AskActions & { ask: DecisionAsk; state: PaneState; focused: boolean; now: number }) {
  const free = ask.options.length === 0;
  const [typed, setWords] = useState<string | null>(null);
  const words = typed ?? (free ? "" : null);
  const picked = state.picks.get(answerKey(ask)) ?? null;
  const { decision } = ask;
  const hint = state.hint?.id === ask.id ? state.hint.text : null;
  const thread = ask.answer === "thread";
  return <Card ask={ask} focused={focused} onFocusAsk={actions.onFocusAsk}>
    <header className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
      <AskKey id={ask.id} tone="decision" /><span>{{ authority: "Authority", worker: "Worker question", product: "Product decision", lifecycle: "Lifecycle" }[askKind(ask)]}</span>
      <Numbers numbers={ask.numbers} onFocus={actions.onFocus} /><span className="ml-auto">{askedBy(ask, now)}</span>
    </header>
    <p className="mt-1 text-[13px] font-medium">{decision.question}</p>
    {decision.evidence.length ? <p className="mt-0.5 text-[11px] text-muted-foreground">Evidence: {decision.evidence.map((item, index) => <span key={`${item.label}-${index}`}>
      {index ? " · " : null}{item.url ? <button type="button" onClick={(event) => { event.stopPropagation(); actions.onOpenUrl(item.url!); }}
        className="underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">{item.label}</button> : item.label}
    </span>)}</p> : null}
    {thread ? <div className="mt-2 flex items-center gap-2">
      {decision.source?.threadId ? <button type="button" className={cn(button, quiet)} onClick={() => actions.onOpenThread(decision.source!.threadId!)}>Open thread</button> : null}
      <span className="text-[11px] text-muted-foreground">Answered in the worker's thread, not here</span>
    </div> : <>
      {free ? null : <div role="group" aria-label={`${ask.id} options`} className="mt-2 grid gap-1">
        {ask.options.map((option) => <button key={option.id} type="button" aria-pressed={picked === option.id} data-option={option.id}
          onClick={(event) => { event.stopPropagation(); actions.onAnswer(ask, { optionId: option.id }); }} title={`Sends ${answerCommand(ask, { optionId: option.id })}; Undo for 10 s`}
          className={cn("grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-2 rounded-md border px-2 py-1.5 text-left outline-none hover:bg-foreground/[0.05] focus-visible:ring-2 focus-visible:ring-ring",
            picked === option.id ? "border-foreground/60 bg-foreground/[0.06]" : "border-border")}>
          <span className="font-mono text-[11px] text-muted-foreground">{option.id}</span>
          <span>{option.label}</span>
          {option.recommended ? <span className="rounded-full border border-border px-1.5 text-[11px] leading-4 text-muted-foreground">Recommended</span> : <span />}
          {option.consequence ? <span className="col-start-2 col-end-4 text-[11px] text-muted-foreground">{option.consequence}</span> : null}
        </button>)}
      </div>}
      {decision.recommendation?.reason ? <p className="mt-1 text-[11px] text-muted-foreground">Recommended {decision.recommendation.optionId}: {decision.recommendation.reason}</p> : null}
      {words !== null ? <form className="mt-1.5" onSubmit={(event) => { event.preventDefault(); if (words.trim()) actions.onAnswer(ask, { text: words.trim() }); }}>
        <input autoFocus={!free} value={words} onChange={(event) => setWords(event.target.value)} aria-label={`${ask.id} in your words`} maxLength={4_000}
          placeholder="Answer in your words, then Enter" className="h-7 w-full rounded-md border border-input bg-background px-2 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring" />
      </form> : null}
      <footer className="mt-1.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span>{hint ?? (picked ? `Enter sends ${answerCommand(ask, { optionId: picked })}` : free ? "No options were offered: answer in your words, then Enter"
          : `${ask.options.map((option) => option.key).join(" / ")} picks, then Enter; nothing is preselected`)}
          {words === null ? <> · <button type="button" onClick={(event) => { event.stopPropagation(); setWords(""); }}
            className="underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">in your words</button></> : null}</span>
        <ThreadText commands={free ? [`${ask.id} `] : ask.options.map((option) => answerCommand(ask, { optionId: option.id }))} onCompose={actions.onCompose} />
      </footer>
    </>}
  </Card>;
}

/** A lifecycle question: pick which drafts to mark ready (or who reviews). The recommended subset is preselected with its reason; Enter accepts it. */
export function LifecycleDecisionCard({ ask, state, focused, ...actions }: AskActions & { ask: DecisionAsk; state: PaneState; focused: boolean }) {
  const [field, setField] = useState("");
  const selected = state.subsets.get(answerKey(ask)) ?? ask.recommended;
  const review = ask.decision.subkind === "request-review";
  const hint = state.hint?.id === ask.id ? state.hint.text : null;
  const reply = { numbers: [...selected] };
  const toggle = (n: number, on: boolean) => actions.onSubset(ask, ask.numbers.filter((other) => other === n ? on : selected.includes(other)));
  return <Card ask={ask} focused={focused} onFocusAsk={actions.onFocusAsk}>
    <header className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
      <AskKey id={ask.id} tone="decision" /><span>Lifecycle · {ask.numbers.length} {ask.numbers.length === 1 ? "PR" : "PRs"}</span>
      <Numbers numbers={ask.numbers} onFocus={actions.onFocus} /><span className="ml-auto">{review ? "no review is requested without you" : "unmarked drafts stay yours"}</span>
    </header>
    <p className="mt-1 text-[13px] font-medium">{ask.decision.question}</p>
    <ul className="mt-1.5 grid gap-0.5">
      {ask.targets.map((item) => <li key={item.target} className="flex min-w-0 items-center gap-2">
        {review || item.n === null ? <span className="w-4" /> : <Checkbox checked={selected.includes(item.n)} aria-label={`Include ${item.n}`}
          onCheckedChange={(on) => toggle(item.n!, on === true)} onClick={(event) => event.stopPropagation()} />}
        <span className="w-6 shrink-0 tabular-nums">{item.n ?? "—"}</span>
        <span className="min-w-0 flex-1 truncate" title={item.title}><span className="text-muted-foreground">{item.repo}{item.number === null ? "" : ` #${item.number}`}</span> {item.title}</span>
        {item.note ? <span className="shrink-0 truncate text-[11px] text-muted-foreground" title={item.note}>{item.note}</span> : null}
      </li>)}
    </ul>
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {review ? <>
        <button type="button" className={cn(button, quiet)} onClick={() => actions.onCompose(`request review ${formatTargets(ask.targets)} from @`)}>Request review…</button>
        <button type="button" className={cn(button, quiet)} onClick={() => actions.onAnswer(ask, { numbers: [] })} title={`Sends ${answerCommand(ask, { numbers: [] })}; Undo for 10 s`}>
          Don't request review</button>
      </> : <>
        <button type="button" className={cn(button, "border-foreground/40 bg-foreground/[0.08] hover:bg-foreground/[0.12]")} onClick={() => actions.onAnswer(ask, reply)}
          title={`Sends ${answerCommand(ask, reply)}; Undo for 10 s`}>{selected.length ? `Mark ${formatTargets(selected.map((n) => ({ target: "", n })))} ready` : "Keep all as drafts"}</button>
        {selected.length ? <button type="button" className={cn(button, quiet)} onClick={() => actions.onAnswer(ask, { numbers: [] })}
          title={`Sends ${answerCommand(ask, { numbers: [] })}; Undo for 10 s`}>Keep all as drafts</button> : null}
        <form className="flex items-center gap-1 text-[11px] text-muted-foreground" onSubmit={(event) => { event.preventDefault(); if (field.trim()) actions.onField(ask, field); }}>
          or <input value={field} onChange={(event) => setField(event.target.value)} aria-label={`${ask.id} numbers`} placeholder="13 15 · all · all but 14" maxLength={200}
            className="h-7 w-40 rounded-md border border-input bg-background px-2 font-mono text-[12px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring" />
        </form>
      </>}
    </div>
    <footer className="mt-1.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      <span>{hint ?? (ask.recommended.length ? `Recommended ${formatTargets(ask.recommended.map((n) => ({ target: "", n })))}${ask.decision.recommendation?.reason ? `: ${ask.decision.recommendation.reason}` : ""}`
        : ask.decision.recommendation?.reason ?? "")}</span>
      <ThreadText commands={[field.trim() ? `${ask.id} ${field.trim()}` : answerCommand(ask, review ? { numbers: [] } : reply)]} onCompose={actions.onCompose} />
    </footer>
  </Card>;
}

/** An answer held for Undo: what it sends, a countdown, and Undo (or `u`) until the window closes. */
export function AnswerReceipt({ receipt, now, onUndo }: { receipt: Receipt; now: number; onUndo(receipt: Receipt): void }) {
  const left = Math.max(0, receipt.until - now);
  const seconds = Math.ceil(left / 1_000);
  return <div role="status" data-receipt={receipt.id} className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-foreground/[0.03] px-3 py-1.5 text-[12px]">
    <span aria-hidden className="text-muted-foreground">✓</span><AskKey id={receipt.id} tone="decision" />
    <code className="font-mono text-[11px]">{receipt.text}</code>
    <span className="min-w-0 flex-1 truncate text-muted-foreground">{left > 0 ? `sends in ${seconds}s` : "sending"}{receipt.numbers.length
      ? ` · ${formatTargets(receipt.numbers.map((n) => ({ target: "", n })))} get it in their next step` : ""}</span>
    {left > 0 ? <button type="button" onClick={() => onUndo(receipt)} title="Take this answer back (u); nothing is sent"
      className={cn(button, quiet, "relative h-6 overflow-hidden")}>Undo · {seconds}s
      <span aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 bg-foreground/40" style={{ width: `${Math.round((left / UNDO_WINDOW) * 100)}%` }} /></button> : null}
  </div>;
}

/**
 * A system issue: what failed or paused, which rows it holds, and its recovery commands. The first that drops no claim runs on click or
 * Enter; one that drops a claim (`reset 17 release`) opens a confirmation naming the likely worker thread.
 */
export function IssueCard({ ask, state, focused, now, ...actions }: AskActions & { ask: IssueAsk; state: PaneState; focused: boolean; now: number }) {
  const { issue } = ask;
  const hint = state.hint?.id === ask.id ? state.hint.text : null;
  return <Card ask={ask} focused={focused} onFocusAsk={actions.onFocusAsk}>
    <header className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
      <AskKey id={ask.id} tone="issue" /><span>System issue</span><Numbers numbers={ask.numbers} onFocus={actions.onFocus} />
      <span className="ml-auto">{issue.raisedAt ? `raised ${clock(issue.raisedAt, now)} · ` : ""}recovery, not a decision</span>
    </header>
    <p className="mt-1 text-[13px] font-medium">{issue.label}</p>
    {issue.detail ? <p className="mt-0.5 text-muted-foreground">{issue.detail}</p> : null}
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {issue.recovery.map((recovery) => <button key={recovery.command} type="button" onClick={(event) => { event.stopPropagation(); actions.onRecover(ask, recovery); }}
        title={recovery.confirm ? `Asks you to confirm no worker is writing, then sends ${recovery.command}` : `Sends ${recovery.command}`}
        className={cn(button, recovery === ask.primary ? "border-foreground/40 bg-foreground/[0.08] hover:bg-foreground/[0.12]" : quiet)}>{recovery.label}</button>)}
      {issue.likelyThreadId ? <button type="button" className={cn(button, quiet)} onClick={(event) => { event.stopPropagation(); actions.onOpenThread(issue.likelyThreadId!); }}>
        Open likely thread</button> : null}
    </div>
    <footer className="mt-1.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      <span>{hint ?? (ask.primary ? `Enter sends ${ask.primary.command}` : issue.recovery.length ? "Each recovery here needs your confirmation" : "Nothing recovers this from here")}</span>
      {issue.recovery.length ? <ThreadText commands={issue.recovery.map((recovery) => recovery.command)} onCompose={actions.onCompose} /> : null}
    </footer>
  </Card>;
}

const previewTitle = (ask: MergeAsk) => `Sends ${ask.command}, which merges nothing, and opens a fresh preview; merging there takes ⌘↵ or a click`;
const wakesText = (ask: MergeAsk) => ask.wakes.map((wake) => `merging ${wake.n} wakes ${formatTargets(wake.children.map((n) => ({ target: "", n })))}`).join(" · ");

/** M: the verified merge candidates. Its one action sends `merge N` and opens their fresh preview, where merging is a separate, explicit step. */
export function MergeStrip({ ask, focused, ...actions }: Pick<AskActions, "onFocusAsk" | "onFocus" | "onPreview" | "onCompose"> & { ask: MergeAsk; focused: boolean }) {
  const count = ask.numbers.length;
  return <Card ask={ask} focused={focused} onFocusAsk={actions.onFocusAsk}>
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <AskKey id="M" tone={null} /><span className="font-medium">{count} verified merge {count === 1 ? "candidate" : "candidates"}</span>
      <Numbers numbers={ask.numbers} onFocus={actions.onFocus} />
      <span className="text-[11px] text-muted-foreground">{[wakesText(ask), "separately authorized"].filter(Boolean).join(" · ")}</span>
      <span className="ml-auto inline-flex items-center gap-2 text-[11px] text-muted-foreground">
        <ThreadText commands={[ask.command]} onCompose={actions.onCompose} /><span>· m</span>
        <button type="button" onClick={(event) => { event.stopPropagation(); actions.onPreview(ask); }} title={previewTitle(ask)} className={cn(button, quiet)}>
          Preview merge · {count}</button>
      </span>
    </div>
  </Card>;
}

/** A narrow pane's ask: one line until it's open. A system issue's line carries its first recovery, and M's its preview. */
function AskLine({ ask, focused, onOpen, onRecover, onPreview }: { ask: Ask; focused: boolean; onOpen(): void } & Pick<AskActions, "onRecover" | "onPreview">) {
  const tone = toneOf(ask);
  const [kind, summary] = ask.kind === "issue" ? ["system", ask.issue.label] : ask.kind === "merge" ? ["merge", "verified merge candidates"]
    : [{ authority: "authority", worker: "worker question", product: "product", lifecycle: "lifecycle" }[askKind(ask)], ask.decision.question];
  return <div data-tone={tone ?? undefined} className={cn("flex min-w-0 items-center gap-2 rounded-md border bg-foreground/[0.03] pr-1 text-[12px]",
    tone ? BORDER[tone] : "border-border", focused && "ring-2 ring-ring")}>
    <button type="button" data-roster-ask={ask.id} onClick={onOpen} aria-expanded={false}
      className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <AskKey id={ask.id} tone={tone} /><span className="shrink-0 tabular-nums text-muted-foreground">{ask.numbers.join(" ")}</span>
      <span className="shrink-0 text-muted-foreground">· {kind} ·</span>
      <span className="min-w-0 flex-1 truncate">{summary}</span><span aria-hidden className="text-muted-foreground">›</span>
    </button>
    {ask.kind === "issue" && ask.primary ? <button type="button" onClick={() => onRecover(ask, ask.primary!)} title={`Sends ${ask.primary.command}`}
      className={cn(button, quiet, "h-6 shrink-0")}>{ask.primary.label}</button> : null}
    {ask.kind === "merge" ? <button type="button" onClick={() => onPreview(ask)} title={previewTitle(ask)}
      className={cn(button, quiet, "h-6 shrink-0")}>Preview merge · {ask.numbers.length}</button> : null}
  </div>;
}

/** Every ask, then the receipts. Wide, each card shows in full, two to a row; narrow, one line each and one open at a time. */
export function AsksBlock({ asks, receipts, state, wide, now, ...actions }: AsksProps) {
  if (asks.length === 0 && receipts.length === 0) return null;
  const focused = (ask: Ask) => state.focus !== null && "ask" in state.focus && state.focus.ask === ask.id;
  const card = (ask: Ask) => !wide && state.open !== ask.id
    ? <AskLine key={ask.id} ask={ask} focused={focused(ask)} onOpen={() => actions.onFocusAsk(ask.id)} onRecover={actions.onRecover} onPreview={actions.onPreview} />
    : ask.kind === "merge" ? <MergeStrip key={ask.id} ask={ask} focused={focused(ask)} {...actions} />
    : ask.kind === "issue" ? <IssueCard key={ask.id} ask={ask} state={state} focused={focused(ask)} now={now} {...actions} />
    // A decision's card is keyed by its revision too, so words or numbers typed for a question that changed don't carry over.
    : ask.answer === "subset" ? <LifecycleDecisionCard key={answerKey(ask)} ask={ask} state={state} focused={focused(ask)} {...actions} />
    : <ProductDecisionCard key={answerKey(ask)} ask={ask} state={state} focused={focused(ask)} now={now} {...actions} />;
  const decisions = asks.filter((ask) => ask.kind === "decision");
  const strips = asks.filter((ask) => ask.kind !== "decision");
  return <section aria-label="Asks" className="grid gap-1.5 px-3 pt-2">
    {decisions.length ? <div className={cn("grid gap-1.5", wide && "grid-cols-2")}>{decisions.map(card)}</div> : null}
    {receipts.map((receipt) => <AnswerReceipt key={receipt.requestId} receipt={receipt} now={now} onUndo={actions.onUndo} />)}
    {strips.map(card)}
  </section>;
}
