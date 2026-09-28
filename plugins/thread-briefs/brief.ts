import type {
  BriefStage,
  BriefStatus,
  ResolvedBrief,
  RowSignal,
  StoredBrief,
} from "./contract.js";

export const briefKey = (threadId: string) => `brief:${threadId}`;
export const threadIdFromKey = (key: string) => key.slice("brief:".length);

/**
 * The effective stage: a manual override wins until the thread has real new
 * activity past the point where it was set.
 */
export function effectiveStage(stored: StoredBrief): BriefStage {
  if (stored.stageOverride === null) return stored.modelStage;
  if (
    stored.stageOverrideSeq !== null &&
    stored.lastActivitySeen > stored.stageOverrideSeq
  ) {
    return stored.modelStage;
  }
  return stored.stageOverride;
}

/** True once the thread has moved on from where a manual override was set. */
export function isStageOverrideStale(stored: StoredBrief): boolean {
  return (
    stored.stageOverride !== null &&
    stored.stageOverrideSeq !== null &&
    stored.lastActivitySeen > stored.stageOverrideSeq
  );
}

/**
 * Status as far as a *stored* brief can tell. Mechanical rather than a model
 * judgement, so it stays right between summaries:
 *
 * - nothing to do and nothing blocking → the work is done
 * - blocked on something → waiting on someone else
 * - otherwise → waiting on me
 *
 * `done` requires *both* fields empty. The summarizer's prompt already promises
 * a non-empty `nextStep` whenever anything is outstanding, but testing
 * `blockedOn` here makes "a blocked thread is not done" a guarantee of this
 * code rather than of the prompt, so one wayward summary cannot put a green
 * tick on a thread that is waiting for a review.
 *
 * `waiting-on-me` is the fallback because an idle thread with unfinished work
 * needs a human look by default — whether or not the agent's last turn happened
 * to end in a question.
 *
 * `working` is deliberately absent: it is live thread state, not a property of
 * a brief, so it is applied per row by {@link rowDecoration}.
 */
export function deriveStatus(args: {
  nextStep: string;
  blockedOn: string;
}): BriefStatus {
  const nextStep = args.nextStep.trim();
  const blockedOn = args.blockedOn.trim();
  if (nextStep === "" && blockedOn === "") return "done";
  if (blockedOn !== "") return "waiting-on-other";
  return "waiting-on-me";
}

export function resolveBrief(stored: StoredBrief): ResolvedBrief {
  return {
    ...stored.fields,
    threadId: stored.threadId,
    stage: effectiveStage(stored),
    status: deriveStatus({
      nextStep: stored.fields.nextStep,
      blockedOn: stored.fields.blockedOn,
    }),
    // Report the override only while it is still in force, so the stage
    // control does not show a stale manual pick as active.
    stageOverride: isStageOverrideStale(stored) ? null : stored.stageOverride,
    lastSummarizedAt: stored.lastSummarizedAt,
  };
}

export const STAGE_LABELS: Record<BriefStage, string> = {
  discovery: "Discovery",
  planning: "Planning",
  implementation: "Implementation",
  review: "Review",
};

export const STATUS_LABELS: Record<BriefStatus, string> = {
  working: "Working",
  "waiting-on-me": "Waiting on you",
  "waiting-on-other": "Blocked",
  done: "Done",
};

export function rowSignalFor(brief: ResolvedBrief): RowSignal {
  return {
    threadId: brief.threadId,
    status: brief.status,
    stage: brief.stage,
    label: `${STATUS_LABELS[brief.status]} — ${STAGE_LABELS[brief.stage]}`,
  };
}

/** Glyph + tone per status. Names are real bb icon-registry entries. */
const GLYPHS: Record<
  BriefStatus,
  { icon: string; tone: "default" | "error" | "running" | "success" }
> = {
  "waiting-on-me": { icon: "MessageQuestion", tone: "default" },
  "waiting-on-other": { icon: "Pause", tone: "default" },
  done: { icon: "CircleCheck", tone: "success" },
  working: { icon: "Circle", tone: "default" },
};

/**
 * The row decoration for one signal, or null for a row that should keep bb's
 * own glyph.
 *
 * Precedence is live first, stored second: a thread whose agent is running or
 * queued is `working` no matter what its brief says. That *does* contradict a
 * stored `done` or `waiting-on-other`, by design — the brief describes the last
 * turn that finished, and a run in flight is newer information than any of it.
 *
 * `working` draws nothing, so the override reads as a suppression rather than a
 * glyph swap. That is deliberate: bb paints a plugin row status *in place of*
 * its unsent-draft pencil, so decorating every row would cost the draft
 * indicator everywhere to say what bb's own running indicator already says.
 * Only the three states that are news get a glyph.
 *
 * `liveWorking` is client-side truth the sidebar already holds, so applying it
 * here costs no server round trip — which is the whole reason `listRowSignals`
 * does no per-thread lookups.
 */
export function rowDecoration(
  signal: RowSignal,
  liveWorking: boolean,
): { icon: string; label: string; tone: "default" | "error" | "running" | "success" } | null {
  const status: BriefStatus = liveWorking ? "working" : signal.status;
  if (status === "working") return null;
  const glyph = GLYPHS[status];
  return {
    icon: glyph.icon,
    tone: glyph.tone,
    label: `${STATUS_LABELS[status]} — ${STAGE_LABELS[signal.stage]}`,
  };
}
