import { useEffect, useMemo, useRef, useState } from "react";
import {
  UrlLink,
  experimental_useSidebarThreads,
  useBbNavigate,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { Board, rpcContract } from "./server";
import type { Prefs } from "./server";
import { inboxRows } from "./inbox-rows";
import {
  pipelineCards,
  pipelineBulkCards,
  byPipelineOrder,
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
  const [dispatchBusy, setDispatchBusy] = useState(false);
  const [dispatch, setDispatch] = useState(board.dispatch);
  const [queuedDirect, setQueuedDirect] = useState<PipelineCard[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);
  const boardRootRef = useRef<HTMLDivElement | null>(null);
  const openThreadRequest = useRef(0);
  const portalScope = usePortalScopeProps();
  const arrivedFocus = useRef<string | null>(null);
  useEffect(() => setDispatch(board.dispatch), [board.dispatch]);
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
      }),
    [board, locals, now, advance.batches, dispatch],
  );
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
  const openCount = visible.filter(
    (card) => card.stage !== "merged" && card.stage !== "released",
  ).length;
  const readyCount = visible.filter(
    (card) => card.stage === "ready" && !card.hold,
  ).length;
  const holdCount = visible.filter(
    (card) => card.stage !== "merged" && card.stage !== "released" && card.hold,
  ).length;
  const completedCount = visible.length - openCount;
  const selectedCard = cards.find((card) => card.key === selected) ?? null;
  const selectionUrl = (card: PipelineCard) => card.pr ? advancePrKey(canonicalPrUrl(card.pr.url) ?? card.pr.url) : null;
  const selectionPrs = cards.flatMap((card) => card.pr ? [{ url: selectionUrl(card)!, state: card.pr.state }] : []);
  const selectionHolds: PrHolds = Object.fromEntries(cards.filter((card) => card.pr && card.hold).map((card) => [selectionUrl(card)!, card.hold!]));
  useEffect(() => setAdvanceSelection((current) => reconcileAdvanceSelection(current, selectionPrs, selectionHolds)), [cards]);
  const visibleSelection = new Set(visible.map(selectionUrl).filter((url): url is string => url !== null));
  const hiddenSelected = advanceSelection.urls.filter((url) => !visibleSelection.has(url)).length;
  useEffect(() => {
    if (messaging && (
      !cards.some((card) => card.key === messaging.key && card.pr?.state === "OPEN" && !card.hold) ||
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
  const goToParent = (parent: PipelineCard) => {
    setQuery("");
    onPrefs({ approvedOnly: false });
    if (HISTORY_LIMIT[parent.stage])
      setShowHistory((current) => ({ ...current, [parent.stage]: true }));
    choose(parent);
  };
  const openParent = (card: PipelineCard) => {
    const target = parentTarget(card);
    if (target?.card) goToParent(target.card);
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
    if (card.local && card.blocker.label === "CI failing")
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
  const displayedStageCards = (
    stage: PipelineStage,
    source: PipelineCard[],
  ) => {
    const sorted = source
      .filter((card) => card.stage === stage)
      .sort(byPipelineOrder);
    const limit = HISTORY_LIMIT[stage];
    return limit && !showHistory[stage] ? sorted.slice(0, limit) : sorted;
  };
  const navCards =
    layout === "stage"
      ? PIPELINE_STAGES.flatMap((stage) => displayedStageCards(stage, visible))
      : efforts.flatMap(([key]) =>
          PIPELINE_STAGES.flatMap((stage) =>
            displayedStageCards(
              stage,
              visible.filter((card) => (card.effortKey ?? "") === key),
            ),
          ),
        );
  useEffect(() => {
    if (messaging?.location === "card" && !navCards.some((card) => card.key === messaging.key))
      setMessaging(null);
  }, [messaging, navCards]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
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
  });

  const cardView = (card: PipelineCard) => {
    const repoName = card.repo.split("/").at(-1) ?? card.repo;
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
          <span
            className={cn(
              "ml-auto shrink-0 text-muted-foreground",
              card.ageSince !== null &&
                now - card.ageSince > 30 * 86_400_000 &&
                "text-amber-600",
            )}
          >
            {age(card, now)}
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
              <button type="button" onClick={() => goToParent(parent.card!)} aria-label={`Go to parent PR #${parent.number} card: ${parent.card.title}`} className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring", BLOCKER_COLOR[card.blocker.tone])}>{card.blocker.label}</button>
            </Tip>
          ) : behindTag && parent.url ? (
            <UrlLink href={parent.url} aria-label={`Open parent PR #${parent.number} on GitHub${card.backlog?.parent ? `: ${card.backlog.parent.pr.title}` : ""}`} title="Parent card is not on this board; open the parent PR on GitHub" className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring", BLOCKER_COLOR[card.blocker.tone])}>{card.blocker.label}</UrlLink>
          ) : (
            <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium", BLOCKER_COLOR[card.blocker.tone])}>{card.blocker.label}</span>
          )}
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
        <div className="mt-2 flex items-center gap-1 border-t border-border/70 pt-1.5">
          {card.pr?.state === "OPEN" && !card.hold && !(messaging?.key === card.key && messaging.location === "card") ? (
              <Tip label="Message agent">
                <button
                  type="button"
                  onClick={() => setMessaging({ key: card.key, location: "card" })}
                  aria-label={`Message agent for ${card.repo} #${card.pr.number}`}
                  className="flex size-8 items-center justify-center rounded text-muted-foreground outline-none hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Icon name="Bot" className="size-[18px]" />
                </button>
              </Tip>
          ) : null}
          {(card.pr || card.local?.cluster.threads.length) && !card.hold ? (
            <Tip label="Open thread">
              <button type="button" onClick={() => void openThread(card)} aria-label={`Open thread for ${label}`} className="flex size-8 items-center justify-center rounded text-muted-foreground outline-none hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"><Icon name="ArrowUpRight" className="size-[18px]" /></button>
            </Tip>
          ) : null}
          <div className="ml-auto flex items-center gap-1">
            <Tip label="Open details">
              <button type="button" aria-label={`Open details for ${label}`} aria-expanded={detailsOpen && selected === card.key} onClick={() => openDetails(card)} className="flex size-8 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:bg-foreground/[0.07] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"><Icon name="PanelRight" className="size-[18px]" /></button>
            </Tip>
            <DropdownMenu.Root>
              <Tip label="More actions"><DropdownMenu.Trigger asChild><button type="button" aria-label={`More actions for ${label}`} className="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:bg-foreground/[0.07] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"><Icon name="MoreHorizontal" className="size-4" /></button></DropdownMenu.Trigger></Tip>
              <DropdownMenu.Portal><DropdownMenu.Content {...portalScope} side="bottom" align="end" sideOffset={4} collisionPadding={8} className="z-50 min-w-44 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md">
                <DropdownMenu.Item className={menuItem} onSelect={() => setEffortEditing(card)}>Change effort…</DropdownMenu.Item>
                {card.hold && card.pr ? <DropdownMenu.Item className={menuItem} onSelect={() => void hold.release(card.pr!.url)}>Release hold</DropdownMenu.Item> : null}
                {card.pr?.state === "OPEN" && !card.hold ? <DropdownMenu.Item className={menuItem} onSelect={() => hold.edit({ url: card.pr!.url, label: `${card.repo} #${card.pr!.number}`, hold: card.hold })}>Put on hold…</DropdownMenu.Item> : null}
                {!card.hold && (card.activity.threadId || card.local?.cluster.threads.length) ? <DropdownMenu.Item className={menuItem} onSelect={() => openThread(card)}>Open thread</DropdownMenu.Item> : null}
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
        {card.activity.state === "working" ? (
          <div className="absolute bottom-0 left-3 right-3 h-0.5 overflow-hidden rounded bg-violet-500/10">
            <span className="block h-full w-1/3 bg-violet-500 motion-safe:animate-pulse" />
          </div>
        ) : null}
      </div>
    );
  };

  const columnCards = (stage: PipelineStage, source = visible) => {
    const all = source
      .filter((card) => card.stage === stage)
      .sort(byPipelineOrder);
    const limit = HISTORY_LIMIT[stage];
    const shown = displayedStageCards(stage, source);
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
              <Tip label="Open details"><button type="button" onClick={() => openDetails(card)} aria-label={`Open details for ${card.repo} #${card.pr?.number}`} className="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring"><Icon name="PanelRight" className="size-4" /></button></Tip>
              <DropdownMenu.Root>
                <Tip label="More actions"><DropdownMenu.Trigger asChild><button type="button" aria-label={`More actions for ${card.repo} #${card.pr?.number}`} className="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring"><Icon name="MoreHorizontal" className="size-4" /></button></DropdownMenu.Trigger></Tip>
                <DropdownMenu.Portal><DropdownMenu.Content {...portalScope} side="bottom" align="end" sideOffset={4} collisionPadding={8} className="z-50 min-w-44 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"><DropdownMenu.Item className="cursor-pointer rounded px-2 py-1.5 text-[12px] outline-none focus:bg-foreground/[0.06]" onSelect={() => setEffortEditing(card)}>Change effort…</DropdownMenu.Item></DropdownMenu.Content></DropdownMenu.Portal>
              </DropdownMenu.Root>
            </div>
          ) : (
            cardView(card)
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
  const bulkMerge = pipelineBulkCards(visible, "ready");
  const bulkNudge = visible.filter(
    (card) => card.stage === "review" && card.action?.kind === "nudge" && card.ageSince !== null && now - card.ageSince >= 7 * 86_400_000,
  );
  const selectedNudge = cards.filter((card) =>
    card.action?.kind === "nudge" &&
    (selectionUrl(card) !== null && advanceSelection.urls.includes(selectionUrl(card)!)),
  );
  const bulkButton = (stage: PipelineStage) => {
    if (stage === "build" || stage === "review" || stage === "feedback") {
      const candidates = pipelineBulkCards(visible, stage);
      const urls = candidates.slice(0, ADVANCE_SELECTION_LIMIT).map((card) => card.pr!.url);
      if (!urls.length && !(stage === "review" && bulkNudge.length)) return null;
      return (
        <div className="ml-auto flex items-center gap-1">
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
        <span>{openCount} open</span>
        <span aria-hidden="true" className="text-muted-foreground">·</span>
        <span>{readyCount} ready to merge</span>
        <span aria-hidden="true" className="text-muted-foreground">·</span>
        <span>{holdCount} on hold</span>
        <span aria-hidden="true" className="text-muted-foreground">·</span>
        <span>{completedCount} completed</span>
      </div>
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
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
                        visible.filter(
                          (card) => (card.effortKey ?? "") === key,
                        ),
                      )}
                    </div>
                  ))}
                </section>
              ))}
            </div>
          )}
        </div>
        {detailsOpen && selectedCard ? (
          <aside
            aria-label="Pipeline item detail"
            className="absolute inset-y-0 right-0 z-20 w-[min(320px,100%)] shrink-0 overflow-y-auto border-l border-border bg-background p-3 text-[11.5px] shadow-xl lg:static lg:shadow-none"
          >
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <h2 className="text-[13px] font-semibold leading-5">
                  {selectedCard.title}
                </h2>
                <p className="mt-1 font-mono text-[10.5px] text-muted-foreground">
                  {selectedCard.repo}
                  {selectedCard.pr ? ` #${selectedCard.pr.number}` : ""} ·{" "}
                  {LABEL[selectedCard.stage]}
                </p>
              </div>
              <button
                type="button"
                aria-label="Close details"
                onClick={() => setDetailsOpen(false)}
                className="rounded px-1 text-muted-foreground hover:bg-foreground/[0.06]"
              >
                ×
              </button>
            </div>
            <div className="mt-3 rounded border border-border bg-muted/30 p-2">
              <p><b>Blocker:</b> {selectedCard.blocker.label}</p>
              <p className="mt-1"><b>Next:</b> {selectedCard.nextStep}</p>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-1">
              {[
                ["Review", selectedCard.pr?.reviewDecision ?? "—"],
                [
                  "Checks",
                  selectedCard.pr?.checkConclusions.length
                    ? selectedCard.pr.checkConclusions.join(", ")
                    : "—",
                ],
                ["Branch", selectedCard.pr?.mergeStateStatus ?? "—"],
                [
                  "Threads",
                  selectedCard.pr?.unresolvedReviewThreads === null ||
                  selectedCard.pr?.unresolvedReviewThreads === undefined
                    ? "Unknown"
                    : `${selectedCard.pr.unresolvedReviewThreads} open`,
                ],
              ].map(([label, value]) => (
                <div
                  key={label}
                  className="min-w-0 rounded bg-muted/60 px-2 py-1"
                >
                  <b className="block text-[10px] text-muted-foreground">
                    {label}
                  </b>
                  <span className="block truncate" title={value}>
                    {value}
                  </span>
                </div>
              ))}
            </div>
            {selectedCard.hold ? (
              <p className="mt-3 rounded bg-muted p-2">
                On hold
                {selectedCard.hold.reason
                  ? ` · ${selectedCard.hold.reason}`
                  : ""}
              </p>
            ) : null}
            {selectedCard.local?.unit.stack || selectedCard.backlog?.parent ? (
              <section className="mt-4">
                <h3 className="mb-1 font-semibold">Stack</h3>
                {selectedCard.local?.unit.stack ? (
                  <p>Position {selectedCard.local.unit.stack.position + 1}</p>
                ) : null}
                {selectedParent ? (
                  <p className="mt-1">
                    Behind{" "}
                    {selectedParent.card ? (
                      <button type="button" onClick={() => goToParent(selectedParent.card!)} aria-label={`Go to parent PR #${selectedParent.number} card: ${selectedParent.card.title}`} className="rounded text-left underline outline-none focus-visible:ring-2 focus-visible:ring-ring">#{selectedParent.number} · {selectedParent.card.title}</button>
                    ) : selectedParent.url ? (
                      <UrlLink href={selectedParent.url} aria-label={`Open parent PR #${selectedParent.number} on GitHub${selectedCard.backlog?.parent ? `: ${selectedCard.backlog.parent.pr.title}` : ""}`} title="Parent card is not on this board; open the parent PR on GitHub" className="underline">#{selectedParent.number}{selectedCard.backlog?.parent ? ` · ${selectedCard.backlog.parent.pr.title}` : ""}</UrlLink>
                    ) : <>#{selectedParent.number}</>}
                    {selectedParent.card && selectedParent.url ? <>{" · "}<UrlLink href={selectedParent.url} className="underline" aria-label={`Open parent PR #${selectedParent.number} on GitHub`}>GitHub</UrlLink></> : null}
                  </p>
                ) : null}
              </section>
            ) : null}
            <section id="pipeline-detail-agent" className="mt-4">
              <h3 className="mb-1 font-semibold">Agent</h3>
              <p className="text-muted-foreground">
                {selectedCard.activity.state === "none"
                  ? "No recent agent activity"
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
                        className="max-w-full rounded text-left text-[11px] underline"
                        title={thread.title}
                      >
                        {thread.active ? "● " : ""}{thread.title}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : <p className="mt-1 text-muted-foreground">No linked threads.</p>}
            </section>
            <section className="mt-4">
              <h3 className="mb-1 font-semibold">Review</h3>
              <p>
                {selectedCard.pr?.unresolvedReviewThreads ?? "Unknown"} open ·{" "}
                {selectedCard.pr?.resolvedReviewThreads ?? "Unknown"} resolved
                threads
              </p>
              {selectedCard.pr?.reviewRequests.length ? (
                <p className="mt-1 text-muted-foreground">
                  Requested: {selectedCard.pr.reviewRequests.join(", ")}
                </p>
              ) : null}
            </section>
            <div className="mt-4 flex flex-wrap items-center gap-1.5 border-t border-border pt-3">
              {selectedCard.action?.kind === "open-pr" && selectedCard.pr ? (
                <UrlLink
                  href={selectedCard.pr.url}
                  className="rounded bg-foreground px-2 py-1 font-medium text-background"
                >
                  {selectedCard.action.label}
                </UrlLink>
              ) : selectedCard.action ? (
                <button
                  type="button"
                  onClick={() => run(selectedCard)}
                  className="rounded bg-foreground px-2 py-1 font-medium text-background"
                >
                  {selectedCard.action.label}
                </button>
              ) : null}
              {selectedCard.pr?.state === "OPEN" && !selectedCard.hold && selectedCard.activity.state !== "working" && selectedCard.action?.kind !== "advance" && selectedCard.action?.kind !== "fix" ? (
                <button
                  type="button"
                  onClick={() => setAgent({ kind: "advance", prUrls: [selectedCard.pr!.url] })}
                  className="rounded border px-2 py-1"
                >
                  Advance…
                </button>
              ) : null}
              {selectedCard.pr ? (
                <UrlLink
                  href={selectedCard.pr.url}
                  className="rounded border px-2 py-1"
                >
                  GitHub
                </UrlLink>
              ) : null}
              {selectedCard.local?.cluster.linear?.url ? (
                <UrlLink
                  href={selectedCard.local.cluster.linear.url}
                  className="rounded border px-2 py-1"
                >
                  Linear
                </UrlLink>
              ) : null}
              {selectedCard.local ? (
                <>
                  <button
                    type="button"
                    onClick={() => openCheckout(selectedCard)}
                    className="rounded border px-2 py-1"
                  >
                    Checkout
                  </button>
                  {!selectedCard.hold ? (
                    <button
                      type="button"
                      onClick={() => setStarting(selectedCard.local)}
                      className="rounded border px-2 py-1"
                    >
                      New thread
                    </button>
                  ) : null}
                </>
              ) : null}
              {selectedCard.pr?.state === "OPEN" && !selectedCard.hold ? (
                <button
                  type="button"
                  onClick={() => setMessaging({ key: selectedCard.key, location: "drawer" })}
                  aria-label={`Message agent in details for ${selectedCard.repo} #${selectedCard.pr.number}`}
                  className="rounded border px-2 py-1"
                >
                  Message agent
                </button>
              ) : null}
              {selectedCard.pr && !selectedCard.hold ? (
                <button
                  type="button"
                  onClick={() =>
                    hold.edit({
                      url: selectedCard.pr!.url,
                      label: `${selectedCard.repo} #${selectedCard.pr!.number}`,
                      hold: selectedCard.hold,
                    })
                  }
                  className="rounded border px-2 py-1"
                >
                  Hold…
                </button>
              ) : null}
            </div>
            {messaging?.key === selectedCard.key && messaging.location === "drawer" ? (
              <div className="mt-3 rounded border border-border p-2">
                <PipelinePrComposer
                  key={selectedCard.key}
                  card={selectedCard}
                  sidebarThreads={sidebarThreads}
                  onClose={() => setMessaging(null)}
                />
              </div>
            ) : null}
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
          {board.lastScanAt
            ? `Scanned ${relativeTime(board.lastScanAt, now)}`
            : "Never scanned"}
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
