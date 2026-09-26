import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useComposerView, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { threadEffortMoveScope, type ThreadEffortReady } from "./thread-effort";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { POINTER_CURSORS, cn } from "@/lib/utils";

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function effortLabel(context: ThreadEffortReady): string {
  if (context.sources.length === 0) return "No linked work";
  const assigned = context.sources.filter((source) => source.effortKey !== null);
  const keys = new Set(assigned.map((source) => source.effortKey));
  const unassigned = context.sources.some((source) => source.effortKey === null);
  if (keys.size === 0) return "No effort";
  if (keys.size > 1) return "Multiple efforts";
  const name = assigned[0]?.effortName ?? "Unnamed effort";
  return unassigned ? `${name} + unassigned work` : name;
}

function SourceScope({ source }: { source: ThreadEffortReady["sources"][number] }) {
  const detail = <div className="space-y-1 break-all text-[11px] text-muted-foreground">
    {source.prUrls.length > 0 ? <p>PRs: {source.prUrls.join(", ")}</p> : null}
    {source.checkoutPaths.length > 0 ? <p>Checkouts: {source.checkoutPaths.join(", ")}</p> : null}
  </div>;
  if (source.prUrls.length + source.checkoutPaths.length <= 3) return detail;
  return <details className="text-[11px] text-muted-foreground">
    <summary className="w-fit cursor-pointer hover:text-foreground">Show {source.prUrls.length} {source.prUrls.length === 1 ? "PR" : "PRs"} and {source.checkoutPaths.length} {source.checkoutPaths.length === 1 ? "checkout" : "checkouts"}</summary>
    <div className="pt-1">{detail}</div>
  </details>;
}

/** The composer surface owns the thread id; remount to discard old thread requests. */
export function ThreadEffortControl() {
  const view = useComposerView();
  if (view.scope.kind !== "thread") return null;
  return <ThreadEffortForThread key={view.scope.threadId} threadId={view.scope.threadId} />;
}

function ThreadEffortForThread({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [context, setContext] = useState<ThreadEffortReady | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  // A board event updates the strip, but never changes a choice mid-dialog.
  const [picker, setPicker] = useState<ThreadEffortReady | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [destinationKey, setDestinationKey] = useState("");
  const [effortSearch, setEffortSearch] = useState("");
  const [prSearch, setPrSearch] = useState("");
  const [prUrl, setPrUrl] = useState("");
  const [linkMode, setLinkMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewNeeded, setReviewNeeded] = useState(false);
  const requestId = useRef(0);
  const checkboxPrefix = useId();

  const refetch = useCallback(() => {
    const request = ++requestId.current;
    void rpc.call("thread_effort_context", { threadId }).then((result) => {
      if (request !== requestId.current) return;
      if (result.ok) {
        setContext(result);
        setReadError(null);
      } else {
        setReadError(result.error);
      }
    }, (cause: unknown) => {
      if (request === requestId.current) setReadError(errorMessage(cause));
    });
  }, [rpc, threadId]);

  useEffect(() => {
    refetch();
    return () => { requestId.current++; };
  }, [refetch]);
  useRealtime("board-changed", refetch);

  const openPicker = () => {
    if (context === null) return;
    setPicker(context);
    setSelectedIds(context.sources.length === 1 ? [context.sources[0]!.id] : []);
    setDestinationKey("");
    setEffortSearch("");
    setPrSearch("");
    setPrUrl("");
    setLinkMode(context.sources.length === 0);
    setError(null);
    setReviewNeeded(false);
    setOpen(true);
  };

  const selectedSources = picker?.sources.filter((source) => selectedIds.includes(source.id)) ?? [];
  const invalidSelection = selectedIds.some((id) => !picker?.sources.some((source) => source.id === id));
  const destination = picker?.efforts.find((effort) => effort.key === destinationKey);
  // A matching label can still hide inferred or mixed ownership that needs saving.
  const changed = selectedSources.some((source) => source.effortKey !== destinationKey || !source.explicit);
  const moving = selectedSources.some((source) => source.effortKey !== null && source.effortKey !== destinationKey);
  const actionLabel = moving ? "Move linked work" : "Add to effort";
  const filteredEfforts = useMemo(() => {
    if (picker === null) return [];
    const query = effortSearch.trim().toLocaleLowerCase();
    return picker.efforts.filter((effort) => effort.key === destinationKey || effort.name.toLocaleLowerCase().includes(query));
  }, [destinationKey, effortSearch, picker]);
  const filteredPrs = useMemo(() => {
    if (picker === null) return [];
    const query = prSearch.trim().toLocaleLowerCase();
    return picker.linkablePrs.filter((pr) => pr.url === prUrl || `${pr.label} ${pr.url}`.toLocaleLowerCase().includes(query));
  }, [picker, prSearch, prUrl]);
  const canMove = picker !== null && picker.sources.length > 0 && selectedIds.length > 0 && !invalidSelection && destination !== undefined && changed && !busy && !reviewNeeded;
  const canLink = picker !== null && linkMode && picker.linkablePrs.some((pr) => pr.url === prUrl) && !busy;

  const acceptResult = (result: Awaited<ReturnType<typeof rpc.call<"thread_effort_context">>>) => {
    if (!result.ok) {
      setError(result.error);
      setReviewNeeded(true);
      return;
    }
    requestId.current++;
    setContext(result);
    setReadError(null);
    setOpen(false);
  };

  const move = async () => {
    if (!canMove || picker === null) return;
    const expectedScope = threadEffortMoveScope(picker, selectedIds, destinationKey);
    if (expectedScope === "") return;
    setBusy(true);
    setError(null);
    try {
      acceptResult(await rpc.call("thread_effort_move", { threadId, sourceIds: selectedIds, destinationKey, expectedScope }));
    } catch (cause) {
      setError(errorMessage(cause));
      setReviewNeeded(true);
    } finally {
      setBusy(false);
    }
  };

  const linkPr = async () => {
    if (!canLink) return;
    setBusy(true);
    setError(null);
    try {
      acceptResult(await rpc.call("thread_effort_link_pr", { threadId, prUrl }));
    } catch (cause) {
      setError(errorMessage(cause));
      setReviewNeeded(true);
    } finally {
      setBusy(false);
    }
  };

  const refreshPicker = async () => {
    setBusy(true);
    try {
      const result = await rpc.call("thread_effort_context", { threadId });
      if (!result.ok) { setError(result.error); return; }
      requestId.current++;
      setContext(result);
      setPicker(result);
      setReadError(null);
      setError(null);
      setReviewNeeded(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  if (context === null) return <div className="px-1 pb-1 text-[11px] text-muted-foreground" role="status">{readError === null ? "Reading linked work…" : <button type="button" onClick={refetch} className="text-destructive underline underline-offset-2">Could not read linked work. Retry</button>}</div>;

  return <Dialog open={open} onOpenChange={(next) => { if (busy) return; if (next) openPicker(); else setOpen(false); }}>
    <div className="flex min-w-0 items-center gap-1 px-1 pb-1 text-[11px] text-muted-foreground">
      <DialogTrigger asChild>
        <button type="button" aria-label={`Effort: ${effortLabel(context)}. Change linked work effort`}
          className="inline-flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 outline-none hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          <span className="shrink-0">Effort:</span><span className="truncate font-medium text-foreground">{effortLabel(context)}</span><span aria-hidden="true">⌄</span>
        </button>
      </DialogTrigger>
      {readError === null ? null : <span role="status" title={readError}>Could not refresh effort</span>}
    </div>
    <DialogContent className={cn("max-h-[calc(100dvh-2rem)] max-w-xl overflow-y-auto", POINTER_CURSORS)}>
      <DialogHeader>
        <DialogTitle>{linkMode ? "Link a PR" : "Linked work effort"}</DialogTitle>
        <DialogDescription>{linkMode
          ? "Choose a scanned or inventoried pull request to link to this thread."
          : "Choose the linked work and the effort that should contain it."}</DialogDescription>
      </DialogHeader>
      {picker === null ? null : linkMode ? <div className="space-y-3 text-[12.5px]">
        {picker.linkedPrUrl === null ? null : <p className="break-all text-muted-foreground">Current linked PR: {picker.linkedPrUrl}</p>}
        {picker.linkablePrs.length === 0 ? <p className="text-muted-foreground">No scanned or inventoried PR is available. Refresh the workstreams scan, then reopen this picker.</p> : <label className="grid gap-1.5 font-medium">Known pull request
          {picker.linkablePrs.length > 8 ? <input type="search" value={prSearch} onChange={(event) => setPrSearch(event.target.value)} placeholder="Find a PR by title or URL" disabled={busy}
            className="h-8 w-full rounded-md border border-input bg-background px-2 font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring" /> : null}
          <select value={prUrl} onChange={(event) => setPrUrl(event.target.value)} disabled={busy}
            className="h-9 w-full rounded-md border border-input bg-background px-2 font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <option value="">Choose a PR</option>
            {filteredPrs.map((pr) => <option key={pr.url} value={pr.url}>{pr.label} — {pr.url}</option>)}
          </select>
        </label>}
        {picker.sources.length > 0 ? <button type="button" onClick={() => setLinkMode(false)} className="text-muted-foreground underline underline-offset-2 hover:text-foreground">Back to effort</button> : null}
      </div> : <div className="space-y-4 text-[12.5px]">
        <section aria-label="Linked work" className="space-y-1.5">
          <p className="font-medium">Linked work</p>
          {picker.sources.length > 1 ? <p className="text-[11.5px] text-muted-foreground">Select each ticket or standalone PR to change. Nothing is selected automatically.</p> : null}
          {picker.sources.some((source) => source.kind === "ticket") ? <p className="text-[11.5px] text-muted-foreground">Selecting a ticket includes its related PRs and checkouts.</p> : null}
          <div className="max-h-52 space-y-1.5 overflow-y-auto">
            {picker.sources.map((source, index) => <div key={source.id} className="flex gap-2 rounded-md border border-border px-2.5 py-2">
              <Checkbox id={`${checkboxPrefix}-${index}`} checked={selectedIds.includes(source.id)} disabled={busy} onCheckedChange={(checked) =>
                setSelectedIds((current) => checked === true ? [...current, source.id] : current.filter((id) => id !== source.id))} className="mt-0.5" />
              <div className="min-w-0 flex-1 space-y-1">
                <label htmlFor={`${checkboxPrefix}-${index}`} className="block cursor-pointer space-y-1">
                  <span className="block font-medium">{source.label}</span>
                  {source.ticket === null ? null : <span className="block font-mono text-[11px] text-muted-foreground">Ticket: {source.ticket}</span>}
                  <span className="block text-[11px] text-muted-foreground">{source.effortName === null ? "No effort" : `Currently in ${source.effortName}`}</span>
                </label>
                <SourceScope source={source} />
              </div>
            </div>)}
          </div>
          {invalidSelection ? <p className="text-destructive">Previously selected work changed. <button type="button" onClick={() => setSelectedIds((ids) => ids.filter((id) => picker.sources.some((source) => source.id === id)))} className="underline underline-offset-2">Remove unavailable selection</button></p> : null}
        </section>
        <label className="grid gap-1.5 font-medium">Destination effort
          {picker.efforts.length > 8 ? <input type="search" value={effortSearch} onChange={(event) => setEffortSearch(event.target.value)} placeholder="Find an effort" disabled={busy}
            className="h-8 w-full rounded-md border border-input bg-background px-2 font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring" /> : null}
          <select value={destinationKey} onChange={(event) => setDestinationKey(event.target.value)} disabled={busy || picker.efforts.length === 0}
            className="h-9 w-full rounded-md border border-input bg-background px-2 font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
            <option value="">Choose an effort</option>
            {filteredEfforts.map((effort) => <option key={effort.key} value={effort.key}>{effort.name}</option>)}
          </select>
        </label>
        {picker.efforts.length === 0 ? <p className="text-muted-foreground">No efforts are available for this work.</p> : null}
        {destination !== undefined && selectedSources.length > 0 && !changed ? <p className="text-muted-foreground">The selected work is already in {destination.name}.</p> : null}
        {picker.linkedPrUrl !== null ? <button type="button" onClick={() => setLinkMode(true)} className="text-[11.5px] text-muted-foreground underline underline-offset-2 hover:text-foreground">Change linked PR</button> : null}
      </div>}
      {error === null ? null : <p role="alert" className="text-[12.5px] text-destructive">{error}</p>}
      {reviewNeeded ? <Button variant="outline" size="sm" disabled={busy} onClick={() => void refreshPicker()}>Refresh details</Button> : null}
      <DialogFooter className="gap-2">
        <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
        {linkMode ? <Button disabled={!canLink} onClick={() => void linkPr()}>{busy ? "Linking…" : "Link a PR"}</Button>
          : <Button disabled={!canMove} onClick={() => void move()}>{busy ? "Saving…" : actionLabel}</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
