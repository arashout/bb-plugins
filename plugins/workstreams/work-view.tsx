import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { UrlLink, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { Board, rpcContract } from "./server";
import type { WorkConversation } from "./work-conversation";
import { inboxRows } from "./inbox-rows";
import { pipelineCards, pipelineEfforts, type PipelineCard } from "./pipeline";
import { useAdvanceBatches } from "./bulk-advance-view";
import { PipelineConversationPanel, type ConversationPanelRequest } from "./pipeline-conversation-panel";
import { PipelineAgentSheet, type PipelineAgentRequest } from "./pipeline-agent-sheet";
import { ActionDialogs, type ActionRequest } from "./rowactions";
import { conversationScope, CONVERSATION_SCOPE_LIMIT } from "./pipeline-conversation-scope";
import { canonicalPrUrl } from "./pr-holds";
import { workItemStatus, workRequests, type WorkRequest } from "./work-view-model";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 50;
const ACTIVE = new Set<WorkRequest["status"]>(["working", "waiting", "attention", "ready"]);
const STATUS_LABEL: Record<WorkRequest["status"], string> = {
  working: "Working", waiting: "Waiting", attention: "Review results", ready: "Ready",
  "not-started": "Not started", finished: "Finished",
};
const statusTone = (status: WorkRequest["status"]) => status === "attention"
  ? "text-amber-700 dark:text-amber-300"
  : status === "working" ? "text-violet-700 dark:text-violet-300"
  : status === "ready" ? "text-emerald-700 dark:text-emerald-300"
  : "text-muted-foreground";
const key = (url: string) => (canonicalPrUrl(url) ?? url).toLowerCase();
const time = (value: number) => new Date(value).toLocaleString();
const failure = (error: unknown) => error instanceof Error ? error.message : String(error);

export function WorkView({ board, now, onPipeline, onMap, onHow }: {
  board: Board; now: number; onPipeline: () => void; onMap: () => void; onHow: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const advance = useAdvanceBatches();
  const [conversations, setConversations] = useState<WorkConversation[]>([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [conversation, setConversation] = useState<ConversationPanelRequest | null>(null);
  const [agent, setAgent] = useState<PipelineAgentRequest | null>(null);
  const [direct, setDirect] = useState<ActionRequest | null>(null);
  const generation = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setWide((entry?.contentRect.width ?? node.clientWidth) >= 900));
    observer.observe(node);
    setWide(node.clientWidth >= 900);
    return () => observer.disconnect();
  }, []);

  const refresh = useCallback(async () => {
    const sequence = ++generation.current;
    try {
      const responses = await Promise.all(Array.from({ length: pages }, (_, page) =>
        rpc.call("conversation_list", { offset: page * PAGE_SIZE, limit: PAGE_SIZE })));
      if (generation.current !== sequence) return;
      setConversations(responses.flatMap((response) => response.items));
      setTotal(responses[0]?.total ?? 0);
      setLoadedAt(Date.now());
      setLoadError(null);
    } catch (error) {
      if (generation.current === sequence) setLoadError(failure(error));
    } finally {
      if (generation.current === sequence) setLoading(false);
    }
  }, [pages, rpc]);
  useEffect(() => {
    void refresh();
    return () => { generation.current++; };
  }, [refresh]);
  useRealtime("board-changed", refresh);
  useEffect(() => {
    const interval = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 15_000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const loadMore = async () => {
    if (loadingMore || conversations.length >= total) return;
    setLoadingMore(true);
    try {
      const response = await rpc.call("conversation_list", { offset: conversations.length, limit: PAGE_SIZE });
      setConversations((current) => [...current, ...response.items.filter((item) => !current.some((existing) => existing.id === item.id))]);
      setTotal(response.total);
      setPages((current) => current + 1);
      setLoadError(null);
    } catch (error) { setLoadError(failure(error)); }
    finally { setLoadingMore(false); }
  };

  const locals = useMemo(() => [...inboxRows(board, now).values()].flat(), [board, now]);
  const cards = useMemo(() => pipelineCards(board.prInventory.entries, locals, now, {
    holds: board.prHolds, batches: advance.batches, dispatch: board.dispatch,
    runs: board.runs, observations: board.prObservations,
  }), [board, locals, now, advance.batches]);
  const requests = useMemo(() => workRequests(conversations, advance.batches, cards), [conversations, advance.batches, cards]);
  const selected = requests.find((request) => request.id === selectedId) ?? null;
  const inventory = cards.filter((card) => card.pr?.state === "OPEN");
  const search = query.trim().toLowerCase();
  const matches = (card: PipelineCard) => !search || [card.repo, card.title, card.effortName, String(card.pr?.number ?? "")]
    .some((part) => part?.toLowerCase().includes(search));
  const visibleInventory = inventory.filter(matches);
  const visibleRequests = requests.filter((request) => !search || [request.title, request.nextStep, ...request.prUrls,
    ...cards.filter((card) => card.pr && request.prUrls.some((url) => key(url) === key(card.pr!.url)))
      .flatMap((card) => [card.title, card.repo, card.effortName ?? "", String(card.pr?.number ?? "")])]
    .some((part) => part.toLowerCase().includes(search)));
  const visibleKeys = new Set(visibleInventory.map((card) => key(card.pr!.url)));
  const hiddenSelected = selection.filter((url) => !visibleKeys.has(key(url))).length;
  const selectedCards = cards.filter((card) => card.pr && selection.some((url) => key(url) === key(card.pr!.url)));
  const selectedUnavailable = selection.length - selectedCards.filter((card) => card.pr?.state === "OPEN").length;
  const heldSelected = selectedCards.filter((card) => card.hold).length;
  const busySelected = selectedCards.filter((card) => !card.hold && card.activity.state === "working").length;
  const prepareUrls = selectedCards.filter((card) => card.pr?.state === "OPEN" && !card.hold && card.activity.state !== "working")
    .map((card) => card.pr!.url);
  const scope = conversationScope(cards, visibleInventory, selection, selection.length ? "Selected PRs" : "Matching open PRs");
  const detailCards = selected?.prUrls.map((url) => ({
    url, card: cards.find((card) => card.pr && key(card.pr.url) === key(url)) ?? null,
    job: selected.jobs.find(({ job }) => key(job.prUrl) === key(url)) ?? null,
  })) ?? [];
  const workingJobs = advance.batches.flatMap((batch) => batch.jobs).filter((job) =>
    ["queued", "launching", "running", "verifying"].includes(job.status)).length;
  const readyCards = cards.filter((card) => card.action?.kind === "merge" && matches(card));
  const planRequestScope = (request: WorkRequest) => conversationScope(cards,
    cards.filter((card) => card.pr && request.prUrls.some((url) => key(url) === key(card.pr!.url))),
    [], "This request's open PRs");
  const jobSummary = (request: WorkRequest) => {
    if (!request.jobs.length || request.status === "finished") return null;
    const jobs = request.jobs.map(({ job }) => ({
      job, state: workItemStatus(cards.find((card) => card.pr && key(card.pr.url) === key(job.prUrl)) ?? undefined, job).status,
    }));
    const running = jobs.filter(({ job }) => ["running", "launching", "verifying"].includes(job.status)).length;
    const queued = jobs.filter(({ job }) => job.status === "queued").length;
    const review = jobs.filter(({ state }) => state === "attention").length;
    const waiting = jobs.filter(({ state }) => state === "waiting").length;
    return [running && `${running} running`, queued && `${queued} queued`, review && `${review} review results`, waiting && `${waiting} waiting`]
      .filter(Boolean).join(" · ") || null;
  };
  const scopeSummary = (request: WorkRequest) => {
    const scoped = cards.filter((card) => card.pr && request.prUrls.some((url) => key(url) === key(card.pr!.url)));
    const efforts = [...new Set(scoped.map((card) => card.effortName).filter((name): name is string => !!name))];
    const repos = [...new Set(scoped.map((card) => card.repo.split("/").at(-1) ?? card.repo))];
    const repoLabel = repos.slice(0, 2).join(", ") + (repos.length > 2 ? ` +${repos.length - 2}` : "");
    return [efforts.length === 1 ? efforts[0] : null, repoLabel].filter(Boolean).join(" · ");
  };
  const reviewMerge = (card: PipelineCard) => {
    if (!card.pr) return;
    setDirect({ kind: "direct", action: "merge", row: {
      repo: card.repo, title: card.title, age: { since: card.ageSince },
      unit: { pr: card.pr, prUrl: card.pr.url },
    } });
  };

  const toggleSelection = (card: PipelineCard) => {
    if (!card.pr) return;
    const url = key(card.pr.url);
    setSelection((current) => current.includes(url) ? current.filter((item) => item !== url)
      : current.length < CONVERSATION_SCOPE_LIMIT ? [...current, url] : current);
  };
  const openPlan = () => {
    setSelectedId(null);
    setConversation({ kind: "scope", scope });
  };
  const requestRow = (request: WorkRequest) => (
    <button key={request.id} type="button" onClick={() => setSelectedId(request.id)}
      className={cn("group flex w-full min-w-0 items-start gap-3 border-b border-border/60 px-4 py-4 text-left outline-none hover:bg-foreground/[0.035] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", selectedId === request.id && "bg-foreground/[0.045]")}
      aria-label={`View ${request.title}: ${STATUS_LABEL[request.status]}`}>
      <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full bg-current", statusTone(request.status))} aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="line-clamp-2 min-w-0 max-w-full break-words text-[13px] font-semibold leading-5">{request.title}</span>
          <span className={cn("text-[11px] font-medium", statusTone(request.status))}>{STATUS_LABEL[request.status]}</span>
        </span>
        {scopeSummary(request) ? <span className="mt-1 block truncate text-[11px] text-muted-foreground">{scopeSummary(request)}</span> : null}
        <span className="mt-1 block text-[11px] text-muted-foreground">{request.prUrls.length} PR{request.prUrls.length === 1 ? "" : "s"} in scope · Updated {time(request.updatedAt)}</span>
        {jobSummary(request) ? <span className="mt-1 block text-[11px] font-medium">{jobSummary(request)}</span> : null}
        <span className="mt-1.5 block break-words text-[12px] leading-5 text-muted-foreground">{request.nextStep}</span>
      </span>
      <span className="shrink-0 text-muted-foreground" aria-hidden="true">›</span>
    </button>
  );
  const section = (title: string, states: WorkRequest["status"][]) => {
    const rows = visibleRequests.filter((request) => states.includes(request.status));
    return rows.length ? <section aria-label={title} className="mt-6">
      <h2 className="px-4 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title} <span className="font-normal">{rows.length}</span></h2>
      <div className="mt-2 border-t border-border/60">{rows.map(requestRow)}</div>
    </section> : null;
  };

  return <div ref={rootRef} className="relative flex min-h-0 min-w-0 flex-1 flex-col text-foreground">
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border/70 px-4 py-2.5">
      <div role="tablist" aria-label="Workstreams views" className="flex items-center gap-3 text-[12px]">
        <button type="button" role="tab" aria-selected={false} onClick={() => navigate.toPluginPanel("board", { subPath: "inventory" })} className="rounded px-1 py-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">Inventory</button>
        <button type="button" role="tab" aria-selected={false} onClick={onMap} className="rounded px-1 py-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">Map</button>
        <button type="button" role="tab" aria-selected={false} onClick={onPipeline} className="rounded px-1 py-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">Pipeline</button>
        <button type="button" role="tab" aria-selected className="rounded px-1 py-1 font-semibold">Work</button>
        <button type="button" role="tab" aria-selected={false} onClick={() => navigate.toPluginPanel("board", { subPath: "efforts" })} className="rounded px-1 py-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">Efforts</button>
      </div>
      <button type="button" onClick={onHow} className="rounded px-2 py-1 text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">How it works</button>
    </header>
    <div className="flex min-h-0 flex-1">
      <main className={cn("min-w-0 flex-1 overflow-y-auto overscroll-contain pb-8", selected && (wide ? "border-r border-border/70" : "hidden"))}>
        <div className="px-4 pb-2 pt-6">
          <h1 className="text-[22px] font-semibold tracking-tight">Work</h1>
          <p className="mt-1 max-w-xl text-[12px] leading-5 text-muted-foreground">Follow requested preparation, inspect results, and choose PRs for the next plan.</p>
          <button type="button" onClick={() => document.getElementById("work-pr-picker")?.scrollIntoView({ block: "start" })} className="mt-4 rounded-md bg-foreground px-3 py-2 text-[11px] font-medium text-background outline-none hover:opacity-85 focus-visible:ring-2 focus-visible:ring-ring">Plan work</button>
          <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 border-y border-border/70 py-3 text-[12px]">
            <span><strong className="font-semibold">{workingJobs}</strong> jobs queued or running</span>
            <span><strong className="font-semibold">{requests.filter((item) => ACTIVE.has(item.status)).length}</strong> requests to follow</span>
            <span><strong className="font-semibold">{readyCards.length}</strong> PRs ready to merge</span>
            <span><strong className="font-semibold">{inventory.length}</strong> open PRs</span>
          </div>
          {advance.error ? <p role="alert" className="mt-3 text-[11px] text-destructive">Preparation status may be stale: {advance.error}</p> : null}
          {loadError ? <p role="alert" className="mt-3 text-[11px] text-destructive">Saved requests may be stale: {loadError} <button type="button" onClick={() => void refresh()} className="underline">Retry</button></p> : null}
          {loadedAt ? <p className="mt-2 text-[10px] text-muted-foreground">Requests updated {time(loadedAt)}{conversations.length < total ? ` · Showing ${conversations.length} of ${total}` : ""}</p> : loading ? <p role="status" className="mt-2 text-[11px] text-muted-foreground">Loading saved requests…</p> : null}
        </div>
        <div className="px-4 pt-4">
          <label htmlFor="work-search" className="sr-only">Search work</label>
          <input id="work-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search work, repository, or PR…" className="h-9 w-full rounded-md border border-input bg-background px-3 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring" />
        </div>
        {section("Working", ["working"])}
        {section("Waiting", ["waiting"])}
        {section("Review results", ["attention"])}
        {section("Ready", ["ready"])}
        {section("Planning", ["not-started"])}
        {readyCards.length ? <section aria-label="Ready to merge" className="mt-8">
          <h2 className="px-4 text-[12px] font-semibold">Ready to merge <span className="font-normal text-muted-foreground">{readyCards.length}</span></h2>
          <p className="mt-1 px-4 text-[11px] text-muted-foreground">Review current GitHub facts and a fresh merge preview for each PR.</p>
          <ul className="mt-2 border-t border-border/60">{readyCards.map((card) => <li key={card.key} className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-4 py-3 text-[11px]">
            <UrlLink href={card.pr!.url} className="min-w-0 break-words font-medium underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">{card.repo} #{card.pr!.number} · {card.title}</UrlLink>
            <button type="button" onClick={() => reviewMerge(card)} className="shrink-0 rounded border border-border px-2 py-1 font-medium outline-none hover:bg-foreground/[0.05] focus-visible:ring-2 focus-visible:ring-ring">Review merge</button>
          </li>)}</ul>
        </section> : null}
        {conversations.length < total ? <button type="button" disabled={loadingMore} onClick={() => void loadMore()} className="mx-4 mt-4 rounded-md border border-border px-3 py-2 text-[11px] font-medium outline-none hover:bg-foreground/[0.05] focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">{loadingMore ? "Loading…" : `Load more requests (${total - conversations.length})`}</button> : null}
        <section id="work-pr-picker" aria-label="Choose pull requests" className="mt-8 scroll-mt-3">
          <div className="px-4">
            <h2 className="text-[14px] font-semibold">Choose PRs <span className="text-[11px] font-normal text-muted-foreground">{visibleInventory.length}</span></h2>
            <p className="mt-1 text-[11px] text-muted-foreground">Plan a new scope or prepare selected PRs. Held PRs can enter a plan and are excluded from direct preparation.</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button type="button" disabled={!scope.prUrls.length || scope.prUrls.length > CONVERSATION_SCOPE_LIMIT || scope.unavailableSelected > 0} onClick={openPlan} className="rounded-md bg-foreground px-3 py-2 text-[11px] font-medium text-background outline-none hover:opacity-85 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">Plan work · {scope.prUrls.length} {selection.length ? "selected" : "matching"}</button>
              <button type="button" disabled={!selection.length || !prepareUrls.length || selectedUnavailable > 0} onClick={() => setAgent({ kind: "advance", prUrls: prepareUrls })} className="rounded-md border border-border px-3 py-2 text-[11px] font-medium outline-none hover:bg-foreground/[0.05] focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">Prepare selected · {prepareUrls.length}</button>
              {selection.length ? <button type="button" onClick={() => setSelection([])} className="rounded px-2 py-2 text-[11px] text-muted-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">Clear {selection.length}</button> : null}
            </div>
            {selection.length ? <p className="mt-2 text-[11px] text-muted-foreground">{selection.length} selected{hiddenSelected ? ` · ${hiddenSelected} hidden by search` : ""}{heldSelected ? ` · ${heldSelected} held` : ""}{busySelected ? ` · ${busySelected} already working` : ""}{selectedUnavailable ? ` · ${selectedUnavailable} unavailable; clear the selection` : ""}</p> : null}
            {!selection.length && scope.prUrls.length > CONVERSATION_SCOPE_LIMIT ? <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-300">This view matches {scope.prUrls.length} PRs. Search or select at most {CONVERSATION_SCOPE_LIMIT} for one plan.</p> : null}
          </div>
          {pipelineEfforts(visibleInventory).map((effort) => <div key={effort.key ?? "one-offs"} className="mt-5">
            <h3 className="px-4 text-[11px] font-semibold text-muted-foreground">{effort.name} <span className="font-normal">{effort.cards.length}</span></h3>
            <ul className="mt-1 border-t border-border/60">{effort.cards.map((card) => <li key={card.key} className="flex items-start gap-3 border-b border-border/60 px-4 py-3">
              <input type="checkbox" checked={selection.includes(key(card.pr!.url))} disabled={!selection.includes(key(card.pr!.url)) && selection.length >= CONVERSATION_SCOPE_LIMIT} onChange={() => toggleSelection(card)} aria-label={`Select ${card.repo} pull request ${card.pr!.number}: ${card.title}`} className="mt-1 size-4 shrink-0 accent-foreground" />
              <div className="min-w-0 flex-1">
                <UrlLink href={card.pr!.url} className="break-words text-[12px] font-medium underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">{card.repo} #{card.pr!.number} · {card.title}</UrlLink>
                <p className="mt-1 text-[11px] text-muted-foreground">{card.hold ? `On hold · ${card.hold.reason}` : card.activity.state === "working" ? "Already being worked on" : card.blocker.label} · {card.nextStep}</p>
              </div>
            </li>)}</ul>
          </div>)}
          {!visibleInventory.length ? <p className="px-4 py-5 text-[12px] text-muted-foreground">No matching open PRs.</p> : null}
        </section>
        <section aria-label="History" className="mt-8 border-t border-border/70 pt-5">
          <button type="button" aria-expanded={historyOpen} onClick={() => setHistoryOpen((current) => !current)} className="mx-4 rounded text-[12px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">{historyOpen ? "▾" : "▸"} History · {visibleRequests.filter((request) => request.status === "finished").length}</button>
          {historyOpen ? <div className="mt-3 border-t border-border/60">{visibleRequests.filter((request) => request.status === "finished").map(requestRow)}</div> : null}
        </section>
      </main>
      {selected ? <aside aria-label="Work request details" className={cn("flex min-w-0 flex-1 flex-col overflow-y-auto overscroll-contain bg-background", wide && "max-w-[min(55%,680px)]")}>
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-border/70 bg-background px-4 py-3">
          <button type="button" onClick={() => setSelectedId(null)} className="rounded px-2 py-1 text-[11px] font-medium outline-none hover:bg-foreground/[0.05] focus-visible:ring-2 focus-visible:ring-ring">← Back to work</button>
          <span className={cn("text-[11px] font-medium", statusTone(selected.status))}>{STATUS_LABEL[selected.status]}</span>
        </div>
        <div className="space-y-6 px-5 py-6 text-[12px]">
          <div><h2 className="break-words text-[19px] font-semibold leading-6">{selected.title}</h2><p className="mt-2 text-muted-foreground">{selected.prUrls.length} PR{selected.prUrls.length === 1 ? "" : "s"} in scope · Updated {time(selected.updatedAt)}</p></div>
          <section><h3 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Next step</h3><p className="mt-2 break-words text-[13px] leading-5">{selected.nextStep}</p></section>
          <div className="flex flex-wrap gap-2">
            {selected.conversationId ? <button type="button" onClick={() => setConversation({ kind: "resume", conversationId: selected.conversationId! })} className="rounded-md bg-foreground px-3 py-2 text-[11px] font-medium text-background outline-none hover:opacity-85 focus-visible:ring-2 focus-visible:ring-ring">Open planning conversation</button> : null}
            {!selected.conversationId && planRequestScope(selected).prUrls.length ? <button type="button" onClick={() => setConversation({ kind: "scope", scope: planRequestScope(selected) })} className="rounded-md bg-foreground px-3 py-2 text-[11px] font-medium text-background outline-none hover:opacity-85 focus-visible:ring-2 focus-visible:ring-ring">Plan this scope</button> : null}
            {selected.threadId ? <button type="button" onClick={() => navigate.toThread(selected.threadId!)} className="rounded-md border border-border px-3 py-2 text-[11px] font-medium outline-none hover:bg-foreground/[0.05] focus-visible:ring-2 focus-visible:ring-ring">Open planning thread</button> : null}
            <button type="button" onClick={onPipeline} className="rounded-md border border-border px-3 py-2 text-[11px] font-medium outline-none hover:bg-foreground/[0.05] focus-visible:ring-2 focus-visible:ring-ring">Review in Pipeline</button>
          </div>
          <section aria-label="Pull request progress"><h3 className="border-b border-border/70 pb-2 text-[12px] font-semibold">Pull requests</h3>
            <ul>{detailCards.map(({ url, card, job }) => {
              const observation = board.prObservations[url.toLowerCase()];
              const threadIds = [...new Set([job?.job.threadId, ...(board.prThreadLinks[url.toLowerCase()] ?? [])].filter((id): id is string => !!id))];
              const detailState = workItemStatus(card ?? undefined, job?.job);
              return <li key={url} className="space-y-2 border-b border-border/60 py-4">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1"><UrlLink href={url} className="min-w-0 break-words font-medium underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">{card ? `${card.repo} #${card.pr!.number} · ${card.title}` : url}</UrlLink><span className="shrink-0 text-[11px] text-muted-foreground">{job ? job.job.status.replaceAll("-", " ") : card?.stage ?? "Unobserved"}</span></div>
                {card ? <p className="break-words text-[11px] text-muted-foreground">Current: {STATUS_LABEL[detailState.status]} · {card.hold ? `On hold: ${card.hold.reason}` : card.blocker.label} · {detailState.nextStep}</p> : null}
                {job ? <p className="break-words text-[11px] text-muted-foreground">Preparation: {job.job.detail}</p> : null}
                {observation?.checkedAt ? <p className="text-[10px] text-muted-foreground">GitHub checked {new Date(observation.checkedAt).toLocaleString()}</p> : null}
                {observation?.failedAt && (!observation.checkedAt || observation.failedAt >= observation.checkedAt) ? <p role="status" className="text-[11px] text-destructive">Latest GitHub check failed; PR facts may be stale.</p> : null}
                {threadIds.length ? <div className="flex flex-wrap gap-x-3 gap-y-1">{threadIds.map((id, index) => <button key={id} type="button" onClick={() => navigate.toThread(id)} className="text-[11px] font-medium underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring">{id === job?.job.threadId ? "Open worker thread" : `Open linked thread ${index + 1}`}</button>)}</div> : null}
                {card?.action?.kind === "merge" ? <button type="button" onClick={() => reviewMerge(card)} className="rounded-md border border-border px-2 py-1.5 text-[11px] font-medium outline-none hover:bg-foreground/[0.05] focus-visible:ring-2 focus-visible:ring-ring">Review merge</button> : null}
                {job && job.job.status === "needs-attention" && !job.job.uncertain && !job.job.hiddenFromProgress && !card?.hold && detailState.status === "attention" ? <button type="button" onClick={() => setAgent({ kind: "repair", batchId: job.batchId, jobId: job.job.id })} className="rounded-md border border-border px-2 py-1.5 text-[11px] font-medium outline-none hover:bg-foreground/[0.05] focus-visible:ring-2 focus-visible:ring-ring">Review repair</button> : null}
              </li>;
            })}</ul>
          </section>
          {selected.batches.length ? <section><h3 className="text-[12px] font-semibold">Preparation batches</h3><p className="mt-1 text-[11px] text-muted-foreground">{selected.batches.length} batch{selected.batches.length === 1 ? "" : "es"} · {selected.jobs.length} tracked PR{selected.jobs.length === 1 ? "" : "s"}</p></section> : null}
        </div>
      </aside> : null}
    </div>
    {conversation ? <div className="absolute inset-0 z-30 flex justify-end bg-background/30"><PipelineConversationPanel request={conversation} onClose={() => { setConversation(null); void refresh(); }} onRemember={() => void refresh()} /></div> : null}
    <ActionDialogs request={direct} now={now} onClose={() => setDirect(null)} onSuccess={() => { setDirect(null); advance.refresh(); void refresh(); }} />
    <PipelineAgentSheet request={agent} onClose={() => setAgent(null)} onStarted={() => { advance.refresh(); void refresh(); }} onOpenThread={(id) => navigate.toThread(id)} />
  </div>;
}
