import { useCallback, useEffect, useMemo, useState } from "react";
import {
  definePluginApp,
  experimental_Icon as Icon,
  experimental_useSidebarThreads,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
// Types only: `contract.ts` reaches the SDK root, which the app build cannot
// resolve, so this import must erase. Runtime values come from `shared.ts`.
import type {
  BriefState,
  ResolvedBrief,
  RowSignal,
  rpcContract,
} from "./contract.js";
import {
  BRIEFS_CHANGED_CHANNEL,
  BRIEF_STAGES,
  isLiveWorking,
  type BriefStage,
} from "./shared.js";
import {
  rowDecoration,
  STAGE_LABELS,
  STATUS_LABELS,
  summarizedAgo,
} from "./brief.js";

type Decoration = {
  icon: string;
  label: string;
  tone: "default" | "error" | "running" | "success";
};

/** The `threadPanelAction` the header button opens. */
const PANEL_ACTION_ID = "brief";

/**
 * The tab's label. Shorter than the action's own title because a tab strip is
 * narrow and the launcher row, which is a list, has room for the longer name.
 */
const PANEL_TAB_TITLE = "Brief";

/**
 * Row glyphs need two things bb keeps in different places: the briefs (server,
 * over rpc and realtime) and the live sidebar rows (React hooks). Only a React
 * component can read the second, and only a content script can *set* a row
 * status — so a no-op overlay component computes the decorations and this
 * module-level store hands them to the content script.
 */
const store = {
  decorations: new Map<string, Decoration>(),
  listeners: new Set<() => void>(),
};

function publishDecorations(next: Map<string, Decoration>) {
  store.decorations = next;
  for (const listener of store.listeners) listener();
}

function subscribeDecorations(listener: () => void): () => void {
  store.listeners.add(listener);
  return () => {
    store.listeners.delete(listener);
  };
}

function sameDecoration(a: Decoration | undefined, b: Decoration | undefined) {
  if (a === undefined || b === undefined) return a === b;
  return a.icon === b.icon && a.label === b.label && a.tone === b.tone;
}

/**
 * Mounted once per app window, renders nothing. Keeps the decoration store in
 * step with the server's briefs and the sidebar's live rows.
 */
function BriefSync() {
  const rpc = useRpc<typeof rpcContract>();
  const { threads } = experimental_useSidebarThreads();
  const [signals, setSignals] = useState<readonly RowSignal[]>([]);

  const load = useCallback(() => {
    void rpc
      .call("listRowSignals")
      .then((result) => setSignals(result.signals))
      .catch(() => {
        // A failed poll leaves the previous glyphs in place rather than
        // clearing every row on a transient error.
      });
  }, [rpc]);

  useEffect(load, [load]);
  useRealtime(BRIEFS_CHANGED_CHANNEL, load);

  // The live half of the status: a thread whose agent is running or queued is
  // `working`, which outranks whatever its last brief concluded.
  const workingIds = useMemo(() => {
    const ids = new Set<string>();
    for (const thread of threads) {
      if (isLiveWorking(thread.status)) ids.add(thread.id);
    }
    return ids;
  }, [threads]);

  useEffect(() => {
    const next = new Map<string, Decoration>();
    for (const signal of signals) {
      const decoration = rowDecoration(signal, workingIds.has(signal.threadId));
      if (decoration !== null) next.set(signal.threadId, decoration);
    }
    publishDecorations(next);
  }, [signals, workingIds]);

  return null;
}

// ------------------------------------------------------------------ the panel

function Field({ label, value }: { label: string; value: string }) {
  if (value.trim() === "") return null;
  return (
    <div className="space-y-0.5">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="text-sm leading-snug text-foreground">{value}</div>
    </div>
  );
}

function StageControl({
  brief,
  onPick,
}: {
  brief: ResolvedBrief;
  onPick: (stage: BriefStage | null) => void;
}) {
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Stage
      </div>
      <div className="flex flex-wrap gap-1">
        {BRIEF_STAGES.map((stage) => {
          const isActive = brief.stage === stage;
          const isManual = brief.stageOverride === stage;
          return (
            <button
              key={stage}
              type="button"
              aria-pressed={isActive}
              // Picking the stage that is already manually set clears the
              // override and hands the judgement back to the summarizer.
              onClick={() => onPick(isManual ? null : stage)}
              className={`rounded border px-1.5 py-0.5 text-xs ${
                isActive
                  ? "border-border bg-card font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-card"
              }`}
            >
              {STAGE_LABELS[stage]}
              {isManual ? " ·" : ""}
            </button>
          );
        })}
      </div>
      {brief.stageOverride !== null ? (
        <div className="text-[11px] text-muted-foreground">
          Set by hand · clears on the next turn
        </div>
      ) : null}
    </div>
  );
}

function BriefBody({
  now,
  state,
  onPick,
  onRefresh,
}: {
  now: number;
  state: BriefState | null;
  onPick: (stage: BriefStage | null) => void;
  onRefresh: () => void;
}) {
  if (state === null) {
    return <div className="text-sm text-muted-foreground">Loading…</div>;
  }
  if (state.state === "summarizing") {
    return <div className="text-sm text-muted-foreground">Summarizing…</div>;
  }
  if (state.state === "absent") {
    // Threads that were already dormant when the plugin arrived are not
    // backfilled, so say so and offer to make one rather than spinning.
    return (
      <div className="space-y-2">
        <div className="text-sm text-muted-foreground">
          No brief for this thread yet.
        </div>
        <button
          type="button"
          onClick={onRefresh}
          className="rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-card"
        >
          Summarize now
        </button>
      </div>
    );
  }
  if (state.state === "unconfigured" || state.state === "error") {
    return <div className="text-sm text-muted-foreground">{state.message}</div>;
  }

  const { brief } = state;
  const allEmpty =
    [brief.goal, brief.currentState, brief.nextStep, brief.blockedOn, brief.constraints]
      .every((value) => value.trim() === "");

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-0.5">
          <div className="text-xs font-medium text-foreground">
            {STATUS_LABELS[brief.status]}
          </div>
          {/*
            A panel stays open across turns, so unlike the popover it can be
            read long after the brief it shows was written. Saying when says
            whether the prose below describes the turn you just watched.
          */}
          <div className="text-[11px] text-muted-foreground">
            Summarized {summarizedAgo(brief.lastSummarizedAt, now)}
          </div>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          className="shrink-0 text-[11px] text-muted-foreground hover:text-foreground"
        >
          Re-summarize
        </button>
      </div>

      {allEmpty ? (
        <div className="text-sm text-muted-foreground">
          Nothing recorded for this thread yet.
        </div>
      ) : (
        <div className="space-y-2.5">
          <Field label="Goal" value={brief.goal} />
          <Field label="Current state" value={brief.currentState} />
          <Field label="Next step" value={brief.nextStep} />
          <Field label="Blocked on" value={brief.blockedOn} />
          <Field label="Constraints" value={brief.constraints} />
          {brief.nextStep.trim() === "" ? (
            <div className="text-sm text-muted-foreground">
              No next step — this thread reads as done.
            </div>
          ) : null}
        </div>
      )}

      <StageControl brief={brief} onPick={onPick} />
    </div>
  );
}

/**
 * Wall-clock time, re-read on an interval, for the "summarized N ago" line.
 *
 * Every other value in the panel changes by a realtime event; this one changes
 * by nothing happening, which is the case a render-time `Date.now()` cannot
 * see. Without the tick a brief written two hours ago reads "just now" for as
 * long as the tab is left open — worse than saying nothing.
 */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * The brief for one thread plus the two writes the panel offers.
 *
 * The panel mounts only while its tab is active in a visible pane, so it
 * re-reads on every mount rather than trusting state from the last time it was
 * on screen, and subscribes unconditionally while it is.
 */
function useBrief(threadId: string) {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<BriefState | null>(null);

  const load = useCallback(() => {
    void rpc
      .call("getBrief", { threadId })
      .then(setState)
      .catch((error: unknown) =>
        setState({
          state: "error",
          message: error instanceof Error ? error.message : "Could not load the brief.",
        }),
      );
  }, [rpc, threadId]);

  useEffect(load, [load]);
  useRealtime(BRIEFS_CHANGED_CHANNEL, load);

  const setStage = useCallback(
    (stage: BriefStage | null) => {
      void rpc
        .call("setStageOverride", { threadId, stage })
        .then(setState)
        .catch(() => load());
    },
    [rpc, threadId, load],
  );

  const refresh = useCallback(() => {
    void rpc.call("refresh", { threadId }).then(() => {
      setState({ state: "summarizing" });
    });
  }, [rpc, threadId]);

  return { state, setStage, refresh };
}

/**
 * The whole brief, in a tab of the thread's side panel.
 *
 * A panel rather than a popover because reading the brief is a deliberate shift
 * out of chatting and into orienting: it wants to stay open while the transcript
 * is scrolled beside it, which a popover — dismissed by the first click outside
 * it — cannot do. The host owns the padding, the scrolling and the width, so
 * none of that is this component's problem.
 */
function BriefPanel({ threadId }: { threadId: string }) {
  const { state, setStage, refresh } = useBrief(threadId);
  const now = useNow(30_000);
  return (
    <BriefBody now={now} state={state} onPick={setStage} onRefresh={refresh} />
  );
}

/**
 * The header button. Opens the panel tab; holds no brief state of its own.
 *
 * It exists because panel tabs are per-thread and per-device: a Brief tab opened
 * on one thread is not open on the next one, so without a fixed control in the
 * header, seeing a brief would mean walking the panel's new-tab launcher on
 * every thread — friction landing on exactly the moment this plugin is for.
 */
function BriefHeaderAction({
  isCompactViewport,
}: {
  isCompactViewport: boolean;
}) {
  const navigate = useBbNavigate();
  const onClick = useCallback(() => {
    // Declines only where the surface has no side panel, and bb renders thread
    // header actions in the main thread view alone — which always has one. On a
    // compact viewport the host reveals the drawer as part of the open.
    navigate.openThreadPanel({
      actionId: PANEL_ACTION_ID,
      title: PANEL_TAB_TITLE,
    });
  }, [navigate]);

  return (
    <button
      type="button"
      aria-label="Thread brief"
      onClick={onClick}
      className="flex h-7 items-center gap-1.5 rounded border border-border px-2 text-xs text-muted-foreground hover:text-foreground"
    >
      <Icon name="ListTodo" className="h-3.5 w-3.5" />
      {isCompactViewport ? null : <span>Brief</span>}
    </button>
  );
}

// ------------------------------------------------------------- registration

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "brief-sync", component: BriefSync });

  app.slots.threadPanelAction({
    id: PANEL_ACTION_ID,
    title: "Thread brief",
    component: BriefPanel,
    // Both entry points — this launcher row and the header button — label the
    // tab the same short way.
    run: ({ openPanel }) => {
      openPanel({ title: PANEL_TAB_TITLE });
    },
  });

  app.slots.experimental_threadHeaderAction({
    id: "brief",
    title: "Thread brief",
    component: BriefHeaderAction,
  });

  app.contentScripts.register({
    id: "row-glyphs",
    mount({ signal, experimental_setThreadRowStatus: setRowStatus }) {
      // Older 0.x clients do not ship the setter; the header button still works.
      if (setRowStatus === undefined) return;

      let applied = new Map<string, Decoration>();

      const apply = () => {
        const next = store.decorations;
        for (const [threadId, decoration] of next) {
          if (!sameDecoration(applied.get(threadId), decoration)) {
            setRowStatus(threadId, {
              icon: decoration.icon,
              label: decoration.label,
              tone: decoration.tone,
            });
          }
        }
        for (const threadId of applied.keys()) {
          if (!next.has(threadId)) setRowStatus(threadId, null);
        }
        applied = new Map(next);
      };

      const unsubscribe = subscribeDecorations(apply);
      apply();

      signal.addEventListener("abort", unsubscribe, { once: true });
      return () => {
        unsubscribe();
        // The host clears statuses when the generation deactivates, but a
        // plain disable/reload should not leave glyphs behind either.
        for (const threadId of applied.keys()) setRowStatus(threadId, null);
        applied = new Map();
      };
    },
  });
});
