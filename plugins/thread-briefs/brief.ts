import type {
  BriefStage,
  BriefStatus,
  NextStepActor,
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
 * `nextStepActor` is the one input the model has to judge: a next step only we
 * can take ("test it", "decide X", "reply to Y") reads the same in prose as one
 * the agent could take unprompted. An actor of `other` therefore means waiting
 * on someone else even when the summarizer named no `blockedOn`.
 *
 * `waiting-on-me` is the fallback because an idle thread with unfinished work
 * needs a human look by default — whether or not the agent's last turn happened
 * to end in a question, and whether or not we know the actor.
 *
 * `working` is deliberately absent: it is live thread state, not a property of
 * a brief, so it is applied per row by {@link rowDecoration}.
 */
export function deriveStatus(args: {
  nextStep: string;
  blockedOn: string;
  nextStepActor?: NextStepActor | undefined;
}): BriefStatus {
  const nextStep = args.nextStep.trim();
  const blockedOn = args.blockedOn.trim();
  if (nextStep === "" && blockedOn === "") return "done";
  if (blockedOn !== "" || args.nextStepActor === "other") {
    return "waiting-on-other";
  }
  // `agent` — an idle thread the agent could carry on by itself — has no status
  // of its own yet, and collapses into waiting-on-me because the nudge is ours
  // to give. If that turns out to be a common bucket in practice it earns its
  // own status then, rather than being guessed at now.
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
      nextStepActor: stored.fields.nextStepActor,
    }),
    // Report the override only while it is still in force, so the stage
    // control does not show a stale manual pick as active.
    stageOverride: isStageOverrideStale(stored) ? null : stored.stageOverride,
    lastSummarizedAt: stored.lastSummarizedAt,
  };
}

/**
 * The title to write to a thread, or null to leave it alone.
 *
 * bb generates a thread's title exactly once, from the opening prompt, before
 * anyone knows what the thread became — `applyGeneratedThreadTitle` refuses to
 * write over an existing title and nothing else in bb rewrites one. So a title
 * this plugin writes is permanent, and the only name that can be clobbered by
 * writing one is a name a person chose.
 *
 * That is the whole of the rule below. bb stores no provenance for a title, so
 * "did a person choose this?" is answered by memory: `applied` is the title we
 * last wrote, and a `current` that disagrees with it is someone else's work.
 *
 * - `applied === null` — we have never written one. Whatever is there is bb's
 *   opening-prompt guess (or nothing), which is exactly what this replaces.
 * - `current === applied` — ours, still untouched. Free to update.
 * - otherwise — renamed by hand since we last wrote. Never again: the caller
 *   leaves `applied` as it is, so this comparison keeps failing and every later
 *   summary skips the rename too, with no "locked" flag to store or clear.
 *
 * `observed` covers the case that rule cannot see: the *first* rename, where
 * `applied` is null and so nothing is being compared against. A summary takes
 * up to a minute, and a thread renamed during it would be overwritten by a
 * name chosen before the rename happened. So the caller reads the title once
 * when the summary starts and again just before writing, and a title that
 * moved in between belongs to whoever moved it.
 *
 * A `desired` equal to what the thread already shows returns null as well, so a
 * settled thread costs no write — which matters because bb's title PATCH also
 * dispatches a rename command to the thread's environment.
 */
export function planRename(args: {
  /** The title now, read as late as the caller can manage. */
  current: string | null;
  /** The title when this summary started; defaults to `current`. */
  observed?: string | null;
  desired: string | undefined;
  applied: string | null | undefined;
}): string | null {
  const desired = args.desired?.trim() ?? "";
  if (desired === "") return null;

  const current = args.current?.trim() ?? "";
  const observed = args.observed === undefined ? current : (args.observed?.trim() ?? "");
  if (current !== observed) return null;

  const applied = args.applied ?? null;
  if (applied !== null && current !== applied.trim()) return null;
  if (current === desired) return null;
  return desired;
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
