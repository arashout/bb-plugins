import { useCallback, useEffect, useRef, useState } from "react";
import { useBbNavigate, useRealtime, useRpc, type PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { PipelineCard } from "./pipeline";
import { Icon } from "@/components/ui/icon";
import { PipelineThreadIndicator } from "./pipeline-thread-indicator";

type PrThread = {
  id: string;
  title: string;
  tier: "started" | "environment" | "ticket" | "paths";
  active: boolean;
  role: "coordinator" | "repo" | "pr" | "linked";
};
type PrThreadContext = { threads: PrThread[]; recommendedThreadId: string | null };

const ROLE_LABEL: Record<PrThread["role"], string> = {
  coordinator: "Effort coordinator",
  repo: "Repository",
  pr: "PR thread",
  linked: "Linked thread",
};
const ACTIVE_INDICATORS = new Set<PluginSidebarThread["indicator"]>([
  "runtime", "workflow", "background-agent", "background-command", "goal", "plan-mode", "waiting-for-input",
]);

export function usePrThreadContext(prUrl: string | null) {
  const rpc = useRpc<typeof rpcContract>();
  const [result, setResult] = useState<{ prUrl: string; context: PrThreadContext | null; error: string | null } | null>(null);
  const generation = useRef(0);

  const refetch = useCallback(() => {
    const sequence = ++generation.current;
    if (prUrl === null) return;
    void rpc.call("pr_thread_context", { prUrl }).then(
      (result) => {
        if (generation.current === sequence) setResult({ prUrl, context: result, error: null });
      },
      (cause) => {
        if (generation.current === sequence)
          setResult({ prUrl, context: null, error: cause instanceof Error ? cause.message : String(cause) });
      },
    );
  }, [prUrl, rpc]);
  useEffect(() => {
    refetch();
    return () => { generation.current++; };
  }, [refetch]);
  useRealtime("board-changed", refetch);

  const current = result?.prUrl === prUrl ? result : null;
  return { context: current?.context ?? null, error: current?.error ?? null, loading: prUrl !== null && current === null };
}

export function threadIsActive(thread: PrThread, sidebarThreads: readonly PluginSidebarThread[]): boolean {
  const live = sidebarThreads.find((item) => item.id === thread.id);
  return live
    ? live.hasPendingInteraction || ACTIVE_INDICATORS.has(live.indicator) || Object.values(live.activity).some((count) => count > 0)
    : thread.active;
}

function useCardThreadUpdate(prUrl: string | null, path: string | null, threadId: string | null) {
  const rpc = useRpc<typeof rpcContract>();
  const [result, setResult] = useState<{ target: string; threadId: string; lastLine: string | null; error: boolean } | null>(null);
  const generation = useRef(0);
  const refetch = useCallback(() => {
    const sequence = ++generation.current;
    if ((!prUrl && !path) || !threadId) return;
    const target = prUrl ? { prUrl } : { path: path! };
    void rpc.call("card_thread_update", { target, threadId }).then(
      (value) => {
        if (generation.current === sequence) setResult({ target: prUrl ?? path!, threadId, lastLine: value.lastLine, error: false });
      },
      () => {
        if (generation.current === sequence) setResult({ target: prUrl ?? path!, threadId, lastLine: null, error: true });
      },
    );
  }, [prUrl, path, threadId, rpc]);
  useEffect(() => {
    refetch();
    return () => { generation.current++; };
  }, [refetch]);
  useRealtime("board-changed", refetch);
  const current = result?.target === (prUrl ?? path) && result.threadId === threadId ? result : null;
  return { lastLine: current?.lastLine ?? null, updateError: current?.error ?? false, refetch };
}

function threadProgress(thread: PrThread, sidebarThreads: readonly PluginSidebarThread[], card: PipelineCard): string {
  const live = sidebarThreads.find((item) => item.id === thread.id);
  if (live?.hasPendingInteraction || live?.indicator === "waiting-for-input") return "Needs you";
  if (live && threadIsActive(thread, sidebarThreads)) return "Working";
  if (card.activity.threadId === thread.id && card.activity.state !== "none")
    return card.activity.state === "needs-you" ? "Needs you" : card.activity.state === "working" ? "Working" : "Last run finished";
  if (live) return "No active work";
  return thread.active ? "Working" : "No active work";
}

export function PrThreadLinks({
  prUrl,
  sidebarThreads,
  onOpenThread,
}: {
  prUrl: string | null;
  sidebarThreads: readonly PluginSidebarThread[];
  onOpenThread: (threadId: string) => void;
}) {
  const { context, error, loading } = usePrThreadContext(prUrl);
  if (loading) return <p className="mt-1 text-muted-foreground">Loading linked threads…</p>;
  if (error) return <p role="alert" className="mt-1 text-destructive">{error}</p>;
  if (!context?.threads.length) return <p className="mt-1 text-muted-foreground">No linked threads for this PR.</p>;
  return (
    <ul className="mt-2 space-y-1">
      {context.threads.map((thread) => (
        <li key={thread.id}>
          <button
            type="button"
            onClick={() => onOpenThread(thread.id)}
            className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left outline-none hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring"
            title={thread.title}
            aria-label={`Open ${ROLE_LABEL[thread.role]} thread: ${thread.title}`}
          >
            <span className="flex size-4 shrink-0 items-center justify-center"><PipelineThreadIndicator threadIds={[thread.id]} sidebarThreads={sidebarThreads} /></span>
            <span className="min-w-0 flex-1">
              <span className="block text-[10px] text-muted-foreground">{ROLE_LABEL[thread.role]}</span>
              <span className="block truncate text-[12px] font-medium text-foreground">{thread.title}</span>
            </span>
            <Icon name="ArrowUpRight" className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        </li>
      ))}
    </ul>
  );
}

export function PipelinePrComposer({
  card,
  sidebarThreads,
  onClose,
}: {
  card: PipelineCard;
  sidebarThreads: readonly PluginSidebarThread[];
  onClose: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const prUrl = card.pr?.url ?? null;
  const path = prUrl ? null : card.local?.unit.path ?? null;
  const { context, error: loadError, loading } = usePrThreadContext(prUrl);
  const [threadId, setThreadId] = useState("");
  const [createdThread, setCreatedThread] = useState<PrThread | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [composing, setComposing] = useState(true);
  const sending = useRef(false);
  const mounted = useRef(true);
  const input = useRef<HTMLTextAreaElement>(null);
  const mayAutoSelect = useRef(true);
  const linkedThreads: PrThread[] = prUrl
    ? context?.threads ?? []
    : (card.local?.cluster.threads ?? []).map((thread) => ({ ...thread, role: "linked" }));
  const threads = createdThread && !linkedThreads.some((thread) => thread.id === createdThread.id)
    ? [...linkedThreads, createdThread]
    : linkedThreads;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!mayAutoSelect.current || (prUrl && !context)) return;
    const available = prUrl ? context?.threads ?? [] : card.local?.cluster.threads ?? [];
    const active = available.filter((thread) => thread.active);
    const recommended = prUrl
      ? context?.recommendedThreadId && available.some((thread) => thread.id === context.recommendedThreadId)
        ? context.recommendedThreadId
        : ""
      : active.length === 1 ? active[0]!.id : available.length === 1 ? available[0]!.id : "";
    setThreadId(recommended);
    mayAutoSelect.current = false;
  }, [prUrl, context, card.local?.cluster.threads]);

  const selectedThread = threads.find((thread) => thread.id === threadId);
  const selectedAvailable = !threadId || selectedThread !== undefined;
  const { lastLine, updateError, refetch: refetchUpdate } = useCardThreadUpdate(prUrl, path, selectedThread?.id ?? null);
  useEffect(() => {
    if (composing) input.current?.focus();
  }, [composing]);

  const send = async () => {
    const trimmed = message.trim();
    if ((!prUrl && !path) || !trimmed || sending.current || loading || !selectedAvailable) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await rpc.call("card_thread_message", {
        target: prUrl ? { prUrl } : { path: path! },
        threadId: threadId || null,
        message: trimmed,
      });
      if (!mounted.current) return;
      if (result.ok) {
        mayAutoSelect.current = false;
        if (result.created) {
          setCreatedThread({ id: result.threadId, title: `${card.repo}${card.pr ? ` #${card.pr.number}` : ""} context`, tier: "started", active: false, role: "linked" });
        }
        setThreadId(result.threadId);
        setMessage("");
        setNotice(result.created ? "Agent thread started. Message sent." : result.delivery === "queued" ? "Message queued for the agent." : "Message sent to the agent.");
        setComposing(false);
        if (!result.created) refetchUpdate();
      } else setError(result.error);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      sending.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <form
      aria-label={`Message agent for ${card.repo}${card.pr ? ` #${card.pr.number}` : ""}`}
      onSubmit={(event) => { event.preventDefault(); void send(); }}
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}
      className="relative z-20 space-y-2 text-[11px]"
    >
      <div className="flex items-center justify-between gap-2">
        <b>Message agent</b>
        <button type="button" onClick={onClose} aria-label="Close message composer" className="rounded px-1 text-muted-foreground hover:bg-foreground/[0.06]">×</button>
      </div>
      {loading ? <p className="text-muted-foreground">Loading linked threads…</p> : null}
      {loadError ? <p role="alert" className="text-destructive">Linked threads are unavailable: {loadError}. You can start a new agent.</p> : null}
      {composing ? (
        <label className="block space-y-1">
          <span className="font-medium">Agent thread</span>
          <select
            value={threadId}
            onChange={(event) => { mayAutoSelect.current = false; setThreadId(event.target.value); setError(null); }}
            disabled={busy || loading}
            className="w-full rounded border border-input bg-background px-2 py-1.5 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="">New agent</option>
            {!selectedAvailable ? <option value={threadId} disabled>Previously selected thread unavailable</option> : null}
            {threads.map((thread) => (
              <option key={thread.id} value={thread.id}>{ROLE_LABEL[thread.role]} · {thread.title}{threadIsActive(thread, sidebarThreads) ? " · active" : ""}</option>
            ))}
          </select>
        </label>
      ) : null}
      {!selectedAvailable ? <p role="alert" className="text-destructive">The selected thread is no longer linked to this item. Choose another thread or New agent.</p> : null}
      {composing && !threadId && !loading ? <p className="text-muted-foreground">A new agent starts when you send this message.</p> : null}
      {card.hold ? <p className="text-muted-foreground">This item is on hold. Ask about status or data. Release the hold before requesting changes.</p> : null}
      {selectedThread ? (
        <div className="space-y-1">
          <button
            type="button"
            onClick={() => navigate.toThread(selectedThread.id)}
            className="inline-flex max-w-full items-center gap-1 rounded-md border border-border px-2 py-1 font-medium text-foreground hover:bg-foreground/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title={selectedThread.title}
            aria-label={`Open thread: ${selectedThread.title}`}
          >
            Open thread <Icon name="ArrowUpRight" className="size-3.5 shrink-0" />
          </button>
          <p className="line-clamp-2 break-words text-muted-foreground">{ROLE_LABEL[selectedThread.role]} · {selectedThread.title}</p>
          <p role="status" className="text-muted-foreground">{createdThread?.id === selectedThread.id && !sidebarThreads.some((thread) => thread.id === selectedThread.id) ? "Waiting for thread status" : threadProgress(selectedThread, sidebarThreads, card)}</p>
          {lastLine ? <p className="line-clamp-2 break-words text-muted-foreground"><span className="font-medium text-foreground">Latest thread update:</span> {lastLine}</p> : null}
          {updateError ? <p role="status" className="text-muted-foreground">Thread update unavailable.</p> : null}
          {selectedThread.role === "repo" || selectedThread.role === "coordinator" ? <p className="text-muted-foreground">This thread can include work on other PRs.</p> : null}
        </div>
      ) : null}
      {composing ? (
        <>
          <label className="block space-y-1">
            <span className="font-medium">What should the agent do?</span>
            <textarea
              ref={input}
              value={message}
              onChange={(event) => { setMessage(event.target.value); setError(null); setNotice(null); }}
              disabled={busy}
              maxLength={4_000}
              rows={3}
              placeholder="Ask about this item or request an adjustment"
              className="w-full resize-y rounded border border-input bg-background px-2 py-1.5 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            <button type="button" onClick={() => { setMessage("Where are we with this? Is anything corrupt or problematic in the Workstreams data for this thread?"); setError(null); setNotice(null); input.current?.focus(); }} disabled={busy} className="rounded text-muted-foreground underline hover:text-foreground disabled:opacity-50">Check status and data</button>
            {card.pr?.state === "OPEN" && !card.hold ? <button type="button" onClick={() => { setMessage("Rebase this PR onto its current base, run the relevant checks, then nudge the requested reviewer with PTAL. Do not merge."); setError(null); setNotice(null); input.current?.focus(); }} disabled={busy} className="rounded text-muted-foreground underline hover:text-foreground disabled:opacity-50">Rebase and PTAL</button> : null}
          </div>
        </>
      ) : null}
      {error ? <p role="alert" className="text-destructive">{error}</p> : null}
      {notice ? <p role="status" className="text-emerald-700 dark:text-emerald-300">{notice}</p> : null}
      {composing ? (
        <div className="flex justify-end">
          <button type="submit" disabled={busy || loading || !selectedAvailable || !message.trim()} className="rounded bg-foreground px-2 py-1 font-medium text-background disabled:opacity-50">{busy ? "Sending…" : "Send message"}</button>
        </div>
      ) : (
        <button type="button" onClick={() => { setComposing(true); setNotice(null); }} className="rounded text-muted-foreground underline hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Follow up</button>
      )}
    </form>
  );
}
