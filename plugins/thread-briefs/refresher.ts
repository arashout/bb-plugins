/**
 * Whether to reorient someone arriving at a thread, and in how many words.
 *
 * Pure: `server.ts` fetches the thread and the dismissal record and hands them
 * in. Every rule the feature has lives in {@link chooseRefresher}, so "when
 * does this show?" is answered by reading one function rather than by tracing a
 * component's effects.
 */
import type {
  RefresherVariant,
  StoredBriefStatus,
  StoredRefresher,
} from "./contract.js";
import { isLiveWorking } from "./shared.js";

/** kv prefix for the per-thread dismissal record. */
export const REFRESHER_SEEN_PREFIX = "refresher-seen:";

export const refresherSeenKey = (threadId: string) =>
  `${REFRESHER_SEEN_PREFIX}${threadId}`;

/**
 * How many multiples of the idle threshold make a thread *cold* — the point
 * where the fuller variant is worth more than the shorter one.
 *
 * Derived from the threshold rather than configured beside it, so tuning the
 * one setting moves both boundaries together and they cannot be set into a
 * contradiction. Three, so the default eight-hour threshold puts the boundary
 * at a day: a thread you left this morning gets the short version, a thread you
 * left before yesterday gets the long one. That is also the span the
 * summarizer's own prompt is written around ("someone returning after a day
 * away"), so the two agree about what "cold" means.
 */
export const REFRESHER_COLD_MULTIPLE = 3;

export interface RefresherDecision {
  /**
   * The prose on the thread's brief. Null or undefined for a brief written
   * before the refresher existed, or one whose summary returned nothing usable.
   */
  prose: StoredRefresher | null | undefined;
  /** The status the brief resolves to now, manual override included. */
  status: StoredBriefStatus;
  /** bb's live thread status, for the "never on a running thread" rule. */
  threadStatus: string;
  /** bb's `latestAttentionAt`: when this thread last did something. */
  latestAttentionAt: number;
  /** The attention cursor this thread's refresher was last dismissed at. */
  dismissedAt: number | null;
  now: number;
  /** The configured idle threshold in ms. Zero or less disables the feature. */
  thresholdMs: number;
}

export interface RefresherChoice {
  text: string;
  variant: RefresherVariant;
  attentionAt: number;
}

/**
 * The reorientation to show, or null — which is the answer almost every time a
 * thread is opened.
 *
 * The rules, in the order they are cheapest to fail:
 *
 * - **The feature is off.** A threshold of zero is the off switch, so turning
 *   the refresher off costs no separate boolean that could disagree with it.
 * - **No prose.** Briefs are never backfilled and the model can decline to
 *   write one, so "no brief" and "a brief with nothing to say" are both
 *   ordinary states, not errors.
 * - **The thread is running.** Live state outranks anything stored: a thread
 *   whose agent is working is not a thread you have to be reminded about, and
 *   the sentence would be describing a position that is moving.
 * - **The prose was written for a different reading.** A status pinned by hand
 *   since the summary means the sentence may tell you to carry on with
 *   something you have just called blocked. Showing nothing is the honest
 *   outcome, because generating a replacement here would be a model call on
 *   open — the one thing this design refuses to do. Pinning a status queues the
 *   re-summary that clears the disagreement.
 * - **Not idle long enough.** The whole premise is that time has passed; below
 *   the threshold you remember.
 * - **Already seen this activity.** A dismissal records the cursor it covered,
 *   so it holds until the thread does something new — and only until then.
 *
 * Then the variant: cold threads get the fuller one. Either variant falls back
 * to the other when the model left it empty, because one sentence in the wrong
 * register beats nothing at all.
 */
export function chooseRefresher(
  input: RefresherDecision,
): RefresherChoice | null {
  if (!(input.thresholdMs > 0)) return null;

  const prose = input.prose ?? null;
  if (prose === null) return null;

  if (isLiveWorking(input.threadStatus)) return null;

  if (prose.writtenForStatus !== input.status) return null;

  const idleMs = input.now - input.latestAttentionAt;
  if (idleMs < input.thresholdMs) return null;

  if (input.dismissedAt !== null && input.dismissedAt >= input.latestAttentionAt) {
    return null;
  }

  const variant: RefresherVariant =
    idleMs >= input.thresholdMs * REFRESHER_COLD_MULTIPLE ? "full" : "short";
  const text = pickText(prose, variant);
  if (text === null) return null;

  return { text: text.text, variant: text.variant, attentionAt: input.latestAttentionAt };
}

/** The asked-for variant, the other one, or nothing at all. */
function pickText(
  prose: StoredRefresher,
  variant: RefresherVariant,
): { text: string; variant: RefresherVariant } | null {
  const other: RefresherVariant = variant === "full" ? "short" : "full";
  const preferred = prose[variant].trim();
  if (preferred !== "") return { text: preferred, variant };
  const fallback = prose[other].trim();
  return fallback === "" ? null : { text: fallback, variant: other };
}
