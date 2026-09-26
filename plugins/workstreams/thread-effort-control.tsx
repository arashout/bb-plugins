import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useComposerView, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { threadEffortAssignmentScope, threadEffortMoveScope, type ThreadEffortReady } from "./thread-effort";
import type { ThreadEffortSuggestions } from "./thread-effort-suggestions";
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

type PickerMode = "thread" | "create" | "move" | "link";

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
  const [threadDestinationKey, setThreadDestinationKey] = useState("");
  const [moveDestinationKey, setMoveDestinationKey] = useState("");
  const [effortSearch, setEffortSearch] = useState("");
  const [prSearch, setPrSearch] = useState("");
  const [prUrl, setPrUrl] = useState("");
  const [createName, setCreateName] = useState("");
  const [suggestions, setSuggestions] = useState<ThreadEffortSuggestions | null>(null);
  const [suggestionError, setSuggestionError] = useState<string | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [mode, setMode] = useState<PickerMode>("thread");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewNeeded, setReviewNeeded] = useState(false);
  const requestId = useRef(0);
  const suggestionRequestId = useRef(0);
  const createRequest = useRef<{ name: string; id: string } | null>(null);
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
    return () => { requestId.current++; suggestionRequestId.current++; };
  }, [refetch]);
  useRealtime("board-changed", refetch);

  const openPicker = () => {
    if (context === null) return;
    suggestionRequestId.current++;
    setPicker(context);
    setSelectedIds(context.sources.length === 1 ? [context.sources[0]!.id] : []);
    setThreadDestinationKey(context.threadEffort?.key ?? "");
    setMoveDestinationKey("");
    setEffortSearch("");
    setPrSearch("");
    setPrUrl("");
    setCreateName("");
    createRequest.current = null;
    setSuggestions(null);
    setSuggestionError(null);
    setSuggesting(false);
    setMode("thread");
    setError(null);
    setReviewNeeded(false);
    setOpen(true);
  };

  const selectedSources = picker?.sources.filter((source) => selectedIds.includes(source.id)) ?? [];
  const invalidSelection = selectedIds.some((id) => !picker?.sources.some((source) => source.id === id));
  const threadDestination = picker?.efforts.find((effort) => effort.key === threadDestinationKey);
  const moveDestination = picker?.efforts.find((effort) => effort.key === moveDestinationKey);
  // A matching label can still hide inferred or mixed ownership that needs saving.
  const changed = selectedSources.some((source) => source.effortKey !== moveDestinationKey || !source.explicit);
  const moving = selectedSources.some((source) => source.effortKey !== null && source.effortKey !== moveDestinationKey);
  const actionLabel = moving ? "Move linked work" : "Add to effort";
  const effortSelection = mode === "thread" ? threadDestinationKey : moveDestinationKey;
  const filteredEfforts = useMemo(() => {
    if (picker === null) return [];
    const query = effortSearch.trim().toLocaleLowerCase();
    return picker.efforts.filter((effort) => effort.key === effortSelection || effort.name.toLocaleLowerCase().includes(query));
  }, [effortSelection, effortSearch, picker]);
  const filteredPrs = useMemo(() => {
    if (picker === null) return [];
    const query = prSearch.trim().toLocaleLowerCase();
    return picker.linkablePrs.filter((pr) => pr.url === prUrl || `${pr.label} ${pr.url}`.toLocaleLowerCase().includes(query));
  }, [picker, prSearch, prUrl]);
  const canSetThread = picker !== null && threadDestination !== undefined && picker.threadEffort?.key !== threadDestinationKey && !busy && !reviewNeeded;
  const canClearThread = picker !== null && picker.threadEffort !== null && !busy && !reviewNeeded;
  const canMove = picker !== null && picker.sources.length > 0 && selectedIds.length > 0 && !invalidSelection && moveDestination !== undefined && changed && !busy && !reviewNeeded;
  const canLink = picker !== null && mode === "link" && picker.linkablePrs.some((pr) => pr.url === prUrl) && !busy && !reviewNeeded;
  const validCreateName = createName.trim().length > 0 && createName.trim().length <= 120;
  const canCreate = picker !== null && validCreateName && !busy && !reviewNeeded;
  const availableSuggestions = suggestions?.suggestions.filter((suggestion) => picker?.efforts.some((effort) => effort.key === suggestion.key)).slice(0, 3) ?? [];

  const switchMode = (next: PickerMode) => {
    setMode(next);
    setEffortSearch("");
    if (!reviewNeeded) setError(null);
  };

  const openCreate = (name = "") => {
    setCreateName(name);
    createRequest.current = null;
    switchMode("create");
  };

  const suggestEfforts = async () => {
    if (picker === null || suggesting || busy) return;
    const request = ++suggestionRequestId.current;
    setSuggesting(true);
    setSuggestionError(null);
    setSuggestions(null);
    try {
      const result = await rpc.call("thread_effort_suggest", { threadId });
      if (request !== suggestionRequestId.current) return;
      if (result.ok) setSuggestions(result);
      else setSuggestionError(result.error);
    } catch (cause) {
      if (request === suggestionRequestId.current) setSuggestionError(errorMessage(cause));
    } finally {
      if (request === suggestionRequestId.current) setSuggesting(false);
    }
  };

  const acceptResult = (result: Awaited<ReturnType<typeof rpc.call<"thread_effort_context">>>) => {
    if (!result.ok) {
      setError(result.error);
      setReviewNeeded(true);
      return;
    }
    requestId.current++;
    suggestionRequestId.current++;
    setContext(result);
    setReadError(null);
    setOpen(false);
  };

  const move = async () => {
    if (!canMove || picker === null) return;
    const expectedScope = threadEffortMoveScope(picker, selectedIds, moveDestinationKey);
    if (expectedScope === "") return;
    setBusy(true);
    setError(null);
    try {
      acceptResult(await rpc.call("thread_effort_move", { threadId, sourceIds: selectedIds, destinationKey: moveDestinationKey, expectedScope }));
    } catch (cause) {
      setError(errorMessage(cause));
      setReviewNeeded(true);
    } finally {
      setBusy(false);
    }
  };

  const setThreadEffort = async (destinationKey: string | null) => {
    if (picker === null || busy || reviewNeeded || (destinationKey === null ? !canClearThread : !canSetThread)) return;
    const expectedScope = threadEffortAssignmentScope(picker, destinationKey);
    if (expectedScope === "") return;
    setBusy(true);
    setError(null);
    try {
      acceptResult(await rpc.call("thread_effort_set", { threadId, destinationKey, expectedScope }));
    } catch (cause) {
      setError(errorMessage(cause));
      setReviewNeeded(true);
    } finally {
      setBusy(false);
    }
  };

  const createEffort = async () => {
    if (!canCreate || picker === null) return;
    const name = createName.trim();
    const expectedScope = threadEffortAssignmentScope(picker, null);
    if (expectedScope === "") return;
    if (createRequest.current?.name !== name) createRequest.current = { name, id: crypto.randomUUID() };
    setBusy(true);
    setError(null);
    try {
      acceptResult(await rpc.call("thread_effort_create", { threadId, name, requestId: createRequest.current.id, expectedScope }));
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
      suggestionRequestId.current++;
      setSuggestions(null);
      setSuggestionError(null);
      setSuggesting(false);
      setThreadDestinationKey((current) => result.efforts.some((effort) => effort.key === current) ? current : (result.threadEffort?.key ?? ""));
      setReadError(null);
      setError(null);
      setReviewNeeded(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  if (context === null) return <div className="px-1 pb-1 text-[11px] text-muted-foreground" role="status">{readError === null ? "Reading thread effort…" : <button type="button" onClick={refetch} className="text-destructive underline underline-offset-2">Could not read thread effort. Retry</button>}</div>;

  return <Dialog open={open} onOpenChange={(next) => { if (busy) return; if (next) openPicker(); else { suggestionRequestId.current++; setOpen(false); } }}>
    <div className="flex min-w-0 items-center gap-1 px-1 pb-1 text-[11px] text-muted-foreground">
      <DialogTrigger asChild>
        <button type="button" aria-label={`Effort: ${context.threadEffort?.name ?? "No thread effort"}. Change thread effort`}
          className="inline-flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 outline-none hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          <span className="shrink-0">Effort:</span><span className="truncate font-medium text-foreground">{context.threadEffort?.name ?? "No thread effort"}</span><span aria-hidden="true">⌄</span>
        </button>
      </DialogTrigger>
      {readError === null ? null : <span role="status" title={readError}>Could not refresh effort</span>}
    </div>
    <DialogContent className={cn("max-h-[calc(100dvh-2rem)] max-w-xl overflow-y-auto", POINTER_CURSORS)}>
      <DialogHeader>
        <DialogTitle>{mode === "thread" ? "Thread effort" : mode === "create" ? "Create effort" : mode === "move" ? "Move linked work" : "Link a PR"}</DialogTitle>
        <DialogDescription>{mode === "thread"
          ? "Confirmed, unassigned work in this thread inherits this effort. Existing assignments stay intact."
          : mode === "create" ? "Creates an effort and assigns this thread. Confirmed, unassigned work inherits it."
          : mode === "move" ? "Choose the linked work and the effort that should contain it."
          : "Choose a scanned or inventoried pull request to link to this thread."}</DialogDescription>
      </DialogHeader>
      {picker === null ? null : mode === "create" ? <div className="space-y-3 text-[12.5px]">
        <label className="grid gap-1.5 font-medium">Effort name
          <input type="text" value={createName} maxLength={120} required autoFocus disabled={busy}
            onChange={(event) => { setCreateName(event.target.value); createRequest.current = null; }}
            className="h-9 w-full rounded-md border border-input bg-background px-2 font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring" />
        </label>
        <button type="button" onClick={() => switchMode("thread")} disabled={busy} className="text-muted-foreground underline underline-offset-2 hover:text-foreground">Back to thread effort</button>
      </div> : mode === "link" ? <div className="space-y-3 text-[12.5px]">
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
        <button type="button" onClick={() => switchMode("thread")} disabled={busy} className="text-muted-foreground underline underline-offset-2 hover:text-foreground">Back to thread effort</button>
      </div> : mode === "thread" ? <div className="space-y-4 text-[12.5px]">
        <label className="grid gap-1.5 font-medium">Thread effort
          {picker.efforts.length > 8 ? <input type="search" value={effortSearch} onChange={(event) => setEffortSearch(event.target.value)} placeholder="Find an effort" disabled={busy}
            className="h-8 w-full rounded-md border border-input bg-background px-2 font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring" /> : null}
          <select value={threadDestinationKey} onChange={(event) => setThreadDestinationKey(event.target.value)} disabled={busy || picker.efforts.length === 0}
            className="h-9 w-full rounded-md border border-input bg-background px-2 font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
            <option value="">Choose an effort</option>
            {filteredEfforts.map((effort) => <option key={effort.key} value={effort.key}>{effort.name}</option>)}
          </select>
        </label>
        {picker.efforts.length === 0 ? <p className="text-muted-foreground">No efforts are available for this thread.</p> : null}
        <div className="space-y-2 text-[11.5px]">
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <button type="button" onClick={() => void suggestEfforts()} disabled={busy || suggesting || reviewNeeded}
              className="text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-50">{suggesting ? "Suggesting…" : "Suggest efforts"}</button>
            <button type="button" onClick={() => openCreate()} disabled={busy}
              className="text-muted-foreground underline underline-offset-2 hover:text-foreground">Create effort</button>
          </div>
          {suggestionError === null ? null : <p role="status" className="text-muted-foreground">Could not suggest efforts: {suggestionError}</p>}
          {suggestions === null ? null : <div className="space-y-1.5" aria-label="Suggested efforts">
            {availableSuggestions.map((suggestion) => {
              const effort = picker.efforts.find((candidate) => candidate.key === suggestion.key)!;
              return <button key={suggestion.key} type="button" onClick={() => setThreadDestinationKey(suggestion.key)} disabled={busy}
                className="block w-full break-all rounded-md border border-border px-2.5 py-2 text-left hover:bg-foreground/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <span className="block font-medium text-foreground">{effort.name}</span>
                <span className="block text-muted-foreground">{suggestion.reason}</span>
              </button>;
            })}
            {suggestions.suggestedName === null ? null : <button type="button" onClick={() => openCreate(suggestions.suggestedName!)} disabled={busy}
              className="break-all text-left text-muted-foreground underline underline-offset-2 hover:text-foreground">Create “{suggestions.suggestedName}”</button>}
            {suggestions.notice === null ? null : <p role="status" className="text-muted-foreground">{suggestions.notice}</p>}
          </div>}
        </div>
        {picker.threadEffort !== null && threadDestinationKey === picker.threadEffort.key ? <p className="text-muted-foreground">This thread is already assigned to {picker.threadEffort.name}.</p> : null}
        {picker.inheritanceNotice === null ? null : <p role="status" className="text-muted-foreground">{picker.inheritanceNotice}</p>}
        <section aria-label="Linked work details" className="space-y-1.5">
          <p className="text-muted-foreground">Linked work: {effortLabel(picker)}</p>
          {picker.sources.length > 0 ? <details className="text-muted-foreground">
            <summary className="w-fit cursor-pointer hover:text-foreground">Show linked work details</summary>
            <div className="max-h-52 space-y-2 overflow-y-auto pt-2">
              {picker.sources.map((source) => <div key={source.id} className="rounded-md border border-border px-2.5 py-2">
                <p className="font-medium text-foreground">{source.label}</p>
                {source.ticket === null ? null : <p className="font-mono text-[11px]">Ticket: {source.ticket}</p>}
                <p className="text-[11px]">{source.effortName === null ? "No effort" : `Currently in ${source.effortName}`}</p>
                <SourceScope source={source} />
              </div>)}
            </div>
          </details> : null}
        </section>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11.5px]">
          {picker.sources.length > 0 ? <button type="button" onClick={() => switchMode("move")} disabled={busy} className="text-muted-foreground underline underline-offset-2 hover:text-foreground">Move linked work</button> : null}
          <button type="button" onClick={() => switchMode("link")} disabled={busy} className="text-muted-foreground underline underline-offset-2 hover:text-foreground">{picker.linkedPrUrl === null ? "Link a PR" : "Change linked PR"}</button>
        </div>
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
          <select value={moveDestinationKey} onChange={(event) => setMoveDestinationKey(event.target.value)} disabled={busy || picker.efforts.length === 0}
            className="h-9 w-full rounded-md border border-input bg-background px-2 font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
            <option value="">Choose an effort</option>
            {filteredEfforts.map((effort) => <option key={effort.key} value={effort.key}>{effort.name}</option>)}
          </select>
        </label>
        {picker.efforts.length === 0 ? <p className="text-muted-foreground">No efforts are available for this work.</p> : null}
        {moveDestination !== undefined && selectedSources.length > 0 && !changed ? <p className="text-muted-foreground">The selected work is already in {moveDestination.name}.</p> : null}
        <button type="button" onClick={() => switchMode("thread")} disabled={busy} className="text-[11.5px] text-muted-foreground underline underline-offset-2 hover:text-foreground">Back to thread effort</button>
      </div>}
      {error === null ? null : <p role="alert" className="text-[12.5px] text-destructive">{error}</p>}
      {reviewNeeded ? <Button variant="outline" size="sm" disabled={busy} onClick={() => void refreshPicker()}>Refresh details</Button> : null}
      <DialogFooter className="gap-2">
        <Button variant="ghost" disabled={busy} onClick={() => { suggestionRequestId.current++; setOpen(false); }}>Cancel</Button>
        {mode === "link" ? <Button disabled={!canLink} onClick={() => void linkPr()}>{busy ? "Linking…" : "Link a PR"}</Button>
          : mode === "move" ? <Button disabled={!canMove} onClick={() => void move()}>{busy ? "Saving…" : actionLabel}</Button>
          : mode === "create" ? <Button disabled={!canCreate} onClick={() => void createEffort()}>{busy ? "Creating…" : "Create and assign"}</Button>
          : <>
            {picker !== null && picker.threadEffort !== null ? <Button variant="outline" disabled={!canClearThread} onClick={() => void setThreadEffort(null)}>Clear thread effort</Button> : null}
            <Button disabled={!canSetThread} onClick={() => void setThreadEffort(threadDestinationKey)}>{busy ? "Saving…" : "Save thread effort"}</Button>
          </>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
