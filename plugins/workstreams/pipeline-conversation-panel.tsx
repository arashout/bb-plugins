import { useCallback, useEffect, useRef, useState } from "react";
import { ThreadChat, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { AdvanceBatch, AdvancePreview } from "./bulk-advance";
import type { ConversationScopeItem, WorkConversation } from "./work-conversation";
import { CONVERSATION_SCOPE_LIMIT, observeConversationProposal, type ConversationScope } from "./pipeline-conversation-scope";
import { Icon } from "@/components/ui/icon";

export type ConversationPanelRequest =
  | { kind: "scope"; scope: ConversationScope }
  | { kind: "resume"; conversationId: string };

type Snapshot = {
  conversation: WorkConversation | null;
  scopeItems: ConversationScopeItem[];
  batches: AdvanceBatch[];
  warning: string | null;
};
type ReviewedPreview = { revision: number; value: AdvancePreview };
const failure = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);

export function PipelineConversationPanel({ request, onClose, onRemember }: {
  request: ConversationPanelRequest;
  onClose: () => void;
  onRemember: (conversationId: string) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [instruction, setInstruction] = useState("");
  const [preview, setPreview] = useState<ReviewedPreview | null>(null);
  const [autoPreviewRevision, setAutoPreviewRevision] = useState<number | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const [busy, setBusy] = useState<"opening" | "previewing" | "starting" | "recovering" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const generation = useRef(0);
  const latestRefresh = useRef(0);
  const highestRevision = useRef(-1);
  const loadedRequestKey = useRef<string | null>(null);
  const seenProposal = useRef<{ initialized: boolean; revision: number }>({ initialized: false, revision: 0 });
  const actionBusy = useRef(false);
  const requestKey = request.kind === "scope"
    ? `scope:${JSON.stringify(request.scope.prUrls)}`
    : `resume:${request.conversationId}`;

  const refresh = useCallback(async () => {
    if (actionBusy.current) return;
    const sequence = generation.current;
    const refreshNumber = ++latestRefresh.current;
    const input = request.kind === "scope"
      ? { prUrls: request.scope.prUrls }
      : { conversationId: request.conversationId };
    try {
      const next = await rpc.call("conversation_get", input);
      if (generation.current !== sequence || latestRefresh.current !== refreshNumber || actionBusy.current) return;
      if (next.conversation && next.conversation.revision < highestRevision.current) return;
      if (next.conversation) highestRevision.current = next.conversation.revision;
      loadedRequestKey.current = requestKey;
      const observed = observeConversationProposal(seenProposal.current, next.conversation?.proposal ?? null);
      seenProposal.current = observed.seen;
      if (observed.autoPreviewRevision !== null) setAutoPreviewRevision(observed.autoPreviewRevision);
      setSnapshot(next);
      setLoadError(null);
      if (next.conversation) onRemember(next.conversation.id);
      setPreview((current) => current && (
        current.revision !== next.conversation?.proposal?.revision ||
        current.value.token !== next.conversation?.proposal?.previewToken
      ) ? null : current);
    } catch (cause) {
      if (generation.current === sequence && latestRefresh.current === refreshNumber && !actionBusy.current) setLoadError(failure(cause));
    }
  }, [requestKey, rpc]);

  useEffect(() => {
    generation.current++;
    latestRefresh.current++;
    highestRevision.current = -1;
    loadedRequestKey.current = null;
    seenProposal.current = { initialized: false, revision: 0 };
    setSnapshot(null);
    setInstruction("");
    setPreview(null);
    setAutoPreviewRevision(null);
    setBusy(null);
    setError(null);
    setLoadError(null);
    actionBusy.current = false;
    if (request.kind === "scope" && (request.scope.prUrls.length === 0 || request.scope.prUrls.length > CONVERSATION_SCOPE_LIMIT || request.scope.unavailableSelected > 0)) return;
    void refresh();
    const interval = window.setInterval(() => { if (!document.hidden) void refresh(); }, 5_000);
    return () => { window.clearInterval(interval); generation.current++; latestRefresh.current++; };
  }, [requestKey, refresh]);
  useRealtime("board-changed", refresh);

  const conversation = snapshot?.conversation ?? null;
  useEffect(() => {
    if (conversation?.threadId) setFocusRequest((current) => current + 1);
  }, [conversation?.threadId, requestKey]);
  const scopeItems = snapshot?.scopeItems ?? [];
  const scopeSize = request.kind === "scope" ? request.scope.prUrls.length : conversation?.scopePrUrls.length ?? 0;
  const scopeKnown = request.kind === "scope" || conversation !== null;
  const heldCount = scopeItems.length
    ? scopeItems.filter((item) => item.hold !== null).length
    : request.kind === "scope" ? request.scope.heldExcluded : 0;
  const readyPreview = preview && conversation?.proposal &&
    preview.revision === conversation.proposal.revision &&
    preview.value.token === conversation.proposal.previewToken &&
    preview.value.expiresAt > Date.now() ? preview.value : null;
  const scopeLabel = (prUrl: string) => {
    const item = scopeItems.find((candidate) => candidate.prUrl.toLowerCase() === prUrl.toLowerCase());
    if (item?.repo && item.number) return `${item.repo} #${item.number}${item.title ? ` · ${item.title}` : ""}`;
    const match = /\/([^/]+\/[^/]+)\/pull\/(\d+)$/u.exec(prUrl);
    return match ? `${match[1]} #${match[2]}` : "Scoped PR";
  };

  const open = async () => {
    if (request.kind !== "scope" || busy || !instruction.trim()) return;
    const sequence = generation.current;
    actionBusy.current = true;
    latestRefresh.current++;
    setBusy("opening");
    setError(null);
    try {
      const result = await rpc.call("conversation_open", { prUrls: request.scope.prUrls, instruction: instruction.trim() });
      if (generation.current !== sequence) return;
      onRemember(result.conversation.id);
      highestRevision.current = result.conversation.revision;
      setSnapshot((current) => current ? { ...current, conversation: result.conversation, warning: result.warning } : current);
    } catch (cause) {
      if (generation.current === sequence) setError(failure(cause));
    } finally {
      if (generation.current === sequence) { actionBusy.current = false; setBusy(null); void refresh(); }
    }
  };
  const getPreview = async () => {
    if (!conversation || busy) return;
    const sequence = generation.current;
    setAutoPreviewRevision(null);
    actionBusy.current = true;
    latestRefresh.current++;
    setBusy("previewing");
    setError(null);
    setPreview(null);
    try {
      const result = await rpc.call("conversation_preview", { conversationId: conversation.id });
      if (generation.current !== sequence) return;
      highestRevision.current = result.conversation.revision;
      setSnapshot((current) => current ? { ...current, conversation: result.conversation } : current);
      setPreview({ revision: result.conversation.proposal!.revision, value: result.preview });
    } catch (cause) {
      if (generation.current === sequence) setError(failure(cause));
    } finally {
      if (generation.current === sequence) { actionBusy.current = false; setBusy(null); void refresh(); }
    }
  };
  const checkExistingThread = async () => {
    if (!conversation || conversation.threadId || busy) return;
    const sequence = generation.current;
    actionBusy.current = true;
    latestRefresh.current++;
    setBusy("recovering");
    setError(null);
    try {
      const next = await rpc.call("conversation_get", { conversationId: conversation.id, recoverThread: true });
      if (generation.current !== sequence) return;
      if (!next.conversation || next.conversation.id !== conversation.id) throw new Error("The saved conversation could not be confirmed.");
      if (next.conversation.revision < highestRevision.current) return;
      highestRevision.current = next.conversation.revision;
      loadedRequestKey.current = requestKey;
      setSnapshot(next);
      setLoadError(null);
    } catch (cause) {
      if (generation.current === sequence) setError(failure(cause));
    } finally {
      if (generation.current === sequence) { actionBusy.current = false; setBusy(null); void refresh(); }
    }
  };
  useEffect(() => {
    if (loadedRequestKey.current !== requestKey || autoPreviewRevision === null || !conversation?.proposal ||
      conversation.proposal.revision !== autoPreviewRevision || busy) return;
    setAutoPreviewRevision(null);
    void getPreview();
  }, [autoPreviewRevision, conversation?.proposal?.revision, busy, requestKey]);
  const start = async () => {
    if (!conversation || !readyPreview || busy || !readyPreview.jobs.some((job) => job.eligible)) return;
    const sequence = generation.current;
    actionBusy.current = true;
    latestRefresh.current++;
    setBusy("starting");
    setError(null);
    try {
      const result = await rpc.call("conversation_start", { conversationId: conversation.id, previewToken: readyPreview.token });
      if (generation.current !== sequence) return;
      highestRevision.current = result.conversation.revision;
      setSnapshot((current) => current ? {
        ...current,
        conversation: result.conversation,
        batches: [result.batch, ...current.batches.filter((batch) => batch.id !== result.batch.id)],
      } : current);
      setPreview(null);
    } catch (cause) {
      if (generation.current === sequence) {
        setError(failure(cause));
        setPreview(null);
      }
    } finally {
      if (generation.current === sequence) { actionBusy.current = false; setBusy(null); void refresh(); }
    }
  };

  return (
    <aside aria-label="Work on these PRs" className="absolute inset-y-0 right-0 z-30 flex w-[min(560px,100%)] min-w-0 shrink-0 flex-col overflow-hidden border-l border-border bg-background text-[12px] shadow-xl lg:static lg:shadow-none">
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold">Work on these PRs</h2>
          <p className="mt-0.5 text-muted-foreground">{request.kind === "scope" ? request.scope.label : "Saved conversation"} · {scopeKnown ? `${scopeSize} PR${scopeSize === 1 ? "" : "s"} in scope` : "Loading scope…"}</p>
        </div>
        <button type="button" aria-label="Close work conversation" onClick={onClose} className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring"><Icon name="X" className="size-4" /></button>
      </header>
      <div className="max-h-[40%] shrink-0 space-y-3 overflow-y-auto border-b border-border px-4 py-3">
        {scopeKnown ? <div className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
          <span className="font-medium text-foreground">{scopeSize - heldCount} not on hold</span>
          <span>{heldCount} on hold, excluded from preparation</span>
          {request.kind === "scope" ? <span>{request.scope.branchesIgnored} branches without PRs ignored</span> : null}
        </div> : null}
        {scopeSize > CONVERSATION_SCOPE_LIMIT ? <p role="alert" className="text-destructive">This scope has {scopeSize} PRs. Select or filter to at most {CONVERSATION_SCOPE_LIMIT} PRs, then open it again.</p> : null}
        {request.kind === "scope" && scopeSize === 0 ? <p role="alert" className="text-muted-foreground">There are no open PRs in this scope.</p> : null}
        {request.kind === "scope" && request.scope.unavailableSelected > 0 ? <p role="alert" className="text-destructive">{request.scope.unavailableSelected} selected PR{request.scope.unavailableSelected === 1 ? " is" : "s are"} no longer open on this board. Clear the selection and choose the current PRs again.</p> : null}
        {snapshot?.warning ? <p role="status" className="text-amber-700 dark:text-amber-300">{snapshot.warning}</p> : null}
        {scopeItems.length ? (
          <details>
            <summary className="cursor-pointer font-medium">Review {scopeItems.length} scoped PRs</summary>
            <ul className="mt-2 space-y-1.5">
              {scopeItems.map((item) => <li key={item.prUrl} className="rounded border border-border/70 px-2 py-1.5">
                <span className="font-medium">{item.repo ?? "Repository"}{item.number ? ` #${item.number}` : ""}</span>
                <span className="ml-2 text-muted-foreground">{item.title ?? item.prUrl}</span>
                {item.hold ? <span className="block text-amber-700 dark:text-amber-300">On hold: {item.hold}</span> : null}
                {item.state !== "OPEN" ? <span className="block text-destructive">{item.state} · unavailable for preparation</span> : null}
                {item.stage || item.blocker || item.advanceStatus ? <span className="block text-muted-foreground">{[item.stage, item.blocker, item.advanceStatus ? `Preparation: ${item.advanceStatus}` : null].filter(Boolean).join(" · ")}</span> : null}
                {item.observation?.checkedAt ? <span className="block text-muted-foreground">GitHub checked {new Date(item.observation.checkedAt).toLocaleString()}</span> : null}
                {item.observation?.failedAt && (!item.observation.checkedAt || item.observation.failedAt >= item.observation.checkedAt) ? <span className="block text-destructive">Latest GitHub check failed; status may be stale.</span> : null}
                {item.exclusionReason ? <span className="block text-muted-foreground">Excluded: {item.exclusionReason}</span> : null}
              </li>)}
            </ul>
          </details>
        ) : null}
        {conversation?.proposal ? (
          <section aria-label="Current proposal" className="rounded-md border border-border bg-muted/20 p-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-semibold">Current proposal</h3>
              <span className="text-muted-foreground">{conversation.proposal.selectedPrUrls.length} selected</span>
            </div>
            <p className="mt-1 whitespace-pre-wrap break-words">{conversation.proposal.instruction || "Prepare the selected PRs."}</p>
            {conversation.proposal.exclusions.length ? <ul className="mt-2 space-y-1 text-muted-foreground">{conversation.proposal.exclusions.map((item) => <li key={item.prUrl}>{scopeLabel(item.prUrl)}: {item.reason}</li>)}</ul> : null}
            <button type="button" disabled={busy !== null || autoPreviewRevision !== null || conversation.proposal.selectedPrUrls.length === 0} onClick={() => void getPreview()} className="mt-3 rounded-md border border-border px-3 py-1.5 font-medium outline-none hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">{busy === "previewing" || autoPreviewRevision === conversation.proposal.revision ? "Checking preparation…" : readyPreview ? "Refresh preparation" : "Review preparation"}</button>
            {readyPreview ? <div className="mt-3 border-t border-border pt-2">
              <p>{readyPreview.jobs.filter((job) => job.eligible).length} ready to prepare · {readyPreview.jobs.filter((job) => !job.eligible).length} unavailable</p>
              <ul className="mt-1 space-y-1 text-muted-foreground">{readyPreview.jobs.map((job) => <li key={job.prUrl}>{job.repo} #{job.number} · {job.title}: {job.detail}</li>)}</ul>
              <button type="button" disabled={busy !== null || !readyPreview.jobs.some((job) => job.eligible)} onClick={() => void start()} className="mt-3 rounded-md bg-foreground px-3 py-2 font-medium text-background outline-none hover:opacity-85 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">{busy === "starting" ? "Starting…" : "Start preparation"}</button>
            </div> : null}
          </section>
        ) : conversation ? <p className="text-muted-foreground">No proposal yet. Ask the planning agent below to choose PRs and explain any exclusions.</p> : null}
        {snapshot?.batches.length ? <section aria-label="Preparation progress"><h3 className="font-semibold">Preparation</h3><p className="mt-1 text-muted-foreground">Changes to the proposal do not change work already started.</p><ul className="mt-1 space-y-1">{snapshot.batches.flatMap((batch) => batch.jobs.map((job) => <li key={job.id} className="text-muted-foreground">{job.repo} #{job.number} · {job.title}: {job.status} · {job.detail}</li>))}</ul></section> : null}
        {loadError ? <p role="alert" className="text-destructive">Could not load conversation: {loadError}</p> : null}
        {error ? <p role="alert" className="text-destructive">{error}</p> : null}
      </div>
      {conversation?.threadId ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2"><span className="font-medium">Planning conversation</span><button type="button" onClick={() => navigate.toThread(conversation.threadId!)} className="rounded px-2 py-1 font-medium underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">Open full thread</button></div>
          <ThreadChat threadId={conversation.threadId} variant="compact" layout="contained" focusRequest={focusRequest} className="min-h-0 flex-1" />
        </div>
      ) : request.kind === "scope" && scopeSize > 0 && scopeSize <= CONVERSATION_SCOPE_LIMIT && request.scope.unavailableSelected === 0 && snapshot && !conversation ? (
        <form onSubmit={(event) => { event.preventDefault(); void open(); }} className="flex min-h-0 flex-1 flex-col gap-3 p-4">
          <label htmlFor="pipeline-conversation-instruction" className="font-medium">What should the planning agent work toward?</label>
          <textarea id="pipeline-conversation-instruction" autoFocus value={instruction} onChange={(event) => setInstruction(event.target.value)} maxLength={4_000} placeholder="Describe the outcome, priorities, and any constraints for these PRs…" className="min-h-28 w-full resize-y rounded-md border border-input bg-background p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring" />
          <p className="text-muted-foreground">This starts a planning conversation. Preparation begins only after you review a proposal and select Start preparation.</p>
          <button type="submit" disabled={busy !== null || !instruction.trim()} className="self-start rounded-md bg-foreground px-3 py-2 font-medium text-background outline-none hover:opacity-85 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">{busy === "opening" ? "Opening…" : "Start conversation"}</button>
        </form>
      ) : conversation && !conversation.threadId ? <div className="space-y-3 p-4"><p className="text-muted-foreground">The planning thread launch is unconfirmed. Check for an existing thread before continuing.</p><button type="button" disabled={busy !== null} onClick={() => void checkExistingThread()} className="rounded-md border border-border px-3 py-2 font-medium outline-none hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">{busy === "recovering" ? "Checking…" : "Check for existing thread"}</button></div> : !snapshot && !loadError && (request.kind === "resume" || (scopeSize > 0 && scopeSize <= CONVERSATION_SCOPE_LIMIT && request.scope.unavailableSelected === 0)) ? <p role="status" className="p-4 text-muted-foreground">Loading conversation…</p> : null}
    </aside>
  );
}
