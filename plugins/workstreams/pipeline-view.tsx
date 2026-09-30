import { useEffect, useMemo, useRef, useState } from "react";
import {
  UrlLink,
  experimental_useSidebarThreads,
  useBbContext,
  useBbNavigate,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { Board, rpcContract } from "./server";
import type { Prefs } from "./server";
import { inboxRows } from "./inbox-rows";
import {
  pipelineCards,
  pipelineBulkCards,
  orderPipelineCards,
  pipelineStackGraph,
  PIPELINE_STAGES,
  selectablePipelineCard,
  togglePipelineSelection,
  type PipelineCard,
  type PipelineStage,
} from "./pipeline";
import { AdvanceProgress, useAdvanceBatches } from "./bulk-advance-view";
import {
  PipelineAgentSheet,
  type PipelineAgentRequest,
} from "./pipeline-agent-sheet";
import {
  ActionDialogs,
  type ActionRequest,
  type DirectRow,
} from "./rowactions";
import { PipelinePrComposer, PrThreadLinks } from "./pipeline-pr-threads";
import { PrHoldDialog, usePrHoldControls } from "./pr-hold-dialog";
import { ArchivedThreadsButton } from "./archivedthreads";
import { StartThreadDialog } from "./inbox";
import type { Row } from "./inbox-rows";
import { matchesApprovedFilter } from "./approval-filter";
import { ADVANCE_SELECTION_LIMIT, advancePrKey, reconcileAdvanceSelection, selectVisibleOpen, type AdvanceSelection } from "./bulk-advance-selection";
import { canonicalPrUrl } from "./pr-holds";
import type { PrHolds } from "./pr-holds";
import { relativeTime } from "./workstreams";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AGENT_ACTIONS, type AgentAction } from "./actions";
import { usePipelineMotion } from "./pipeline-motion";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { Tip } from "@/components/ui/tooltip";
import { usePortalScopeProps } from "./lib/portal-scope";
import { PipelineCardEffortDialog } from "./pipeline-card-effort";
import { PipelineThreadIndicator } from "./pipeline-thread-indicator";
import { conversationScope } from "./pipeline-conversation-scope";
import { PipelineConversationPanel, type ConversationPanelRequest } from "./pipeline-conversation-panel";

const LABEL: Record<PipelineStage, string> = {
  build: "Build",
  review: "Review",
  feedback: "Feedback",
  ready: "Ready",
  merged: "Merged",
  released: "Released",
};
const BLOCKER_COLOR = {
  bad: "bg-destructive/10 text-destructive",
  warn: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  wait: "bg-muted text-muted-foreground",
  clear: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
};
const HISTORY_LIMIT: Partial<Record<PipelineStage, number>> = {
  merged: 5,
  released: 3,
};
const EMPTY_SELECTION: AdvanceSelection = { urls: [], removed: 0 };

const lastConversationKey = (projectId: string | null) => `workstreams:last-conversation:${projectId ?? "global"}`;
function readLastConversation(projectId: string | null): string | null {
  try { return window.localStorage.getItem(lastConversationKey(projectId)); }
  catch { return null; }
}
function saveLastConversation(projectId: string | null, id: string): void {
  try { window.localStorage.setItem(lastConversationKey(projectId), id); }
  catch { /* The open panel still retains this conversation. */ }
}

function age(card: PipelineCard, now: number): string {
  if (card.ageSince === null) return "";
  const days = Math.max(0, Math.floor((now - card.ageSince) / 86_400_000));
  return days < 1
    ? "today"
    : days < 30
      ? `${days}d`
      : `${Math.floor(days / 30)}mo`;
}

function canTypeKey(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.closest(
        "input, textarea, select, button:not([data-pipeline-card]), a, [contenteditable], [role=dialog], [role=menu]",
      ) !== null)
  );
}

export function PipelineView({
  board,
  prefs,
  onPrefs,
  now,
  focusTicket,
  onFocusTicket,
  onMap,
  onHow,
  onRescan,
}: {
  board: Board;
  prefs: Prefs;
  onPrefs: (patch: Partial<Prefs>) => void;
  now: number;
  focusTicket: string | null;
  onFocusTicket: (ticket: string | null) => void;
  onMap: () => void;
  onHow: () => void;
  onRescan: () => Promise<void>;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const { projectId } = useBbContext();
  const navigate = useBbNavigate();
  const advance = useAdvanceBatches();
  const hold = usePrHoldControls();
  const [query, setQuery] = useState("");
  const [layout, setLayout] = useState<"stage" | "effort">("stage");
  const [selected, setSelected] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [effortEditing, setEffortEditing] = useState<PipelineCard | null>(null);
  const [advanceSelection, setAdvanceSelection] = useState<AdvanceSelection>(EMPTY_SELECTION);
  const [filterOpen, setFilterOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showHistory, setShowHistory] = useState<Record<string, boolean>>({});
  const [direct, setDirect] = useState<ActionRequest | null>(null);
  const [agent, setAgent] = useState<PipelineAgentRequest | null>(null);
  const [messaging, setMessaging] = useState<{ key: string; location: "card" | "drawer" } | null>(null);
  const [starting, setStarting] = useState<Row | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [conversationRequest, setConversationRequest] = useState<ConversationPanelRequest | null>(null);
  const [lastConversationId, setLastConversationId] = useState<string | null>(() => readLastConversation(projectId));
  const [dispatchBusy, setDispatchBusy] = useState(false);
  const [dispatch, setDispatch] = useState(board.dispatch);
  const [queuedDirect, setQueuedDirect] = useState<PipelineCard[]>([]);
  const [refreshingPr, setRefreshingPr] = useState<string | null>(null);
  const [refreshResults, setRefreshResults] = useState<Record<string, { checkedAt: string | null; error: string | null; attemptAt: number }>>({});
  const searchRef = useRef<HTMLInputElement>(null);
  const boardRootRef = useRef<HTMLDivElement | null>(null);
  const openThreadRequest = useRef(0);
  const portalScope = usePortalScopeProps();
  const arrivedFocus = useRef<string | null>(null);
  useEffect(() => setDispatch(board.dispatch), [board.dispatch]);
  useEffect(() => setLastConversationId(readLastConversation(projectId)), [projectId]);
  useEffect(() => () => { openThreadRequest.current++; }, []);

  const locals = useMemo(
    () => [...inboxRows(board, now).values()].flat(),
    [board, now],
  );
  const cards = useMemo(
    () =>
      pipelineCards(board.prInventory.entries, locals, now, {
        holds: board.prHolds,
        batches: advance.batches,
        dispatch,
        runs: board.runs,
        observations: board.prObservations,
      }),
    [board, locals, now, advance.batches, dispatch],
  );
  const stackGraph = useMemo(() => pipelineStackGraph(cards), [cards]);
  const counts = useMemo(
    () =>
      Object.fromEntries(
        PIPELINE_STAGES.map((stage) => [
          stage,
          cards.filter((card) => card.stage === stage).length,
        ]),
      ) as Record<PipelineStage, number>,
    [cards],
  );
  const agentCards = cards.filter(
    (card) => !card.hold && card.activity.state !== "none",
  );
  const working = agentCards.filter(
    (card) => card.activity.state === "working",
  ).length;
  const needsYou = agentCards.filter(
    (card) => card.activity.state === "needs-you",
  ).length;
  const done = agentCards.filter(
    (card) => card.activity.state === "done",
  ).length;
  const search = query.trim().toLowerCase();
  usePipelineMotion(boardRootRef, cards, {
    layout,
    search,
    approvedOnly: prefs.approvedOnly,
  });
  const visible = cards.filter(
    (card) =>
      matchesApprovedFilter(card.pr, prefs.approvedOnly) &&
      (!search ||
        [
          card.repo,
          card.title,
          card.pr ? `#${card.pr.number}` : "",
          String(card.pr?.number ?? ""),
          card.effortName ?? "",
          card.local?.cluster.ticket ?? "",
        ].some((part) => part.toLowerCase().includes(search))),
  );
  const filteredCounts = Object.fromEntries(
    PIPELINE_STAGES.map((stage) => [
      stage,
      visible.filter((card) => card.stage === stage).length,
    ]),
  ) as Record<PipelineStage, number>;
  const stageCount = (stage: PipelineStage) =>
    search || prefs.approvedOnly
      ? `${filteredCounts[stage]}/${counts[stage]}`
      : String(counts[stage]);
  const openCount = visible.filter((card) => card.pr?.state === "OPEN").length;
  const branchCount = visible.filter((card) => card.pr === null && card.stage !== "merged" && card.stage !== "released").length;
  const readyCount = visible.filter(
    (card) => card.action?.kind === "merge",
  ).length;
  const holdCount = visible.filter(
    (card) => card.stage !== "merged" && card.stage !== "released" && card.hold,
  ).length;
  const completedCount = visible.filter((card) => card.stage === "merged" || card.stage === "released").length;
  const selectedCard = cards.find((card) => card.key === selected) ?? null;
  const selectedObservation = selectedCard?.pr ? board.prObservations[selectedCard.pr.url.toLowerCase()] : null;
  const selectedRefresh = selectedCard?.pr ? refreshResults[selectedCard.pr.url] : null;
  const selectedCheckedAt = [selectedObservation?.checkedAt, selectedRefresh?.checkedAt].filter((at): at is string => !!at)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
  const selectedRefreshError = selectedRefresh?.error && (!selectedCheckedAt || Date.parse(selectedCheckedAt) <= selectedRefresh.attemptAt)
    ? selectedRefresh.error
    : selectedObservation?.failedAt && (!selectedCheckedAt || Date.parse(selectedObservation.failedAt) >= Date.parse(selectedCheckedAt))
      ? "The latest GitHub status check failed. Previous PR facts may be stale."
      : null;
  const selectionUrl = (card: PipelineCard) => card.pr ? advancePrKey(canonicalPrUrl(card.pr.url) ?? card.pr.url) : null;
  const selectionPrs = cards.flatMap((card) => card.pr ? [{ url: selectionUrl(card)!, state: card.pr.state }] : []);
  const selectionHolds: PrHolds = Object.fromEntries(cards.filter((card) => card.pr && card.hold).map((card) => [selectionUrl(card)!, card.hold!]));
  useEffect(() => setAdvanceSelection((current) => reconcileAdvanceSelection(current, selectionPrs, selectionHolds)), [cards]);
  const visibleSelection = new Set(visible.map(selectionUrl).filter((url): url is string => url !== null));
  const hiddenSelected = advanceSelection.urls.filter((url) => !visibleSelection.has(url)).length;
  const workScope = conversationScope(cards, visible, advanceSelection.urls);
  const openWorkConversation = (request: ConversationPanelRequest) => {
    setDetailsOpen(false);
    setConversationRequest(request);
  };
  const rememberConversation = (id: string) => {
    setLastConversationId(id);
    saveLastConversation(projectId, id);
  };
  useEffect(() => {
    if (messaging && (
      !cards.some((card) => card.key === messaging.key) ||
      (messaging.location === "drawer" && (selected !== messaging.key || !detailsOpen))
    )) setMessaging(null);
  }, [cards, messaging, selected, detailsOpen]);
  useEffect(() => {
    if (
      selected !== null &&
      (search || prefs.approvedOnly) &&
      !visible.some((card) => card.key === selected)
    ) {
      setSelected(null);
      setDetailsOpen(false);
    }
  }, [selected, search, prefs.approvedOnly, visible]);
  const sidebarThreads = experimental_useSidebarThreads().threads;

  useEffect(() => {
    if (focusTicket === null || arrivedFocus.current === focusTicket) return;
    arrivedFocus.current = focusTicket;
    const match = cards.find(
      (card) => card.local?.cluster.ticket === focusTicket,
    );
    if (match) setSelected(match.key);
  }, [cards, focusTicket]);

  const choose = (card: PipelineCard) => {
    setSelected(card.key);
    if (card.local) {
      arrivedFocus.current = card.local.cluster.ticket;
      onFocusTicket(card.local.cluster.ticket);
    }
    requestAnimationFrame(() => {
      const element = document.getElementById(`pipeline-${card.key}`);
      element?.scrollIntoView({ block: "nearest", inline: "nearest" });
      (element instanceof HTMLButtonElement
        ? element
        : element?.querySelector<HTMLButtonElement>("[data-pipeline-card]")
      )?.focus({ preventScroll: true });
    });
  };
  const openDetails = (card: PipelineCard) => {
    setSelected(card.key);
    setDetailsOpen(true);
  };
  const showThreadChoices = (card: PipelineCard) => {
    openDetails(card);
    toast.info("Choose a linked thread in details");
    requestAnimationFrame(() => document.getElementById("pipeline-detail-agent")?.scrollIntoView({ block: "nearest" }));
  };
  const toggleSelection = (card: PipelineCard) => {
    choose(card);
    if (selectablePipelineCard(card) && (advanceSelection.urls.includes(selectionUrl(card)!) || advanceSelection.urls.length < ADVANCE_SELECTION_LIMIT))
      setAdvanceSelection((current) => togglePipelineSelection(current, card));
  };
  const parentTarget = (card: PipelineCard) => {
    const number = card.backlog?.parent?.pr.number ?? card.local?.unit.stack?.blockedBelow;
    if (number == null) return null;
    const childUrl = card.pr ? canonicalPrUrl(card.pr.url) : null;
    const url = card.backlog?.parent?.pr.url ?? childUrl?.replace(/\/pull\/\d+$/u, `/pull/${number}`) ?? null;
    const parent = cards.find((item) => item.pr && (
      url ? selectionUrl(item) === advancePrKey(canonicalPrUrl(url) ?? url) : item.repo === card.repo && item.pr.number === number
    )) ?? null;
    return { number, url, card: parent };
  };
  const goToCard = (card: PipelineCard) => {
    setQuery("");
    onPrefs({ approvedOnly: false });
    if (HISTORY_LIMIT[card.stage])
      setShowHistory((current) => ({ ...current, [card.stage]: true }));
    choose(card);
  };
  const openParent = (card: PipelineCard) => {
    const target = parentTarget(card);
    if (target?.card) goToCard(target.card);
    else if (target?.url) window.open(target.url, "_blank", "noopener,noreferrer");
    else toast.info("Parent PR is not available on this board");
  };
  const directRow = (card: PipelineCard): DirectRow | null =>
    card.pr === null
      ? null
      : (card.local ?? {
          repo: card.repo,
          title: card.title,
          age: { since: card.ageSince },
          unit: { pr: card.pr, prUrl: card.pr.url },
        });
  const refreshPr = async (card: PipelineCard) => {
    if (!card.pr || refreshingPr !== null) return;
    const url = card.pr.url;
    setRefreshingPr(url);
    const attemptAt = Date.now();
    setRefreshResults((current) => ({ ...current, [url]: { checkedAt: current[url]?.checkedAt ?? null, error: null, attemptAt } }));
    try {
      const result = await rpc.call("pr_refresh", { prUrl: url });
      if (result.status === "checked") {
        setRefreshResults((current) => ({ ...current, [url]: { checkedAt: result.checkedAt, error: null, attemptAt } }));
      } else {
        setRefreshResults((current) => ({ ...current, [url]: { checkedAt: result.checkedAt, error: result.error, attemptAt } }));
        toast.error(result.error);
      }
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : "Could not refresh GitHub status";
      setRefreshResults((current) => ({ ...current, [url]: { checkedAt: current[url]?.checkedAt ?? null, error, attemptAt } }));
      toast.error(error);
    } finally {
      setRefreshingPr(null);
    }
  };
  const openThread = async (card: PipelineCard) => {
    const request = ++openThreadRequest.current;
    if (card.pr) {
      try {
        const context = await rpc.call("pr_thread_context", { prUrl: card.pr.url });
        if (request !== openThreadRequest.current) return;
        if (context.recommendedThreadId) {
          navigate.toThread(context.recommendedThreadId);
          return;
        }
        if (context.threads.length > 0) {
          showThreadChoices(card);
          return;
        }
        toast.info("No linked thread for this PR");
      } catch (cause) {
        if (request !== openThreadRequest.current) return;
        toast.error(cause instanceof Error ? cause.message : "Could not find the linked thread");
      }
      return;
    }
    const linked = card.local?.cluster.threads ?? [];
    if (linked.length === 1) navigate.toThread(linked[0]!.id);
    else if (linked.length > 1) showThreadChoices(card);
    else toast.info("No linked thread for this item");
  };
  const repairAction = (card: PipelineCard): AgentAction | null => {
    if (card.local && card.blocker.label.startsWith("CI failing"))
      return "investigate-ci";
    if (card.local?.action?.kind === "agent") return card.local.action.action;
    const attempt = dispatch.attempts.find(
      (item) => item.path === card.local?.key && item.prUrl === card.pr?.url,
    );
    if (attempt && AGENT_ACTIONS.some((action) => action === attempt.action))
      return attempt.action as AgentAction;
    const run = board.runs.find(
      (item) =>
        item.path === card.local?.key &&
        item.prUrl === card.pr?.url &&
        item.kind === "agent",
    );
    if (run && AGENT_ACTIONS.some((action) => action === run.action))
      return run.action as AgentAction;
    return null;
  };
  const openCheckout = (card: PipelineCard) => {
    if (!card.local) return;
    const path = card.local.unit.path;
    const accepted =
      board.hostId !== null &&
      navigate.experimental_openFileExternally({
        target: { kind: "host", hostId: board.hostId, path },
        location: null,
      });
    if (!accepted)
      void navigator.clipboard.writeText(path).then(
        () => toast.success("Checkout path copied"),
        () => toast.error("Could not open or copy the checkout path"),
      );
  };
  const run = (card: PipelineCard) => {
    const action = card.action;
    if (!action) return;
    if (action.kind === "release") {
      if (card.pr) void hold.release(card.pr.url);
      return;
    }
    if (action.kind === "open-thread") {
      openThread(card);
      return;
    }
    if (action.kind === "open-pr" && card.pr) {
      window.open(card.pr.url, "_blank", "noopener,noreferrer");
      return;
    }
    if (action.kind === "open-parent") {
      openParent(card);
      return;
    }
    if (action.kind === "advance" || action.kind === "fix") {
      if (
        action.kind === "fix" &&
        card.activity.source === "advance" &&
        card.pr
      ) {
        const batch = advance.batches.find((item) =>
          item.jobs.some(
            (job) =>
              job.prUrl === card.pr?.url && job.status === "needs-attention",
          ),
        );
        const job = batch?.jobs.find(
          (item) =>
            item.prUrl === card.pr?.url && item.status === "needs-attention",
        );
        if (batch && job) {
          setAgent({ kind: "repair", batchId: batch.id, jobId: job.id });
          return;
        }
      }
      if (card.pr?.state === "OPEN" && !card.hold) {
        setAgent({ kind: "advance", prUrls: [card.pr.url] });
        return;
      }
      const actionToRepair = repairAction(card);
      if (card.local && actionToRepair) {
        setAgent({ kind: "agent", action: actionToRepair, row: card.local });
        return;
      }
      if (action.kind === "fix" && card.activity.threadId) {
        openThread(card);
        return;
      }
      choose(card);
      toast.info("Open the PR to inspect its current blocker");
      return;
    }
    const row = directRow(card);
    if (row && (action.kind === "merge" || action.kind === "nudge"))
      setDirect({ kind: "direct", action: action.kind, row });
  };
  const startDirectQueue = (
    items: PipelineCard[],
    action: "merge" | "nudge",
  ) => {
    const eligible = items.filter(
      (card) => card.action?.kind === action && directRow(card),
    );
    if (!eligible.length) return;
    setQueuedDirect(eligible.slice(1));
    setDirect({ kind: "direct", action, row: directRow(eligible[0]!)! });
  };
  const nextDirect = () => {
    const [next, ...rest] = queuedDirect;
    if (
      !next ||
      (next.action?.kind !== "merge" && next.action?.kind !== "nudge")
    ) {
      setQueuedDirect([]);
      setDirect(null);
      return;
    }
    setQueuedDirect(rest);
    setDirect({
      kind: "direct",
      action: next.action.kind,
      row: directRow(next)!,
    });
  };
  const setDispatchMode = async (
    mode: Board["dispatch"]["mode"],
    effortKey: string | null,
  ) => {
    setDispatchBusy(true);
    try {
      setDispatch(await rpc.call("dispatch_set", { mode, effortKey }));
    } catch (cause) {
      toast.error(
        cause instanceof Error
          ? cause.message
          : "Could not change automatic dispatch",
      );
    } finally {
      setDispatchBusy(false);
    }
  };

  const efforts = [
    ...new Map(
      visible.map((card) => [
        card.effortKey ?? "",
        card.effortName ?? "One-offs",
      ]),
    ).entries(),
  ].sort((a, b) => a[1].localeCompare(b[1]));
  const orderedVisible = orderPipelineCards(visible, stackGraph);
  const orderedEfforts = new Map(efforts.map(([key]) => [key, orderPipelineCards(visible.filter((card) => (card.effortKey ?? "") === key), stackGraph)]));
  const displayedStageCards = (
    stage: PipelineStage,
    source: PipelineCard[],
  ) => {
    const sorted = source.filter((card) => card.stage === stage);
    const limit = HISTORY_LIMIT[stage];
    return limit && !showHistory[stage] ? sorted.slice(0, limit) : sorted;
  };
  const navCards =
    layout === "stage"
      ? PIPELINE_STAGES.flatMap((stage) => displayedStageCards(stage, orderedVisible))
      : efforts.flatMap(([key]) =>
          PIPELINE_STAGES.flatMap((stage) =>
            displayedStageCards(stage, orderedEfforts.get(key) ?? []),
          ),
        );
  useEffect(() => {
    if (messaging?.location === "card" && !navCards.some((card) => card.key === messaging.key))
      setMessaging(null);
  }, [messaging, navCards]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (conversationRequest) {
        if (event.key === "Escape" && !event.defaultPrevented && !canTypeKey(event.target)) {
          event.preventDefault();
          setConversationRequest(null);
        }
        return;
      }
      if (
        event.key === "Escape" && detailsOpen &&
        !event.defaultPrevented && !effortEditing && !agent && !direct &&
        !hold.target && !messaging && !starting && !historyOpen &&
        !filterOpen && !menuOpen &&
        !(event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable], [role=dialog], [role=menu]"))
      ) {
        event.preventDefault();
        setDetailsOpen(false);
        return;
      }
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        canTypeKey(event.target)
      )
        return;
      if (effortEditing || agent || direct || hold.target || starting || historyOpen) return;
      if (event.key === "/") {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (
        messaging ||
        filterOpen ||
        menuOpen
      )
        return;
      if (event.key === "j" || event.key === "k") {
        event.preventDefault();
        const index = navCards.findIndex((card) => card.key === selected);
        const next =
          event.key === "j"
            ? Math.min(navCards.length - 1, index + 1)
            : Math.max(0, index < 0 ? 0 : index - 1);
        if (navCards[next]) choose(navCards[next]);
      } else if (selectedCard && ["a", "m", "t", "o"].includes(event.key)) {
        event.preventDefault();
        if (event.key === "t") openThread(selectedCard);
        else if (event.key === "o") openCheckout(selectedCard);
        else if (
          event.key === "a" &&
          ["advance", "fix"].includes(selectedCard.action?.kind ?? "")
        )
          run(selectedCard);
        else if (event.key === "m" && selectedCard.action?.kind === "merge")
          run(selectedCard);
      } else if (event.key === "Escape") {
        if (detailsOpen) setDetailsOpen(false);
        else setSelected(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [conversationRequest, detailsOpen, selected, navCards, messaging, filterOpen, menuOpen, effortEditing, agent, direct, hold.target, starting, historyOpen]);

  const linkedThreadIds = (card: PipelineCard): string[] => card.pr
    ? board.prThreadLinks[canonicalPrUrl(card.pr.url) ?? card.pr.url] ?? []
    : card.local?.cluster.threads.map((thread) => thread.id) ?? [];

  const cardView = (card: PipelineCard, nested: boolean) => {
    const repoName = card.repo.split("/").at(-1) ?? card.repo;
    const dependents = stackGraph.childrenByParent.get(card.key) ?? [];
    const label = `${card.repo}${card.pr ? ` #${card.pr.number}` : ""}: ${card.title}`;
    const parent = parentTarget(card);
    const behindTag = parent !== null && card.blocker.label === `Behind #${parent.number}`;
    const selectable = selectablePipelineCard(card);
    const checked = selectable && advanceSelection.urls.includes(selectionUrl(card)!);
    const selectionFull = advanceSelection.urls.length >= ADVANCE_SELECTION_LIMIT && !checked;
    const menuItem = "cursor-pointer rounded px-2 py-1.5 text-[12px] outline-none focus:bg-foreground/[0.06] data-[disabled]:pointer-events-none data-[disabled]:opacity-40";
    return (
      <div
        key={card.key}
        id={`pipeline-${card.key}`}
        data-pipeline-motion-key={card.key}
        className={cn(
          "group relative isolate min-w-0 rounded-lg border bg-card px-3 py-2.5 text-left shadow-sm transition-colors hover:border-foreground/30",
          nested && "ml-2 border-l-2 border-l-foreground/25",
          card.hold && "opacity-55 hover:opacity-90",
          selected === card.key && "border-ring ring-1 ring-ring/40",
          checked && "border-foreground/50 bg-foreground/[0.04]",
        )}
      >
        <div className="flex min-w-0 items-center gap-2 font-mono text-[11px]">
          {selectable ? (
            <input
              type="checkbox"
              checked={checked}
              disabled={selectionFull}
              onChange={() => {
                setSelected(card.key);
                setAdvanceSelection((current) => togglePipelineSelection(current, card));
              }}
              aria-label={`Select ${card.repo} #${card.pr!.number} for Advance`}
              className="shrink-0 accent-foreground"
            />
          ) : null}
          <b className="truncate" title={card.repo}>
            {repoName}
          </b>
          {card.pr ? (
            <UrlLink
              href={card.pr.url}
              className="shrink-0 text-muted-foreground hover:underline"
            >
              #{card.pr.number}
            </UrlLink>
          ) : (
            <span className="text-muted-foreground">
              branch
            </span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            <PipelineThreadIndicator threadIds={linkedThreadIds(card)} sidebarThreads={sidebarThreads} preferredThreadId={card.activity.threadId} />
            <span className={cn("text-muted-foreground", card.ageSince !== null && now - card.ageSince > 30 * 86_400_000 && "text-amber-600")}>{age(card, now)}</span>
          </span>
        </div>
        <button
          data-pipeline-card
          type="button"
          onClick={() => toggleSelection(card)}
          aria-label={selectable ? selectionFull ? `Focus ${label}; Advance selection limit reached` : `${checked ? "Remove" : "Select"} ${label} ${checked ? "from" : "for"} Advance` : `Focus ${label}`}
          aria-pressed={selectable ? checked : undefined}
          className="mt-1 block w-full overflow-hidden text-ellipsis rounded text-left text-[12px] leading-4 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          style={{
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
          }}
        >
          {card.title}
        </button>
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
          {behindTag && parent.card ? (
            <Tip label={`Go to parent PR #${parent.number} card: ${parent.card.title}`}>
              <button type="button" onClick={() => goToCard(parent.card!)} aria-label={`Go to parent PR #${parent.number} card: ${parent.card.title}`} className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring", BLOCKER_COLOR[card.blocker.tone])}>{card.blocker.label}</button>
            </Tip>
          ) : behindTag && parent.url ? (
            <UrlLink href={parent.url} aria-label={`Open parent PR #${parent.number} on GitHub${card.backlog?.parent ? `: ${card.backlog.parent.pr.title}` : ""}`} title="Parent card is not on this board; open the parent PR on GitHub" className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring", BLOCKER_COLOR[card.blocker.tone])}>{card.blocker.label}</UrlLink>
          ) : (
            <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium", BLOCKER_COLOR[card.blocker.tone])}>{card.blocker.label}</span>
          )}
          {!behindTag && parent?.card ? (
            <button type="button" onClick={() => goToCard(parent.card!)} aria-label={`Go to parent PR #${parent.number} card: ${parent.card.title}`} className="shrink-0 rounded px-1 py-0.5 text-[10px] text-muted-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">Behind #{parent.number}</button>
          ) : !behindTag && parent?.url ? (
            <UrlLink href={parent.url} aria-label={`Open parent PR #${parent.number} on GitHub`} className="shrink-0 rounded px-1 py-0.5 text-[10px] text-muted-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">Behind #{parent.number}</UrlLink>
          ) : null}
          <button
            type="button"
            onClick={() => setEffortEditing(card)}
            aria-label={`Change effort for ${label}; current effort ${card.effortName ?? "One-offs"}`}
            title={`Change effort: ${card.effortName ?? "One-offs"}`}
            className="min-w-0 max-w-full flex-1 truncate rounded px-1 py-0.5 text-left text-[10px] text-muted-foreground outline-none hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            {card.effortName ?? "One-offs"}
          </button>
          {card.action?.kind === "open-pr" && card.pr ? (
            <UrlLink
              href={card.pr.url}
              className="ml-auto shrink-0 rounded border px-2 py-1 text-[10.5px] font-semibold hover:bg-foreground/[0.06]"
            >
              {card.action.label}
            </UrlLink>
          ) : card.action ? (
            <button
              type="button"
              onClick={() => run(card)}
              className={cn(
                "ml-auto shrink-0 rounded border px-2 py-1 text-[10.5px] font-semibold outline-none hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring",
                card.action.kind === "merge" &&
                  "border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700",
                card.action.kind === "fix" &&
                  "border-destructive/30 text-destructive",
              )}
            >
              {card.action.label}
            </button>
          ) : null}
        </div>
        <p className="mt-1 text-[10.5px] leading-4 text-muted-foreground">
          <b className="text-foreground">Next:</b> {card.nextStep}
        </p>
        {dependents.length > 0 ? (
          <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
            <span>{dependents.length === 1 ? "Dependent:" : "Dependents:"}</span>
            {dependents.map((child) => (
              <button key={child.key} type="button" onClick={() => goToCard(child)} title={child.title} aria-label={`Go to dependent ${child.repo} #${child.pr!.number} in ${LABEL[child.stage]}${child.hold ? ", on hold" : ""}: ${child.title}`} className="rounded border px-1 py-0.5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                #{child.pr!.number} · {LABEL[child.stage]}{child.hold ? " · On hold" : ""}
              </button>
            ))}
          </div>
        ) : null}
        <div className="mt-2 flex items-center gap-1 border-t border-border/70 pt-1.5">
          {!(messaging?.key === card.key && messaging.location === "card") ? (
              <Tip label="Message agent">
                <button
                  type="button"
                  onClick={() => setMessaging({ key: card.key, location: "card" })}
                  aria-label={`Message agent for ${card.repo}${card.pr ? ` #${card.pr.number}` : ""}`}
                  className="flex size-8 items-center justify-center rounded text-muted-foreground outline-none hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Icon name="Bot" className="size-[18px]" />
                </button>
              </Tip>
          ) : null}
          {card.pr || card.local?.cluster.threads.length ? (
            <Tip label="Open thread">
              <button type="button" onClick={() => void openThread(card)} aria-label={`Open thread for ${label}`} className="flex size-8 items-center justify-center rounded text-muted-foreground outline-none hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"><Icon name="ArrowUpRight" className="size-[18px]" /></button>
            </Tip>
          ) : null}
          <div className="ml-auto flex items-center gap-1">
            {refreshingPr === card.pr?.url ? <span role="status" className="text-[10px] text-muted-foreground">Checking GitHub…</span> : null}
            <Tip label="Open details">
              <button type="button" aria-label={`Open details for ${label}`} aria-expanded={detailsOpen && selected === card.key} onClick={() => openDetails(card)} className="flex size-8 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:bg-foreground/[0.07] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"><Icon name="PanelRight" className="size-[18px]" /></button>
            </Tip>
            <DropdownMenu.Root>
              <Tip label="More actions"><DropdownMenu.Trigger asChild><button type="button" aria-label={`More actions for ${label}`} className="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:bg-foreground/[0.07] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"><Icon name="MoreHorizontal" className="size-4" /></button></DropdownMenu.Trigger></Tip>
              <DropdownMenu.Portal><DropdownMenu.Content {...portalScope} side="bottom" align="end" sideOffset={4} collisionPadding={8} className="z-50 min-w-44 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md">
                <DropdownMenu.Item className={menuItem} onSelect={() => setEffortEditing(card)}>Change effort…</DropdownMenu.Item>
                {card.hold && card.pr ? <DropdownMenu.Item className={menuItem} onSelect={() => void hold.release(card.pr!.url)}>Release hold</DropdownMenu.Item> : null}
                {card.pr?.state === "OPEN" && !card.hold ? <DropdownMenu.Item className={menuItem} onSelect={() => hold.edit({ url: card.pr!.url, label: `${card.repo} #${card.pr!.number}`, hold: card.hold })}>Put on hold…</DropdownMenu.Item> : null}
                {card.activity.threadId || card.local?.cluster.threads.length ? <DropdownMenu.Item className={menuItem} onSelect={() => openThread(card)}>Open thread</DropdownMenu.Item> : null}
                {card.pr ? <DropdownMenu.Item disabled={refreshingPr !== null} className={menuItem} onSelect={() => void refreshPr(card)}>{refreshingPr === card.pr.url ? "Checking GitHub…" : "Refresh GitHub status"}</DropdownMenu.Item> : null}
                {!card.hold && card.local ? <DropdownMenu.Item className={menuItem} onSelect={() => openCheckout(card)}>Open checkout</DropdownMenu.Item> : null}
                {card.pr?.state === "OPEN" && !card.hold && card.activity.state !== "working" && card.action?.kind !== "advance" && card.action?.kind !== "fix" ? <DropdownMenu.Item className={menuItem} onSelect={() => setAgent({ kind: "advance", prUrls: [card.pr!.url] })}>Advance…</DropdownMenu.Item> : null}
              </DropdownMenu.Content></DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        </div>
        {messaging?.key === card.key && messaging.location === "card" ? <div className="mt-2"><PipelinePrComposer key={card.key} card={card} sidebarThreads={sidebarThreads} onClose={() => setMessaging(null)} /></div> : null}
        {card.activity.state !== "none" ? (
          <button
            type="button"
            disabled={!card.activity.threadId}
            onClick={() => openThread(card)}
            className={cn(
              "mt-2 block w-full truncate border-t border-dashed border-border/70 py-1.5 text-left text-[10px] text-muted-foreground disabled:cursor-default",
              card.activity.state === "working" &&
                "text-violet-600 dark:text-violet-300",
              card.activity.state === "needs-you" && "text-destructive",
            )}
          >
            {" "}
            <b className="capitalize">
              {card.activity.state.replace("-", " ")}
            </b>{" "}
            · {card.activity.detail}
          </button>
        ) : null}
      </div>
    );
  };

  const columnCards = (stage: PipelineStage, source = orderedVisible) => {
    const all = source.filter((card) => card.stage === stage);
    const limit = HISTORY_LIMIT[stage];
    const shown = displayedStageCards(stage, source);
    const inColumn = new Map(all.map((card) => [card.key, card]));
    const isNested = (card: PipelineCard) => {
      const parent = inColumn.get(stackGraph.parentByChild.get(card.key) ?? "");
      return parent !== undefined && (parent.hold !== null) === (card.hold !== null);
    };
    return (
      <>
        {shown.map((card) =>
          limit ? (
            <div
              key={card.key}
              id={`pipeline-${card.key}`}
              data-pipeline-motion-key={card.key}
              className={cn(
                "flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 rounded px-1 py-1 text-left text-[10.5px] hover:bg-foreground/[0.05]",
                selected === card.key && "bg-foreground/[0.07]",
              )}
            >
              <button data-pipeline-card type="button" onClick={() => choose(card)} aria-label={`Focus ${card.repo} #${card.pr?.number}: ${card.title}`} className="flex min-w-0 basis-full items-baseline gap-1 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <b className="shrink-0 font-mono">{card.repo.split("/").at(-1)}</b>
                <span className="shrink-0 font-mono text-muted-foreground">#{card.pr?.number}</span>
                <span className="min-w-0 truncate text-muted-foreground">{card.title}</span>
              </button>
              <button type="button" onClick={() => setEffortEditing(card)} aria-label={`Change effort for ${card.repo} #${card.pr?.number}`} title={`Change effort: ${card.effortName ?? "One-offs"}`} className="min-w-0 flex-1 truncate rounded px-1 text-left text-[10px] text-muted-foreground outline-none hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring">{card.effortName ?? "One-offs"}</button>
              <PipelineThreadIndicator threadIds={linkedThreadIds(card)} sidebarThreads={sidebarThreads} preferredThreadId={card.activity.threadId} />
              {refreshingPr === card.pr?.url ? <span role="status" className="text-[10px] text-muted-foreground">Checking GitHub…</span> : null}
              <Tip label="Open details"><button type="button" onClick={() => openDetails(card)} aria-label={`Open details for ${card.repo} #${card.pr?.number}`} className="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring"><Icon name="PanelRight" className="size-4" /></button></Tip>
              <DropdownMenu.Root>
                <Tip label="More actions"><DropdownMenu.Trigger asChild><button type="button" aria-label={`More actions for ${card.repo} #${card.pr?.number}`} className="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring"><Icon name="MoreHorizontal" className="size-4" /></button></DropdownMenu.Trigger></Tip>
                <DropdownMenu.Portal><DropdownMenu.Content {...portalScope} side="bottom" align="end" sideOffset={4} collisionPadding={8} className="z-50 min-w-44 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md">
                  <DropdownMenu.Item className="cursor-pointer rounded px-2 py-1.5 text-[12px] outline-none focus:bg-foreground/[0.06]" onSelect={() => setEffortEditing(card)}>Change effort…</DropdownMenu.Item>
                  {card.pr ? <DropdownMenu.Item disabled={refreshingPr !== null} className="cursor-pointer rounded px-2 py-1.5 text-[12px] outline-none focus:bg-foreground/[0.06]" onSelect={() => void refreshPr(card)}>Refresh GitHub status</DropdownMenu.Item> : null}
                </DropdownMenu.Content></DropdownMenu.Portal>
              </DropdownMenu.Root>
            </div>
          ) : (
            cardView(card, isNested(card))
          ),
        )}
        {limit && all.length > limit ? (
          <button
            type="button"
            onClick={() =>
              setShowHistory((current) => ({
                ...current,
                [stage]: !current[stage],
              }))
            }
            className="rounded px-2 py-1 text-left text-[11px] text-muted-foreground hover:text-foreground"
          >
            {showHistory[stage] ? "Show recent" : `Show all ${all.length}`}
          </button>
        ) : null}
        {all.length === 0 ? (
          <p className="rounded border border-dashed p-3 text-center text-[11px] text-muted-foreground">
            Nothing here
          </p>
        ) : null}
      </>
    );
  };
  const bulkMerge = pipelineBulkCards(visible, "ready", stackGraph);
  const bulkNudge = visible.filter(
    (card) => card.stage === "review" && card.action?.kind === "nudge" && card.ageSince !== null && now - card.ageSince >= 7 * 86_400_000,
  );
  const selectedNudge = cards.filter((card) =>
    card.action?.kind === "nudge" &&
    (selectionUrl(card) !== null && advanceSelection.urls.includes(selectionUrl(card)!)),
  );
  const bulkButton = (stage: PipelineStage) => {
    if (stage === "build" || stage === "review" || stage === "feedback") {
      const candidates = pipelineBulkCards(visible, stage, stackGraph);
      const urls = candidates.slice(0, ADVANCE_SELECTION_LIMIT).map((card) => card.pr!.url);
      const stageWork = stage === "feedback"
        ? conversationScope(cards, visible.filter((card) => card.stage === stage), [], "Feedback")
        : null;
      if (!urls.length && !(stage === "review" && bulkNudge.length) && !stageWork?.prUrls.length) return null;
      return (
        <div className="ml-auto flex items-center gap-1">
          {stageWork?.prUrls.length ? (
            <button
              type="button"
              onClick={() => openWorkConversation({ kind: "scope", scope: stageWork })}
              title={`Work on ${stageWork.prUrls.length} matching Feedback PRs`}
              className="rounded border px-2 py-1 text-[10px] hover:bg-foreground/[0.06]"
            >
              Work on these…
            </button>
          ) : null}
          {urls.length ? (
            <button
              type="button"
              onClick={() => setAgent({ kind: "advance", prUrls: urls })}
              title={candidates.length > ADVANCE_SELECTION_LIMIT ? `First ${ADVANCE_SELECTION_LIMIT} of ${candidates.length} visible PRs` : undefined}
              className="rounded border px-2 py-1 text-[10px] hover:bg-foreground/[0.06]"
            >
              Advance {urls.length}
            </button>
          ) : null}
          {stage === "review" && bulkNudge.length ? (
            <button
              type="button"
              onClick={() => startDirectQueue(bulkNudge, "nudge")}
              className="rounded border px-2 py-1 text-[10px] hover:bg-foreground/[0.06]"
            >
              Nudge {bulkNudge.length}
            </button>
          ) : null}
        </div>
      );
    }
    if (stage === "ready" && bulkMerge.length)
      return (
        <button
          type="button"
          onClick={() => startDirectQueue(bulkMerge, "merge")}
          className="ml-auto rounded border px-2 py-1 text-[10px] hover:bg-foreground/[0.06]"
        >
          Merge {bulkMerge.length}
        </button>
      );
    return null;
  };
  const selectedParent = selectedCard ? parentTarget(selectedCard) : null;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col text-foreground">
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2">
        <div
          role="tablist"
          aria-label="Workstreams views"
          className="flex shrink-0 items-center gap-2 text-[11.5px]"
        >
          <button
            type="button"
            role="tab"
            aria-selected={false}
            onClick={() => navigate.toPluginPanel("board", { subPath: "inventory" })}
            className="rounded px-1 py-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Inventory
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={false}
            onClick={onMap}
            className="rounded px-1 py-0.5 text-muted-foreground hover:text-foreground"
          >
            Map
          </button>
          <button
            type="button"
            role="tab"
            aria-selected
            className="rounded px-1 py-0.5 font-semibold"
          >
            Pipeline
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={false}
            onClick={() => navigate.toPluginPanel("board", { subPath: "work" })}
            className="rounded px-1 py-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Work
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={false}
            onClick={() => navigate.toPluginPanel("board", { subPath: "efforts" })}
            className="rounded px-1 py-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Efforts
          </button>
        </div>
        <div
          role="group"
          aria-label="Pipeline layout"
          className="flex rounded-md border border-border p-0.5 text-[11px]"
        >
          <button
            type="button"
            aria-pressed={layout === "stage"}
            onClick={() => setLayout("stage")}
            className={cn(
              "rounded px-2 py-1",
              layout === "stage" && "bg-foreground/[0.08] font-medium",
            )}
          >
            Stages
          </button>
          <button
            type="button"
            aria-pressed={layout === "effort"}
            onClick={() => setLayout("effort")}
            className={cn(
              "rounded px-2 py-1",
              layout === "effort" && "bg-foreground/[0.08] font-medium",
            )}
          >
            By effort
          </button>
        </div>
        <input
          ref={searchRef}
          aria-label="Search pipeline"
          placeholder="Search repo, PR, ticket, effort… (/)"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="h-7 min-w-36 flex-1 rounded-md border border-input bg-background px-2 text-[11.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <button
          type="button"
          onClick={() => openWorkConversation({ kind: "scope", scope: workScope })}
          className="shrink-0 rounded-md border border-border px-2.5 py-1.5 text-[11px] font-medium outline-none hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring"
        >
          {advanceSelection.urls.length ? `Work on ${advanceSelection.urls.length} PRs…` : "Work on these…"}
        </button>
        {lastConversationId ? <button type="button" onClick={() => openWorkConversation({ kind: "resume", conversationId: lastConversationId })} className="shrink-0 rounded-md px-2 py-1.5 text-[11px] text-muted-foreground outline-none hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">Resume conversation</button> : null}
        <div className="relative">
          <button
            type="button"
            aria-expanded={filterOpen}
            onClick={() => setFilterOpen(!filterOpen)}
            className="rounded-md border border-border px-2 py-1 text-[11px]"
          >
            Filter{prefs.approvedOnly ? " · Approved" : ""}
          </button>
          {filterOpen ? (
            <div className="absolute right-0 top-8 z-30 w-48 rounded-lg border border-border bg-popover p-2 text-[11px] shadow-lg">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={prefs.approvedOnly}
                  onChange={(event) =>
                    onPrefs({ approvedOnly: event.target.checked })
                  }
                />
                Approved only
              </label>
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  onPrefs({ approvedOnly: false });
                  setFilterOpen(false);
                }}
                className="mt-2 rounded text-muted-foreground underline"
              >
                Clear filters
              </button>
            </div>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => {
            const target =
              cards.find(
                (card) => !card.hold && card.activity.state === "needs-you",
              ) ??
              cards.find(
                (card) => !card.hold && card.activity.state === "working",
              ) ??
              cards.find(
                (card) => !card.hold && card.activity.state === "done",
              );
            if (target) {
              setQuery("");
              onPrefs({ approvedOnly: false });
              setShowHistory((current) => ({
                ...current,
                [target.stage]: true,
              }));
              choose(target);
            }
          }}
          disabled={agentCards.length === 0}
          className="rounded-full border border-violet-500/30 bg-violet-500/10 px-2 py-1 text-[11px] text-violet-700 disabled:opacity-50 dark:text-violet-300"
          title="Jump to agent activity"
        >
          {working} working · {needsYou} need you · {done} done
        </button>
        <div className="relative">
          <button
            type="button"
            aria-label="Pipeline options"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(!menuOpen)}
            className="rounded px-2 py-1 text-muted-foreground hover:bg-foreground/[0.06]"
          >
            ⋯
          </button>
          {menuOpen ? (
            <div className="absolute right-0 top-8 z-30 flex w-48 flex-col rounded-lg border border-border bg-popover p-1 text-left text-[11px] shadow-lg">
              <button
                type="button"
                disabled={board.scanning}
                onClick={() => {
                  void onRescan().catch((cause: unknown) =>
                    toast.error(
                      cause instanceof Error
                        ? cause.message
                        : "Could not rescan checkouts",
                    ),
                  );
                  setMenuOpen(false);
                }}
                className="rounded px-2 py-1 text-left hover:bg-foreground/[0.06] disabled:opacity-50"
              >
                {board.scanning ? "Scanning…" : "Rescan checkouts"}
              </button>
              <button
                type="button"
                disabled={board.prInventory.refreshing}
                onClick={() => {
                  void rpc
                    .call("inventory_refresh")
                    .catch((cause: unknown) =>
                      toast.error(
                        cause instanceof Error
                          ? cause.message
                          : "Could not refresh PR inventory",
                      ),
                    );
                  setMenuOpen(false);
                }}
                className="rounded px-2 py-1 text-left hover:bg-foreground/[0.06] disabled:opacity-50"
              >
                Refresh PR inventory
              </button>
              <button
                type="button"
                onClick={() => {
                  setHistoryOpen(true);
                  setMenuOpen(false);
                }}
                className="rounded px-2 py-1 text-left hover:bg-foreground/[0.06]"
              >
                Advance history
              </button>
              <button
                type="button"
                onClick={() => {
                  onHow();
                  setMenuOpen(false);
                }}
                className="rounded px-2 py-1 text-left hover:bg-foreground/[0.06]"
              >
                How this works
              </button>
              <ArchivedThreadsButton />
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  navigate.toPluginPanel("board", { subPath: "board" });
                }}
                className="rounded px-2 py-1 text-left hover:bg-foreground/[0.06]"
              >
                Legacy Board
              </button>
              {board.warnings.length ? (
                <details className="border-t px-2 py-1 text-muted-foreground">
                  <summary className="cursor-pointer">
                    {board.warnings.length} scan notices
                  </summary>
                  <ul className="max-h-40 overflow-auto pl-3">
                    {board.warnings.map((warning, index) => (
                      <li key={`${index}-${warning}`} className="py-1">
                        {warning}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      <div role="group" aria-label="Advance selection" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/60 px-3 py-1.5 text-[11px]">
        <button
          type="button"
          onClick={() => setAdvanceSelection((current) => ({ ...current, urls: selectVisibleOpen(current.urls, visible.filter(selectablePipelineCard).map((card) => ({ url: selectionUrl(card)!, state: "OPEN" }))) }))}
          disabled={!visible.some((card) => selectablePipelineCard(card) && !advanceSelection.urls.includes(selectionUrl(card)!)) || advanceSelection.urls.length >= ADVANCE_SELECTION_LIMIT}
          className="rounded border px-2 py-1 hover:bg-foreground/[0.06] disabled:opacity-50"
        >
          Select visible
        </button>
        <button
          type="button"
          onClick={() => setAgent({ kind: "advance", prUrls: advanceSelection.urls })}
          disabled={advanceSelection.urls.length === 0}
          className="rounded border px-2 py-1 font-medium hover:bg-foreground/[0.06] disabled:opacity-50"
        >
          Advance selected ({advanceSelection.urls.length})
        </button>
        {selectedNudge.length ? (
          <button
            type="button"
            onClick={() => startDirectQueue(selectedNudge, "nudge")}
            className="rounded border px-2 py-1 hover:bg-foreground/[0.06]"
          >
            Nudge selected ({selectedNudge.length})
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => setAdvanceSelection(EMPTY_SELECTION)}
          disabled={advanceSelection.urls.length === 0 && advanceSelection.removed === 0}
          className="rounded px-2 py-1 text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          Clear selection
        </button>
        {hiddenSelected ? <span className="text-muted-foreground">{hiddenSelected} selected outside this filter</span> : null}
        {advanceSelection.removed ? <span className="text-muted-foreground">{advanceSelection.removed} removed after hold, close, or disappearance</span> : null}
      </div>
      <div
        aria-label="Pipeline summary"
        className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/60 bg-muted/30 px-3 py-1 text-[11px]"
      >
        <span className="font-medium text-foreground">
          {search || prefs.approvedOnly ? "Matching" : "Overall"}
        </span>
        <span>{openCount} open PRs</span>
        {branchCount > 0 ? <><span aria-hidden="true" className="text-muted-foreground">·</span><span>{branchCount} branches without PRs</span></> : null}
        <span aria-hidden="true" className="text-muted-foreground">·</span>
        <span>{readyCount} ready to merge</span>
        <span aria-hidden="true" className="text-muted-foreground">·</span>
        <span>{holdCount} on hold</span>
        <span aria-hidden="true" className="text-muted-foreground">·</span>
        <span>{completedCount} completed</span>
      </div>
      <div className="relative flex min-h-0 min-w-0 w-full flex-1 overflow-hidden">
        <div ref={boardRootRef} className="min-w-0 flex-1 overflow-auto">
          {layout === "stage" ? (
            <div className="min-w-[1520px]">
              <div className="sticky top-0 z-10 grid grid-cols-6 gap-4 bg-background px-3">
                {PIPELINE_STAGES.map((stage) => (
                  <header
                    key={stage}
                    data-pipeline-stage-header={stage}
                    className="flex min-h-12 items-center gap-2 border-b border-border py-2 text-[11px]"
                  >
                    <h2 className="font-semibold">{LABEL[stage]}</h2>
                    <span className="font-mono text-muted-foreground">
                      {stageCount(stage)}
                    </span>
                    {bulkButton(stage)}
                  </header>
                ))}
              </div>
              <div className="grid grid-cols-6 gap-4 px-3 pb-3">
                {PIPELINE_STAGES.map((stage) => (
                  <section
                    key={stage}
                    id={`pipeline-column-${stage}`}
                    className="flex min-w-0 flex-col gap-3 pt-3"
                  >
                    {columnCards(stage)}
                  </section>
                ))}
              </div>
            </div>
          ) : (
            <div className="min-w-[1696px] p-3">
              <p className="border-b border-border px-1 pb-1 text-[10.5px] text-muted-foreground">
                Automatic actions run for one effort at a time
                {dispatch.effortKey
                  ? ` · active: ${efforts.find(([key]) => key === dispatch.effortKey)?.[1] ?? "another effort"}`
                  : ""}
                .
              </p>
              {efforts.map(([key, name]) => (
                <section
                  key={key}
                  className="grid grid-cols-[160px_repeat(6,minmax(240px,1fr))] gap-4 border-b border-border/70 py-3"
                >
                  <div className="sticky left-0 z-10 bg-background text-[12px] leading-4 after:absolute after:inset-y-0 after:-right-4 after:w-4 after:bg-background">
                    <b
                      className="overflow-hidden break-words"
                      title={name}
                      style={{
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                      }}
                    >
                      {name}
                    </b>
                    <span className="mt-1 block text-[11px] text-muted-foreground">
                      {
                        visible.filter(
                          (card) =>
                            (card.effortKey ?? "") === key &&
                            card.stage !== "merged" &&
                            card.stage !== "released",
                        ).length
                      }{" "}
                      open
                    </span>
                    {key ? (
                      <details className="relative mt-2">
                        <summary className="cursor-pointer text-[10px] text-muted-foreground">
                          ⋯ Agents
                        </summary>
                        <select
                          aria-label={`Automatic dispatch for ${name}; replaces the current effort`}
                          disabled={dispatchBusy}
                          value={
                            dispatch.effortKey === key ? dispatch.mode : "off"
                          }
                          onChange={(event) =>
                            void setDispatchMode(
                              event.target.value as Board["dispatch"]["mode"],
                              event.target.value === "off" ? null : key,
                            )
                          }
                          className="max-w-full rounded border border-border bg-background px-1 py-0.5 text-[10px]"
                        >
                          <option value="off">Agents off</option>
                          <option value="shadow">Preview only</option>
                          <option value="auto">Run automatically</option>
                        </select>
                      </details>
                    ) : null}
                  </div>
                  {PIPELINE_STAGES.map((stage) => (
                    <div
                      key={stage}
                      data-pipeline-stage={stage}
                      className="flex min-w-0 flex-col gap-3"
                    >
                      <h3 className="text-[11px] font-medium text-muted-foreground">
                        {LABEL[stage]}
                      </h3>
                      {columnCards(
                        stage,
                        orderedEfforts.get(key) ?? [],
                      )}
                    </div>
                  ))}
                </section>
              ))}
            </div>
          )}
        </div>
        {conversationRequest ? <PipelineConversationPanel request={conversationRequest} onClose={() => setConversationRequest(null)} onRemember={rememberConversation} /> : null}
        {detailsOpen && selectedCard && !conversationRequest ? (
          <aside
            aria-label="Pipeline item detail"
            className="absolute inset-y-0 right-0 z-20 flex w-[min(390px,100%)] shrink-0 flex-col overflow-hidden border-l border-border bg-background text-[13px] shadow-xl lg:static lg:shadow-none"
          >
            <div className="shrink-0 border-b border-border/70 px-5 py-2">
              <div className="flex items-start justify-between gap-3">
                <p className="min-w-0 truncate font-mono text-[11px] text-muted-foreground" title={selectedCard.repo}>
                  {selectedCard.repo}{selectedCard.pr ? ` #${selectedCard.pr.number}` : ""}
                </p>
                <button
                  type="button"
                  aria-label="Close details"
                  onClick={() => setDetailsOpen(false)}
                  className="-mr-1 -mt-1 flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Icon name="X" className="size-4" />
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 space-y-6 overflow-y-auto overscroll-contain px-5 pb-6 pt-4">
              <div>
                <h2 className="break-words text-[20px] font-semibold leading-7 tracking-tight">{selectedCard.title}</h2>
                <p className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                  <span className="rounded border border-border px-1.5 py-0.5 font-medium text-foreground">{LABEL[selectedCard.stage]}</span>
                  <button type="button" onClick={() => setEffortEditing(selectedCard)} aria-label={`Change effort for ${selectedCard.repo}${selectedCard.pr ? ` #${selectedCard.pr.number}` : ""}; current effort ${selectedCard.effortName ?? "One-offs"}`} title="Change effort" className="min-w-0 truncate rounded px-1 py-0.5 text-left outline-none hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">{selectedCard.effortName ?? "One-offs"}</button>
                </p>
              </div>
              <section>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Next step</p>
                <p className="mt-2 text-[14px] leading-5 text-foreground">{selectedCard.nextStep}</p>
                <p className={cn("mt-2 text-[11px]", selectedCard.blocker.tone === "bad" ? "text-destructive" : selectedCard.blocker.tone === "warn" ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground")}>{selectedCard.blocker.label}</p>
                {selectedCard.pr ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                    <span>GitHub checked {selectedCheckedAt ? relativeTime(selectedCheckedAt, now) : "never"}</span>
                    <button type="button" disabled={refreshingPr !== null} onClick={() => void refreshPr(selectedCard)} className="rounded underline-offset-2 hover:underline disabled:opacity-50">{refreshingPr === selectedCard.pr.url ? "Checking…" : "Refresh GitHub status"}</button>
                    {selectedRefreshError ? <span role="alert" className="w-full text-destructive">{selectedRefreshError}</span> : null}
                  </div>
                ) : null}
                {selectedCard.hold?.reason ? <p className="mt-2 break-words text-[11px] text-muted-foreground">Hold reason: {selectedCard.hold.reason}</p> : null}
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  {selectedCard.action?.kind === "open-pr" && selectedCard.pr ? (
                    <UrlLink href={selectedCard.pr.url} className="inline-flex min-h-9 items-center rounded-md bg-foreground px-3 py-1.5 text-[12px] font-medium text-background outline-none hover:opacity-85 focus-visible:ring-2 focus-visible:ring-ring">{selectedCard.action.label}</UrlLink>
                  ) : selectedCard.action ? (
                    <button type="button" onClick={() => run(selectedCard)} className="inline-flex min-h-9 items-center rounded-md bg-foreground px-3 py-1.5 text-[12px] font-medium text-background outline-none hover:opacity-85 focus-visible:ring-2 focus-visible:ring-ring">{selectedCard.action.label}</button>
                  ) : null}
                  {selectedCard.pr?.state === "OPEN" && !selectedCard.hold && selectedCard.activity.state !== "working" && selectedCard.action?.kind !== "advance" && selectedCard.action?.kind !== "fix" ? (
                    <button type="button" onClick={() => setAgent({ kind: "advance", prUrls: [selectedCard.pr!.url] })} className="rounded-md px-2 py-1.5 text-[12px] font-medium text-muted-foreground outline-none hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">Advance…</button>
                  ) : null}
                </div>
              </section>
            {selectedCard.local?.unit.stack || selectedCard.backlog?.parent ? (
              <section className="border-t border-border/70 pt-5">
                <h3 className="text-[12px] font-semibold">Stack</h3>
                {selectedCard.local?.unit.stack ? (
                  <p className="mt-2 text-muted-foreground">Position {selectedCard.local.unit.stack.position + 1}</p>
                ) : null}
                {selectedParent ? (
                  <p className="mt-2 break-words leading-5">
                    Behind{" "}
                    {selectedParent.card ? (
                      <button type="button" onClick={() => goToCard(selectedParent.card!)} aria-label={`Go to parent PR #${selectedParent.number} card: ${selectedParent.card.title}`} className="rounded text-left underline outline-none focus-visible:ring-2 focus-visible:ring-ring">#{selectedParent.number} · {selectedParent.card.title}</button>
                    ) : selectedParent.url ? (
                      <UrlLink href={selectedParent.url} aria-label={`Open parent PR #${selectedParent.number} on GitHub${selectedCard.backlog?.parent ? `: ${selectedCard.backlog.parent.pr.title}` : ""}`} title="Parent card is not on this board; open the parent PR on GitHub" className="underline">#{selectedParent.number}{selectedCard.backlog?.parent ? ` · ${selectedCard.backlog.parent.pr.title}` : ""}</UrlLink>
                    ) : <>#{selectedParent.number}</>}
                    {selectedParent.card && selectedParent.url ? <>{" · "}<UrlLink href={selectedParent.url} className="underline" aria-label={`Open parent PR #${selectedParent.number} on GitHub`}>GitHub</UrlLink></> : null}
                  </p>
                ) : null}
              </section>
            ) : null}
            <section id="pipeline-detail-agent" className="border-t border-border/70 pt-5">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-[12px] font-semibold">Agent</h3>
                {selectedCard.pr || selectedCard.local ? (
                  <button
                    type="button"
                    onClick={() => setMessaging({ key: selectedCard.key, location: "drawer" })}
                    aria-label={`Message agent in details for ${selectedCard.repo}${selectedCard.pr ? ` #${selectedCard.pr.number}` : ""}`}
                    className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[11px] font-medium text-foreground outline-none hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Icon name="Bot" className="size-4" />
                    Message agent
                  </button>
                ) : null}
              </div>
              <p className={cn("mt-2 break-words text-[12px] leading-5", selectedCard.activity.state === "needs-you" ? "text-destructive" : selectedCard.activity.state === "working" ? "text-violet-600 dark:text-violet-300" : "text-muted-foreground")}>
                {selectedCard.activity.state === "none"
                  ? selectedCard.pr ? "No recent PR activity" : "No recent thread activity"
                  : `${selectedCard.activity.state.replace("-", " ")} · ${selectedCard.activity.detail}`}
              </p>
              {selectedCard.pr ? (
                <PrThreadLinks
                  prUrl={selectedCard.pr.url}
                  sidebarThreads={sidebarThreads}
                  onOpenThread={(id) => navigate.toThread(id)}
                />
              ) : selectedCard.local?.cluster.threads.length ? (
                <ul className="mt-1 space-y-1">
                  {selectedCard.local.cluster.threads.map((thread) => (
                    <li key={thread.id}>
                      <button
                        type="button"
                        onClick={() => navigate.toThread(thread.id)}
                        className="max-w-full rounded text-left text-[12px] underline outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        title={thread.title}
                      >
                        {thread.active ? "● " : ""}{thread.title}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : <p className="mt-1 text-muted-foreground">No linked threads.</p>}
              {messaging?.key === selectedCard.key && messaging.location === "drawer" ? (
                <div className="mt-3 rounded-md border border-border p-3">
                  <PipelinePrComposer
                    key={selectedCard.key}
                    card={selectedCard}
                    sidebarThreads={sidebarThreads}
                    onClose={() => setMessaging(null)}
                  />
                </div>
              ) : null}
            </section>
            {selectedCard.pr ? (
              <section className="border-t border-border/70 pt-5">
                <h3 className="text-[12px] font-semibold">Readiness</h3>
                <dl className="mt-2 divide-y divide-border/60 text-[12px]">
                  {[
                    ["Review", selectedCard.pr.reviewDecision ?? "—"],
                    ["Checks", selectedCard.pr.checkConclusions.length ? selectedCard.pr.checkConclusions.join(", ") : "—"],
                    ["Branch", selectedCard.pr.mergeStateStatus ?? "—"],
                    ["Threads", `${selectedCard.pr.unresolvedReviewThreads ?? "Unknown"} open · ${selectedCard.pr.resolvedReviewThreads ?? "Unknown"} resolved`],
                  ].map(([label, value]) => (
                    <div key={label} className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-3 py-2 leading-5">
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd className="min-w-0 break-words text-right" title={value}>{value}</dd>
                    </div>
                  ))}
                </dl>
                {selectedCard.pr.reviewRequests.length ? <p className="mt-2 break-words text-[11px] text-muted-foreground">Requested: {selectedCard.pr.reviewRequests.join(", ")}</p> : null}
              </section>
            ) : null}
              <section className="border-t border-border/70 pt-5">
                <h3 className="text-[12px] font-semibold">More actions</h3>
                <div className="mt-2 flex flex-wrap items-center gap-1 text-[12px] text-muted-foreground">
                  {selectedCard.pr && selectedCard.action?.kind !== "open-pr" ? (
                    <UrlLink href={selectedCard.pr.url} className="rounded-md px-2 py-1.5 outline-none hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">GitHub</UrlLink>
                  ) : null}
                  {selectedCard.local?.cluster.linear?.url ? (
                    <UrlLink href={selectedCard.local.cluster.linear.url} className="rounded-md px-2 py-1.5 outline-none hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">Linear</UrlLink>
                  ) : null}
                  {selectedCard.local ? (
                    <>
                      <button type="button" onClick={() => openCheckout(selectedCard)} className="rounded-md px-2 py-1.5 outline-none hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">Checkout</button>
                      {!selectedCard.hold ? (
                        <button type="button" onClick={() => setStarting(selectedCard.local)} className="rounded-md px-2 py-1.5 outline-none hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">New thread</button>
                      ) : null}
                    </>
                  ) : null}
                  {selectedCard.pr && !selectedCard.hold ? (
                    <button type="button" onClick={() => hold.edit({ url: selectedCard.pr!.url, label: `${selectedCard.repo} #${selectedCard.pr!.number}`, hold: selectedCard.hold })} className="rounded-md px-2 py-1.5 outline-none hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">Hold…</button>
                  ) : null}
                </div>
              </section>
            </div>
          </aside>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap gap-x-3 gap-y-1 border-t border-border/60 px-3 py-2 text-[10px] text-muted-foreground">
        <span>j/k move</span>
        <span>a advance</span>
        <span>m merge</span>
        <span>t thread</span>
        <span>o checkout</span>
        <span>v map</span>
        <span className="ml-auto">
          {board.lastScanAt ? `Checkouts scanned ${relativeTime(board.lastScanAt, now)}` : "Checkouts not scanned"}
          {board.lastPrCheckedAt ? ` · Latest GitHub check ${relativeTime(board.lastPrCheckedAt, now)}` : " · GitHub not checked"}
        </span>
      </div>
      <PrHoldDialog target={hold.target} onClose={hold.close} />
      <PipelineCardEffortDialog card={effortEditing} onClose={() => setEffortEditing(null)} />
      <ActionDialogs
        request={direct}
        now={now}
        onClose={() => {
          setQueuedDirect([]);
          setDirect(null);
        }}
        onSuccess={nextDirect}
      />
      <PipelineAgentSheet
        request={agent}
        onClose={() => setAgent(null)}
        onStarted={() => {
          if (agent?.kind === "advance") {
            const started = new Set(agent.prUrls.map((url) => advancePrKey(canonicalPrUrl(url) ?? url)));
            setAdvanceSelection((current) => {
              const urls = current.urls.filter((url) => !started.has(url));
              return urls.length === current.urls.length ? current : { ...current, urls };
            });
          }
          void advance.refresh();
        }}
        onOpenThread={(id) => navigate.toThread(id)}
      />
      <StartThreadDialog row={starting} onClose={() => setStarting(null)} />
      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Advance history</DialogTitle>
          </DialogHeader>
          {advance.batches.length ? (
            <AdvanceProgress
              batches={advance.batches}
              error={advance.error}
              onRefresh={advance.refresh}
              onOpenThread={(id) => navigate.toThread(id)}
              onRepair={(batchId, jobId) => {
                setHistoryOpen(false);
                setAgent({ kind: "repair", batchId, jobId });
              }}
              width={560}
            />
          ) : (
            <p className="text-xs text-muted-foreground">
              No advance batches yet.
            </p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
