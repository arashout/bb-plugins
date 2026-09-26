import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc, type PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { PipelineCard } from "./pipeline";

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
    <ul className="mt-1 space-y-1">
      {context.threads.map((thread) => (
        <li key={thread.id}>
          <button
            type="button"
            onClick={() => onOpenThread(thread.id)}
            className="max-w-full rounded text-left text-[11px] underline hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title={thread.title}
            aria-label={`Open ${ROLE_LABEL[thread.role]} thread: ${thread.title}`}
          >
            <span className="text-muted-foreground">{ROLE_LABEL[thread.role]} · </span>
            {threadIsActive(thread, sidebarThreads) ? "● " : ""}{thread.title}
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
  const prUrl = card.pr?.url ?? null;
  const { context, error: loadError, loading } = usePrThreadContext(prUrl);
  const [threadId, setThreadId] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const sending = useRef(false);
  const mounted = useRef(true);
  const input = useRef<HTMLTextAreaElement>(null);
  const didFocus = useRef(false);
  const mayAutoSelect = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!context) return;
    if (!context.threads.some((thread) => thread.id === threadId)) {
      const recommended = mayAutoSelect.current && context.threads.some((thread) => thread.id === context.recommendedThreadId)
        ? context.recommendedThreadId ?? ""
        : mayAutoSelect.current && context.threads.length === 1 ? context.threads[0]!.id : "";
      if (recommended) mayAutoSelect.current = false;
      setThreadId(recommended);
    }
    if (!didFocus.current) {
      input.current?.focus();
      didFocus.current = true;
    }
  }, [context]);

  const send = async () => {
    const trimmed = message.trim();
    if (!prUrl || !context?.threads.some((thread) => thread.id === threadId) || !trimmed || sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await rpc.call("thread_message", {
        prUrl,
        threadId,
        message: trimmed,
        ...(card.local ? { path: card.local.unit.path } : {}),
      });
      if (!mounted.current) return;
      if (result.ok) {
        setMessage("");
        setNotice(result.delivery === "queued" ? "Message queued for the agent." : "Message sent to the agent.");
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
      aria-label={`Message agent for ${card.repo} #${card.pr?.number ?? ""}`}
      onSubmit={(event) => { event.preventDefault(); void send(); }}
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}
      className="relative z-20 space-y-2 text-[11px]"
    >
      <div className="flex items-center justify-between gap-2">
        <b>Message agent</b>
        <button type="button" onClick={onClose} aria-label="Close message composer" className="rounded px-1 text-muted-foreground hover:bg-foreground/[0.06]">×</button>
      </div>
      {loading ? <p className="text-muted-foreground">Loading linked threads…</p> : null}
      {loadError ? <p role="alert" className="text-destructive">{loadError}</p> : null}
      {context && !context.threads.length ? <p className="text-muted-foreground">No linked agent thread for this PR.</p> : null}
      {context?.threads.length ? (
        <>
          {context.threads.length > 1 || !context.threads.some((thread) => thread.id === threadId) ? (
            <label className="block space-y-1">
              <span className="font-medium">Agent thread</span>
              <select
                value={threadId}
                onChange={(event) => { mayAutoSelect.current = false; setThreadId(event.target.value); }}
                disabled={busy}
                className="w-full rounded border border-input bg-background px-2 py-1.5 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="">Choose a thread</option>
                {context.threads.map((thread) => (
                  <option key={thread.id} value={thread.id}>{ROLE_LABEL[thread.role]} · {thread.title}{threadIsActive(thread, sidebarThreads) ? " · active" : ""}</option>
                ))}
              </select>
            </label>
          ) : (
            <p className="truncate text-muted-foreground" title={context.threads[0]!.title}>
              To {ROLE_LABEL[context.threads[0]!.role].toLowerCase()} · {context.threads[0]!.title}
            </p>
          )}
          {context.threads.find((thread) => thread.id === threadId) ? (
            <p role="status" className="text-muted-foreground">
              {threadProgress(context.threads.find((thread) => thread.id === threadId)!, sidebarThreads, card)}
            </p>
          ) : null}
          <label className="block space-y-1">
            <span className="font-medium">What should the agent do?</span>
            <textarea
              ref={input}
              value={message}
              onChange={(event) => { setMessage(event.target.value); setError(null); setNotice(null); }}
              disabled={busy}
              maxLength={4_000}
              rows={3}
              placeholder="Write a command for this PR"
              className="w-full resize-y rounded border border-input bg-background px-2 py-1.5 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
          <button
            type="button"
            onClick={() => { setMessage("Rebase this PR onto its current base, run the relevant checks, then nudge the requested reviewer with PTAL. Do not merge."); setError(null); setNotice(null); input.current?.focus(); }}
            disabled={busy}
            className="rounded text-muted-foreground underline hover:text-foreground disabled:opacity-50"
          >
            Rebase and PTAL
          </button>
          {error ? <p role="alert" className="text-destructive">{error}</p> : null}
          {notice ? <p role="status" className="text-emerald-700 dark:text-emerald-300">{notice}</p> : null}
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={busy || !threadId || !message.trim()}
              className="rounded bg-foreground px-2 py-1 font-medium text-background disabled:opacity-50"
            >
              {busy ? "Sending…" : "Send message"}
            </button>
          </div>
        </>
      ) : null}
    </form>
  );
}
