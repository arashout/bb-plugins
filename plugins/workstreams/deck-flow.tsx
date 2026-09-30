// What the effort deck and All PRs share at the SDK layer (plan amendment
// A15): the dialog frame that never starts on a write button and hands focus
// back where it came from, the batch flow (plan, listing confirm, delayed
// send, Undo), and the one key registry's handler.
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { DeckWrite } from "./deck-shared";
import { ACTION, actionForKey, typingTarget, type DeckActionId } from "./deck-keys";
import { SECTIONS, type Availability } from "./deck-view-model";
import { ConfirmBody, type ConfirmPlan } from "./deck-screen";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./components/ui/dialog";
import { cn, POINTER_CURSORS } from "./lib/utils";

export const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
/** The last thing Undo takes back: a batch still waiting to send, a classification, or a pile move. */
export type Undo = { label: string; run(): Promise<void>; live(): boolean };

/** One dialog frame: focus starts on its first field or on the dialog itself, never on a write button, and `onReturn` puts it back. */
export function DeckDialog({ open, title, sub, wide, bare, closeKey, onClose, onReturn, onConfirmKey, children }: { open: boolean; title: string; sub?: string; wide?: boolean;
  bare?: boolean; closeKey?: string; onClose(): void; onReturn(): void; onConfirmKey?: () => void; children: ReactNode }) {
  const content = useRef<HTMLDivElement | null>(null);
  return <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
    <DialogContent ref={content} hideCloseButton className={cn("max-h-[calc(100dvh-2rem)] overflow-y-auto", wide ? "max-w-3xl" : "max-w-lg", bare && "gap-0 p-0", POINTER_CURSORS)}
      onOpenAutoFocus={(event) => { event.preventDefault(); (content.current?.querySelector<HTMLElement>("input:not([type=checkbox]), textarea, select") ?? content.current)?.focus(); }}
      onCloseAutoFocus={(event) => { event.preventDefault(); onReturn(); }} onAfterCloseAutoFocus={onReturn}
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && onConfirmKey) { event.preventDefault(); onConfirmKey(); }
        else if (closeKey && event.key === closeKey && !typingTarget(event.target)) { event.preventDefault(); onClose(); }
      }}>
      <DialogHeader className={bare ? "sr-only" : undefined}><DialogTitle>{title}</DialogTitle>{sub ? <DialogDescription>{sub}</DialogDescription> : null}</DialogHeader>
      {children}
    </DialogContent>
  </Dialog>;
}

const VERB: Record<DeckWrite | "advance", string> = { nudge: "Nudge", request: "Request", ready: "Mark ready", release: "Release", ask: "Ask", fix: "Ask", advance: "Run" };
type Pending = { plan: ConfirmPlan; batchId: string; request: { kind: DeckWrite | "advance"; effortId: string | null; prUrls: string[] | null }; reviewer: string;
  /** The reviewer field as the listing was planned: another name typed there sends nothing until it plans again. */
  planned: string };

/**
 * Every GitHub write from the deck or All PRs: plan it (nothing is written), list each PR in a confirm, and send it only after the
 * server's Undo window. `reread` is anything that changes with each read, so refusals from batches this view started show on their rows.
 */
export function useBatchConfirm(options: { seenAt(): Record<string, number>; scopeName(effortId: string): string | null; say(text: string, undo?: boolean, ms?: number): void;
  setUndo(undo: Undo | null): void; load(): void; onOpen(): void; onReturn(): void; reread: unknown }) {
  const rpc = useRpc<typeof rpcContract>();
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [batches, setBatches] = useState<readonly string[]>([]);
  const [details, setDetails] = useState<ReadonlyMap<string, string>>(new Map());
  const latest = useRef(options);
  latest.current = options;

  const plan = useCallback(async (kind: DeckWrite | "advance", effortId: string | null, prUrls: string[] | null, reviewer = "") => {
    const { say } = latest.current;
    const reviewers = reviewer.trim() ? reviewer.split(/[\s,]+/u).map((login) => login.replace(/^@/u, "")).filter(Boolean) : undefined;
    const result = await rpc.call("deck_batch_plan", { kind, ...effortId ? { effortId } : {}, ...prUrls ? { prUrls } : {}, ...reviewers ? { reviewers } : {},
      seen: latest.current.seenAt() }).catch((cause: unknown) => ({ ok: false as const, error: message(cause) }));
    const open = pending !== null;
    if (!result.ok) { if (open) setError(result.error); else say(result.error); return; }
    if (!result.batchId) { const first = result.skipped[0]; const why = first ? `${first.ref}: ${first.reason}` : "Nothing to send here."; if (open) setError(why); else say(why); return; }
    // One PR's listing names it: Advance from a row reads "Advance folio #340".
    const one = prUrls?.length === 1 ? result.items[0]?.ref ?? result.skipped[0]?.ref : undefined;
    const scope = one ?? (effortId ? latest.current.scopeName(effortId) ?? "this effort" : `${prUrls?.length ?? 0} PR${prUrls?.length === 1 ? "" : "s"}`);
    if (!open) latest.current.onOpen();
    setError(null); setBusy(false);
    setPending({ batchId: result.batchId, request: { kind, effortId, prUrls }, reviewer, planned: reviewer, plan: {
      title: kind === "advance" ? `Advance ${scope}` : kind === "release" ? `Release · ${scope}` : kind === "ask" ? `Ask its thread · ${scope}`
        : kind === "fix" ? `Ask threads to fix · ${scope}` : `${SECTIONS[kind].title} · ${scope}`,
      sub: kind === "advance" ? `${result.items.length} action${result.items.length === 1 ? "" : "s"}, listed in full. Nothing else changes.`
        : kind === "release" ? "Each hold, listed in full. Batches and Advance can act on these again."
        : kind === "ask" ? "The listed thread gets the approval-feedback recipe. Nothing is confirmed."
        : kind === "fix" ? "Each PR's thread gets its own fix; a PR with none gets a new worker. Nothing merges." : "Each PR's one write, listed in full.",
      when: kind === "release" ? "Releases" : "Sends",
      verb: VERB[kind], items: result.items, skipped: result.skipped, request: kind === "request" || (kind === "advance" && result.items.some((item) => item.kind === "request")),
      excluded: kind === "advance" ? "Not included: merges (preview them with m) and code work, which each PR's thread does." : null } });
  }, [rpc, pending]);

  const dirty = !!pending && pending.reviewer.trim() !== pending.planned.trim();
  const start = useCallback(async () => {
    if (!pending || busy) return;
    // ⌘↵ after typing another reviewer plans again rather than send a listing that asks someone else.
    if (dirty) { void plan(pending.request.kind, pending.request.effortId, pending.request.prUrls, pending.reviewer); return; }
    const { say, setUndo, load } = latest.current;
    setBusy(true);
    const { batchId, plan: listed } = pending;
    const started = await rpc.call("deck_batch_start", { batchId }).catch((cause: unknown) => ({ ok: false as const, error: message(cause) }));
    if (!started.ok) { setError(started.error); setBusy(false); return; }
    setPending(null);
    setBatches((current) => [...current, batchId]);
    const { dispatchAt } = started;
    setUndo({ label: listed.title, live: () => Date.now() < dispatchAt, run: async () => {
      const undone = await rpc.call("deck_batch_undo", { batchId }).catch((cause: unknown) => ({ ok: false as const, error: message(cause) }));
      latest.current.say(undone.ok ? "Undone. Nothing was sent." : undone.error);
      latest.current.load();
    } });
    // The line and its Undo go when the window closes, since an Undo after that takes nothing back.
    say(`${listed.verb} ${listed.items.length} · sends in ${Math.max(1, Math.round((dispatchAt - Date.now()) / 1_000))} s`, true, Math.max(0, dispatchAt - Date.now()));
    load();
  }, [rpc, pending, busy, dirty, plan]);

  // What a refused or cut-off write said, from the batches this view started, until each is done.
  useEffect(() => {
    let live = true;
    for (const batchId of batches) void rpc.call("deck_batch_get", { batchId }).then((batch) => {
      if (!live || !batch) return;
      const said = batch.items.filter((item) => (item.state === "refused" || item.state === "unknown") && item.detail);
      if (said.length) setDetails((current) => new Map([...current, ...said.map((item) => [item.prUrl, item.detail!] as const)]));
      if (batch.state !== "done" && batch.state !== "cancelled") return;
      setBatches((current) => current.filter((id) => id !== batchId));
      const sent = batch.items.filter((item) => item.state === "sent").length;
      if (batch.state === "done") latest.current.say([`${sent} sent`, batch.items.length - sent && `${batch.items.length - sent} not sent`].filter(Boolean).join(" · "));
    }, () => undefined);
    return () => { live = false; };
  }, [options.reread, batches, rpc]);

  const element = <DeckDialog open={pending !== null} title={pending?.plan.title ?? ""} sub={pending?.plan.sub} onClose={() => setPending(null)} onReturn={options.onReturn}
    onConfirmKey={() => void start()}>
    {pending ? <ConfirmBody plan={pending.plan} busy={busy} error={error} reviewer={pending.reviewer} dirty={dirty} onReviewer={(value) => setPending({ ...pending, reviewer: value })}
      onReplan={() => void plan(pending.request.kind, pending.request.effortId, pending.request.prUrls, pending.reviewer)} onConfirm={() => void start()}
      onCancel={() => setPending(null)} /> : null}
  </DeckDialog>;
  return { plan, details, open: pending !== null, element };
}

/**
 * The one key registry's handler for a view: only while focus is in `root` (or nowhere), never while you type (⌘K aside), and a key
 * that can't run here says why in the hint bar. Enter opens a row's details only on the row itself; on a button it's that button's click.
 */
export function useRegistryKeys(rootRef: RefObject<HTMLElement | null>, handlers: { on(): Availability; run(id: DeckActionId, n?: number): void; say(text: string): void;
  isRow(target: HTMLElement): boolean }) {
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const root = rootRef.current;
      const active = document.activeElement;
      if (!root || (active && active !== document.body && !root.contains(active))) return;
      const hit = actionForKey(event);
      const typing = typingTarget(event.target);
      if (event.key === "Escape") { if (hit && !typing) { event.preventDefault(); latest.current.run("clear"); } return; }
      if (!hit || (typing && hit.id !== "palette")) return;
      if (hit.id === "expand" && !(event.target instanceof HTMLElement && latest.current.isRow(event.target))) return;
      event.preventDefault();
      const available = latest.current.on()[hit.id];
      if (available.on) latest.current.run(hit.id, hit.n);
      else if (available.why && available.why !== "you're here") latest.current.say(`${ACTION[hit.id].title.replace("…", "")}: ${available.why}.`);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rootRef]);
}
