// review-watch — the Reviews page.
//
// Start and Review N ask the server to spawn threads; Dismiss drops a row. The
// page never talks to GitHub; the server's poller owns that.
import { useCallback, useEffect, useRef, useState } from "react";
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
import { groupByArea } from "./src/areas";
import type { QueueItem, Rule } from "./src/types";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

/** The panel's route segment. Shared so every jump to it names one string. */
const REVIEWS_PATH = "reviews";

/** Headings, in the order a human should work them. */
const SECTIONS: readonly { rule: Rule; title: string }[] = [
  { rule: "review-requested", title: "Needs your review" },
  { rule: "review-followup", title: "Needs a follow-up" },
];

function isActiveItem(item: QueueItem): boolean {
  return item.state === "queued" || item.state === "started";
}

function canBatchReview(item: QueueItem): boolean {
  return item.state === "queued";
}

function ruleLabel(rule: Rule): string {
  return SECTIONS.find((section) => section.rule === rule)?.title ?? rule;
}

// Workstreams' visual vocabulary, copied so the two lists read alike.
/** The 2px accent ring every control shows on keyboard focus. */
const RING = "outline-none focus-visible:ring-2 focus-visible:ring-sky-500";
const CHIP = "inline-flex h-5 min-w-0 max-w-72 shrink-0 items-center gap-1 rounded px-1.5 text-[11px]";
const TONE = {
  blue: "bg-sky-500/10 text-sky-800 dark:text-sky-200",
  amber: "bg-amber-500/10 text-amber-800 dark:text-amber-200",
  gray: "bg-foreground/[0.05] text-muted-foreground",
} as const;
const CHECKBOX = "size-3.5 shrink-0 accent-sky-600";
/** Preflight leaves native controls on the arrow cursor; this scopes the pointer to the page. */
const POINTER_CURSORS = "[&_button:not(:disabled)]:cursor-pointer [&_summary]:cursor-pointer [&_a[href]]:cursor-pointer [&_input[type=checkbox]:not(:disabled)]:cursor-pointer";

/** Each rule as a chip on its row. */
const RULE_CHIP: Record<Rule, { text: string; tone: keyof typeof TONE }> = {
  "review-requested": { text: "Review", tone: "blue" },
  "review-followup": { text: "Follow-up", tone: "amber" },
};

/** The spinner a control shows while it works; still under reduced motion. */
const Spin = () => <span aria-hidden className="inline-block leading-none motion-safe:animate-spin">↻</span>;

/** A key badge; on the inverted primary button it takes the button's text color. */
function Kbd({ children, inverted }: { children: string; inverted?: boolean }) {
  return <kbd className={cn("inline-block min-w-4 rounded border px-1 text-center font-mono text-[10.5px] leading-[14px]",
    inverted ? "border-transparent bg-background/20 text-background" : "border-border text-muted-foreground")}>{children}</kbd>;
}

/** An age: 25s, 52m, 5h, 2d. */
function age(at: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1_000));
  return seconds < 60 ? `${seconds}s` : seconds < 3_600 ? `${Math.floor(seconds / 60)}m` : seconds < 86_400 ? `${Math.floor(seconds / 3_600)}h` : `${Math.floor(seconds / 86_400)}d`;
}

/**
 * The selection after a click on one of `order`'s rows: Shift adds every row
 * from the last one clicked through this one, in drawn order; otherwise the
 * click toggles this row. Rows no longer in `order` drop out.
 */
function pickRows(order: readonly string[], picked: ReadonlySet<string>, key: string, shift: boolean, anchor: string | null): Set<string> {
  const next = new Set(order.filter((item) => picked.has(item)));
  const from = anchor === null ? -1 : order.indexOf(anchor);
  if (shift && from >= 0) {
    const [a, b] = [from, order.indexOf(key)].sort((x, y) => x - y);
    for (const item of order.slice(a, b + 1)) next.add(item);
  } else if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/** Typing in a field is never a shortcut. A checkbox takes no text, so b and esc still act from one. */
function typingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable ||
    target.closest("input:not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable]") !== null);
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
  now,
  busy,
  picked = false,
  onPick,
  onStart,
  onDismiss,
}: {
  item: QueueItem;
  now: number;
  busy: boolean;
  picked?: boolean;
  /** Absent on archived rows, which never select. */
  onPick?: (shift: boolean) => void;
  onStart: () => void;
  onDismiss: () => void;
}) {
  const navigate = useBbNavigate();
  const threadId = item.threadId;
  const rule = RULE_CHIP[item.rule];
  const info = `${item.author} · ${item.reason} · ${age(Date.parse(item.updatedAt), now)} ago`;
  return (
    <li className={cn("group flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-[12px] hover:bg-foreground/[0.025]", picked && "bg-sky-500/[0.07]")}>
      {onPick === undefined ? null : canBatchReview(item) ? (
        <input
          type="checkbox"
          checked={picked}
          disabled={busy}
          aria-label={`Select ${item.repo}#${item.number}`}
          onChange={() => undefined}
          onClick={(event) => onPick(event.shiftKey)}
          className={CHECKBOX}
        />
      ) : <span aria-hidden className="size-3.5 shrink-0" />}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          {/* UrlLink opens through the client's own BB browser preference. A
              long repo name truncates first; the number never does. */}
          <UrlLink
            href={item.url}
            title={`${item.repo}#${item.number}`}
            className={cn("flex min-w-0 max-w-full rounded-sm font-mono text-[11px] text-muted-foreground hover:underline", RING)}
          >
            <span className="min-w-0 truncate">{item.repo}</span>
            <span className="shrink-0">#{item.number}</span>
          </UrlLink>
          <span className="min-w-0 truncate font-medium" title={item.title}>{item.title}</span>
        </div>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground" title={info}>{info}</p>
      </div>
      <span className={cn(CHIP, TONE[rule.tone])}>{rule.text}</span>
      {item.state === "started" ? <span className={cn(CHIP, TONE.amber)}>Review not sent</span> : null}
      {threadId !== undefined ? (
        <button
          type="button"
          onClick={() => navigate.toThread(threadId)}
          title="Open its review thread"
          className={cn(CHIP, TONE.gray, "hover:underline", RING)}
        >
          Open<span aria-hidden>↗</span>
        </button>
      ) : item.state === "queued" ? (
        <button
          type="button"
          disabled={busy}
          onClick={onStart}
          className={cn("shrink-0 rounded-md border border-border px-2 py-1 text-[11px] hover:bg-foreground/[0.06] disabled:opacity-50", RING)}
        >
          Start
        </button>
      ) : (
        <span className={cn(CHIP, TONE.gray)}>Thread unavailable</span>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={onDismiss}
        aria-label={`Dismiss ${item.repo}#${item.number}`}
        className={cn("shrink-0 rounded px-1 text-[11px] text-muted-foreground opacity-0 hover:bg-foreground/[0.06] hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100", RING)}
      >
        Dismiss
      </button>
    </li>
  );
}

/**
 * A tri-state box over `keys`, as on Workstreams' lists: partial or empty
 * selects them all, full clears them. No selectable rows keeps its space.
 */
function ScopeCheckbox({
  keys,
  picked,
  label,
  onPick,
}: {
  keys: readonly string[];
  picked: ReadonlySet<string>;
  label: string;
  onPick: (keys: readonly string[], select: boolean) => void;
}) {
  if (keys.length === 0) return <span aria-hidden className="size-3.5 shrink-0" />;
  const count = keys.filter((key) => picked.has(key)).length;
  const full = count === keys.length;
  return (
    <input
      type="checkbox"
      checked={full}
      ref={(element) => { if (element) element.indeterminate = count > 0 && !full; }}
      aria-label={full ? `Clear ${label}` : `Select ${label}`}
      onChange={() => onPick(keys, !full)}
      className={CHECKBOX}
    />
  );
}

function ReviewsPage() {
  const { rpc, items, lastPoll, error, report, refetch } = useQueue();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const [polling, setPolling] = useState(false);
  const [pollError, setPollError] = useState<string | null>(null);
  const navigate = useBbNavigate();
  const rootRef = useRef<HTMLDivElement>(null);
  const now = Date.now();
  const activeItems = items?.filter(isActiveItem) ?? [];
  const archivedItems = items?.filter((item) => item.state === "archived") ?? [];
  const areas = groupByArea(activeItems);
  // Selectable rows in drawn order: Shift ranges and the section's box use it.
  const selectable = areas.flatMap((area) => area.items.filter(canBatchReview).map((item) => item.key));
  const selection = selectable.filter((key) => picked.has(key));

  useEffect(() => {
    if (items === null) return;
    const reviewKeys = new Set(
      items.filter(canBatchReview).map((item) => item.key),
    );
    setPicked((keys) => new Set([...keys].filter((key) => reviewKeys.has(key))));
  }, [items]);

  const pick = (key: string, shift: boolean) => {
    setPicked((keys) => pickRows(selectable, keys, key, shift, anchor.current));
    anchor.current = key;
  };
  const pickScope = (keys: readonly string[], select: boolean) => {
    setPicked((current) => select
      ? new Set([...current, ...keys])
      : new Set([...current].filter((key) => !keys.includes(key))));
  };
  const clear = () => setPicked(new Set());

  const startBatch = (keys: string[]) => {
    if (keys.length < 2) return;
    setBatchBusy(true);
    rpc
      .call("item_batch_start", { keys })
      .then(
        ({ threadId }) => {
          clear();
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
        setPicked((keys) => new Set([...keys].filter((current) => current !== key)));
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

  const starting = batchBusy || (busyKey !== null && picked.has(busyKey));
  // One selected opens its own thread; two or more share one batch thread.
  const review = () => {
    if (starting || busyKey !== null) return;
    if (selection.length === 1) act(selection[0]!, "item_start");
    else startBatch(selection);
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

  // b reviews the selection and esc clears it, while focus is on this page
  // (or nowhere) and not in a text field.
  const shortcut = useRef({ review, clear, count: selection.length });
  shortcut.current = { review, clear, count: selection.length };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const root = rootRef.current;
      const active = document.activeElement;
      if (!root || (active && active !== document.body && !root.contains(active))) return;
      if (event.metaKey || event.ctrlKey || event.altKey || typingTarget(event.target)) return;
      if (shortcut.current.count === 0) return;
      if (event.key === "Escape") {
        event.preventDefault();
        shortcut.current.clear();
      } else if (event.key === "b" && !event.repeat) {
        event.preventDefault();
        shortcut.current.review();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const rowProps = (item: QueueItem) => ({
    item,
    now,
    busy: batchBusy || busyKey === item.key,
    onStart: () => act(item.key, "item_start"),
    onDismiss: () => act(item.key, "item_dismiss"),
  });

  return (
    <div ref={rootRef} className={cn("flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground", POINTER_CURSORS)}>
      <header className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/70 px-3 py-1">
        <h1 className="text-[13px] font-semibold">Reviews</h1>
        <button
          type="button"
          disabled={polling}
          onClick={poll}
          title={lastPoll === null ? "Check GitHub now" : `Last read ${new Date(lastPoll.at).toLocaleString()} · check GitHub now`}
          className={cn("ml-auto inline-flex min-w-0 items-center gap-1 rounded text-[11.5px] text-muted-foreground hover:text-foreground disabled:hover:text-inherit", RING)}
        >
          {polling ? <Spin /> : <span aria-hidden>↻</span>}
          <span className="truncate">
            {lastPoll === null ? "Not read yet" : `Last read ${age(Date.parse(lastPoll.at), now)} ago`}
          </span>
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-8">
        {pollError === null && error === null && (lastPoll === null || lastPoll.ok) ? null : (
          <div className="grid gap-1 px-4 pt-3 text-[12px]">
            {pollError === null && error === null ? null : (
              <p role="alert" className="text-destructive">{pollError ?? error}</p>
            )}
            <SyncFailureNotice lastPoll={lastPoll} />
          </div>
        )}
        {items === null ? (
          <p role="status" className="px-4 pt-4 text-[12px] text-muted-foreground">Reading the queue…</p>
        ) : (
          <section className="mt-4" aria-label="Waiting on you">
            <h2 className="mb-2 flex items-center gap-3 px-4 text-[14px] font-semibold">
              <ScopeCheckbox keys={selectable} picked={picked} label="every review waiting on you" onPick={pickScope} />
              <span>Waiting on you <span className="font-normal tabular-nums text-muted-foreground">{activeItems.length}</span></span>
            </h2>
            {areas.length === 0 ? (
              <p className="px-4 text-[12px] text-muted-foreground">Nothing waiting on you.</p>
            ) : (
              <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
                {areas.map((area) => (
                  <section key={area.key} className="min-w-0" aria-label={area.label}>
                    <h3 className="mb-1 flex min-w-0 items-center gap-3 px-4 text-[11px] font-medium text-muted-foreground">
                      <ScopeCheckbox
                        keys={area.items.filter(canBatchReview).map((item) => item.key)}
                        picked={picked}
                        label={area.label}
                        onPick={pickScope}
                      />
                      <span className="min-w-0 truncate">
                        {area.label}
                        {area.repos.join(", ") === area.label ? null : (
                          <span className="font-normal text-muted-foreground/70"> · {area.repos.join(", ")}</span>
                        )}
                      </span>
                      <span className="font-normal tabular-nums">{area.items.length}</span>
                    </h3>
                    <ul className="min-w-0 divide-y divide-border/50 border-y border-border/50">
                      {area.items.map((item) => (
                        <ReviewRow
                          key={item.key}
                          {...rowProps(item)}
                          picked={picked.has(item.key)}
                          onPick={(shift) => pick(item.key, shift)}
                        />
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}
            {archivedItems.length > 0 ? (
              <details className="mt-4">
                <summary className={cn("mx-4 w-fit rounded-sm text-[11px] text-muted-foreground hover:text-foreground", RING)}>
                  {archivedItems.length} archived · show
                </summary>
                <ul className="mt-2 min-w-0 divide-y divide-border/50 border-y border-border/50 opacity-70">
                  {archivedItems.map((item) => <ReviewRow key={item.key} {...rowProps(item)} />)}
                </ul>
              </details>
            ) : null}
          </section>
        )}
      </div>
      {selection.length === 0 ? null : (
        <div aria-label="Selection" className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-border bg-background px-4 py-1.5 text-[12px]">
          <b className="mr-1 font-semibold">{selection.length} selected</b>
          <button
            type="button"
            disabled={starting || busyKey !== null}
            aria-busy={starting || undefined}
            onClick={review}
            title={selection.length === 1 ? "Start a review thread for it" : "Start one thread that reviews them together"}
            className={cn("inline-flex h-6 items-center gap-1.5 rounded-md border border-foreground bg-foreground px-2 font-medium text-background disabled:opacity-45", RING)}
          >
            {starting ? <><Spin />Starting…</> : <>Review {selection.length}<Kbd inverted>b</Kbd></>}
          </button>
          <span className="flex-1" />
          <button
            type="button"
            onClick={clear}
            className={cn("inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-muted-foreground hover:bg-foreground/[0.06]", RING)}
          >
            Clear<Kbd>esc</Kbd>
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * How many items still want a human. Each caller keeps its own copy: the
 * header action mounts once per visible pane in a split layout, so the count
 * cannot live in a module-level singleton.
 */
function useActiveReviewItems(): { items: QueueItem[]; lastPoll: LastPoll } {
  const rpc = useRpc<typeof rpcContract>();
  const [activeReviews, setActiveReviews] = useState<QueueItem[]>([]);
  const [lastPoll, setLastPoll] = useState<LastPoll>(null);
  const refetch = useCallback(() => {
    rpc.call("queue_list").then(
      (result) => {
        setActiveReviews(result.items.filter(isActiveItem));
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
  return { items: activeReviews, lastPoll };
}

/**
 * The count on the sidebar row. No public SDK API lets a plugin raise a user
 * notification, so for a notify-only plugin this badge and the realtime signal
 * are the notification.
 */
function QueuedBadge() {
  const { items } = useActiveReviewItems();
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
  const { items, lastPoll } = useActiveReviewItems();
  const initial = items.filter((item) => item.rule === "review-requested").length;
  const followups = items.filter((item) => item.rule === "review-followup").length;
  const activeCount = items.length;
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
                  {item.state === "started" ? (
                    <p className="mt-0.5 text-[11px] font-medium text-amber-800 dark:text-amber-200">
                      Review not sent
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {activeCount > 5 ? (
            <p className="mt-2 text-xs text-muted-foreground">
              +{activeCount - 5} more
            </p>
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
