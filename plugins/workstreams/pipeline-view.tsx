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
  PIPELINE_STAGES,
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
  ThreadMessageDialog,
  type ActionRequest,
  type DirectRow,
} from "./rowactions";
import { PrHoldDialog, usePrHoldControls } from "./pr-hold-dialog";
import { ArchivedThreadsButton } from "./archivedthreads";
import { backlogThreads } from "./backlog-threads";
import { StartThreadDialog } from "./inbox";
import type { Row } from "./inbox-rows";
import { matchesApprovedFilter } from "./approval-filter";
import { ADVANCE_SELECTION_LIMIT } from "./bulk-advance-selection";
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

function age(card: PipelineCard, now: number): string {
  if (card.ageSince === null) return "";
  const days = Math.max(0, Math.floor((now - card.ageSince) / 86_400_000));
  return days < 1
    ? "today"
    : days < 30
      ? `${days}d`
      : `${Math.floor(days / 30)}mo`;
}

function cardSort(a: PipelineCard, b: PipelineCard): number {
  const severity = { bad: 0, warn: 1, wait: 2, clear: 3 };
  return (
    Number(Boolean(a.hold)) - Number(Boolean(b.hold)) ||
    severity[a.blocker.tone] - severity[b.blocker.tone] ||
    (a.ageSince ?? Infinity) - (b.ageSince ?? Infinity)
  );
}

function recentSort(a: PipelineCard, b: PipelineCard): number {
  const aAt = a.pr?.mergedAt ? Date.parse(a.pr.mergedAt) : (a.ageSince ?? 0);
  const bAt = b.pr?.mergedAt ? Date.parse(b.pr.mergedAt) : (b.ageSince ?? 0);
  return bAt - aAt;
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
  const [filterOpen, setFilterOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showHistory, setShowHistory] = useState<Record<string, boolean>>({});
  const [direct, setDirect] = useState<ActionRequest | null>(null);
  const [agent, setAgent] = useState<PipelineAgentRequest | null>(null);
  const [messaging, setMessaging] = useState<PipelineCard | null>(null);
  const [starting, setStarting] = useState<Row | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [dispatchBusy, setDispatchBusy] = useState(false);
  const [dispatch, setDispatch] = useState(board.dispatch);
  const [queuedDirect, setQueuedDirect] = useState<PipelineCard[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollBehavior = () =>
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? ("instant" as const)
      : ("smooth" as const);
  const arrivedFocus = useRef<string | null>(null);
  useEffect(() => setDispatch(board.dispatch), [board.dispatch]);

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
  const selectedCard = cards.find((card) => card.key === selected) ?? null;
  useEffect(() => {
    if (
      selected !== null &&
      (search || prefs.approvedOnly) &&
      !visible.some((card) => card.key === selected)
    )
      setSelected(null);
  }, [selected, search, prefs.approvedOnly, visible]);
  const sidebarThreads = experimental_useSidebarThreads().threads;
  const selectedThreads = selectedCard?.pr
    ? backlogThreads(
        selectedCard.pr.url,
        selectedCard.local?.cluster.threads ?? [],
        board.runs,
        advance.batches.flatMap((batch) => batch.jobs),
        sidebarThreads,
      )
    : (selectedCard?.local?.cluster.threads ?? []);

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
  const directRow = (card: PipelineCard): DirectRow | null =>
    card.pr === null
      ? null
      : (card.local ?? {
          repo: card.repo,
          title: card.title,
          age: { since: card.ageSince },
          unit: { pr: card.pr, prUrl: card.pr.url },
        });
  const openThread = (card: PipelineCard) => {
    const linked = card.pr
      ? backlogThreads(
          card.pr.url,
          card.local?.cluster.threads ?? [],
          board.runs,
          advance.batches.flatMap((batch) => batch.jobs),
          sidebarThreads,
        )
      : (card.local?.cluster.threads ?? []);
    const id = card.activity.threadId ?? linked[0]?.id;
    if (id) navigate.toThread(id);
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
      const repoOf = (item: PipelineCard) =>
        item.pr?.url.replace(/\/pull\/\d+.*$/u, "") ??
        item.repo.split("/").at(-1);
      const parent = cards.find(
        (item) =>
          repoOf(item) === repoOf(card) && item.pr?.number === action.behind,
      );
      if (parent) {
        setQuery("");
        onPrefs({ approvedOnly: false });
        setShowHistory({});
        choose(parent);
      } else if (card.pr)
        window.open(card.pr.url, "_blank", "noopener,noreferrer");
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
      if (card.blocker.label === "CI failing" && card.local) {
        setAgent({ kind: "agent", action: "investigate-ci", row: card.local });
        return;
      }
      if (card.pr?.state === "OPEN" && card.pr.reviewDecision === "APPROVED") {
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
      .sort(stage === "merged" || stage === "released" ? recentSort : cardSort);
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
    const onKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        canTypeKey(event.target)
      )
        return;
      if (event.key === "/") {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (
        agent ||
        direct ||
        hold.target ||
        messaging ||
        starting ||
        historyOpen ||
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
      } else if (event.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const cardView = (card: PipelineCard) => {
    const repoName = card.repo.split("/").at(-1) ?? card.repo;
    return (
      <div
        key={card.key}
        id={`pipeline-${card.key}`}
        className={cn(
          "group relative min-w-0 rounded-lg border bg-card px-3 py-2.5 text-left shadow-sm transition-colors hover:border-foreground/30",
          card.hold && "opacity-55 hover:opacity-90",
          selected === card.key && "border-ring ring-1 ring-ring/40",
        )}
      >
        <button
          data-pipeline-card
          type="button"
          onClick={() => choose(card)}
          aria-label={`Details for ${card.repo}${card.pr ? ` #${card.pr.number}` : ""}: ${card.title}`}
          className="absolute inset-0 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <div className="relative flex min-w-0 items-baseline gap-2 font-mono text-[11px]">
          <b className="pointer-events-none truncate" title={card.repo}>
            {repoName}
          </b>
          {card.pr ? (
            <UrlLink
              href={card.pr.url}
              className="z-10 shrink-0 text-muted-foreground hover:underline"
            >
              #{card.pr.number}
            </UrlLink>
          ) : (
            <span className="pointer-events-none text-muted-foreground">
              branch
            </span>
          )}
          <span
            className={cn(
              "pointer-events-none ml-auto shrink-0 text-muted-foreground",
              card.ageSince !== null &&
                now - card.ageSince > 30 * 86_400_000 &&
                "text-amber-600",
            )}
          >
            {age(card, now)}
          </span>
        </div>
        <div
          className="pointer-events-none relative mt-1 overflow-hidden text-ellipsis text-[12px] leading-4"
          style={{
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
          }}
        >
          {card.title}
        </div>
        <div className="relative mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
          <span
            className={cn(
              "pointer-events-none shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
              BLOCKER_COLOR[card.blocker.tone],
            )}
          >
            {card.blocker.label}
          </span>
          {layout === "stage" ? (
            <span
              className="pointer-events-none min-w-0 flex-1 truncate text-[10px] text-muted-foreground"
              title={card.effortName ?? "One-offs"}
            >
              {card.effortName ?? "One-offs"}
            </span>
          ) : null}
          {card.action?.kind === "open-pr" && card.pr ? (
            <UrlLink
              href={card.pr.url}
              className="relative z-10 ml-auto shrink-0 rounded border px-2 py-1 text-[10.5px] font-semibold hover:bg-foreground/[0.06]"
            >
              Open PR
            </UrlLink>
          ) : card.action ? (
            <button
              type="button"
              onClick={() => run(card)}
              className={cn(
                "relative z-10 ml-auto shrink-0 rounded border px-2 py-1 text-[10.5px] font-semibold outline-none hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring",
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
        {card.activity.state !== "none" ? (
          <button
            type="button"
            disabled={!card.activity.threadId}
            onClick={() => openThread(card)}
            className={cn(
              "relative z-10 mt-2 block w-full truncate border-t border-dashed border-border/70 py-1.5 text-left text-[10px] text-muted-foreground disabled:cursor-default",
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
      .sort(stage === "merged" || stage === "released" ? recentSort : cardSort);
    const limit = HISTORY_LIMIT[stage];
    const shown = displayedStageCards(stage, source);
    return (
      <>
        {shown.map((card) =>
          limit ? (
            <button
              key={card.key}
              id={`pipeline-${card.key}`}
              data-pipeline-card
              type="button"
              onClick={() => choose(card)}
              className={cn(
                "flex min-w-0 items-baseline gap-1 rounded px-1 py-1 text-left text-[10.5px] hover:bg-foreground/[0.05]",
                selected === card.key && "bg-foreground/[0.07]",
              )}
            >
              <b className="shrink-0 font-mono">
                {card.repo.split("/").at(-1)}
              </b>
              <span className="shrink-0 font-mono text-muted-foreground">
                #{card.pr?.number}
              </span>
              <span className="min-w-0 truncate text-muted-foreground">
                {card.title}
              </span>
            </button>
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
  const bulkAdvanceCards = pipelineBulkCards(visible, "feedback");
  const bulkAdvance = bulkAdvanceCards
    .slice(0, ADVANCE_SELECTION_LIMIT)
    .map((card) => card.pr!.url);
  const bulkMerge = pipelineBulkCards(visible, "ready");
  const bulkNudge = pipelineBulkCards(visible, "review").filter(
    (card) => card.ageSince !== null && now - card.ageSince >= 7 * 86_400_000,
  );
  const bulkButton = (stage: PipelineStage) => {
    if (stage === "feedback" && bulkAdvance.length)
      return (
        <button
          type="button"
          onClick={() => setAgent({ kind: "advance", prUrls: bulkAdvance })}
          title={
            bulkAdvanceCards.length > ADVANCE_SELECTION_LIMIT
              ? `First ${ADVANCE_SELECTION_LIMIT} of ${bulkAdvanceCards.length} eligible PRs`
              : undefined
          }
          className="ml-auto rounded border px-2 py-1 text-[10px] hover:bg-foreground/[0.06]"
        >
          Advance {bulkAdvance.length}
        </button>
      );
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
    if (stage === "review" && bulkNudge.length)
      return (
        <button
          type="button"
          onClick={() => startDirectQueue(bulkNudge, "nudge")}
          className="ml-auto rounded border px-2 py-1 text-[10px] hover:bg-foreground/[0.06]"
        >
          Nudge {bulkNudge.length}
        </button>
      );
    return null;
  };
  const scrollToStage = (stage: PipelineStage) => {
    const target =
      layout === "stage"
        ? document.getElementById(`pipeline-column-${stage}`)
        : document.querySelector<HTMLElement>(
            `[data-pipeline-stage="${stage}"]`,
          );
    target?.scrollIntoView({
      behavior: scrollBehavior(),
      block: "nearest",
      inline: "start",
    });
  };
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
      <div
        aria-label="Pipeline stage counts"
        className="flex shrink-0 gap-1 overflow-x-auto border-b border-border/60 bg-muted/30 px-3 py-1"
      >
        {PIPELINE_STAGES.map((stage) => (
          <button
            key={stage}
            type="button"
            onClick={() => scrollToStage(stage)}
            className="flex min-w-20 flex-1 items-center justify-between rounded bg-background px-2 py-1 text-[10.5px] hover:bg-foreground/[0.05]"
          >
            <span className="truncate">{LABEL[stage]}</span>
            <b
              className="ml-1 font-mono"
              title={
                search || prefs.approvedOnly ? "Matching / total" : "Total"
              }
            >
              {stageCount(stage)}
            </b>
          </button>
        ))}
      </div>
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div className="min-w-0 flex-1 overflow-auto p-3">
          {layout === "stage" ? (
            <div className="grid min-w-[1520px] grid-cols-6 gap-4">
              {PIPELINE_STAGES.map((stage) => (
                <section
                  key={stage}
                  id={`pipeline-column-${stage}`}
                  className="flex min-w-0 flex-col gap-3"
                >
                  <header className="sticky top-0 z-10 flex min-h-12 items-center gap-2 border-b border-border bg-background py-2 text-[11px]">
                    <h2 className="font-semibold">{LABEL[stage]}</h2>
                    <span className="font-mono text-muted-foreground">
                      {stageCount(stage)}
                    </span>
                    {bulkButton(stage)}
                  </header>
                  {columnCards(stage)}
                </section>
              ))}
            </div>
          ) : (
            <div className="min-w-[1696px]">
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
                  <div className="sticky left-0 z-10 bg-background text-[12px] leading-4">
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
        {selectedCard ? (
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
                onClick={() => setSelected(null)}
                className="rounded px-1 text-muted-foreground hover:bg-foreground/[0.06]"
              >
                ×
              </button>
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
                {selectedCard.backlog?.parent ? (
                  <p className="mt-1">
                    Behind{" "}
                    <UrlLink
                      href={selectedCard.backlog.parent.pr.url}
                      className="underline"
                    >
                      #{selectedCard.backlog.parent.pr.number} ·{" "}
                      {selectedCard.backlog.parent.pr.title}
                    </UrlLink>
                  </p>
                ) : selectedCard.action?.kind === "open-parent" ? (
                  <p className="mt-1">Behind #{selectedCard.action.behind}</p>
                ) : null}
              </section>
            ) : null}
            <section className="mt-4">
              <h3 className="mb-1 font-semibold">Agent</h3>
              <p className="text-muted-foreground">
                {selectedCard.activity.state === "none"
                  ? "No recent agent activity"
                  : `${selectedCard.activity.state.replace("-", " ")} · ${selectedCard.activity.detail}`}
              </p>
              {selectedThreads.length ? (
                <ul className="mt-1 space-y-1">
                  {selectedThreads.map((thread) => (
                    <li key={thread.id}>
                      <button
                        type="button"
                        onClick={() => navigate.toThread(thread.id)}
                        className="max-w-full truncate rounded text-left text-[11px] underline"
                        title={thread.title}
                      >
                        {thread.active ? "● " : ""}
                        {thread.title}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
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
                  Open PR
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
                    onClick={() => openThread(selectedCard)}
                    disabled={!selectedThreads.length}
                    className="rounded border px-2 py-1 disabled:opacity-50"
                  >
                    Thread
                  </button>
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
              {selectedCard.local &&
              !selectedCard.hold &&
              selectedThreads.length &&
              selectedCard.pr ? (
                <button
                  type="button"
                  onClick={() => setMessaging(selectedCard)}
                  className="rounded border px-2 py-1"
                >
                  Message
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
        onStarted={advance.refresh}
        onOpenThread={(id) => navigate.toThread(id)}
      />
      <ThreadMessageDialog
        row={messaging?.local ?? null}
        threads={messaging?.local?.cluster.threads ?? []}
        onClose={() => setMessaging(null)}
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
