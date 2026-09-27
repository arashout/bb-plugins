import { useEffect, useMemo, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { cardEffortMoveScope, type CardEffortReady } from "./card-effort";
import type { PipelineCard } from "./pipeline";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { POINTER_CURSORS, cn } from "@/lib/utils";

type CardTarget = { prUrl: string } | { path: string };

function targetFor(card: PipelineCard | null): CardTarget | null {
  if (card?.pr) return { prUrl: card.pr.url };
  if (card?.local) return { path: card.local.unit.path };
  return null;
}

function failure(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function prLabel(url: string): string {
  const match = url.match(/\/([^/]+\/[^/]+)\/pull\/(\d+)(?:[/?#]|$)/);
  return match ? `${match[1]} #${match[2]}` : url;
}

function ScopeDetails({ context }: { context: CardEffortReady }) {
  const { tickets, prUrls, checkoutPaths } = context.affected;
  const count = tickets.length + prUrls.length + checkoutPaths.length;
  return <section aria-label="Affected work" className="min-w-0 space-y-1.5 rounded-md border border-border p-2.5 text-[11.5px]">
    <p className="font-medium text-foreground">Affected work</p>
    <p className="text-muted-foreground">{count === 0 ? "No linked work was found." : "These linked items move together."}</p>
    {tickets.length > 0 ? <div className="min-w-0"><p className="text-muted-foreground">{tickets.length === 1 ? "Ticket" : "Tickets"}</p><ul className="space-y-0.5">{tickets.map((ticket) => <li key={ticket} className="break-words font-mono">{ticket}</li>)}</ul></div> : null}
    {prUrls.length > 0 ? <div className="min-w-0"><p className="text-muted-foreground">{prUrls.length === 1 ? "Pull request" : "Pull requests"}</p><ul className="space-y-0.5">{prUrls.map((url) => <li key={url} title={url} className="line-clamp-2 break-words"><span className="font-medium">{prLabel(url)}</span>{context.prTitles[url] ? ` · ${context.prTitles[url]}` : null}</li>)}</ul></div> : null}
    {checkoutPaths.length > 0 ? <div className="min-w-0"><p className="text-muted-foreground">{checkoutPaths.length === 1 ? "Checkout" : "Checkouts"}</p><ul className="space-y-0.5">{checkoutPaths.map((path) => <li key={path} title={path} className="break-words">{path.split(/[\\/]/).filter(Boolean).at(-1) ?? path}</li>)}</ul></div> : null}
  </section>;
}

export function PipelineCardEffortDialog({ card, onClose }: { card: PipelineCard | null; onClose: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const target = targetFor(card);
  const targetKey = target === null ? null : "prUrl" in target ? `pr:${target.prUrl}` : `path:${target.path}`;
  const [context, setContext] = useState<CardEffortReady | null>(null);
  const [destinationKey, setDestinationKey] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewNeeded, setReviewNeeded] = useState(false);
  const sequence = useRef(0);
  const saving = useRef(false);

  useEffect(() => {
    const request = ++sequence.current;
    setContext(null);
    setDestinationKey("");
    setSearch("");
    setError(null);
    setReviewNeeded(false);
    setLoading(target !== null);
    setBusy(false);
    if (target === null) return;
    void rpc.call("card_effort_context", target).then((result) => {
      if (sequence.current !== request) return;
      if (result.ok) setContext(result);
      else setError(result.error);
      setLoading(false);
    }, (cause: unknown) => {
      if (sequence.current !== request) return;
      setError(failure(cause));
      setLoading(false);
    });
    return () => { sequence.current++; };
  }, [rpc, targetKey]);

  const efforts = useMemo(() => {
    if (context === null) return [];
    const query = search.trim().toLocaleLowerCase();
    return context.efforts.filter((effort) => effort.key === destinationKey || effort.name.toLocaleLowerCase().includes(query));
  }, [context, destinationKey, search]);
  const selected = context?.efforts.find((effort) => effort.key === destinationKey);
  const changed = context !== null && (context.source.effortKey !== destinationKey || !context.source.explicit);
  const canSave = target !== null && context !== null && context.canMove && selected !== undefined && changed && !busy && !loading && !reviewNeeded;

  const refresh = async () => {
    if (target === null || busy || loading) return;
    const request = ++sequence.current;
    setLoading(true);
    setError(null);
    try {
      const result = await rpc.call("card_effort_context", target);
      if (sequence.current !== request) return;
      if (!result.ok) { setError(result.error); return; }
      setContext(result);
      setReviewNeeded(false);
      if (destinationKey && !result.efforts.some((effort) => effort.key === destinationKey)) {
        setDestinationKey("");
        setError("The selected effort is no longer available. Choose another effort.");
      } else if (reviewNeeded) {
        setError("Details refreshed. Review the affected work, then save again.");
      }
    } catch (cause) {
      if (sequence.current === request) setError(failure(cause));
    } finally {
      if (sequence.current === request) setLoading(false);
    }
  };

  const save = async () => {
    if (!canSave || saving.current || target === null || context === null) return;
    const expectedScope = cardEffortMoveScope(context, destinationKey);
    if (!expectedScope) return;
    const request = sequence.current;
    saving.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await rpc.call("card_effort_move", { target, destinationKey, expectedScope });
      if (sequence.current !== request) return;
      if (!result.ok) { setError(result.error); setReviewNeeded(true); return; }
      onClose();
    } catch (cause) {
      if (sequence.current === request) { setError(failure(cause)); setReviewNeeded(true); }
    } finally {
      saving.current = false;
      if (sequence.current === request) setBusy(false);
    }
  };

  return <Dialog open={card !== null} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogContent className={cn("max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-[430px] overflow-y-auto", POINTER_CURSORS)}>
      <DialogHeader className="min-w-0">
        <DialogTitle>Change card effort</DialogTitle>
        <DialogDescription className="break-words">{card === null ? null : `${card.repo}${card.pr ? ` #${card.pr.number}` : ""} · ${card.title}`}</DialogDescription>
      </DialogHeader>
      {loading && context === null ? <p role="status" className="text-[12px] text-muted-foreground">Reading linked work…</p> : null}
      {context !== null ? <div className="min-w-0 space-y-3 text-[12px]">
        <p>Current effort: <span className="font-medium">{context.source.effortKey === null ? "One-offs" : context.source.effortName ?? "Unnamed effort"}</span></p>
        {context.notice ? <p role="status" className="text-muted-foreground">{context.notice}</p> : null}
        <ScopeDetails context={context} />
        <label className="grid min-w-0 gap-1.5 font-medium">Destination effort
          {context.efforts.length > 8 ? <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find an effort" disabled={busy || loading}
            className="h-8 w-full min-w-0 rounded-md border border-input bg-background px-2 font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring" /> : null}
          <select value={destinationKey} onChange={(event) => { setDestinationKey(event.target.value); setError(null); }} disabled={busy || loading || !context.canMove || context.efforts.length === 0}
            className="h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
            <option value="">Choose an effort</option>
            {efforts.map((effort) => <option key={effort.key} value={effort.key}>{effort.name}</option>)}
          </select>
        </label>
        {context.efforts.length === 0 ? <p className="text-muted-foreground">No efforts are available.</p> : null}
        {selected && !changed ? <p className="text-muted-foreground">This work is already in {selected.name}.</p> : null}
      </div> : null}
      {error ? <p role="alert" className="break-words text-[12px] text-destructive">{error}</p> : null}
      {reviewNeeded || (context === null && !loading && error) ? <Button variant="outline" size="sm" disabled={busy || loading} onClick={() => void refresh()}>Refresh details</Button> : null}
      <DialogFooter className="gap-2">
        <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
        <Button disabled={!canSave} onClick={() => void save()}>{busy ? "Saving…" : context?.source.effortKey === null ? "Add to effort" : "Move to effort"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
