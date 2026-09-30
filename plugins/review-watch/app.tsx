// review-watch — the Reviews page.
//
// Start and Review selected ask the server to spawn threads; Dismiss drops a
// row. The page never talks to GitHub; the server's poller owns that.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import * as HoverCard from "@radix-ui/react-hover-card";
import {
  definePluginApp,
  UrlLink,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { QueueItem, Rule } from "./src/types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

/** The panel's route segment. Shared so every jump to it names one string. */
const REVIEWS_PATH = "reviews";

/** Headings, in the order a human should work them. */
const SECTIONS: readonly { rule: Rule; title: string }[] = [
  { rule: "review-requested", title: "Needs your review" },
  { rule: "review-followup", title: "Needs a follow-up" },
];

function canBatchReview(item: QueueItem): boolean {
  return item.state === "queued";
}

function ruleLabel(rule: Rule): string {
  return SECTIONS.find((section) => section.rule === rule)?.title ?? rule;
}

function relativeAge(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / (60 * 24))}d ago`;
}

type LastPoll = { at: string; ok: boolean; error?: string } | null;

function SyncFailureNotice({ lastPoll }: { lastPoll: LastPoll }) {
  if (lastPoll === null || lastPoll.ok) return null;
  const date = new Date(lastPoll.at);
  const time = Number.isNaN(date.valueOf())
    ? lastPoll.at
    : date.toLocaleString();
  return (
    <p role="status" className="text-xs text-muted-foreground">
      Last sync failed at <time dateTime={lastPoll.at}>{time}</time>
      {`: ${lastPoll.error || "The poll did not complete."}`}
    </p>
  );
}

function QueueCountChip({
  count,
  className,
}: {
  count: number;
  className: string;
}) {
  const chipRef = useRef<HTMLSpanElement>(null);
  const previousCount = useRef(count);
  useEffect(() => {
    if (previousCount.current === count) return;
    previousCount.current = count;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const animation = chipRef.current?.animate(
      [
        { transform: "translateY(1px) scale(0.96)", opacity: 0.72 },
        { transform: "translateY(-2px) scale(1.06)", opacity: 1 },
        { transform: "translateY(0) scale(1)", opacity: 1 },
      ],
      { duration: 240, easing: "cubic-bezier(0.25, 1, 0.5, 1)" },
    );
    return () => animation?.cancel();
  }, [count]);
  return (
    <span ref={chipRef} className={className}>
      {count > 99 ? "99+" : count}
    </span>
  );
}

function QueueCountChips({
  initial,
  followups,
  sidebar = false,
}: {
  initial: number;
  followups: number;
  sidebar?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border border-border bg-muted tabular-nums",
        sidebar
          ? "min-w-[3rem] justify-center gap-0.5 px-0.5 py-0.5"
          : "gap-1.5 px-1.5 py-0.5",
      )}
    >
      <QueueCountChip
        count={initial}
        className="inline-flex min-w-4 justify-center rounded bg-primary/10 px-1 py-1 text-[10px] font-medium leading-none text-primary"
      />
      <QueueCountChip
        count={followups}
        className="inline-flex min-w-4 justify-center rounded bg-amber-500/10 px-1 py-1 text-[10px] font-medium leading-none text-amber-800 dark:text-amber-200"
      />
    </span>
  );
}

/** The queue, kept current by the server's "queue-changed" signal. */
function useQueue() {
  const rpc = useRpc<typeof rpcContract>();
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [lastPoll, setLastPoll] = useState<LastPoll>(null);
  const [error, setError] = useState<string | null>(null);
  const report = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);
  const refetch = useCallback(() => {
    rpc.call("queue_list").then((result) => {
      setItems(result.items);
      setLastPoll(result.lastPoll);
      setError(null);
    }, report);
  }, [rpc, report]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  // The poller publishes after every change it writes, so a pass that runs
  // while this page is open shows up without a reload.
  useRealtime("queue-changed", refetch);
  return { rpc, items, lastPoll, error, report, refetch };
}

function ReviewRow({
  item,
  onStart,
  onDismiss,
  selected,
  onSelect,
  busy,
}: {
  item: QueueItem;
  onStart: () => void;
  onDismiss: () => void;
  selected: boolean;
  onSelect: (selected: boolean) => void;
  busy: boolean;
}) {
  const navigate = useBbNavigate();
  const threadId = item.threadId;
  return (
    <li className="flex items-start gap-3 py-3 text-sm transition-colors hover:bg-foreground/[0.025]">
      {canBatchReview(item) ? (
        <Checkbox
          className="mt-0.5"
          checked={selected}
          onCheckedChange={(checked) => onSelect(checked === true)}
          disabled={busy}
          aria-label={
            `Select ${item.repo}#${item.number} for batch review`
          }
        />
      ) : null}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          {/* UrlLink opens through the client's own BB browser preference. */}
          <UrlLink
            href={item.url}
            className="font-mono text-xs text-muted-foreground hover:text-foreground hover:underline"
          >
            {item.repo}#{item.number}
          </UrlLink>
          <span className="min-w-0 flex-1 truncate font-medium">{item.title}</span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {item.author} · {item.reason} · {relativeAge(item.updatedAt)}
        </p>
      </div>
      {threadId !== undefined ? (
        <Button
          variant="ghost"
          size="sm"
          className={cn("shrink-0 text-muted-foreground hover:text-foreground")}
          onClick={() => navigate.toThread(threadId)}
        >
          <Icon name="ExternalLink" className="size-3.5" />
          Open thread
        </Button>
      ) : item.state === "started" ? (
        <span className="shrink-0 text-xs text-muted-foreground">
          Thread unavailable
        </span>
      ) : (
        <Button size="sm" disabled={busy} onClick={onStart}>
          Start
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon"
        className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
        aria-label={`Dismiss ${item.repo}#${item.number}`}
        disabled={busy}
        onClick={onDismiss}
      >
        <Icon name="X" className="size-4" />
      </Button>
    </li>
  );
}

/** The dashed box BB's own list pages use for loading and empty states. */
function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"
    >
      {children}
    </div>
  );
}

function ReviewsPage() {
  const { rpc, items, lastPoll, error, report, refetch } = useQueue();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [selectedReviewKeys, setSelectedReviewKeys] = useState<string[]>([]);
  const [polling, setPolling] = useState(false);
  const [pollError, setPollError] = useState<string | null>(null);
  const navigate = useBbNavigate();
  const queuedItems = items?.filter((item) => item.state === "queued") ?? [];
  const startedItems = items?.filter((item) => item.state === "started") ?? [];
  const eligibleReviewKeys = new Set(
    items?.filter(canBatchReview).map((item) => item.key),
  );
  const activeReviewSelection = selectedReviewKeys.filter((key) =>
    eligibleReviewKeys.has(key),
  );

  useEffect(() => {
    if (items === null) return;
    const reviewKeys = new Set(
      items.filter(canBatchReview).map((item) => item.key),
    );
    setSelectedReviewKeys((keys) => keys.filter((key) => reviewKeys.has(key)));
  }, [items]);

  const selectReview = (key: string, selected: boolean) => {
    setSelectedReviewKeys((keys) =>
      selected
        ? [...new Set([...keys, key])]
        : keys.filter((current) => current !== key),
    );
  };

  const startBatch = (keys: string[]) => {
    if (keys.length < 2) return;
    setBatchBusy(true);
    rpc
      .call("item_batch_start", { keys })
      .then(
        ({ threadId }) => {
          setSelectedReviewKeys([]);
          refetch();
          navigate.toThread(threadId);
        },
        report,
      )
      .finally(() => setBatchBusy(false));
  };

  const act = (key: string, method: "item_start" | "item_dismiss") => {
    setBusyKey(key);
    rpc
      .call(method, { key })
      .then(({ item }) => {
        setSelectedReviewKeys((keys) => keys.filter((current) => current !== key));
        const threadId = item.threadId;
        if (method === "item_start") {
          if (threadId === undefined) {
            report(new Error("Started review has no thread."));
            return;
          }
          navigate.toThread(threadId);
        }
        refetch();
      }, report)
      .finally(() => setBusyKey(null));
  };

  const poll = () => {
    setPolling(true);
    setPollError(null);
    rpc
      .call("poll_now")
      .then((result) => {
        if (!result.ok) setPollError(result.error ?? "Poll failed.");
        refetch();
      }, (cause) => {
        setPollError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setPolling(false));
  };

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl px-4 pb-4 pt-3 md:px-5 md:pt-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            Review requests and follow-ups waiting for you on GitHub. Start
            opens a thread; nothing is posted to GitHub for you.
          </p>
          <div className="flex shrink-0 items-center gap-2">
            {activeReviewSelection.length > 1 ? (
              <Button
                size="sm"
                disabled={batchBusy || busyKey !== null}
                onClick={() => startBatch(activeReviewSelection)}
              >
                Review selected ({activeReviewSelection.length})
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              disabled={polling}
              onClick={poll}
              aria-label="Poll GitHub now"
            >
              <Icon
                name={polling ? "Spinner" : "ArrowReloadHorizontal"}
                className="size-4"
              />
              Refresh
            </Button>
          </div>
        </div>

        {pollError === null && error === null ? null : (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {pollError ?? error}
          </p>
        )}
        <SyncFailureNotice lastPoll={lastPoll} />

        <div className="mt-4">
          {items === null ? (
            <EmptyState>Loading the queue…</EmptyState>
          ) : (
            <>
              {queuedItems.length === 0 ? (
                <EmptyState>
                  No review requests or follow-ups queued. Select Refresh to
                  check GitHub again.
                </EmptyState>
              ) : null}
              {SECTIONS.map(({ rule, title }) => {
                const group = queuedItems.filter((item) => item.rule === rule);
                if (group.length === 0) return null;
                return (
                  <section key={rule} className="mt-6">
                    <div className="flex flex-wrap items-center justify-between gap-2 px-4">
                      <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        {title} <span className="font-normal">{group.length}</span>
                      </h2>
                    </div>
                    <ul className="mt-2 divide-y divide-border/60 overflow-hidden rounded-lg border border-border bg-card px-4">
                      {group.map((item) => (
                        <ReviewRow
                          key={item.key}
                          item={item}
                          busy={batchBusy || busyKey === item.key}
                          selected={selectedReviewKeys.includes(item.key)}
                          onSelect={(selected) => selectReview(item.key, selected)}
                          onStart={() => act(item.key, "item_start")}
                          onDismiss={() => act(item.key, "item_dismiss")}
                        />
                      ))}
                    </ul>
                  </section>
                );
              })}
              {startedItems.length > 0 ? (
                <section className="mt-8 border-t border-border/60 pt-5">
                  <h2 className="px-4 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Opened threads <span className="font-normal">{startedItems.length}</span>
                  </h2>
                  <ul className="mt-2 divide-y divide-border/60 overflow-hidden rounded-lg border border-border bg-muted/30 px-4">
                    {startedItems.map((item) => (
                      <ReviewRow
                        key={item.key}
                        item={item}
                        busy={batchBusy || busyKey === item.key}
                        selected={false}
                        onSelect={() => {}}
                        onStart={() => act(item.key, "item_start")}
                        onDismiss={() => act(item.key, "item_dismiss")}
                      />
                    ))}
                  </ul>
                </section>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * How many items still want a human. Each caller keeps its own copy: the
 * header action mounts once per visible pane in a split layout, so the count
 * cannot live in a module-level singleton.
 */
function useQueuedItems(): { items: QueueItem[]; lastPoll: LastPoll } {
  const rpc = useRpc<typeof rpcContract>();
  const [queued, setQueued] = useState<QueueItem[]>([]);
  const [lastPoll, setLastPoll] = useState<LastPoll>(null);
  const refetch = useCallback(() => {
    rpc.call("queue_list").then(
      (result) => {
        setQueued(result.items.filter((item) => item.state === "queued"));
        setLastPoll(result.lastPoll);
      },
      // Keep the last queue response visible while a transient fetch fails.
      () => {},
    );
  }, [rpc]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime("queue-changed", refetch);
  return { items: queued, lastPoll };
}

/**
 * The count on the sidebar row. No public SDK API lets a plugin raise a user
 * notification, so for a notify-only plugin this badge and the realtime signal
 * are the notification.
 */
function QueuedBadge() {
  const { items } = useQueuedItems();
  const initial = items.filter((item) => item.rule === "review-requested").length;
  const followups = items.filter((item) => item.rule === "review-followup").length;
  return (
    <span
      role="img"
      aria-label={`${initial} initial reviews, ${followups} follow-up reviews`}
    >
      <QueueCountChips
        initial={initial}
        followups={followups}
        sidebar
      />
    </span>
  );
}

/**
 * The same two counts in the thread header, so review work stays visible
 * while the user works in a thread, including when the queue is empty.
 */
function QueuedHeaderAction({
  isCompactViewport,
}: PluginThreadHeaderActionProps) {
  const navigate = useBbNavigate();
  const { items, lastPoll } = useQueuedItems();
  const initial = items.filter((item) => item.rule === "review-requested").length;
  const followups = items.filter((item) => item.rule === "review-followup").length;
  const queued = items.length;
  const previewItems = [...items].sort((left, right) => {
    const ruleOrder = SECTIONS.findIndex((section) => section.rule === left.rule)
      - SECTIONS.findIndex((section) => section.rule === right.rule);
    return ruleOrder || right.updatedAt.localeCompare(left.updatedAt);
  });
  // The registration's `title` labels the host's wrapper, not this button.
  const label = `${initial} initial reviews, ${followups} follow-up reviews`;
  return (
    <HoverCard.Root openDelay={250} closeDelay={150}>
      <HoverCard.Trigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "shrink-0 text-muted-foreground hover:text-foreground",
            // Keep the action at 28px to match neighboring header controls.
            isCompactViewport ? "h-7 gap-1 px-1.5" : "h-7 gap-1.5 px-2",
          )}
          aria-label={label}
          onClick={() => navigate.toPluginPanel(REVIEWS_PATH)}
        >
          <Icon name="GitPullRequest" className="size-4" />
          <QueueCountChips
            initial={initial}
            followups={followups}
          />
        </Button>
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          side="bottom"
          align="end"
          sideOffset={6}
          className="z-50 w-80 max-w-[calc(100vw-1rem)] rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-md"
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="flex flex-wrap gap-x-2 text-xs font-medium">
              <span>Initial: {initial}</span>
              <span>Follow-ups: {followups}</span>
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7"
              onClick={() => navigate.toPluginPanel(REVIEWS_PATH)}
            >
              Open Reviews
            </Button>
          </div>
          <SyncFailureNotice lastPoll={lastPoll} />
          {previewItems.length === 0 ? (
            <p role="status" className="py-2 text-xs text-muted-foreground">
              No review requests or follow-ups queued.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {previewItems.slice(0, 5).map((item) => (
                <li key={item.key} className="py-2 first:pt-0 last:pb-0">
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {item.repo}#{item.number}
                  </p>
                  <p className="mt-0.5 line-clamp-2 text-xs font-medium">
                    {item.title}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {ruleLabel(item.rule)}
                  </p>
                </li>
              ))}
            </ul>
          )}
          {queued > 5 ? (
            <p className="mt-2 text-xs text-muted-foreground">+{queued - 5} more</p>
          ) : null}
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "reviews",
    title: "Reviews",
    icon: "GitPullRequest",
    path: REVIEWS_PATH,
    component: ReviewsPage,
    experimental_sidebarAccessory: QueuedBadge,
  });
  app.slots.experimental_threadHeaderAction({
    id: "queued-count",
    title: "Review queue",
    component: QueuedHeaderAction,
  });
});
