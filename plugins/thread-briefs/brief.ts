import type {
  BriefStage,
  BriefStatus,
  NextStepActor,
  ResolvedBrief,
  RowSignal,
  StoredBrief,
} from "./contract.js";
import { projectColorIndex } from "./shared.js";

export const briefKey = (threadId: string) => `brief:${threadId}`;
export const threadIdFromKey = (key: string) => key.slice("brief:".length);

/**
 * Whether an override anchored at `anchorSeq` still applies to a thread whose
 * activity cursor reads `cursor`.
 *
 * The whole of "sticks until real thread activity", shared by both overrides so
 * they cannot drift apart. An override with no anchor holds indefinitely: that
 * is unreachable today — setting one always records the cursor — but reading an
 * unanchored pin as *expired* would silently discard a deliberate choice, where
 * reading it as held merely leaves it for the user to clear.
 */
export function overrideHolds(
  anchorSeq: number | null | undefined,
  cursor: number,
): boolean {
  return anchorSeq === null || anchorSeq === undefined || cursor <= anchorSeq;
}

/**
 * The effective stage: a manual override wins until the thread has real new
 * activity past the point where it was set.
 */
export function effectiveStage(stored: StoredBrief): BriefStage {
  if (isStageOverrideStale(stored)) return stored.modelStage;
  return stored.stageOverride ?? stored.modelStage;
}

/** True once the thread has moved on from where a manual stage was set. */
export function isStageOverrideStale(stored: StoredBrief): boolean {
  return (
    stored.stageOverride !== null &&
    !overrideHolds(stored.stageOverrideSeq, stored.lastActivitySeen)
  );
}

/** True once the thread has moved on from where a manual status was set. */
export function isStatusOverrideStale(stored: StoredBrief): boolean {
  return (
    (stored.statusOverride ?? null) !== null &&
    !overrideHolds(stored.statusOverrideSeq, stored.lastActivitySeen)
  );
}

/**
 * The status this brief reports: the manual one while it holds, otherwise the
 * derivation over the brief's own fields.
 *
 * The override sits *in front of* {@link deriveStatus} rather than editing the
 * fields it reads, because `renderTranscript` feeds the previous brief into the
 * next summary as a starting point: a `nextStep` blanked in storage would
 * simply be written back, where a pin is a separate fact the summarizer never
 * sees and cannot undo.
 *
 * It exists for the one thing the derivation cannot see. A `nextStep` addressed
 * to you and carried out *outside the thread* — reload a client, check a
 * rollout, confirm a glyph — leaves no trace in the transcript, so no summary
 * can retire it and re-summarizing reads the same unresolved instruction back.
 * That thread is `waiting-on-me` forever unless you can say otherwise.
 */
export function effectiveStatus(stored: StoredBrief): BriefStatus {
  const override = stored.statusOverride ?? null;
  if (override !== null && !isStatusOverrideStale(stored)) return override;
  return deriveStatus({
    nextStep: stored.fields.nextStep,
    blockedOn: stored.fields.blockedOn,
    nextStepActor: stored.fields.nextStepActor,
  });
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
    status: effectiveStatus(stored),
    // Report each override only while it is still in force, so a control does
    // not show a stale manual pick as active.
    stageOverride: isStageOverrideStale(stored) ? null : stored.stageOverride,
    statusOverride: isStatusOverrideStale(stored)
      ? null
      : (stored.statusOverride ?? null),
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

/**
 * How long ago a brief was written, for the panel's staleness line.
 *
 * Coarse on purpose. The question it answers is "does this describe the turn I
 * just watched, or one from this morning?", and a brief is only rewritten after
 * a quiet period anyway, so minute precision on a two-hour-old one would be
 * false precision. A `now` behind the timestamp — clock skew between the server
 * that wrote it and the browser reading it — clamps to "just now" rather than
 * counting into the future.
 */
export function summarizedAgo(lastSummarizedAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - lastSummarizedAt) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
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

/**
 * The accessible label for a row glyph, naming both axes.
 *
 * Stage leads because the glyph now draws the stage, and a ring reads as "how
 * far along" rather than as a word — the label is the only thing that says
 * which stage that is. Status still has to appear: the sidebar's status
 * grouping says it in the section header, but grouping is off by default and
 * nothing else on an ungrouped row says it at all.
 */
export function rowLabelFor(stage: BriefStage, status: BriefStatus): string {
  return `${STAGE_LABELS[stage]} — ${STATUS_LABELS[status]}`;
}

export function rowSignalFor(brief: ResolvedBrief): RowSignal {
  return {
    threadId: brief.threadId,
    status: brief.status,
    stage: brief.stage,
    label: rowLabelFor(brief.stage, brief.status),
  };
}

/** bb's convention for a plugin's own icon-registry names: `<pluginId>/<name>`. */
const ICON_PREFIX = "thread-briefs/";

/**
 * The registry name of the ring drawn for a stage — one quarter filled per
 * stage reached, so `implementation` is three quarters and `review` closes the
 * ring. The artwork is registered by `app.tsx`.
 *
 * Built from the stage rather than listed against it, so a stage added to
 * `BRIEF_STAGES` cannot get a name without also getting artwork: `app.tsx`
 * registers its icons by mapping this same function over the same list.
 */
export function stageRingIcon(stage: BriefStage, colorIndex?: number): string {
  return `${ICON_PREFIX}stage-${stage}${ringColorSuffix(colorIndex)}`;
}

/**
 * The palette suffix on a ring's registry name, or "" for the neutral ring.
 *
 * Every ring exists twice over: once in `currentColor`, which is what the panel
 * and the stage picker want — they sit inside one thread, where naming its
 * project back to it says nothing — and once per palette slot for the sidebar
 * row, where the project is the fact the colour is there to carry.
 */
function ringColorSuffix(colorIndex: number | undefined): string {
  return colorIndex === undefined ? "" : `-c${colorIndex}`;
}

/** {@link DONE_RING_ICON} in a project's colour, or neutral without one. */
export function doneRingIcon(colorIndex?: number): string {
  return `${DONE_RING_ICON}${ringColorSuffix(colorIndex)}`;
}

/**
 * The closed, filled ring drawn for `done`, in place of any stage ring.
 *
 * `done` is a status, not a fifth stage: the arc is over, so which stage it
 * ended in stops being the interesting fact about the row. Keeping it off the
 * ring is also what holds the ring at four 90° segments, and four is the point
 * where the fill's endpoint lands on a clock position you can read without
 * counting marks. A fifth segment in a 16px glyph is where that stops working.
 */
export const DONE_RING_ICON = `${ICON_PREFIX}done`;

/**
 * The row decoration for one signal, or null for a row that should keep bb's
 * own glyph.
 *
 * The glyph draws the **stage**, not the status. Status is what the sidebar's
 * own status grouping already puts in the section header, so a status glyph
 * spends the row's one slot repeating its own heading; stage is orthogonal to
 * it, and is the fact that says which of a dozen threads waiting on you is one
 * turn from finished. Stage is also ordinal, which a ring can show and a set of
 * unrelated glyphs cannot: you read four rings at a glance without reading any
 * of them.
 *
 * The one channel a named icon leaves free — colour — goes to the **project**,
 * because `sidebarGrouping status` is what takes the sidebar's own project
 * grouping away and nothing else on the row replaces it. `done` used to hold
 * that channel and gives it up: it already has the two marks that do not need
 * it, the filled centre and its section heading, where the project has neither.
 *
 * Unconditionally, including where only one project is on screen. A colour that
 * appeared only sometimes would have to be interpreted before it could be read,
 * against a rule nothing in the sidebar shows you — and "only one project" is a
 * fact a filter or a newly added project can change without any thread having
 * changed.
 *
 * `waiting-on-me` and `waiting-on-other` still draw the same ring, told apart
 * by the section header or by the label on hover when grouping is off.
 *
 * Precedence is live first, stored second: a thread whose agent is running or
 * queued is `working` no matter what its brief says, and `working` still draws
 * nothing. Three reasons, in order of how much they cost:
 *
 * - bb hides a plugin row status outright when its own indicator is `runtime`,
 *   `unread-error` or `waiting-for-input`, so for a plain running thread a
 *   decoration here is ignored anyway.
 * - It is *not* hidden for `plan-mode`, `goal`, `workflow` or
 *   `background-agent`, where it would displace a shimmering live glyph that
 *   says something a stored brief cannot.
 * - bb paints the status in place of the unsent-draft pencil, so decorating a
 *   row always costs the pencil there.
 *
 * `liveWorking` is client-side truth the sidebar already holds, so applying it
 * here costs no server round trip — which is the whole reason `listRowSignals`
 * does no per-thread lookups.
 */
export function rowDecoration(
  signal: RowSignal,
  liveWorking: boolean,
  project: { id: string; name: string } | null = null,
): { icon: string; label: string; tone: "default" | "error" | "running" | "success" } | null {
  if (liveWorking) return null;
  const isDone = signal.status === "done";
  const colorIndex =
    project === null ? undefined : projectColorIndex(project.id);
  const label = rowLabelFor(signal.stage, signal.status);
  return {
    icon: isDone ? doneRingIcon(colorIndex) : stageRingIcon(signal.stage, colorIndex),
    // Never `success`. The colour channel belongs to the project now, and a
    // green that showed up only on the rows this function happens to be handed
    // no project for would be a second, invisible rule competing with it.
    // `done` keeps the two marks that do not need the channel: the filled
    // centre, and its section heading.
    tone: "default",
    label:
      project === null || project.name === "" ? label : `${label} (${project.name})`,
  };
}
